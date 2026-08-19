# PopDEX 停止平仓事实与退出清理设计

## 背景

BTCUSDT 三格验收中，开仓订单完整成交后，反向限价补单因官方快照过期而未能提交。操作员执行 `stop`，程序成功撤单并通过 reduce-only 市价单将账户平仓，但随后的最终 ownership 对账仍报：

```text
POPDEX_POSITION_MISMATCH：BTCUSDT Long 持仓不足：required=200000000000000 actual=0
```

事故状态显示：机器人已经 `running=false`，活动订单为空，成交事件为 `EVENT_COMPLETED / suppressRequote=true`，官方账户为零挂单、零持仓。当前 ownership 只记录开仓成交和补单关系，没有记录“该开仓敞口已经被已确认的停止平仓消除”。因此 reconciler 仍把历史开仓成交计入最低所需多仓。

最终对账抛错后，CLI 还会保留交易所刷新定时器和进程锁，导致命令行看似卡住。现有人工平仓恢复命令只接受 `running=true / EVENT_PENDING`，也无法归档本次 `running=false / EVENT_COMPLETED` 的安全停止状态。

## 目标与范围

本次修复只处理 PopDEX Stage 7 三格验收：

1. 持久化经过官方空仓确认的停止平仓事实，并让 reconciler 使用该事实闭合历史开仓敞口。
2. `stop` 失败时始终关闭交易所定时器并释放进程锁，同时保留恢复文件和原始错误。
3. 扩展显式人工平仓恢复命令，严格支持本次已经停止且成交事件已完成的事故状态。

不修改 Decibel、RISEx、PopDEX 下单编码、价格策略、正式服务器、API 或前端。

## 方案比较

### 方案一：把 suppression 事件直接视为已平仓

改动最小，但 `suppressRequote=true` 只表示停止补单，不证明账户已经平仓。网络异常或平仓失败时也可能出现 suppression，直接忽略会掩盖真实敞口，拒绝采用。

### 方案二：平仓后删除开仓 ownership

可以让当前对账通过，但会丢失开仓、成交和平仓关联，无法审计，也无法区分正常结算与本地文件被误删，拒绝采用。

### 方案三：保存精确的敞口结算证明（采用）

在 ownership 中保存与开仓成交事件绑定的结算证明。证明只能在停止平仓写入已确认、官方刷新确认 BTCUSDT 空仓后写入。reconciler 仅对具有有效结算证明的开仓事件免除持仓要求；suppression 本身不改变持仓校验。

## 持久化模型

ownership 根记录增加 `settledExposureEvents`，每条记录至少包含：

- `fillEventId`：被平仓的开仓成交事件；
- `orderId`：开仓订单身份；
- `filledQtyWad`：已结算的精确成交数量；
- `reason`：固定为停止平仓语义；
- `confirmedAt`：官方空仓确认时间。

写入前必须满足：

- 对应 ownership 订单存在，且为 BTCUSDT opening、非 reduce-only；
- 订单已经终态成交，事件身份和数量完全一致；
- 事件已 suppression，禁止后续补单；
- 官方开放订单为零；
- 官方 BTCUSDT 持仓为零；
- 本次 `closePosition` 已返回成功并完成写后官方刷新。

重复记录同一事实必须幂等；身份或数量不一致必须 fail fast。文件仍使用原有原子写入和权限规则。

## 停止流程

停止顺序保持：撤单和 suppression 对账、处理 pending 事件、平仓、最终对账、清理文件。

变化如下：

1. `GridBot.stop()` 在确认平仓成功后，要求支持该能力的交易所把本次已 suppression 的 opening 成交事件记录为已结算敞口。
2. PopDEX 必须先确认官方零挂单和零持仓，再持久化结算证明。
3. reconciler 计算最低所需 Long 数量时，只排除具有完全匹配结算证明的 opening 成交；缺失、重复或冲突证明立即报错。
4. 最终对账成功后仍按现有规则删除验收状态文件。

`closePosition()` 返回 `true` 的旧接口保持不变；新增能力使用可选的适配器方法，避免改变 Decibel、RISEx 和 Paper 路径。

## CLI 失败清理

`grid-probe stop` 无论在哪个阶段失败，都必须：

- 保留 state、ownership 和 operation 文件；
- 调用 `exchange.stop()` 关闭刷新定时器；
- 释放进程锁；
- 把会话标记为已关闭；
- 输出失败阶段并重新抛出原错误。

不得在失败清理中撤单、平仓、删除文件或吞掉错误。这样即使最终对账失败，Node 进程也能退出，恢复事实仍可供诊断。

## 当前事故恢复

扩展 `--confirm-manual-flat-order <orderId>`，增加第二种严格形态：

- state 为 `running=false`、`active=[]`；
- `processedFillEventIds` 恰好包含目标事件；
- ownership 恰好一个匹配的 opening `FILLED` 订单；
- 事件为 `EVENT_COMPLETED / suppressRequote=true / replacementOrderId=null`；
- operation 文件不存在；
- 官方 REST 和链上活动订单均为零；
- 官方 BTCUSDT 持仓为零；
- 官方成交的 orderId、fill IDs 和累计数量与 ownership 完全一致。

通过后沿用现有原子归档流程，链上写入为零。普通 `--resume` 仍保持严格，不自动把空仓推断为人工平仓。

## 可观测性

新增日志只输出脱敏或非敏感事实：

- 平仓成功后记录的结算事件数和累计数量；
- reconciler 使用的活动持仓、未结算开仓量和已结算事件数；
- stop 失败后是否已关闭定时器并释放锁；
- 人工恢复匹配的是 `pending-manual-flat` 还是 `stopped-completed-flat` 形态。

不记录私钥、签名或完整账户敏感信息。

## 测试

按测试先行覆盖：

1. 无结算证明时，官方空仓仍触发 `POPDEX_POSITION_MISMATCH`。
2. suppression 本身不能绕过持仓校验。
3. 完全匹配的结算证明允许官方空仓通过最终对账。
4. 证明身份、数量、订单类型或重复事实冲突时 fail fast。
5. 停止平仓确认后先持久化证明，再执行最终对账；不会重复广播平仓。
6. stop 最终对账失败时保留文件、关闭定时器、释放锁并结束会话。
7. 当前 `running=false / EVENT_COMPLETED` 事故状态可用显式命令归档。
8. 仍有挂单、持仓、未完成 operation、成交不一致时拒绝归档。
9. 完整 Node 测试通过，确认 Decibel、RISEx 和其他 PopDEX 路径无回归。

## 验收标准

- 正常 stop 在真实平仓后可以完成最终对账并清理验收文件。
- 平仓未确认时绝不能产生结算证明。
- suppression 不再被误当作平仓证明。
- stop 任何失败都不会让 CLI 因定时器或锁继续卡住。
- 当前事故能通过显式、只读、零链上写入命令安全归档。

