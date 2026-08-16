# AGENTS.md

本文件补充工作区根目录规则，并记录本项目当前不可违反的实盘事实。

## 当前产品边界

- Decibel、Extended 与 RISEx 支持 `paper` 和 `live`；RISEx live 只允许 mainnet 的 BTC-PERP / ETH-PERP。
- PopDEX 仍处于只读协议验证阶段，尚未注册为可运行交易所；目标市场仅限 BTCUSDT / ETHUSDT。PopDEX `/overview` 只用于账户概览，持仓事实必须从订单预编译合约 `0x0000000000000000000000000000000000001000` 的只读方法 `getOpenPositionsByAccount` 获取，禁止猜测 overview 内含 `positions`。
- RISEx 私有 Orders/Fills WebSocket 与 REST 对账共同构成订单、成交和持仓的事实来源。
- RISEx Orders WebSocket、订单历史和单笔订单接口的价量字段按当前主网人类可读十进制字符串解析；开放订单仍按 ticks/steps，仓位仍按已验证的 WAD 结构，禁止按字符串长度猜单位。
- RISEx Orders/Fills WebSocket 游标优先使用 `block_timestamp`，其次使用服务端 `timestamp`；顶层时间缺失或为空时才使用订单 `created_at` / 成交 `time`，所有候选缺失或非法必须进入 `HALTED`，禁止填 `0` 或本地时间。
- RISEx 持仓缓存、杠杆回读和平仓确认统一使用 `/v1/positions` 全持仓接口；禁止把 `/v1/account/position` 的单市场返回交给全持仓 WAD 解析器。
- RISEx `/v1/positions` 的 `mark_price` / `unrealized_pnl` 是可选估值字段；缺失时必须使用同轮官方盘口价（启动对账可使用刚读取的官方市场价）计算浮盈并记录一次来源切换，禁止因此中断订单管理，也禁止填 `0`。仓位大小、方向和开仓均价仍须严格解析。
- 禁止根据订单消失推测成交或在正常状态自动撤销未知订单；唯一例外是用户已批准的 RISEx `HALTED` 紧急 `cancelAll`，它必须经过 REST 前置快照和逐单终态确认。成功后仍保持 `HALTED`，其他写操作继续禁止。
- RISEx mainnet 的订单写接口（place/cancel/cancel-all）使用 `permit`，账户参数接口（目前 leverage）使用 `permit_params`；杠杆动作哈希必须包含 `RISE_PERPS_UPDATE_LEVERAGE_V1` 类型哈希并按 `uint16/uint8` 编码，permit 必须使用链上状态的下一 `nonce_anchor`。`risex-client 0.1.11` 的杠杆字段、杠杆编码和 nonce 行为与当前主网不兼容，写操作必须经过本地 `mainnet-client.js` 兼容层。
- 禁止自动运行任何 RISEx 真实写入验证；真实账户验收必须由用户明确执行只读私有验证后，再人工使用最小资金操作。
- 下单、设置杠杆、撤单和平仓等关键动作只有在交易所明确确认成功后，才能推进本地状态。
- 网格补单只能由交易所明确确认的终态成交驱动；相邻终态订单必须先从活动层腾空，再串行确认反向替代单，完成后才能持久化。禁止按配置挂单总数盲目补单或静默丢弃同层在途补单。
- RISEx 定时只读刷新只允许在 `READY` 状态执行；`RECONCILING`/`HALTED` 期间应记录跳过，不得把状态机拒绝记作 REST 刷新故障。
- GitHub 发布统一使用已登录的 GitHub CLI；需要联网的认证、推送和 PR 命令在受限沙箱外执行，避免网络限制导致认证误判。
- 崩溃恢复以持久化的市场名称为主键；旧 `marketId` 必须在恢复前重新解析，并等待首次挂单对账完成。
- `.env` 和 `.state.json` 在 POSIX 系统上必须使用仅所有者可读写的 `0600` 权限。
