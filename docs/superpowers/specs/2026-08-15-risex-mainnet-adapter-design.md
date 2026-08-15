# RISEx Mainnet 实盘适配器设计

日期：2026-08-15
目标分支：`codex/risex-mainnet-adapter`

## 1. 背景与目标

`dex-wangge` 当前只允许 RISEx 模拟盘。旧版 `3xx-wangge-main` 和 `classic-grid` 虽然能够调用 RISEx 实盘接口，但仍存在把“订单从开放列表消失”推断为成交的路径，无法满足真实资金所需的确定性状态确认。

RISEx 当前官方接口提供：

- 带 `status`、`filled_size`、`avg_price` 的私有 Orders WebSocket；
- 私有 Fills WebSocket；
- REST 开放订单、订单历史、成交历史、仓位与账户接口；
- EIP-712 permit 下单和撤单接口。

本功能的目标是在不削弱现有安全边界的前提下，重新实现 RISEx mainnet 适配器，使其遵守与 Decibel、Extended 相同的 `IExchange` 契约，并以 RISEx 官方订单状态和实际成交数量作为唯一事实来源。

官方参考：

- <https://developer.rise.trade/reference/general-information>
- <https://developer.rise.trade/reference/orders-channel>
- <https://developer.rise.trade/reference/javascripttypescript>
- <https://developer.rise.trade/reference/orderservice_placeorder>

## 2. 已确认范围

### 2.1 包含

- 直接接入 RISEx mainnet。
- 只允许 `BTC-PERP` 和 `ETH-PERP`。
- `RS_MODE=paper` 继续使用现有模拟适配器。
- `RS_MODE=live` 使用新的 RISEx 实盘适配器。
- `risex-client` 只负责 EIP-712 签名和发送写请求。
- 官方 Orders/Fills WebSocket 和 REST 负责订单、成交、仓位及恢复确认。
- 支持下单、撤单、批量撤单、杠杆、平仓、重连和重启接管。
- 使用现有 GridBot 的终态成交语义：部分成交订单在最终 `FILLED` 或 `CANCELLED` 前不补反向单。
- 增加 mainnet 公共只读验证和用户执行的私有只读验证。

### 2.2 不包含

- RISEx testnet 接入。
- BTC、ETH 之外的市场。
- 由开发或自动测试执行真实下单、撤单、平仓。
- 手写完整 EIP-712 下单协议。
- 与人工订单或其他机器人共享同一 RISEx 账户。
- 把 WebSocket/REST 状态不确定性降级成“推测成交”。

## 3. 安全前提

1. RISEx 必须使用独立交易账户，BTC/ETH 不得同时存在人工策略或其他机器人订单。
2. 实盘凭据只存在 VPS 的 `.env`，不得写入日志、状态文件、测试夹具或 Git。
3. `risex-client` 精确固定为 `0.1.11`，禁止使用范围版本自动升级。
4. live 模式禁止配置任意 API/WS 域名，必须使用经过校验的 RISEx mainnet HTTPS/WSS 地址。
5. 启动时必须验证 EIP-712 domain、mainnet chain ID、signer 注册状态、BTC/ETH 市场元数据和私有 WebSocket 认证。
6. 任何关键状态未知时停止新增风险，不自动猜测、补单或全市场清理。

## 4. 架构

```text
GridBot
  |
  v
RisexExchange（IExchange 适配器/编排）
  |-- risex-client 0.1.11（签名、下单、撤单）
  |-- RisexPrivateStream（官方 Orders/Fills WebSocket）
  |-- 官方 REST（挂单、历史、成交、仓位、账户）
  `-- RisexOrderState（纯订单状态机和去重）
