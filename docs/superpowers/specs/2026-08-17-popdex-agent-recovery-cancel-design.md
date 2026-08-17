# PopDEX Agent 恢复撤单设计

## 目标

为 `.popdex-write-probe.json` 中已经存在、且由成功 `OrderCreate` 回执和官方 REST 共同确认仍在活动的唯一订单，提供一次显式授权的 Agent 恢复撤单能力。该能力不得创建新订单，不得选择其他订单，也不得在订单身份、状态或数量存在不确定性时广播。

## 方案比较

### 方案一：继续依赖 PopDEX 网页撤单

优点是程序保持完全只读。缺点是当前官方网页持续返回 `Wallet not connected`，无法完成已存在订单的风险处置，且网页钱包会话不受本程序控制。

### 方案二：提供一次性 Node 脚本或手工 RPC 命令

优点是实现快。缺点是容易抄错订单 ID、客户端订单 ID 或账户，缺少恢复记录、状态机、回执事件和 REST 终态校验，也无法阻止重复广播，不接受该方案。

### 方案三：扩展现有 write-probe 的受控恢复模式（采用）

新增组合参数 `--resume --confirm-mainnet-cancel`。继续复用现有恢复文件、Agent 授权检查、交易编码、单次广播、回执事件解析和 REST 终态确认。普通 `--resume` 仍然严格只读。

## CLI 边界

- `--resume`：保持只读，不发送任何交易。
- `--resume --confirm-mainnet-cancel`：仅允许撤销恢复记录对应的唯一活动订单。
- `--confirm-mainnet-cancel` 不得单独使用，也不得与下单参数或 `--confirm-mainnet-write` 同时使用。
- 不新增网页按钮、服务器路由、GridBot 接口或自动任务。

## 撤单前验证

执行真实撤单前必须按顺序完成：

1. 加载并严格校验 `.popdex-write-probe.json`；记录必须至少处于 `BROADCAST`，并包含原下单交易哈希。
2. 校验 PopDEX chain ID 为 2184。
3. 读取原下单交易回执，验证交易哈希、`status=0x1` 和唯一 `OrderCreate` 事件。
4. 从事件取得精确 `orderId`，并与恢复记录已有 `orderId`（如果存在）一致。
5. 用官方 REST 按规范 UTF-8 `clientOid` 精确查找订单。
6. 校验主账户、BTCUSDT/ETHUSDT 白名单、方向、价格、数量、非 reduce-only、订单 ID 和客户端订单 ID 全部一致。
7. 仅允许状态精确为 `NewAccept`，且 `filledQty=0`、`remainingQty=qty`、`cancelledQty=0` 的订单进入撤单。`WaitToSend`、`PendingNew` 和 `PendingCancel` 都表示状态尚未稳定，必须保持只读并停止，防止重复动作。
8. 再次验证 `.env` 中临时 Agent 私钥对应的 Agent 授权仍有效、未过期、非 global 且 delegator 是主账户。

任何一步失败都必须在签名和广播前终止，并保留恢复记录。

## 写入与确认

1. 若恢复记录仍处于 `BROADCAST`，先把由回执确认的 `orderId` 持久化并推进到 `OPEN_CONFIRMED`。
2. 编码精确的 `cancelOrder(mainAccount, orderId, clientOrderId)`。
3. 执行 `eth_call` 模拟；只接受当前主网已验证的精确空结果 `0x`。
4. 使用临时 Agent 签名 legacy 交易，广播前把确定性撤单交易哈希写入恢复记录并推进到 `CANCEL_BROADCAST`。
5. 只广播一次；网络不确定时禁止自动重试。
6. 验证同一交易哈希的成功回执及唯一 `OrderCancel` 事件。
7. 轮询官方 REST，只有 `Cancelled`、`filledQty=0`、`remainingQty=0`、`cancelledQty=qty` 且数量守恒时，才推进 `CANCEL_CONFIRMED` 并清理恢复记录。

## 崩溃恢复

- 在广播前失败：保留原阶段和错误信息，不产生撤单交易。
- 在广播后回执未知：保留 `CANCEL_BROADCAST` 和确定性撤单交易哈希，禁止第二次撤单广播。
- 再次运行普通 `--resume`：只读查询原下单回执和 REST；若 REST 已确认零成交 `Cancelled`，安全完成并清理。
- 再次运行 `--resume --confirm-mainnet-cancel` 且记录已是 `CANCEL_BROADCAST`：不得再次广播，必须提示改用普通 `--resume` 获取事实。
- 任何成交量大于零：保留记录并输出 `filled-manual-position-required`，要求人工处理仓位。

## 可观测性与敏感信息

- 输出模式、订单 ID、阶段、交易哈希和确认状态。
- 不输出 Agent 私钥、原始签名交易或完整主账户地址。
- 所有错误保持单行、可追溯，不吞掉 REST、回执或恢复记录冲突。

## 测试与验收

- 参数组合：接受 `--resume --confirm-mainnet-cancel`，拒绝其他冲突组合。
- 安全前置：无恢复记录、错误阶段、缺失/失败回执、REST 未找到、身份冲突、非活动状态、任何成交、Agent 无效时均不得构造写客户端或广播。
- 成功路径：从回执恢复订单 ID，推进状态，单次广播，验证 `OrderCancel` 和 REST 零成交终态，清理恢复文件。
- 不确定路径：广播错误或回执超时时保留 `CANCEL_BROADCAST`，再次运行不得重复广播。
- 回归：完整 `npm test` 必须通过，证明 Decibel、Extended、RISEx 和 PopDEX 既有只读/授权路径不受影响。
