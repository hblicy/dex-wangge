# PopDEX 官方只减仓市价平仓修正设计

日期：2026-08-18

## 背景与结论

Stage 5 原设计把链上仓位返回的 `side=Long(1)` 直接传给
`placeReverseOrder(account, 20000, 1)`。真实主网交易
`0x3e921b685c9268015c152637d2c961abf3850449cbc9a5fefa5955474175bbda`
以 `[15200] Invalid position side` 失败，BTCUSDT 多仓未平。

用户随后通过 PopDEX 官方网页成功平仓。成功交易
`0xbb8f28e0cbef74faa8d706676ec6ad93c89196d6440cc4ac8d46c362c8b91e50`
的官方 RPC 事实为：

- `chainId=2184`，回执 `status=0x1`；
- 目标为 Order 预编译 `0x0000000000000000000000000000000000001000`；
- 方法选择器为 `0x0f05a9d9`，即
  `placeOrder(address,bytes32,uint16,bytes32,uint256,uint256,uint256,address,uint256)`；
- `account` 为主账户，`symbolId=20000`；
- `clientOrderId` 解码为 `web-1787034309231`；
- `orderParams=0x0201010000000100000000000000000000000000000000000000000000000000`；
- `price=0`；
- `qty=200000000000000 WAD`，即 `0.0002 BTC`；
- `slippage=30000000000000000 WAD`，即 `3%`；
- `builder` 为零地址，`builderFeeRate=0`；
- 发送方是官方网页临时 Agent `0x20f1…6a65`，不是 Bot Agent；
- 交易完成后官方只读验证为 BTCUSDT 活动订单 `0`、链上持仓 `0`。

`orderParams` 的有效字节为：

```text
[2, 1, 1, 0, 0, 0, 1, 0]
```

对应已验证的平仓意图为 Futures、Market、Sell、ReduceOnly、OneWay/Net。
因此根因不是单独一个枚举值错误，而是原设计选错了平仓原语。修复必须删除
Stage 5 对 `placeReverseOrder` 的调用，改为复刻官方网页的只减仓市价
`placeOrder`。

## 产品边界

本次只修复独立 `popdex:fill-close-probe` 的最终清仓路径，不把 PopDEX
注册到 `GridBot`，不增加服务器或网页交易路由，也不实现 `IExchange`。

未来正式网格仍使用 `LIMIT + GTC` 限价单：初始挂单、成交后的反向补单和
正常网格减仓都不得使用本次市价平仓编码。`MARKET + ReduceOnly + Net + 3%`
只允许用于：

1. Stage 5 最小成交平仓验收；
2. 用户明确执行“停止、撤单并平仓”的最终清仓；
3. 未来另行设计并批准的紧急风险平仓。

本次不修改 Decibel、RISEx、PopDEX 普通限价下单撤单探针或现有
`encodeOrderParams(side)`。

## 平仓编码

新增独立的 PopDEX 只减仓市价编码函数，禁止复用或改变普通网格限价参数编码。
调用参数固定为：

```text
placeOrder(
  account          = mainAccount,
  clientOrderId    = 独立且确定的平仓订单标识,
  symbolId         = 20000,
  orderParams      = 0x0201010000000100...,
  price            = 0,
  qty              = 已确认的精确 BTCUSDT 多仓 WAD 数量,
  slippage         = 0.03 WAD,
  builder          = 0x0000000000000000000000000000000000000000,
  builderFeeRate   = 0
)
```

平仓 `clientOrderId` 继续遵守 PopDEX 已验证的受限 UTF-8 字符集，使用独立
`dw-bc-` 前缀和小写十六进制熵，不得复用入场订单 ID。数量必须来自平仓前最新
链上唯一 BTCUSDT Long 持仓，并与 journal 中已确认的仓位量完全一致；禁止从
配置、初始计划或浮点数重新推导。

## 写入前条件

广播前必须重新完成以下检查，任一失败立即终止且不创建写客户端：

- Chain ID 精确为 `2184`；
- 主账户与 journal 一致；
- Bot 临时 Agent 授权有效且 delegator 为主账户；
- BTCUSDT 活动订单为 `0`；
- 链上只有一个 BTCUSDT `Long=1` 非零仓位；
- 持仓量与 journal 的 `positionQtyWad` 完全一致；
- 市场、方向、滑点、builder 和费用参数均为上述固定值。