```

### 4.1 `RisexExchange`

文件：`src/exchange/rs/risex.js`

实现现有 `IExchange` 接口：

- `init()` / `reconnect()`
- `getMarkets()` / `getCandles()` / `getPrice()`
- `setLeverage()`
- `placeLimitOrder()`
- `cancelOrder()` / `cancelAll()`
- `fetchOpenOrders()` / `getOpenOrders()` / `adoptOrder()`
- `getPosition()` / `closePosition()`
- `start()` / `stop()`
- `price` / `fill` / `error` 事件

它负责写请求串行化、REST/WS 合并、健康状态、订单恢复和向 GridBot 输出统一事件，不在内部推测网格策略。

### 4.2 `RisexPrivateStream`

文件：`src/exchange/rs/private-stream.js`

职责：

- 获取官方认证 domain 和服务端 nonce；
- 使用精确固定版本的 `ethers` 对 session signer 执行 EIP-712 `auth_v2` 签名；
- 使用项目已有的 `undici` WebSocket 直接连接官方端点；
- 订阅私有 `orders`、`fills`；
- 对消息做结构校验并保留 block/log/timestamp；
- 断线后指数退避重连、重新认证、重新订阅；
- 在恢复完成前缓存消息，不自行触发交易动作；
- 输出认证、连接、订单和成交事件。

### 4.3 `RisexOrderState`

文件：`src/exchange/rs/order-state.js`

纯逻辑模块，负责：

- 订单状态迁移；
- 累计 `filled_size` 和实际成交数量校验；
- Orders/Fills 消息去重；
- 重复、乱序消息处理；
- 终态只生成一次标准化成交结果；
- 数据倒退、超量成交、未知状态时报完整错误。

该模块不得访问网络、环境变量或 GridBot，以便进行完整的状态矩阵测试。

## 5. 依赖与配置

### 5.1 依赖

`package.json` 增加：

```json
"ethers": "6.13.5",
"risex-client": "0.1.11"
```

使用范围限定为：

- 初始化签名客户端；
- 生成并提交 EIP-712 permit 写请求；
- 调用已审计的只读客户端方法。

不使用 `classic-grid` 中修改 `globalThis.fetch`、推测成交或 vendor 整包复制的逻辑。

`ethers` 只用于官方 `auth_v2` 的 EIP-712 签名，并作为直接生产依赖固定版本；WebSocket 复用项目现有的 `undici`，不从 `risex-client` 的传递依赖导入包。

### 5.2 环境变量

```dotenv
RS_MODE=paper
RS_NETWORK=mainnet
RISEX_ACCOUNT=
RISEX_SIGNER_KEY=
RISEX_API_URL=https://api.rise.trade
RISEX_WS_URL=wss://api.rise.trade/ws/
```

规则：

- `RS_MODE=live` 时账户和 signer 必填。
- `RS_NETWORK` 只接受 `mainnet`。
- live 模式的 API/WS URL 必须与允许的 mainnet 地址完全匹配。
- 私钥不返回给前端，也不记录在 `.state.json`。

## 6. 市场限制

初始化时读取官方市场列表，只保留规范化名称为 `BTC-PERP`、`ETH-PERP` 的市场。

每个市场必须同时具备：

- 唯一且安全的整数 `marketId`；
- 有效 `stepSize`、`stepPrice`、`minOrderSize`；
- 有效 `maxLeverage`；
- 正数参考价格。

缺少任意一个目标市场或元数据不合法时，live 初始化失败。其他 RISEx 市场不得出现在仪表盘选择框，也不能通过直接 API 参数启动。

## 7. 启动同步与恢复屏障

live 初始化按以下顺序执行：

1. 校验配置、mainnet endpoint 和依赖版本。
2. 初始化 `risex-client`，验证 signer 已注册。
3. 加载并校验 BTC/ETH 市场。
4. 连接并认证私有 WebSocket，开始缓存 Orders/Fills 消息。
5. 读取 REST 开放订单、订单历史、成交历史、仓位和账户。
6. 以 REST 快照建立状态，再按 block/log/timestamp 应用缓存的 WebSocket 更新。
7. 对比 Orders 快照、REST 开放订单和本地状态。
8. 一致后进入 `READY`；不一致则进入 `HALTED` 或终止启动。

重启时，GridBot 通过 `adoptOrder()` 恢复 `.state.json` 中的订单。适配器把这些 ID 与官方开放订单及近期终态历史匹配：

- 仍开放：恢复跟踪；
- 停机期间终态成交：按实际总成交量生成一次成交；
- 明确取消且无成交：移除，不补单；
- 无法确认：进入 `HALTED`，不自动清理。

## 8. 订单状态机

允许状态：

```text
PENDING -> OPEN -> PARTIAL -> FILLED
             |         |       |
             +---------+-> CANCELLED
