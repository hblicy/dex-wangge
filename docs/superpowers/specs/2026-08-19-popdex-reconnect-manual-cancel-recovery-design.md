# PopDEX 重连失败清理与运行中零成交人工撤单恢复设计

## 背景

PopDEX BTCUSDT 三格主网验收出现了一个可重复的安全故障链：

1. 本地和 REST 都能看到一笔仍开放的零成交订单；
2. 链上 active orders 暂时没有同一订单；
3. 严格对账因两个官方数据源不一致进入 `RECONCILING`，30 秒后抛出 `POPDEX_UNKNOWN_TERMINAL`；
4. `stop` 因非 `READY` 状态拒绝撤单，没有发出链上写入；
5. `reconnect` 失败后交互命令监听退出，但交易所刷新定时器继续运行，进程持续输出错误；
6. 用户结束进程并在网页人工撤销零成交订单后，官方状态已是挂单 0、持仓 0，但本地仍为 `running=true + active=1 + ownership OPEN`；
7. 现有 `--confirm-manual-cancel-order` 只接受 `running=false + active=0 + ownership UNKNOWN_TERMINAL`，无法归档该真实现场。

本次现场订单为 `246940766838980608`。订单没有成交、没有持仓、没有未完成写操作。设计不得依赖这个固定订单号，但测试必须覆盖完全相同的状态形状。

## 根因

### 1. 重连失败没有交给会话统一清理

交互层收到 `reconnect` 异常后只移除 stdin 和信号监听并拒绝外层 Promise，没有调用会话的交易所停止和锁释放路径。交易所定时刷新仍持有事件循环，因此命令行看似失败，进程却不会退出。

### 2. 人工撤单恢复状态机缺少一种真实中断形态

当前人工撤单恢复只识别“程序已经完成本地停止，但官方撤单终态缺失”的旧形态。此次故障发生在撤单写入之前，`GridBot.stop()` 按 fail-fast 原则保留 `running=true` 和活动订单；随后用户在程序外完成撤单。本地事实是正确保存的，但恢复命令没有相应的严格验证分支。

### 3. 官方数据冲突不是本次需要放宽的对象

REST open 与链上 active 不一致时进入 `RECONCILING` 是预期的安全行为。不能为了让撤单方便而把单一数据源提升为绝对权威，也不能在身份事实不闭合时自动签名撤单。

## 目标

- 任意交互控制命令失败后，统一停止交易所刷新、释放进程锁并让进程退出。
- 保留全部状态、ownership 和 operation 事实，失败清理不得删除恢复证据。
- 扩展现有人工撤单恢复命令，支持“运行中进程异常退出后，用户人工撤销唯一零成交订单”的精确形态。
- 恢复过程保持链上写入为 0。
- 任一账户、订单身份、数量、成交、持仓或本地写操作事实不匹配时立即拒绝恢复。
- 保持 REST 与链上 active 冲突时的严格 `RECONCILING` 行为。

## 非目标

- 不改变 PopDEX 官方 REST、RPC 或成交数据的信任等级。
- 不允许 `HALTED` 或 `RECONCILING` 状态自动绕过写入保护。
- 不增加“强制清空所有状态”命令。
- 不修改 Decibel、RISEx、通用 GridBot 或 PopDEX 下单与平仓协议。
- 不自动替用户执行网页撤单。

## 方案

### 一、会话拥有唯一的失败关闭路径

`createSession()` 返回的会话增加幂等失败关闭能力。交互层执行 `status`、`reconnect` 或 `stop` 发生异常时，必须先调用该关闭路径，再把原始错误交给顶层输出。

关闭顺序固定为：

1. 标记会话不再接受控制命令；
2. 停止 PopDEX 交易所刷新定时器；
3. 释放 grid-probe 进程锁；
4. 保留 state、ownership 和 operation 文件；
5. 输出命令名、失败阶段、交易所是否已停止、锁是否已释放；
6. 重新抛出原始错误。

如果清理自身失败，抛出包含原始控制命令错误和全部清理错误的 `AggregateError`，不得覆盖根因。重复调用关闭路径不得重复释放锁或产生第二个副作用。

`stop` 当前已有专用失败清理行为，实施时应收敛到同一个会话关闭原语，避免 `stop` 与 `reconnect` 再次产生不同生命周期。

### 二、人工撤单恢复支持两种互斥形态

现有 `--confirm-manual-cancel-order <orderId>` 保留旧形态，并增加新形态。命令仍与 `--resume`、`--confirm-mainnet-grid` 和所有新网格参数互斥。

#### 形态 A：`stopped-unknown-terminal`

保持现有行为：

