# PopDEX 第 6 阶段：IExchange 适配器与 Paper 模式设计

日期：2026-08-18

## 背景

PopDEX 第 5 阶段已经完成并通过主网最小金额验收：Agent 授权、BTCUSDT 1x 杠杆、限价下单、撤单、成交确认和 reduce-only 市价平仓均已有可验证链上与官方账户事实。最新恢复结果为 `completed-flat`，说明实盘开仓到仓位归零的闭环已经完成。

本阶段对应总设计的实施顺序第 6 项：实现独立的 PopDEX `IExchange` 适配器与 Paper 模式。第 7 阶段才接入 Bot 成交补单、重启恢复和故障状态，因此本阶段不得开放自动实盘网格。

## 目标

- 新增 PopDEX live 与 paper 两个独立适配器。
- 新增适用于 live 独立写操作的通用持久化日志，消除进程崩溃后的广播事实歧义。
- 两个适配器提供与现有交易所一致的方法和事件外形。
- live 适配器只组合已经验证的 PopDEX 客户端、编码器、回执解析器和日志，不重复实现协议细节。
- paper 适配器使用 PopDEX 官方 BTCUSDT、ETHUSDT 行情，在本地模拟订单、成交、余额和仓位。
- 保持 Decibel、RISEx、Extended、Bot、配置、API 和前端行为不变。

## 非目标

- 不把 PopDEX 注册到服务器或 Bot。
- 不增加 PopDEX 配置、API 路由或前端交易页面。
- 不实现 live 成交补单、离线成交补发、重启接管或自动网格恢复。
- 不删除 Extended；该工作属于总设计第 8、9 阶段。
- 不进行新的主网写入验收。
- 不解除 BTCUSDT 已验证范围之外的 live 写操作限制。

## 方案选择

采用组合式独立适配器：新增 `px/index.js`、`px/popdex.js`、`px/paper.js` 和 `px/operation-journal.js`，复用现有 PopDEX 严格客户端和写入边界。

未采用以下方案：

- 复制 Extended 适配器：会继承与 PopDEX 不一致的订单身份、轮询和仓位假设。
- 抽取所有交易所共用基类：重构范围过大，可能影响当前正常运行的 Decibel 和 RISEx。

## 文件与职责

### `src/exchange/px/index.js`

- 提供 PopDEX live/paper 工厂。
- 根据显式传入的 `mode` 创建适配器。
- 本阶段不从服务器、配置加载器或前端调用该工厂。
- live 构造必须收到主账户、Agent 私钥和固定主网客户端依赖；paper 构造必须收到显式手续费率。

### `src/exchange/px/popdex.js`

- 继承 `EventEmitter`，提供 live `IExchange` 外观。
- 组合现有 `PublicClient`、`AccountClient`、`TradingClient`、严格标准化器、回执解析器和持久化日志。
- 维护市场、价格、余额、权益、已实现盈亏、开放订单和仓位的最近一次完整已验证快照。
- 维护 `READY`、`RECONCILING`、`HALTED` 状态以及可观测健康信息。
- 所有写操作通过单一串行队列进入现有写入边界。
- 本阶段不产生 live `fill` 事件；第 7 阶段完成订单状态机和恢复对账后才开放。

### `src/exchange/px/operation-journal.js`

- 为 `leverage`、`place`、`cancel`、`close` 四类独立 live 操作保存精确恢复事实。
- 每条记录包含版本、操作类型、阶段、主账户、Agent 地址、市场、订单/仓位身份、clientOrderId、交易哈希、错误摘要和更新时间。
- 使用临时文件加原子重命名写入；POSIX 文件权限必须为 `0600`。
- 一次只允许存在一条未完成操作；发现未完成记录时，新写操作必须拒绝并要求先执行只读恢复。
- `PREPARED` 表示尚无广播事实；`BROADCAST` 表示已经持久化本地交易哈希；`CONFIRMED` 表示链上回执和官方终态均已确认。
- 只有 `CONFIRMED` 记录才能清理。广播失败、回执未知或 REST 终态不明确时保留记录，不自动重试。
- 现有探针日志继续服务探针，不改写为适配器日志，也不伪造探针专用字段。

