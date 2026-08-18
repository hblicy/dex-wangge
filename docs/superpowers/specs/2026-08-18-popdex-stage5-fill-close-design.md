# PopDEX 第 5 阶段成交与平仓闭环设计

日期：2026-08-18

## 目标

在 PopDEX Mainnet 上完成第 5 阶段剩余验收：BTCUSDT 杠杆设置与回读、最小买入成交、剩余委托撤销、仓位确认以及整仓平仓。

本阶段只实现独立探针，不把 PopDEX 注册到 `GridBot`，不开放网页网格，不实现 `IExchange` 或 Paper 模式。Decibel、RISEx 和现有 PopDEX 单笔下单撤单探针必须保持原有行为。

开发和自动测试不得执行真实交易。主网写入必须等代码和测试完成后，由用户另行明确批准。

## 已确认协议事实

当前 PopDEX 官方网页构建产物和现有只读客户端已确认：

- Mainnet `chainId=2184`，BTCUSDT `symbolId=20000`。
- UserConfig 预编译地址为 `0x0000000000000000000000000000000000001009`；官方界面以该地址配合 UserConfig ABI 调用 `updatePositionMode`。
- 账户配置通过 `getAccountConfig(account)` 读取，其中 `symbolLeverages` 包含 `symbolId:uint16` 和 `leverage:uint8`。
- 杠杆写入接口为 `updateLeverage(account, request)`；BTC 合约请求固定使用 `newLeverage=1`、`symbolId=20000`、`category=Futures(2)` 和零地址 `tokenAddress`。官方枚举明确为 `Spot=0`、`Margin=1`、`Futures=2`；订单类别 `Regular=0` 是另一枚举，禁止混用。
- `LeverageUpdated` 事件包含账户、市场、杠杆、`succeeded` 和 `code`，可用于回执核验。
- 平仓接口为 `placeReverseOrder(account, symbolId, positionSide)`；`PositionSide.Long=1`、`PositionSide.Short=2`。
- 官方仓位分页包含 `symbolId`、`side`、`holdSizeWad`、`closeSizeWad` 和 `lockedSizeWad`，所有大整数必须以字符串处理。
- 已验收的 Agent 签名、写 RPC、订单回执、订单分页和恢复机制可以作为底层能力复用。

官方 ABI 声明部分写方法返回 `bool`，但 PopDEX Order 预编译的真实成功模拟曾返回精确空数据 `0x`。新写方法必须按真实主网模拟结果和回执验证，禁止未经证据强制解码 `bool`，也禁止把空结果直接当作完整业务成功。

## 固定安全边界

- 市场只允许 BTCUSDT。
- 杠杆固定为 1x；拒绝任何其他杠杆参数。
- 方向固定为买入开多；拒绝卖出开空。
- 数量固定为满足 lot、`minQty` 和最低名义价值的最小可交易量。
- 成交限价不高于最新 best ask 加 `0.3%`，然后按 BTC tick 向上对齐。
- 不追价、不重试下单、不重复平仓。
- 探针结束后 BTCUSDT 杠杆保持 1x，不恢复原杠杆。
- 实盘完整探针的一次明确授权覆盖最小开仓和紧接其后的首次整仓平仓；进程重启后不继承写授权。
- 启动前必须确认 BTCUSDT 无活动订单、无持仓、Agent 有效且保证金足够；账户 `positionMode` 必须是官方界面映射的 `OneWay=0`，本探针不得修改持仓模式。

任何前置条件不满足都必须在广播前失败。

## 组件边界

新增独立命令：

```bash
npm run popdex:fill-close-probe
```

组件职责：

- 扩展 `src/exchange/px/order-codec.js` 或新增同层纯编码模块，支持 `getAccountConfig`、`updateLeverage` 和 `placeReverseOrder` 的固定 ABI 编码与严格结果校验。
- 扩展 `src/exchange/px/rpc-client.js`，提供账户配置回读及严格、完整的 BTC 仓位分页读取。
- 扩展 `src/exchange/px/trading-client.js`，复用已有 Agent 验证、模拟、签名、单次广播和回执读取能力。
- 新增独立探针编排文件，负责预检、杠杆、入场、撤销剩余委托、仓位核验和平仓。
- 新增独立恢复记录 `.popdex-fill-close-probe.json`，不得复用或覆盖 `.popdex-write-probe.json`。

探针不得接入 exchange registry、`GridBot`、SSE、网页按钮、AI 逻辑或服务启动流程。

## Dry-run

默认命令只执行只读检查和编码：

1. 校验 chainId、主账户、Agent 授权和 BTC 市场身份。
2. 读取账户配置、盘口、保证金、活动订单和完整仓位分页。
3. 计算 1x 杠杆请求、最小数量、价格上限和全部 calldata。
4. 仅执行不会改变状态的模拟，不签名、不广播、不创建恢复记录。
5. 输出脱敏地址、价格、数量、名义价值、当前/目标杠杆和 calldata hash。

