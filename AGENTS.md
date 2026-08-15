# AGENTS.md

本文件补充工作区根目录规则，并记录本项目当前不可违反的实盘事实。

## 当前产品边界

- Decibel、Extended 与 RISEx 支持 `paper` 和 `live`；RISEx live 只允许 mainnet 的 BTC-PERP / ETH-PERP。
- RISEx 私有 Orders/Fills WebSocket 与 REST 对账共同构成订单、成交和持仓的事实来源；禁止根据订单消失推测成交或自动撤销未知订单。
- RISEx mainnet 的订单写接口（place/cancel/cancel-all）使用 `permit`，账户参数接口（目前 leverage）使用 `permit_params`；杠杆动作哈希必须包含 `RISE_PERPS_UPDATE_LEVERAGE_V1` 类型哈希并按 `uint16/uint8` 编码，permit 必须使用链上状态的下一 `nonce_anchor`。`risex-client 0.1.11` 的杠杆字段、杠杆编码和 nonce 行为与当前主网不兼容，写操作必须经过本地 `mainnet-client.js` 兼容层。
- 禁止自动运行任何 RISEx 真实写入验证；真实账户验收必须由用户明确执行只读私有验证后，再人工使用最小资金操作。
- 下单、设置杠杆、撤单和平仓等关键动作只有在交易所明确确认成功后，才能推进本地状态。
- RISEx 定时只读刷新只允许在 `READY` 状态执行；`RECONCILING`/`HALTED` 期间应记录跳过，不得把状态机拒绝记作 REST 刷新故障。
- GitHub 发布统一使用已登录的 GitHub CLI；需要联网的认证、推送和 PR 命令在受限沙箱外执行，避免网络限制导致认证误判。
- 崩溃恢复以持久化的市场名称为主键；旧 `marketId` 必须在恢复前重新解析，并等待首次挂单对账完成。
- `.env` 和 `.state.json` 在 POSIX 系统上必须使用仅所有者可读写的 `0600` 权限。
