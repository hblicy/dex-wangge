# PopDEX 三格验收人工平仓恢复设计

## 背景与目标

三格验收的开仓单已经真实成交，本地 ownership 将该成交持久化为 `FILLED / EVENT_PENDING`。操作员随后在 PopDEX 网页人工平仓，官方账户事实变为 BTCUSDT 挂单 0、持仓 0。恢复时 reconciler 仍要求该开仓成交对应的 Long 持仓，因此以 `POPDEX_POSITION_MISMATCH` 停止。这是正确的安全保护，但当前 CLI 没有显式声明“该持仓已由人工平仓”的恢复入口。

本次为 `popdex:grid-probe` 增加只读、显式、可审计的人工平仓恢复命令。它只处理当前已观察到的单笔完整开仓成交场景，不发送交易，不自动推断人工行为，也不改变普通 `--resume` 的严格校验。

## 方案比较

### 方案一：直接删除本地状态文件

操作简单，但会丢失成交和恢复审计事实，也可能在交易所快照异常时允许重复启动，拒绝采用。

### 方案二：普通 `--resume` 发现空仓后自动清理

使用方便，但程序无法区分人工平仓、接口漏报仓位和短暂数据不一致。自动清理会削弱 `POPDEX_POSITION_MISMATCH` 的安全边界，拒绝采用。

### 方案三：指定成交订单的显式人工平仓恢复命令（采用）

新增 `--confirm-manual-flat-order <orderId>`。操作员必须给出本地唯一成交订单号；程序重新读取并交叉检查状态、ownership、REST/链上挂单、成交和持仓，全部严格一致后才原子归档恢复文件。该流程链上写入为 0。

## CLI 与数据边界

- `--confirm-manual-flat-order <orderId>` 与 `--resume`、`--confirm-mainnet-grid`、上下界及其他运行参数互斥。
- `orderId` 必须是大于 0 的整数字符串。
- 命令获取现有 grid-probe 进程锁；存在活动实例时立即拒绝。
- 命令只允许 BTCUSDT、主账户匹配、版本 1 的 Stage 7 文件。
- 不修改 GridBot、交易适配器、服务器、前端、Decibel 或 RISEx。

## 严格恢复条件

只有同时满足以下条件才允许恢复：

1. `.popdex-grid-probe.json` 存在，账户匹配，快照为 `running=true`、`active=[]`、`processedFillEventIds=[]`。
2. `.popdex-grid-probe-operation.json` 不存在，证明没有 PREPARED/BROADCAST/CONFIRMED 写操作待恢复。
3. ownership 中恰好一个订单，且订单号与命令参数一致。
4. 该订单是 BTCUSDT opening buy、非 reduce-only、`FILLED`，`filledQtyWad=qtyWad>0`。
5. 订单只有一个 `EVENT_PENDING` 终态事件；事件为 `FILLED`，成交量和 fill IDs 与订单完全一致，未 suppression、没有 replacementOrderId。
6. 官方 REST 挂单和链上活动订单均为 0。
7. 官方 BTCUSDT 持仓为 0。
8. 官方成交列表按 orderId 精确找到成交；其 fill ID 集合与 ownership 完全相同，成交数量总和与 `filledQtyWad` 完全一致。

任何条件不满足都 fail fast，保留全部原文件，不进行归档。

## 归档与输出

验证通过后，将存在的 state、ownership、operation 文件以同一时间戳原子改名为 `.manual-flat-<timestamp>.bak`。归档途中失败时，将已移动文件按反序恢复原名。

成功输出模式 `manual-flat-recovered`、订单号、归档文件列表和 `writes=0`。CLI 明确打印“人工平仓恢复完成”和“链上写入=0”。不输出私钥、签名或完整账户地址。

## 测试与验收

- 参数解析接受唯一人工平仓命令并拒绝所有冲突组合。
- 真实事故形态：唯一 `FILLED / EVENT_PENDING` opening 订单、官方空挂单空仓且成交完全匹配时，归档成功且写入为 0。
- 拒绝状态不匹配、活动订单、仍有仓位、写日志存在、订单身份冲突、部分成交、事件已 suppression/已补单、官方成交缺失及 fill ID/数量冲突。
- 归档中途失败时回滚原文件。
- 完整 `npm test` 通过，证明既有 PopDEX、Decibel 和 RISEx 行为不受影响。