只有专用参数 `--confirm-mainnet-fill-close` 才能进入完整写入流程，不能与现有 `--confirm-mainnet-write` 混用，以避免误操作。恢复剩余委托只能使用 `--resume --confirm-mainnet-cancel`，恢复已有仓位只能使用 `--resume --confirm-mainnet-close`。

## 杠杆流程

1. 从 `getAccountConfig(account).symbolLeverages` 匹配 `symbolId=20000`；空匹配表示该市场尚无显式杠杆配置，不能假定为 1x，必须进入固定 1x 写入流程；重复匹配仍视为无效事实。
2. 若已为 1x，不发送杠杆交易，直接记录 `LEVERAGE_CONFIRMED`。
3. 若不是 1x，构造固定 BTC 合约杠杆请求并先模拟。
4. 广播前持久化可确定的交易哈希和 `LEVERAGE_BROADCAST` 阶段，只广播一次。
5. 要求交易回执成功，并严格解析唯一匹配的 `LeverageUpdated`：账户、category、symbolId、newLeverage 均一致，`succeeded=true` 且 `code=0`。
6. 再次调用 `getAccountConfig`，确认 BTCUSDT 回读为 1x 后才进入下一阶段。

事件和回读任一不一致都视为失败，禁止继续下单。

## 入场计算与下单

1. 读取最新 best ask、tick、lot、`minQty` 和 `minNotional`。
2. 数量取 `max(minQty, ceil(minNotional / bestAsk, lot))`，最终再次验证名义价值不低于最低要求。
3. 限价取 `ceil(bestAsk * 1.003, tick)`；超出该保护边界的输入一律拒绝。
4. 订单固定为 BTCUSDT、Buy、Regular、Limit、GTC、非 reduce-only、Net position。
5. 使用新的、可追踪的 bytes32 `clientOrderId`；广播前先模拟并保存 `ENTRY_BROADCAST`。
6. Agent 只签名和广播一次，RPC 返回的交易哈希必须与本地签名交易哈希一致。
7. 通过成功回执、活动/完成订单分页、成交分页和仓位分页共同确认订单事实，交易哈希不能充当订单 ID。

有界等待结束后：

- 全部成交：进入仓位确认。
- 部分成交：立即进入剩余委托撤销流程，只处理实际成交形成的仓位。
- 零成交：撤销活动委托并安全退出，本次验收结果为 `zero-fill-cleared`，不视为闭环成功，也不重新下单。
- 无法唯一确定订单或成交事实：保留记录并停止。

## 剩余委托撤销

部分成交或零成交且订单仍活动时，使用已确认的官方 `orderId` 和原始 `clientOrderId` 调用 `cancelOrder`：

1. 模拟、记录 `REMAINDER_CANCEL_BROADCAST`、签名并只广播一次。
2. 要求回执成功。
3. 通过活动订单分页证明该订单已消失，通过完成订单或撤单回执证明剩余量已撤销。
4. 核对 `filledQty + cancelledQty = qty` 且 `remainingQty=0`。

任何数量关系不成立都必须停止。撤单完成前不得发送平仓交易。

## 仓位确认与平仓

存在实际成交时，必须从完整仓位分页唯一确认：

- 仅有一个 BTCUSDT 多仓；
- `side=Long(1)`；
- 有效持仓量为正；
- 没有 BTCUSDT 空仓；
- 没有 BTCUSDT 活动订单；
- 仓位数量与本次订单已成交数量一致。

满足条件后记录 `POSITION_CONFIRMED`，调用官方：

```text
placeReverseOrder(mainAccount, 20000, Long=1)
```

平仓步骤：

1. 先模拟，无法证明成功则不广播。
2. 广播前保存交易哈希和 `CLOSE_BROADCAST`，只广播一次。
3. 要求交易回执成功。
4. 有界轮询完整仓位分页和活动订单分页。
5. 只有同时确认 BTC 持仓为零、没有反向空仓、没有 BTC 活动订单，才能记录 `COMPLETED`。

若平仓后仍有残余或反向仓位，探针不得再次自动平仓，必须保留恢复记录并要求人工处理。

## 状态机与恢复

状态固定为：

```text
PREPARED
LEVERAGE_BROADCAST
LEVERAGE_CONFIRMED
ENTRY_BROADCAST
ENTRY_SETTLING
REMAINDER_CANCEL_BROADCAST
POSITION_CONFIRMED
CLOSE_BROADCAST
COMPLETED
```

恢复文件使用原子写入，并在 POSIX 上保持 `0600`。至少保存：

