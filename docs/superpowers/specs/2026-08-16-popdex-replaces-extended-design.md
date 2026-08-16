# PopDEX 替换 Extended 设计

日期：2026-08-16

## 目标与范围

在 `dex-wangge` 中用 PopDEX 永续合约适配器完整替换 Extended，保留现有网格策略、持久化、安全边界、仪表盘和机器人控制流程。

首版只支持 PopDEX Mainnet：

- `BTCUSDT`（官方 `symbolId=20000`）
- `ETHUSDT`（官方 `symbolId=20001`）

内部命名、HTTP API、配置和界面全部从 `ex`/Extended 改为 `px`/PopDEX，不保留兼容别名。主钱包私钥不进入项目；实盘只保存经主账户授权的 Agent 私钥。

## 参考实现的使用边界

参考仓库：[hblicy/PopDex](https://github.com/hblicy/PopDex)。

可以复用的信息包括：PopDEX Mainnet 链 ID、公开市场接口、预编译地址线索、Agent Key 浏览器生成流程、`approveAgent` 授权交互和账户查询路径。

不得直接移植其交易运行器，原因如下：

- 参考仓库 README 明确说明自动成交对账、撤单和成交补单尚未完成可靠验证。
- `popdex-live.js` 对 Agent 是否能作为原始交易发送方的注释与实现矛盾。
- 交易哈希被当作订单标识，无法建立可靠的订单身份链。
- 成交按最近网格价格猜测层级，无法处理同价、滑点或部分成交。
- 仓位根据有限成交记录推导，而不是官方仓位快照。
- 缺少经过验证的杠杆设置、reduce-only 平仓、断线恢复和订单竞态处理。
- 错误路径存在吞错，测试只覆盖网格数学。

因此参考仓库只用于协议发现；实盘实现必须重新验证协议并遵守本项目的 `IExchange` 契约。

## 总体架构

新增 `src/exchange/px/`，保持 PopDEX 协议细节与网格策略隔离：

```text
src/exchange/px/
├── index.js
├── popdex.js
├── paper.js
├── agent.js
├── rpc-client.js
├── account-client.js
├── normalize.js
├── order-state.js
├── types.js
└── verify.js
```

组件职责：

- `agent.js`：Agent 地址派生、授权状态检查、经验证的签名和交易编码。
- `rpc-client.js`：链 ID 校验、交易模拟、广播、回执和失败原因读取。
- `account-client.js`：官方余额、开放订单、订单历史、成交和仓位读取。
- `normalize.js`：严格解析官方响应，保留大整数订单 ID 和精确小数。
- `order-state.js`：订单生命周期、部分成交累计、终态去重和网格元数据关联。
- `popdex.js`：状态机、写入串行化、REST/链上对账和 `IExchange` 实现。
- `verify.js`：公共与私有只读验证，不执行下单、撤单、杠杆或平仓。

## 协议验证门槛

在实现任何自动网格写操作前，必须通过独立协议验证阶段确认：

1. PopDEX Mainnet `chainId=2184` 和官方 RPC 身份。
2. Account 预编译及 `approveAgent` 的准确 ABI、nonce 单位和授权读取方式。
3. Order 预编译的准确 ABI、Agent 签名和交易发送模型。
4. Agent 交易中 `msg.sender`、主账户、Agent 地址之间的实际关系。
5. `txHash`、`clientOrderId`、官方 `orderId` 的映射。
6. 下单、撤单、杠杆和 reduce-only 平仓的官方终态。
7. 账户 REST 对订单、成交和仓位的完整字段及分页规则。
8. 最大开放订单数和接口限流规则。

参考代码中的 `Date.now()` nonce、gas 参数和 Agent 原始交易格式均不得直接视为正确。协议验证优先使用只读调用和交易模拟；确需写入时，只允许用户批准的最小名义金额单笔测试。

任何一项未确认，适配器只能处于只读状态，不能开放实盘启动。

## 市场与精度

启动时从官方 `/api/v1/config/symbols?category=Futures` 获取市场，并严格验证：

| 市场 | symbolId | tickSize | lotSize | minNotional |
|---|---:|---:|---:|---:|
| BTCUSDT | 20000 | 1 | 0.0001 | 10 USDT |
| ETHUSDT | 20001 | 0.1 | 0.001 | 10 USDT |

这些值是当前已观察到的主网数据，只作为预期值；官方返回与预期不一致时必须拒绝启动并报告差异，不能静默使用硬编码值。

所有价格和数量先按字符串/整数单位验证，再转换为机器人显示值。订单 ID、成交 ID、nonce 和区块字段不得经过不安全的 JavaScript `Number`。

## Agent Key 创建与授权

仪表盘增加独立的 PopDEX Agent 卡片：

1. 浏览器本地生成随机 Agent Key。
2. 私钥只在浏览器显示一次，默认不发送后端。
3. 用户连接 EVM 钱包；页面请求切换或添加 PopDEX Mainnet。
4. 浏览器钱包使用主账户确认 `approveAgent` 交易。
5. 页面等待链上回执，并通过独立读取接口验证授权已经生效。
6. 用户明确点击保存后，Agent 私钥和主账户地址才写入 `.env`。
7. 后端再次派生 Agent 地址并验证授权；验证通过前禁止实盘。

安全要求：

- 主钱包私钥永不进入页面代码、HTTP 请求、后端或日志。
- Agent 私钥不通过状态 API、SSE、错误消息或日志返回。
- `.env` 在 POSIX 上必须保持 `0600`。
- Agent 与主账户地址相同、授权过期、被撤销或链不匹配时立即拒绝写操作。
- 前端不将 Agent 私钥存入 Local Storage、Session Storage 或持久化状态。

## 订单身份与写操作

必须严格区分：

- `txHash`：链上交易标识，只证明交易广播和执行。
- `clientOrderId`：机器人生成的幂等标识，与网格层级一起持久化。
- `orderId`：PopDEX 官方订单标识，用于开放订单、撤单、历史和成交确认。

限价下单流程：

1. 验证状态、市场、价格、数量、最小名义金额和 reduce-only 语义。
2. 写入“待提交”持久化记录并生成唯一 `clientOrderId`。
3. 串行分配经协议验证的 nonce，模拟并签名交易。
4. 广播交易并等待成功回执。
5. 通过官方账户接口按 `clientOrderId` 查找订单。
6. 获得官方字符串 `orderId` 并核对市场、方向、价格、数量。
7. 完成持久化后才向网格机器人返回 `{ orderId }`。

回执成功但无法确认官方订单时进入 `HALTED`，不得把 `txHash` 当作订单 ID，也不得自动重试制造重复订单。

撤单、批量撤单、杠杆设置和平仓均采用“链上成功回执 + 官方 REST 终态确认”。批量撤单只有在目标市场开放订单全部消失后才返回成功。平仓必须使用 reduce-only，并以官方仓位归零作为成功条件。

## 成交确认与补单

成交只能通过官方 `orderId`/`clientOrderId` 关联本地订单，不得按价格猜测网格层级。

`order-state.js` 必须支持：

- OPEN、PARTIAL、FILLED、CANCELLED、REJECTED、EXPIRED 等已验证状态。
- 多笔 fill 累计和 fill ID 去重。
- 部分成交时保留活动订单，不提前补单。
- 终态成交只产生一次网格 `fill` 事件。
- 撤单与成交竞态以官方最终成交数量为准。
- 程序离线期间发生的成交在恢复对账后补发一次。
- 批量撤单期间出现的成交计入统计，但禁止重新报价。

每个本地订单持久化 `marketId`、`levelIndex`、`side`、`price`、`sizeBase`、`clientOrderId` 和官方 `orderId`。补单由现有网格核心根据原订单层级计算。

## 状态机、对账与恢复

PopDEX 适配器使用与 RISEx 一致的安全状态：

- `READY`：授权、REST 数据和订单身份一致，允许写入。
- `RECONCILING`：启动、断线或人工重连期间只读对账，拒绝新风险。
- `HALTED`：订单冲突、签名错误、响应结构变化或仓位不可确认，拒绝写入；仅允许经过确认的紧急撤单路径。

启动与重连对账数据源：

- 本地持久化网格订单所有权快照。
- 官方 BTCUSDT/ETHUSDT 开放订单。
- 官方订单历史和成交记录。
- 官方 BTCUSDT/ETHUSDT 仓位。
- Agent 链上授权状态。

出现外部订单、未知订单、重复 `clientOrderId`、本地订单从官方数据消失但没有终态，或仓位字段不完整时进入 `HALTED`，不自动撤单、不猜测成交、不自动平仓。

轮询需要单飞控制和明确游标；分页必须遍历到本地所有活动订单均有结论。网络错误保留底层 cause 和阶段信息，但进行凭据脱敏。

## Paper 模式

PopDEX paper 使用 PopDEX 官方 BTCUSDT/ETHUSDT 公开行情，订单和仓位只在本地模拟。公开行情不可用时健康状态报错，不切换到未标识的随机价格。

Paper 和 live 暴露相同市场 ID、精度和 `IExchange` 方法，确保策略层无需分支。

## 配置、API 与界面迁移

最终替换关系：

```text
config.ex  -> config.px
/api/ex/*  -> /api/px/*
EXTENDED_* -> POPDEX_*
EXTENDED_PROXY -> POPDEX_PROXY
```

基础配置：

```ini
PX_MODE=paper
PX_NETWORK=mainnet
POPDEX_MAIN_ACCOUNT=
POPDEX_AGENT_PRIVATE_KEY=
POPDEX_PROXY=
```

官方 API、RPC、chainId 和预编译地址提供固定主网默认值；普通实盘配置不允许任意覆盖。开发测试覆盖必须显式启用，避免实盘连接伪造端点。

仪表盘、总览、AI 助手、代理设置、日志、环境变量说明和 README 中的 Extended 全部改为 PopDEX。旧 `EXTENDED_*` 不自动迁移，也不作为 PopDEX 配置读取。

开发期间允许在功能分支中暂时保留 `ex`，用于对照测试；最终合并版本必须删除 Extended 适配器、Stark 签名代码和相关文档，不保留运行入口。

## 测试与验收

自动化测试至少覆盖：

- Agent 地址派生、授权编码和授权状态验证。
- 经官方确认的签名/ABI 测试向量。
- BTC/ETH 市场白名单、精度、最小数量和最小名义金额。
- 大整数订单 ID、精确小数和异常响应拒绝。
- 下单回执与官方订单映射。
- 部分成交、完整成交、重复 fill、乱序 fill 和撤单竞态。
- 批量撤单、reduce-only 平仓和杠杆回读。
- 网络断开、REST 过期、对账冲突和 `HALTED` 边界。
- 程序重启接管、离线成交恢复和状态写入失败清理。
- 私钥、账户令牌和 URL 查询参数不出现在日志。
- 现有 Decibel、RISEx、Bot、持久化、安全和前端 API 测试无回归。

主网验收按顺序执行：

1. 公共只读验证。
2. Agent 创建、授权、读取和撤销检测。
3. 私有只读余额、订单、成交和仓位验证。
4. BTC 最小限价单：提交、确认、撤单、确认消失。
5. BTC 最小可成交单：部分/完整成交确认和 reduce-only 平仓。
6. BTC 小网格：成交补单、重启恢复和网络断线对账。
7. ETH 重复以上流程。
8. 所有验收通过后才解除完整网格数量限制。

## 实施顺序

1. 协议验证和只读探针。
2. PopDEX 公共/账户客户端与严格标准化。
3. Agent 生成、钱包授权和后端授权验证。
4. 订单状态机和持久化所有权模型。
5. 单笔下单、撤单、杠杆和平仓闭环。
6. `IExchange` 适配器和 Paper 模式。
7. Bot 成交补单、恢复和故障状态集成。
8. 前端/API/config 从 `ex` 迁移到 `px`。
9. 删除 Extended 和 Stark 相关代码。
10. 自动测试、分阶段主网验收和部署文档。

每个阶段必须先完成对应只读或最小写入验收；不得用未验证接口继续堆叠下一阶段。

## 完成标准

只有同时满足以下条件，才能称为“PopDEX 已替换 Extended”：

- 项目中不再存在可运行的 Extended 入口。
- PopDEX BTCUSDT/ETHUSDT paper/live 完整实现 `IExchange`。
- Agent 授权、下单、撤单、成交、杠杆、仓位和平仓均来自可验证官方状态。
- 成交补单、断线对账和重启接管不依赖价格猜测或本地成交推导。
- 全量自动测试通过，并完成 BTC、ETH 小资金主网验收。
- README、`.env.example`、VPS 部署和安全说明已同步更新。