PENDING/OPEN/PARTIAL -> UNKNOWN（仅错误状态，不继续交易）
```

### 8.1 终态规则

- `FILLED`：按最终累计成交量和官方平均成交价生成一次 `fill`。
- `CANCELLED` 且累计成交量大于零：按实际成交部分生成一次 `fill`。
- `CANCELLED` 且累计成交量为零：不生成 `fill`。
- `OPEN/PARTIAL`：继续跟踪，不触发反向补单。
- `UNKNOWN`：暂停该交易所自动动作并报警。

### 8.2 去重规则

- Fills 优先使用官方 fill/trade ID 去重。
- Orders 使用订单ID、累计成交量、block/log/timestamp 判断新旧。
- 相同终态重复到达不得重复生成成交。
- 累计成交量只能单调增加，且不得超过订单原始数量。
- 订单ID始终使用字符串，禁止经过 JavaScript `Number`。

## 9. 写请求与竞态处理

### 9.1 下单

1. 只允许 `READY` 状态下单。
2. 生成加密随机 uint64 `client_order_id`。
3. 所有写请求通过同一串行队列，遵守 nonce 和服务端限流。
4. 要求下单响应返回非空字符串订单ID。
5. 建立 `PENDING` 跟踪，再等待 Orders/REST 确认。
6. 立即成交消息若先于调用方完成跟踪，则缓冲到 `placeLimitOrder()` 返回后的事件周期再派发。
7. 确认超时后查询 REST；仍未知则进入 `UNKNOWN/HALTED`。

### 9.2 撤单

- 发送撤单请求后保留本地跟踪。
- 只有 Orders 或 REST 历史确认 `CANCELLED` 才认为撤单成功。
- 撤单竞态中若订单已成交，则按真实成交处理。
- 撤单请求失败或状态未知时返回失败并保留跟踪。

### 9.3 批量撤单

- 进入写屏障，拒绝新的 place 请求。
- 发送批量撤单后反复读取官方开放订单。
- BTC/ETH 目标市场挂单确认归零才返回成功。
- 屏障期间发生的成交可以记账，但不得补出反向订单。
- 超时或仍有订单时抛错，GridBot 保持跟踪状态。

### 9.4 平仓

- 先完成并确认撤单。
- 使用 reduce-only 平仓能力。
- 重复读取官方仓位，确认绝对数量归零才返回成功。
- 无明确归零不得在面板宣称已平仓。

## 10. 健康状态和熔断

### 10.1 状态

- `READY`：私有 WS 已认证且 REST 对账成功，允许写操作。
- `RECONCILING`：连接或状态暂时不可用，保留现有挂单但禁止新写操作。
- `HALTED`：数据完整性、未知订单、撤单或仓位确认失败，需要人工处理。

### 10.2 进入 `RECONCILING`

- 私有 WebSocket 断开；
- 私有数据超过允许的新鲜度；
- 临时网络错误或限流；
- REST/WS 正在重新合并。

恢复条件是重新认证、重新订阅并完成完整 REST 对账。

### 10.3 进入 `HALTED`

- 订单状态或字段结构未知；
- 订单ID为空或精度受损；
- 累计成交量倒退、超量或无法解析；
- 撤单/平仓无法确认；
- 无运行快照却检测到 BTC/ETH 遗留挂单或仓位；
- WebSocket 与 REST 在有界重试后仍矛盾。

`HALTED` 不自动转为 paper、不自动清空交易所状态，也不继续新增风险。

## 11. 独立账户与所有权

由于现有 GridBot 的市场级撤单和恢复模型会管理所选市场的全部网格订单，RISEx live 必须使用独立账户。

- 账户不得存在人工 BTC/ETH 挂单或其他机器人的订单。
- 正常重启只接管 `.state.json` 中能够与官方数据匹配的订单。
- 没有运行快照却发现 BTC/ETH 挂单或仓位时进入 `HALTED`。
- 程序不自动认领来源不明订单，也不自动撤销它们。
- 人工处理完成后通过重连或重启重新执行同步屏障。

## 12. 可观测性

日志至少记录：

- WebSocket连接、认证、订阅、断线、重连；
- REST/WS最后成功时间和延迟；
- 订单状态迁移、累计成交量、最终成交数量；
- 写请求类型、订单ID、耗时、重试次数和限流等待；
- 对账前后挂单数、未知订单数、差异原因；
- 健康状态迁移及具体原因。

不得记录：

- signer 私钥；
- 完整认证签名；
- permit 原始敏感字段；
- `.env` 内容。

仪表盘健康状态增加 RISEx 私有流状态、最后订单更新时间、REST新鲜度、是否正在对账、未知订单数量和暂停原因。

## 13. 测试设计

### 13.1 订单状态机单元测试

- OPEN → FILLED；
- OPEN → CANCELLED；
- OPEN → PARTIAL → FILLED；
- OPEN → PARTIAL → CANCELLED；
- 重复终态；
- Fills重复和乱序；
- 累计成交量倒退、超量；
- 未知状态和非法字段。

### 13.2 适配器契约测试

使用 fake REST、fake WebSocket 和 fake 写客户端覆盖：

- mainnet校验、signer校验和市场白名单；
- 下单返回与立即成交竞态；
- 字符串订单ID和随机 client ID；
- nonce/写请求串行；
- 429、超时、有界重试；
- WebSocket断线后禁止下单；
- REST/WS重连合并；
- 撤单失败保留跟踪；
- 批量撤单写屏障；
- 平仓确认；
- 停机期间成交恢复；
- 无快照遗留订单/仓位熔断；
- paper模式不受影响。

### 13.3 回归与安全检查

- 现有完整 `npm test` 必须通过。
- 新增测试必须进入默认 `npm test`。
- 检查 `risex-client` 精确版本和锁文件。
- 运行依赖审计和安全差异复查。
- 验证日志和错误响应不包含密钥。

## 14. 验证命令

新增：

```bash
npm run risex:verify
```

无密钥、无写操作，检查 mainnet endpoint、chain/domain、BTC/ETH市场、行情和公共 WebSocket。

新增：

```bash
npm run risex:verify -- --private
```

由用户在 VPS 上执行，读取本地 `.env`，验证 signer 注册、私有 WebSocket、账户、挂单和仓位。该命令不得调用任何写接口。

## 15. 上线验收

自动实现阶段只执行单元测试、模拟集成测试和 mainnet 公共只读验证，不读取用户实盘密钥、不发送真实订单。

用户在独立小资金账户上完成：

1. 确认 BTC/ETH 无遗留挂单和仓位；
2. 运行私有只读验证；
3. 使用最小允许数量启动极小网格；
4. 在 RISEx 官网核对挂单数量、方向、价格和数量；
5. 验证一次真实成交和反向补单；
6. 验证撤单、平仓和重启接管；
7. 任一步状态不一致立即停止并保留日志。

## 16. 预期修改文件

- `package.json`
- `package-lock.json`
- `.env.example`
- `README.md`
- `src/config.js`
- `src/exchange/rs/index.js`
- `src/exchange/rs/risex.js`
- `src/exchange/rs/private-stream.js`（新增）
- `src/exchange/rs/order-state.js`（新增）
- `src/server.js`（仅健康状态/集成需要时）
- `public/index.html`（仅展示 RISEx live 状态所需的小改动）
- `test/exchange-adapters.test.js`
- `test/startup.test.js`
- RISEx 状态机、私有流和验证命令对应的新测试文件

## 17. 完成标准

- `RS_MODE=live` 只在完整 mainnet安全检查通过后启动。
- 仪表盘只展示 BTC-PERP、ETH-PERP。
- 没有任何“订单消失即成交”的路径。
- 部分成交按最终实际成交量处理，终态只触发一次补单。
- 断线、未知状态、撤单失败时不会继续扩大风险。
- 重启能接管已知挂单并恢复停机期间的终态成交。
- 所有自动测试、只读验证、依赖审计和安全差异复查通过。
- README 明确独立账户、mainnet风险和用户手动验收流程。

## 18. 2026-08-15 实盘复查修订

本节修订此前设计中对 `risex-client 0.1.11` 只读返回类型的假设。该版本的 TypeScript 类型和测试夹具仍描述旧接口，但客户端运行时不会转换 REST 字段；适配器必须以 RISEx 当前主网接口和官方前端实际消费的数据结构为准，不能继续依赖旧类型声明。

### 18.1 严格区分各只读接口的数据结构

`src/exchange/rs/normalize.js` 为不同来源保留独立解析器，不用宽松的通用兜底掩盖接口变化：

- REST 开放订单继续解析 `order_id`、数字 `side`、`price_ticks`、`size_steps` 和 `resting_order_id`。
- REST 历史订单及单笔订单解析 `id`、`BUY/SELL`、`created_at`、`block_number`、`log_index`；`price`、`size`、`filled_size`、`avg_price` 必须按当前主网实际返回的人类可读十进制字符串解析，不得按 WAD 缩放。
- REST 账户成交解析 `id`、`order_id`、`BUY/SELL`、普通十进制 `price/size/fee`、`time`，游标从 `blockchain_data.block_number/log_index` 读取。
- REST 全部仓位解析 `BUY/SELL`、`avg_entry_price` 以及接口定义的 18 位数值；单市场仓位如果方向仍为数字，只允许明确记录的 `0/1` 结构。未知字段组合必须抛错，不能猜测。
- 私有 Orders/Fills WebSocket 继续使用现有独立解析器，不与 REST 开放订单格式混用。

公共和私有只读验证必须复用同一套生产解析器，避免验证脚本显示成功而适配器实际无法读取仓位。

### 18.2 精确订单确认

单笔下单、撤单及批量撤单后的终态确认改用官方 `GET /v1/orders/by-id/{order_id}`：

- 请求必须带原始字符串订单 ID，禁止转为 `Number`。
- 正常响应必须通过历史订单解析器并校验返回 ID 与请求 ID 一致。
- 明确的未找到响应可以返回“尚未确认”；格式错误、网络错误和其他 HTTP 错误直接抛出。
- 不再扫描最近 100 条订单历史来推断某一订单状态。

### 18.3 批量撤单周期与延迟终态

全局 `_bulkCancel` 只承担写屏障，不再决定成交是否补单。批量撤单开始时捕获该市场所有受影响的已跟踪订单 ID，并把它们加入独立的“禁止补单订单集合”：

1. 批量撤单期间收到终态时，按真实成交记账，但 `suppressRequote=true`。
2. REST 开放订单归零后，逐个通过单笔订单接口确认受影响订单已经进入 `FILLED` 或 `CANCELLED`。
3. 状态机应用终态后才允许 `cancelAll()` 成功返回，避免内部记录停留在 `OPEN/PARTIAL`。
4. 延迟或重复 WebSocket 终态仍按订单 ID 保持禁止补单语义，直到状态机已确认并消费该终态。
5. 有界等待后仍无法确认任意订单时进入 `HALTED`，保留跟踪，不宣称撤单完成。

这样，停止网格、调整区间和启动前清理都不会因为消息晚于 REST 开放订单查询而重新挂出替代订单。

### 18.4 私有连接和认证超时

`RisexPrivateStream` 的以下边界使用明确的有界超时：

- WebSocket 建连及 `auth_v2` 完成；
- 首个 Orders snapshot 到达；
- EIP-712 domain 和服务端 nonce 的 HTTP GET。

HTTP 使用 `AbortController` 主动取消；WebSocket 和 snapshot 等待在超时后拒绝 promise、清理计时器和 socket/waiter，并输出不含密钥的阶段化错误。生产默认值固定在代码中，测试可以通过构造参数注入较短超时。超时不得自动切换 paper 或绕过对账。

### 18.5 回归测试与验收

新增测试必须先证明旧实现失败，再实现修复，并覆盖：

- 当前主网历史订单、账户成交、全部仓位和单市场仓位样例；
- 验证脚本使用与适配器相同的仓位解析；
- 单笔订单确认调用精确端点且保留字符串 ID；
- REST 已显示零挂单、WebSocket 终态延迟到达时不补单；
- 批量撤单只有在所有受影响订单终态确认后返回；
- connect、snapshot、domain 和 nonce 超时均明确失败并完成资源清理。

完成验收仍只运行模拟测试和主网公共只读验证，不读取用户私钥，不执行真实下单或撤单。

## 19. 2026-08-15 主网订单单位与紧急撤单修订

本节记录一次真实主网启动故障：已接受的 BTC 限价单通过 Orders 事件进入适配器时，主网实际返回 `size="0.004447"`、`price="61000"`，但解析器按照仍声称这些字段为 WAD 的文档示例执行缩放前校验，导致事件解析失败、适配器进入 `HALTED`。随后启动回滚调用批量撤单，又因 `HALTED` 写屏障被拒绝，形成需要人工处理的遗留挂单。

主网单笔订单与订单历史的只读回查已确认同一订单使用人类可读十进制字段。本设计以主网实际响应为运行契约，并保留严格的来源级解析，禁止根据字符串长度猜测 WAD 或十进制。

### 19.1 订单数据单位边界

- 私有 Orders WebSocket 的 `size`、`price`、`filled_size`、`avg_price` 按人类可读十进制字符串解析。
- REST 订单历史和 `GET /v1/orders/by-id/{order_id}` 使用相同的十进制订单字段规则。
- REST 开放订单仍只解析 `size_steps`、`price_ticks` 和市场步长，不与订单历史结构混用。
- REST 仓位继续使用其已验证的 WAD 字段规则；本修订不得顺带改变仓位单位。
- 不增加 WAD/十进制双模式自动识别。整数形式同样按该端点的十进制契约解释，后续由订单状态机的不可变价量校验发现跨来源不一致。
- 数值字段必须是有限的十进制字符串；缺失字段、数字类型、指数形式、负数量、负价格、超量成交和来源冲突都直接报错。

### 19.2 `HALTED` 紧急批量撤单

`HALTED` 继续阻止所有新增或改变风险的操作。唯一例外是已初始化 RISEx 客户端上的 `cancelAll(marketId)`，用于清理该白名单市场的遗留挂单：

1. 只允许 BTC-PERP 或 ETH-PERP 的已知 market ID。
2. 写入前先通过 REST 开放订单读取该市场真实挂单，并与本地已跟踪订单 ID 取并集；无法取得该快照时不发送盲目写入，明确要求人工处理。
3. 仍经过现有串行写队列、签名 permit 和批量撤单写屏障。
4. 不允许下单、设置杠杆、单笔平仓或任何替代挂单。
5. REST 开放订单必须归零，且写入前由 REST 或本地跟踪发现的每个订单必须通过单笔订单接口确认 `FILLED` 或 `CANCELLED`，才能返回成功；仅为确认紧急撤单而发现的外部订单不得被接管为网格订单。
6. 清理期间发生的真实成交照常记账，但必须携带 `suppressRequote=true`，禁止产生替代订单。
7. 撤单失败或终态无法确认时保留已有本地跟踪并明确报错。
8. 撤单成功后连接状态仍为 `HALTED`，不得自动恢复 `READY`；必须由用户检查账户后显式重连或重启并重新执行同步屏障。

该例外仅降低现有挂单风险，不把 `HALTED` 变成一般写入模式。

### 19.3 可观测性

- Orders 解析失败必须记录通道、消息类型、订单 ID、失败字段和值的类型；不得记录 signer、签名、permit 或完整认证报文。
- 紧急撤单日志必须明确标记“HALTED 紧急撤单”，记录 market ID、受影响订单数、每轮剩余开放订单数和未确认终态数。
- 启动回滚失败必须继续向上抛出原始解析原因和撤单原因，不能把两者折叠成模糊的“启动失败”。

### 19.4 测试与验收

回归测试必须先在旧实现上失败，并覆盖：

- Orders snapshot/update 对 `size="0.004447"`、`price="61000"`、`filled_size="0"`、`avg_price="0"` 的解析；
- REST 历史订单及精确订单查询使用相同十进制结构；
- 非字符串、指数形式和非法范围继续失败；
- `HALTED` 时 `cancelAll` 可以执行，但下单、杠杆和平仓仍被拒绝；
- 紧急撤单成功后仍为 `HALTED`，失败时保留跟踪；
- 延迟成交在紧急撤单期间只记账、不补单；
- 完整 `npm test` 和主网公共只读验证通过。

自动验收不得使用用户私钥或执行新的真实写入。用户在 VPS 更新后，应先确认交易所无遗留委托，再执行私有只读验证，最后仅用最小数量和低杠杆重新试单。
