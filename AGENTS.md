# AGENTS.md

本文件补充工作区根目录规则，并记录本项目当前不可违反的实盘事实。

## 当前产品边界

- Decibel、Extended 与 RISEx 支持 `paper` 和 `live`；RISEx live 只允许 mainnet 的 BTC-PERP / ETH-PERP。
- RISEx 私有 Orders/Fills WebSocket 与 REST 对账共同构成订单、成交和持仓的事实来源；禁止根据订单消失推测成交或自动撤销未知订单。
- RISEx mainnet 的签名 REST 请求字段为 `permit_params`，杠杆值使用 18 位 WAD；`risex-client` 固定版本的 `permit` 字段与主网不兼容，写操作必须经过本地 `mainnet-client.js` 兼容层。
- 禁止自动运行任何 RISEx 真实写入验证；真实账户验收必须由用户明确执行只读私有验证后，再人工使用最小资金操作。
- 下单、设置杠杆、撤单和平仓等关键动作只有在交易所明确确认成功后，才能推进本地状态。
- 崩溃恢复以持久化的市场名称为主键；旧 `marketId` 必须在恢复前重新解析，并等待首次挂单对账完成。
- `.env` 和 `.state.json` 在 POSIX 系统上必须使用仅所有者可读写的 `0600` 权限。