### `src/exchange/px/paper.js`

- 继承 `EventEmitter`，在内存中模拟交易。
- 只从 PopDEX 官方公共客户端读取 BTCUSDT、ETHUSDT 市场、ticker 和 K 线。
- 使用官方最新价格驱动限价撮合，并产生 `price`、`fill` 事件。
- 本地维护订单、仓位、余额、权益和已实现盈亏。
- 手续费率必须由调用方显式传入并严格验证，不使用未经确认的默认值。
- 官方行情失败或过期时停止撮合并报告错误，不生成随机行情，也不继续用旧价格制造成交。

## IExchange 方法

live 与 paper 均提供以下方法：

- `init()`
- `reconnect()`
- `getMarkets()`
- `getCandles(marketId, intervalSec, n)`
- `getPrice(marketId)`
- `setLeverage(marketId, leverage)`
- `placeLimitOrder(order)`
- `cancelOrder(marketId, orderId)`
- `cancelAll(marketId)`
- `getOpenOrders(marketId)`
- `fetchOpenOrders(marketId)`
- `adoptOrder(meta)`
- `getPosition(marketId)`
- `closePosition(marketId)`
- `start()`
- `stop()`
- `getHealth()`

公开返回值与现有 Bot 约定一致：市场使用数值 `marketId`，官方订单 ID 始终保留为字符串，价格和数量只在通过严格解析后转换为显示数值。

## Live 初始化与只读刷新

`init()` 不执行写操作，并按顺序完成：

1. 验证 PopDEX Mainnet `chainId=2184` 和固定官方端点。
2. 读取并严格验证 BTCUSDT、ETHUSDT 市场身份和精度。
3. 派生 Agent 地址并验证其属于配置的主账户、授权有效且非 global Agent。
4. 读取账户概览、BTC/ETH 开放订单和仓位。
5. 所有响应完整且身份一致后原子替换本地快照并进入 `READY`。

`start()` 只启动公共价格和账户只读刷新。每轮刷新使用单飞控制，只有全部数据成功后才替换快照；不得把半轮数据暴露给同步读取方法。`stop()` 只停止轮询，不撤单、不平仓、不清除订单跟踪。

`getPosition()`、`getOpenOrders()` 等同步方法只读取最近一次完整快照。异步 `fetchOpenOrders()` 必须执行或等待一次受控官方读取，不能把读取失败伪装为空数组。

## Live 写操作边界

本阶段只允许已经通过主网验证的能力：

- BTCUSDT 1x 杠杆。
- BTCUSDT 限价下单和精确订单撤单。
- 撤销适配器明确接管的 BTCUSDT 订单。
- BTCUSDT 多仓的 reduce-only 市价平仓，并以官方仓位归零确认成功。

以下操作必须明确拒绝：

- ETHUSDT live 写操作。
- BTCUSDT 非 1x 杠杆。
- 未经验证的 BTC 空仓平仓路径。
- 不属于适配器的外部手工订单撤销。
- `RECONCILING` 或 `HALTED` 状态下的任何普通写操作。

每次写操作必须：

1. 检查当前状态和快照新鲜度。
2. 校验市场、方向、价格、数量、精度、最小名义金额和订单所有权。
3. 创建一条 `PREPARED` 通用操作日志；已有未完成记录时拒绝继续。
4. 通过串行队列调用现有 `TradingClient`。
5. 签名前完成模拟；签名后、广播前将本地交易哈希持久化为 `BROADCAST`。
6. 验证成功链上回执和官方账户终态。
7. 将日志推进到 `CONFIRMED`，原子更新本地快照，再清理已完成日志。

回执成功但官方终态不明确时进入 `HALTED`，不得自动重试。普通限价单仍要求回执价格完全匹配；只有显式 reduce-only 市价平仓使用已经验证的正执行价格规则。

`init()` 或 `reconnect()` 发现未完成通用操作日志时，只允许执行只读恢复：根据记录的交易哈希读取回执，再通过订单、成交、杠杆或仓位官方事实确定结果。无法得到唯一结论时保持 `HALTED`，不得清理日志或重复广播。

