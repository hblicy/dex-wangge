# AGENTS.md

本文件补充工作区根目录规则，并记录本项目当前不可违反的实盘事实。

## 当前产品边界

- Decibel、Extended 与 RISEx 支持 `paper` 和 `live`；RISEx live 只允许 mainnet 的 BTC-PERP / ETH-PERP。
- PopDEX 处于“只读验证 + 独立临时 Agent 授权 + 显式 CLI 单笔探针”阶段；普通下单撤单探针允许 BTCUSDT / ETHUSDT，第 5 阶段成交平仓探针只允许 BTCUSDT、Buy/Long、OneWay、1x。两者都尚未注册为可运行交易所，也尚未开放自动网格。
- PopDEX 主钱包私钥禁止进入前端、后端、配置或日志。临时 Agent 私钥只能由浏览器内存生成，链上授权回验成功且用户明确确认后才能写入 `.env`；撤销必须先确认链上 Agent 已失效，再清除本地私钥。
- PopDEX Agent API 必须独立于 exchange registry、GridBot、`.state.json`、AI、Decibel 和 RISEx；本阶段禁止新增 PopDEX start/stop/order/cancel/leverage/close 路由。
- PopDEX 真实订单只允许由独立 CLI 触发：已验收的非成交下单撤单探针使用 `npm run popdex:write-probe` 与 `--confirm-mainnet-write`。第 5 阶段真实成交证明 `placeReverseOrder(account,20000,Long=1)` 会被主网以 `[15200] Invalid position side` 拒绝，因此 `--confirm-mainnet-fill-close` 和 `--resume --confirm-mainnet-close` 必须保持禁用，直至取得官方网页成功平仓交易并证明正确 calldata。默认命令必须 dry-run；服务器、网页、Agent API 和 GridBot 禁止导入或调用交易客户端。
- PopDEX UserConfig 预编译固定为 `0x0000000000000000000000000000000000001009`，`getAccountConfig`、`updateLeverage`、`LeverageUpdated` 属于该预编译。BTCUSDT 杠杆请求固定 `newLeverage=1`、`symbolId=20000`、零 token 地址、`category=Futures(2)`；禁止把 `OrderCategory.Regular(0)` 当作合约品类。Order 预编译 `0x0000000000000000000000000000000000001000` 提供订单、仓位和 `placeReverseOrder`。
- PopDEX 新账户的 `getAccountConfig().symbolLeverages` 可以没有 BTCUSDT 条目；这只表示尚无显式市场杠杆配置，禁止猜成默认 1x。dry-run 显示 `unset`，实盘必须写入固定 1x 并回读到唯一、明确的 BTCUSDT 1x 条目后才能下单。
- PopDEX 当前主网 `/trade/fills` 使用十进制字符串 `execId` 作为成交唯一标识；规范化层必须将其保留为内部 `fillId`，并继续拒绝 `execId`、`fillId`、`tradeId` 之间的冲突或非法值。
- PopDEX 写入只允许 `write-rpc-client.js` 广播，顺序必须为账户可用保证金校验、模拟、签名、广播前落盘确定性交易哈希、单次广播、回执、订单事实确认；当前官方静态 ABI 声明 `placeOrder`/`cancelOrder` 返回 bool，但 2026-08-17 主网 Order 预编译的成功 `eth_call` 实测返回精确空数据 `0x`，探针以主网实测结果为模拟成功条件。RPC 错误或任何非空结果都必须在签名前拒绝。成功写入必须解析同一交易回执的 `OrderCreate` / `OrderCancel` 事件取得精确订单身份，并用官方账户 REST 的 `clientOid`、状态和数量确认活动或终态；主网已实测预编译活动/完成订单分页可能在网页和 REST 显示 `NewAccept` 时仍返回空，不得再将其作为即时确认的唯一来源。禁止把交易哈希当订单 ID，禁止不确定结果自动重试。
- PopDEX Order 预编译会把 `clientOrderId` 作为受限字符集的 UTF-8 字符串解析；新订单必须使用 `encodeBytes32String` 生成不超过 31 字节、仅包含固定前缀、连字符和小写十六进制随机字符的规范 ID。禁止使用 Keccak、任意随机 32 字节或包含 `_`、`+`、`/`、`=` 的 Base64/Base64URL 标识。
- PopDEX `.popdex-write-probe.json` 是单笔探针的恢复事实。`PREPARED` 且尚未广播可安全清理；广播后必须保留到权威事实确认零成交撤单终态，或同时确认已记录下单哈希的回执为 `0x0` 且 REST 与预编译活动/完成查询都不存在该客户端订单。普通 `--resume` 只读：成功的 `OrderCreate` 回执必须与 REST 精确匹配；`CANCEL_BROADCAST` 只有在已记录撤单哈希的成功回执包含精确 `OrderCancel`、REST 活动订单已消失、所有成交分页不存在该 `orderId` 且目标市场所有链上持仓分页为空时，才可记录 `recoveredFromChain` 并清理；任何成交或持仓都必须保留 journal 并人工处理。仅 `--resume --confirm-mainnet-cancel` 可例外发送一笔 Agent 撤单，且必须由同一下单回执与 REST 共同确认恢复记录中的唯一订单精确处于 `NewAccept`、零成交、身份与数量完全一致；写入前再次验证 Agent，广播一次后以既有 journal 和普通 `--resume` 恢复，严禁重复广播、撤销其他订单或接入服务器、网页和 GridBot。不得伪造撤单交易哈希，也不得仅因订单查询为空而清理或重复下单。
- PopDEX `.popdex-fill-close-probe.json` 独立记录第 5 阶段杠杆、入场、撤余单、仓位和平仓事实，禁止与 `.popdex-write-probe.json` 混用。普通 `npm run popdex:fill-close-probe -- --resume` 永远不得创建写客户端或广播；恢复撤单只允许 `--resume --confirm-mainnet-cancel`，恢复平仓写入当前禁用。已有 cancel/close txHash 时必须继续普通 resume，禁止重复广播。失败的平仓回执只有在只读事实同时证明 BTCUSDT 活动订单为 0 且 Long/Short 持仓都为 0 后，才可按人工平仓完成清理；仓位仍存在时必须保留 journal 并输出失败原因。
- PopDEX `/overview` 只用于账户概览，持仓事实必须从订单预编译合约 `0x0000000000000000000000000000000000001000` 的只读方法 `getOpenPositionsByAccount` 获取，禁止猜测 overview 内含 `positions`。
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
