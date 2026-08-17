# PopDEX 单笔下单写入探针设计

日期：2026-08-17

## 目标

在 PopDEX Mainnet 上实现一个独立、显式授权的单笔限价单闭环：Agent 签名下单、链上回执确认、官方订单身份确认、Agent 签名撤单和官方撤单终态确认。

本阶段只验证 PopDEX 写入协议，不把 PopDEX 注册到 `GridBot`，不增加网页下单按钮，也不开放自动网格。目标市场仍严格限制为 `BTCUSDT` 和 `ETHUSDT`。

## 已知事实与未决证据

现有只读验证已经确认：

- Mainnet `chainId=2184`（`0x888`）。
- Order 预编译地址为 `0x0000000000000000000000000000000000001000`。
- `placeOrder`、`cancelOrder` 的官方 ABI，以及调用方提供的 `clientOrderId`。
- `getActiveOrdersByAccount`、`getCompletedOrdersByAccount` 的官方 ABI；返回值包含完整 `clientOrderId`、官方 `orderId`、状态及成交/剩余/撤销量。
- 真实主账户的 Agent 已能按 Account 预编译状态完成授权回验。
- BTCUSDT/ETHUSDT 的官方市场身份、精度和最低名义金额。

静态证据尚未完整证明真实订单写入时 Agent 发送者、nonce、gas、`orderParams` 字段和 REST 订单映射的全部细节。实现前必须重新扫描并固定当前官方网页构建产物；无法从官方产物或链上模拟证明的字段不得猜测。最终协议事实由用户显式执行的一笔最低金额实盘测试确认。

## 方案

采用独立命令行写入探针，而不是直接接入网页或网格运行时。探针内部组件以后可以被正式 PopDEX 适配器复用，但本阶段与 exchange registry、`GridBot`、SSE、AI、Decibel 和 RISEx 保持隔离。

不采用以下方案：

- 不直接移植参考仓库的 `popdex-live.js`。该实现把交易哈希当订单标识，且 nonce、gas、订单状态和 Agent 发送模型未形成可靠闭环。
- 不复制浏览器 Bearer Token 或 `dy-token`。账户只读接口已经证明无需该凭据。
- 不直接替换 Extended。成交、仓位、平仓、恢复和补单尚未完成验收。

## 组件边界

新增或扩展以下组件：

- `src/exchange/px/order-codec.js`：纯函数形式验证订单输入、生成 `clientOrderId`、编码 `orderParams`、`placeOrder` 和 `cancelOrder` calldata。
- `src/exchange/px/trading-client.js`：验证链和 Agent 授权，构造并签署 legacy 交易，广播、等待回执并读取失败原因。只接受注入的 RPC、账户客户端和时钟，便于无网络测试。
- `src/exchange/px/rpc-client.js`：补充有界分页的链上活动/完成订单读取和按 `clientOrderId` 唯一匹配；所有订单 ID 和 WAD 数量保持字符串。现有 REST `account-client.js` 只作为交叉检查，不承担订单终态事实来源。
- `src/exchange/px/write-probe.js`：解析命令行参数，执行 dry-run 或一次下单—撤单闭环，并维护安全恢复记录。
- `test/popdex-order-codec.test.js`、`test/popdex-trading-client.test.js`、`test/popdex-write-probe.test.js`：覆盖纯编码、写入边界和命令编排。

`rpc-client.js` 继续作为 JSON-RPC 边界，但写方法必须显式注入允许列表；现有只读验证器仍拒绝任何写方法，不能因本阶段而放宽。

## 命令与输入

命令默认只做 dry-run：

```bash
npm run popdex:write-probe -- --symbol BTCUSDT --side buy --price 60000 --qty 0.0002
```

只有同时满足以下条件才允许广播：

- 命令包含 `--confirm-mainnet-write`。
- `.env` 中存在 `POPDEX_MAIN_ACCOUNT` 和 `POPDEX_AGENT_PRIVATE_KEY`。
- 链上 Agent 存在、未过期、delegator 与主账户一致且 `isGlobal=false`。
- 市场是 BTCUSDT 或 ETHUSDT，官方市场身份与固定预期一致。
- 价格和数量严格对齐 tick/lot，数量不低于 `minQty`，名义金额不低于 10 USDT。
- 买单价格低于当前 best bid，或卖单价格高于当前 best ask；探针拒绝可能立即吃单的价格。

探针仅支持限价、非 reduce-only、单向测试单。用户必须显式提供价格和数量，代码不自动选择交易方向或价格。

## 下单数据流

1. 加载安全的 `.env`，派生 Agent 地址，但不输出私钥。
2. 验证官方 chainId、市场身份、最新盘口和 Agent 授权。
3. 生成不可重复的 bytes32 `clientOrderId`，并把阶段 `PREPARED` 原子写入仅所有者可读写的恢复文件。
4. 使用当前官方网页产物验证过的格式编码 `placeOrder`。
5. 在广播前执行只读模拟；模拟失败时不广播。
6. Agent 签名并在广播前保存可由签名交易确定计算的 `txHash` 和阶段 `BROADCAST`。
7. 只广播一次并核对 RPC 返回的交易哈希；不对不确定结果自动重试，随后等待成功回执。
8. 有界轮询 Order 预编译的 `getActiveOrdersByAccount`，按完整 `clientOrderId` 找到唯一官方订单。
9. 严格核对主账户、市场、方向、价格、数量和官方字符串 `orderId`，然后记录 `OPEN_CONFIRMED`。