- schema 版本和当前阶段；
- symbol、symbolId、杠杆、价格、数量；
- 主账户和 Agent 地址；
- `clientOrderId`、官方 `orderId`；
- 杠杆、入场、撤单和平仓交易哈希；
- 已确认成交量、仓位 ID、方向和数量；
- 最后查询到的活动订单数、仓位数、更新时间和脱敏错误摘要。

不得保存私钥、签名、原始签名交易或钱包认证数据。

普通 `--resume` 永远只读：

- 有交易哈希时恢复该交易的回执和业务事实，禁止重新广播。
- 有活动剩余委托时报告需要独立恢复撤单授权。
- 已有多仓但没有平仓交易时报告需要独立恢复平仓授权。
- 已有平仓交易时只恢复其回执和最终仓位事实。
- 状态冲突或事实不完整时保留记录并停止。

若中断发生在入场交易广播之前，或入场交易已有精确失败回执，普通 `--resume` 可以在完整证明 BTC 活动订单为零、成交为零、持仓为零后，把结果记为 `safe-no-exposure` 并清除记录。该结果只表示没有资金暴露，不得计为第 5 阶段闭环通过，也不得自动继续下单。

恢复撤单和恢复平仓必须使用不同的显式参数。进程重启后，原实盘确认参数不能被视为继续写入授权。

只有最终确认 BTC 持仓为零、反向仓位为零、活动订单为零后，才可输出 `completed-flat` 并清除记录。`zero-fill-cleared` 和 `safe-no-exposure` 可以安全清除记录，但不计为第 5 阶段闭环验收通过。

## 错误边界与可观测性

- 字段缺失、类型不符、非安全整数或分页不完整：立即失败。
- 模拟失败：广播前失败。
- 广播明确失败：记录并退出，不重试。
- 广播结果不确定、回执失败或超时：保留交易哈希，不重发。
- 订单、成交和仓位来源互相冲突：保留全部非敏感事实并停止。
- 杠杆事件成功但回读不一致：禁止下单。
- 平仓回执成功但仓位未归零：禁止宣称成功。

日志必须记录阶段变化、耗时、脱敏账户、市场、价格、数量、交易哈希、订单 ID、成交量、仓位方向/数量以及每轮查询计数。RPC 错误保留方法、错误码和脱敏后的原始原因。

禁止用空数组、零仓位或成功状态兜底接口异常；禁止吞掉错误。

## 自动化测试

自动测试不得连接主网或执行真实签名广播，至少覆盖：

- `getAccountConfig`、`updateLeverage`、`LeverageUpdated` 和 `placeReverseOrder` 固定 ABI 向量。
- Category、PositionSide、symbolId 和 1x 杠杆的允许值及拒绝值。
- tick、lot、`minQty`、最低名义价值和 `0.3%` 价格保护。
- 已为 1x、杠杆设置成功、事件失败、回读不一致。
- 全部成交、部分成交、零成交和订单事实不唯一。
- 剩余委托撤销成功、超时及数量关系冲突。
- 唯一多仓确认、残余仓位、意外空仓和平仓后反向仓位。
- 每个广播阶段中断后的只读恢复，以及恢复命令不自动写入。
- 恢复文件权限、原子写入和敏感数据禁止项。
- REST/RPC 字段缺失时必须失败。
- 现有 PopDEX 下单撤单探针、只读验证、Agent 授权、Decibel、RISEx、GridBot、持久化和安全测试全部无回归。

## VPS 主网验收

自动化测试全部通过后，由用户另行批准并在 VPS 人工执行：

1. 运行 PopDEX 公共和账户只读验证。
2. 确认网页中 BTCUSDT 活动订单为 0、持仓为 0。
3. 运行新探针 dry-run，核对 BTCUSDT、1x、最小数量、价格上限和 Agent。
4. 用户明确批准后，执行一次完整实盘探针。
5. 核对最终输出 `completed-flat`。
6. 再次运行账户只读验证，并在网页确认 BTCUSDT 杠杆 1x、活动订单 0、持仓 0、没有反向空仓。

若出现中断，只能先运行普通 `--resume` 读取事实，再由用户根据输出单独批准恢复撤单或恢复平仓。

## 完成标准

- 默认 dry-run 不签名、不广播、不写恢复记录。
- 1x 杠杆事件和回读形成闭环。
- 一笔最小 BTCUSDT 买入的订单、成交和仓位事实可唯一追踪。
- 部分成交的剩余委托能够安全撤销。
- `placeReverseOrder` 平仓后能够严格证明无订单、无多仓、无空仓。
- 任意中断阶段都不会自动重复交易。
- 全量测试通过，Decibel、RISEx 和现有 PopDEX 功能无回归。
- 用户批准的主网测试最终输出 `completed-flat`。

达到以上标准后，才进入第 6 阶段 `IExchange` 适配器和 Paper 模式；本阶段不得提前开放 PopDEX 网格。