交易仍通过现有唯一的 `write-rpc-client.js` 边界签名和广播。必须在发送前将
确定性交易哈希、`closeClientOrderId`、数量和固定参数持久化；链上
`closeOrderId` 只能在成功回执中取得。RPC 不确定结果或进程崩溃后禁止重新生成
或自动发送第二笔平仓。

## Journal 与恢复状态机

`.popdex-fill-close-probe.json` 增加以下平仓事实：

- `closeClientOrderId`
- `closeOrderId`
- `closeQtyWad`
- `closeTxHash`

平仓路径调整为：

```text
POSITION_CONFIRMED
  -> CLOSE_BROADCAST
  -> CLOSE_SETTLING
  -> COMPLETED
```

`CLOSE_BROADCAST` 表示平仓交易哈希已在广播前持久化。普通只读 `--resume`
取得成功回执后，必须解析唯一且完全匹配的 `OrderCreate`，保存
`closeOrderId` 后进入 `CLOSE_SETTLING`。回执失败时不得重试；如果用户已经通过
官方网页人工平仓，只有在官方只读事实同时证明 BTCUSDT 活动订单为 `0`、所有
BTCUSDT 持仓为 `0` 后，才允许标记人工完成并清理 journal。

`CLOSE_SETTLING` 必须以 `closeOrderId`、`closeClientOrderId`、BTCUSDT 和 Sell
方向严格匹配成交记录，不能使用账户级总成交数。只有以下事实同时成立才能进入
`COMPLETED`：

- 平仓单累计成交数量等于 `closeQtyWad`；
- BTCUSDT 活动订单为 `0`；
- 链上 BTCUSDT Long/Short/Net 非零持仓均不存在。

如果出现部分成交、活动残单、成交身份冲突、回执异常或有界等待超时，保留
journal，输出交易哈希、订单 ID、已成交量、剩余持仓量和当前阶段，停止所有后续
写入且禁止自动补发。恢复撤单仍沿用独立且明确批准的现有边界，不因本设计扩大。

## CLI 安全边界

默认 `npm run popdex:fill-close-probe` 和普通 `--resume` 始终只读，不得创建
写客户端。完整主网探针仍只能由唯一显式参数 `--confirm-mainnet-fill-close`
触发；恢复阶段的任何写入仍要求独立显式参数。已有 `closeTxHash` 时所有写模式
必须拒绝，用户只能运行普通只读 `--resume`。

实现和离线验证期间保持当前主网平仓写入口禁用。只有精确官方 calldata 向量、
状态机、崩溃恢复和全量回归测试通过并完成代码审核后，才恢复显式写参数；是否
实际运行下一次主网探针仍由用户单独决定。

## 测试与验收

测试必须先失败后实现，并至少覆盖：

1. 成功交易的 `placeOrder` calldata 逐字节向量，包括固定
   `orderParams`、`price=0`、精确数量和 `slippage=3%`；
2. Stage 5 代码不再生成或广播 `placeReverseOrder`；
3. 普通限价 `encodeOrderParams` 和现有下单撤单向量完全不变；
4. 平仓前错误账户、失效 Agent、活动订单、空仓、双向仓位和数量不一致均在
   签名前失败；
5. 回执必须包含唯一且匹配的 `OrderCreate`，并把 `closeOrderId` 持久化；
6. 完全成交且最终空仓才能完成；部分成交、残单、残余仓位和超时均保留 journal；
7. 每个广播阶段崩溃后普通 `--resume` 只读且不重复发送；
8. 已失败 Reverse Order 在人工平仓并确认空仓后安全清理；
9. 安全隔离测试继续证明服务器、网页、`GridBot`、Decibel 和 RISEx 不导入
   PopDEX 写交易实现；
10. 项目完整测试通过，且文档和 `AGENTS.md` 同步为新的协议事实。

主网最终验收只接受以下证据：Bot Agent 发出的唯一市价只减仓交易回执成功、
回执和 REST 成交身份一致、BTCUSDT 活动订单为 `0`、链上持仓为 `0`。交易哈希
本身不能代替订单或仓位事实。