- state 为版本 1、账户匹配；
- `running=false`；
- active 为空；
- processed fill 为空；
- ownership 恰好一笔目标订单；
- ownership 为 `UNKNOWN_TERMINAL`、零成交、无 fill、无 terminal event；
- operation 不存在。

#### 形态 B：`aborted-running-zero-fill-open`

只在以下全部条件成立时接受：

- state 为版本 1、账户匹配；
- `running=true`；
- active 恰好一笔，Map key 精确等于命令行 `orderId`；
- processed fill 为空；
- active 元数据的 client order ID、方向、价格、数量、reduce-only、opening、recovery 和 parent fill 身份与 ownership 精确一致；
- ownership 恰好一笔目标订单；
- ownership 状态只能是 `OPEN` 或 `UNKNOWN_TERMINAL`；
- `filledQtyWad=0`、fill IDs 为空、terminal event 为空、cancel proof 为空；
- operation 不存在。

两种形态随后共享完全相同的官方验证：

- REST open 为 0；
- 链上 active orders 为 0；
- BTCUSDT 持仓为 0；
- 官方 fills 中不存在该 order ID；
- 主账户与本地状态账户完全一致。

验证通过后，原样归档 state 和 ownership 文件，不先改写成 stopped，也不伪造撤单证明。归档应继续使用现有原子回滚逻辑：任一文件移动失败时，把已移动文件全部恢复到原路径。

成功结果增加 `recoveryShape`：

- `stopped-unknown-terminal`
- `aborted-running-zero-fill-open`

CLI 必须明确输出形态、`链上写入=0` 和每个归档路径。

### 三、没有状态文件时给出准确错误

人工撤单或人工平仓恢复在 state 文件不存在时，应明确报告“没有可恢复状态”，不能复用“版本或账户不匹配”。这只改善可观测性，不放宽验证。

## 数据流

### 重连失败

`reconnect` → 严格对账失败 → 会话失败关闭 → 停止刷新 → 释放锁 → 保留恢复文件 → 顶层输出原始 `POPDEX_UNKNOWN_TERMINAL` → 进程退出。

### 网页人工撤单后的恢复

只读 preflight → 读取 state/ownership/operation → 判定唯一恢复形态 → 精确交叉校验本地身份 → 校验官方挂单 0、持仓 0、目标订单无成交 → 原子归档 → 输出 `writes=0`。

## 错误处理与可观测性

- 官方 REST 与链上 active 冲突继续进入 `RECONCILING`，不自动撤单。
- 控制命令错误日志必须包含命令名，不能只输出笼统的 grid-probe 失败。
- 失败关闭日志必须分别确认“交易所刷新已停止”和“进程锁已释放”。
- 恢复拒绝信息应指出不匹配类别：状态形态、活动订单身份、ownership、operation、官方挂单、持仓或成交。
- 日志不得输出 Agent 私钥、签名或授权令牌。

## 测试设计

### 会话生命周期

- `reconnect` 抛出 `POPDEX_UNKNOWN_TERMINAL` 时，交易所 `stop()` 恰好调用一次。
- 同一路径释放进程锁，保留三类恢复文件，并使后续控制命令失败为“会话已关闭”。
- `stop` 失败继续满足同一清理契约。
- 清理失败时保留原始错误和清理错误。

### 新人工撤单形态

- 使用本次现场的 `running=true + active=1 + ownership OPEN + zero fill`，官方 0/0 时恢复成功且 writes 为 0。
- ownership 为 `UNKNOWN_TERMINAL` 的同形态也可恢复。
- active order ID、client order ID、价格、数量、方向或网格意图任一冲突时拒绝。
- ownership 为 PARTIAL/FILLED/CANCELLED、存在 fill、terminal event 或 cancel proof 时拒绝。
- operation 存在、官方仍开放、链上仍 active、存在持仓或存在目标订单成交时拒绝。
- 归档第二个文件失败时完整回滚。

### 回归

- 旧的 stopped UNKNOWN_TERMINAL 人工撤单恢复继续通过。
- 已停止人工平仓恢复继续通过。
- PopDEX adapter、ownership、reconciler 和 grid-probe 聚焦测试通过。
- `npm test` 全量通过，确保 Decibel 和 RISEx 不受影响。

## 验收标准

- 相同现场再次发生时，`reconnect` 失败后进程自行退出，不再持续打印定时刷新错误。
- 网页人工撤销唯一零成交订单后，恢复命令能在官方挂单 0、持仓 0、无成交的前提下归档事实。
- 恢复结果显示 `aborted-running-zero-fill-open` 和 `链上写入=0`。
- 归档后只读 `npm run popdex:grid-probe` 通过。
- 任一不确定事实都导致明确失败，不删除文件、不产生链上写入。