`cancelAll()` 只遍历适配器明确接管的订单，逐笔使用已验证撤单路径，并在官方快照确认所有目标订单消失后返回 `true`。外部手工订单保留不动。

## Paper 模式

Paper 模式同时支持 BTCUSDT、ETHUSDT，市场身份和精度与 live 一致。

行为规则：

- 买单在官方价格向下触及限价时成交；卖单在官方价格向上触及限价时成交。
- 成交价使用订单限价，数量使用订单剩余数量。
- 成交后更新余额、手续费、已实现盈亏和加权持仓成本。
- reduce-only 订单只能减少现有反向仓位，不能反手开仓。
- 不满足 reduce-only 条件的订单明确终止并产生可观测错误，不静默转成普通订单。
- `closePosition()` 按当前有效官方价格在本地平仓。
- `cancelOrder()` 和 `cancelAll()` 只在本地修改订单，并返回明确确认结果。
- `adoptOrder()` 只接受完整且通过精度校验的 paper 订单元数据。

行情超过规定新鲜度或公共读取失败时：

- 停止撮合。
- 健康状态显示行情不可用。
- `getPrice()` 和新增风险写操作报错。
- 已有本地订单和仓位保持不变。

## 状态机与恢复规则

### `READY`

最近一次公共、账户和授权快照完整有效。仅此状态允许已验证 live 写操作。

### `RECONCILING`

用于初始化、人工重连和暂时网络读取失败。拒绝所有 live 写操作。网络恢复后，只有一次完整对账成功才能自动回到 `READY`。

### `HALTED`

用于响应结构变化、Agent 身份冲突、订单身份冲突、回执冲突、持久化失败或仓位无法确认。不得由定时轮询自动恢复；必须人工调用 `reconnect()`，并在完整对账成功后恢复。

任何状态转换均记录原状态、目标状态和脱敏原因。错误保留底层 `cause` 与阶段信息，但不得包含 Agent 私钥、完整签名或认证材料。

## 可观测性

`getHealth()` 至少返回：

- `state`
- `lastPublicOkAt`
- `lastAccountOkAt`
- `lastAuthorizationOkAt`
- `lastErrorStage`
- `lastErrorMessage`
- `writeInFlight`
- `dataSource`

写操作日志记录操作类型、市场、订单 ID、clientOrderId、交易哈希和耗时。敏感账户地址按现有规则缩写；私钥和原始签名永不记录。

## 测试设计

自动化测试至少覆盖：

- live/paper 方法契约和 EventEmitter 行为。
- BTCUSDT、ETHUSDT 白名单、官方身份和精度拒绝。
- 初始化成功、网络失败、结构异常、状态转换和人工重连。
- 完整快照原子替换，读取失败不能变成空订单或空仓位。
- 非 `READY` 状态拒绝写入。
- 写操作串行化和调用现有严格交易客户端。
- 通用操作日志 schema、原子写入、`0600` 权限、合法阶段转换和未完成记录互斥。
- `BROADCAST` 记录通过链上回执和官方终态只读恢复，未知事实保持 `HALTED` 且不重播交易。
- BTC 1x、限价下单、撤单、仅接管订单批量撤单和多仓平仓。
- ETH live 写、非 1x、BTC 空仓平仓和外部订单撤销被拒绝。
- Paper 限价撮合、持仓加减、reduce-only、显式手续费和成交事件。
- Paper 行情失败或过期后停止撮合，不生成合成行情。
- 错误和日志不泄露 Agent 私钥。
- Decibel、RISEx、Bot、持久化、安全和现有 PopDEX 测试无回归。

## 阶段验收

1. 完整 `npm test` 通过。
2. VPS 现有 `npm run popdex:verify -- --account-env POPDEX_MAIN_ACCOUNT` 公共与账户只读验证通过。
3. 不运行新的 PopDEX 主网写入命令。
4. 现有页面、配置和 Bot 中不出现可启动的 PopDEX 网格入口。
5. 文档明确标注“PopDEX 网格尚未开放”。

完成本阶段只能声明“PopDEX IExchange 外观和 Paper 模式已实现”，不能声明“PopDEX 网格可上实盘”。第 7 阶段完成 live 成交状态机、补单、离线恢复和断线对账后，才能开始 BTC 小网格验收。