交易哈希只表示链上交易，不得作为订单 ID。成功回执后如果找不到唯一官方订单，探针保留恢复记录并非零退出，禁止再次下单。

## 撤单数据流

1. 使用确认过的官方 `orderId` 和原始 `clientOrderId` 编码 `cancelOrder`。
2. 广播前模拟，Agent 签名后只广播一次。
3. 等待成功回执并记录 `CANCEL_BROADCAST`。
4. 有界轮询 Order 预编译的活动订单和完成订单，确认该订单离开活动集合、进入完成集合，且 `filledQty=0`、`cancelledQty=qty`、`remainingQty=0`。
5. 记录 `CANCEL_CONFIRMED`，随后删除恢复文件。

如果订单从活动集合消失但没有出现在完成集合，不能视为撤单成功。如果完成订单出现任何成交数量，探针立即停止、保留记录并要求用户人工处理仓位；本阶段不自动平仓。

## nonce、gas 与广播规则

实现只能采用当前官方网页产物可以定位到的 Agent 交易格式。nonce、交易类型、gas 和 gasPrice 必须被协议证据和测试向量固定：

- 禁止使用普通 EVM `eth_getTransactionCount` 代替 PopDEX 自定义 nonce，除非官方代码明确如此。
- 禁止在未知提交结果后递增 nonce 并重试。
- 禁止静默改变 gas 或交易类型来绕过失败。
- RPC 错误必须保留方法、阶段、错误码和脱敏后的底层原因。

如果当前官方构建无法证明订单交易格式，开发停在 dry-run 编码和模拟阶段，并明确报告缺失证据，不能开放广播。

## 恢复记录与可观测性

恢复文件固定为 `.popdex-write-probe.json`，使用原子写入并在 POSIX 上保持 `0600`。它只保存：

- 阶段。
- symbol、side、price、qty。
- `clientOrderId`、官方 `orderId`（确认后）。
- 下单和撤单交易哈希。
- 最后更新时间和脱敏错误摘要。

不保存 Agent 私钥、签名原文、原始交易或钱包认证数据。探针启动时若发现未完成记录，必须拒绝新下单并进入只读恢复检查，显示下一步人工操作，不自动重发或撤单。

日志必须为每个阶段输出单行事件，包含 symbol、`clientOrderId`、阶段和耗时；主账户和 Agent 地址仅显示首尾片段。

## 错误边界

- Agent 授权、市场身份、精度、名义金额或盘口保护不满足：广播前失败。
- 模拟失败：广播前失败，并显示官方错误原因。
- 广播明确失败：记录失败并退出，不重试。
- 广播结果不确定：保留恢复记录，拒绝任何新写入。
- 回执失败或超时：保留交易哈希，拒绝自动重发。
- 回执成功但订单无法唯一映射：保留记录并停止。
- 撤单回执成功但终态不可验证：保留记录并停止。
- 订单发生部分或完整成交：停止并提示人工检查持仓。

任何异常都不得被转换为空订单、成功撤单或可继续状态。

## 测试

自动测试不得连接主网或签署真实资金交易，至少覆盖：

- 两个白名单市场和所有非白名单市场。
- tick、lot、`minQty`、最低名义金额和盘口外价格保护。
- bytes32 `clientOrderId` 唯一性、长度和往返解码。
- `placeOrder`/`cancelOrder` 的固定 ABI 向量与 `orderParams` 字节向量。
- Agent 与主账户关系、授权过期、delegator 冲突和 global 授权拒绝。
- 模拟、广播、回执失败与超时。
- 成功回执后通过链上活动订单分页完成唯一订单映射，以及零个/多个/字段冲突的拒绝。
- 撤单终态、订单消失但无终态、部分成交和完整成交。
- 恢复文件权限、原子写入、未完成记录阻止新订单。
- 日志不包含私钥、签名和原始交易。
- 现有 PopDEX 只读验证仍调用零个写方法。
- Decibel、RISEx、Bot、持久化、安全和 Agent 授权测试全部无回归。

## 主网验收

自动测试通过后，由用户在 VPS 人工执行：

1. 再次运行 PopDEX 公共和账户只读验证。
2. 运行 dry-run，检查链、Agent、精度和盘口保护。
3. 选择 BTCUSDT 盘口外最低名义金额限价单，加入 `--confirm-mainnet-write`。
4. 在 PopDEX 网页确认订单短暂出现，并确认探针撤单后消失。
5. 核对探针输出的 `clientOrderId`、官方 `orderId` 和交易状态。
6. BTC 闭环稳定通过后，使用 ETHUSDT 重复一次。

探针不会由自动测试或服务启动流程触发真实写入。任何实盘验收失败都必须先解决根因，不能继续开发自动网格。

## 完成标准

- dry-run 默认安全且不会广播。
- 显式实盘命令能完成一次订单提交、官方身份确认、撤单和官方终态确认。
- 不确定结果和意外成交均可追溯且不会自动重试。
- 全量测试通过，Decibel、RISEx 和现有 PopDEX Agent 功能无回归。
- BTCUSDT 与 ETHUSDT 各完成一笔用户批准的最小金额主网验收。
- 本阶段仍不显示 PopDEX 网格启动入口。
