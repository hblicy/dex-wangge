# RISEx 临时认证网络故障重连设计

## 背景

RISEx 私有 WebSocket 断线后会重新执行 `auth_v2`。认证开始前调用官方客户端的 `isSignerRegistered()`；该请求若出现一次 `TypeError: fetch failed`，当前私有流会把所有认证异常统一交给 `_fatal()`，停止重连并把适配器切到 `HALTED`。机器人随后每 30 秒调用一次开放订单对账，因此持续报告 `RISEx 对账不可用：HALTED fetch failed`。

普通只读刷新失败本身不会设置 `HALTED`。线上出现的精确 `haltReason=fetch failed` 来自未分类的认证前网络异常，而不是订单、签名或数据冲突。

## 目标

- 已经成功认证并进入运行态的私有流，自动重连遇到临时网络错误时只保持 `RECONCILING`，禁止新增风险写入并按指数退避持续重连。
- 认证、REST 快照和私有 Orders/Fills 对账全部成功后才恢复 `READY`。
- 确定性的安全错误继续立即进入 `HALTED`，不得降低现有保护边界。
- 错误日志保留失败阶段和嵌套网络原因，但不得输出账户密钥或完整敏感参数。
- 不修改 Decibel、PopDEX、通用 GridBot 或前端行为。

## 方案比较

### 方案 1：在私有流认证边界分类错误（采用）

私有流记录是否曾经成功认证，并识别完整 `cause` 链中的网络错误。已认证流的自动重连遇到临时错误时，关闭本次 socket、拒绝本次 `connect()`、保留非停止状态并安排既有指数退避重连；确定性错误仍调用 `_fatal()`。

优点是错误在产生它的边界处理，适配器无需猜测私有流内部状态，现有重连与 REST/WS 对账屏障可以复用。

### 方案 2：固定重试认证请求三次

改动小，但网络故障超过重试窗口仍会错误熔断，不能解决短时网络抖动与 VPS 出口不稳定。

### 方案 3：适配器收到 `fatal` 后重建客户端

可以恢复，但私有流已经把自身标记为停止；在适配器层补救会产生双重重连、socket 竞态和职责混乱。

## 错误分类

统一检查错误及最多五层 `cause`：

- 临时网络错误：`fetch failed`、`AbortError`、连接/解析超时、`ECONNRESET`、`ECONNREFUSED`、`ETIMEDOUT`、`EAI_AGAIN`、`ENOTFOUND`、`UND_ERR_*`、socket/连接中断。
- 确定性错误：signer 未注册、签名失败、EIP-712 domain/chain/verifying contract 不匹配、nonce 格式非法、服务端明确拒绝认证、私有订单或成交字段冲突。

HTTP 非成功响应继续按确定性错误处理；未经证据不得把 401、403、429 或其他服务端响应归类为网络故障。

## 状态流转

1. 已认证 socket 断开时，适配器保持现有行为：保存订单所有权、开始缓冲并切到 `RECONCILING`。
2. 新 socket 打开后执行 signer 注册检查、domain/nonce 获取和签名。
3. 任一步出现临时网络错误：
   - 输出包含阶段和嵌套原因的可清洗日志；
   - 拒绝本次连接等待者；
   - 关闭本次 socket，但不设置 `_stopped`、不发送 `fatal`；
   - 由现有 1 秒至 30 秒指数退避调度下一次连接。
4. 认证成功后订阅 Orders/Fills，继续执行现有 REST/WS 所有权同步。
5. 只有快照身份、订单终态和持仓事实全部通过，适配器才进入 `READY` 并恢复写入。
6. 确定性错误仍立即停止私有流并使适配器进入 `HALTED`。

初次启动、独立私有验证和用户主动重建客户端时尚未建立可信运行态，仍采用 fail-fast：当前连接失败立即向调用方返回错误，不在后台伪装成已启动。自动持续重连只适用于同一私有流已经成功认证、随后发生的运行中断线。

## 可观测性

- 临时认证故障日志必须以 `RISEx WS 临时认证错误` 标识，并包含清洗后的 `describeError()` 因果链。
- 重连日志继续输出下一次退避时间。
- `getHealth()` 在恢复前显示 `RECONCILING`，不得伪装为正常。
- 不吞掉验证命令错误；`npm run risex:verify -- --private` 仍可在当前尝试失败时返回非零结果和完整清洗原因。

## 测试

- 已成功认证的流在重连时，`isSignerRegistered()` 抛出带 `UND_ERR_SOCKET` cause 的 `fetch failed`：不触发 `fatal`，本次连接失败并安排重连。
- 初次连接发生相同错误：保持 fail-fast，验证命令或启动调用方得到非零失败结果。
- domain/nonce GET 超时或网络断开：相同行为。
- 重连后认证成功：适配器保持 `RECONCILING`，直到 REST/WS 对账完成才进入 `READY`。
- signer 未注册、非法 domain、订单 schema 冲突：仍触发 `HALTED`。
- 重连期间的下单、补单、调杠杆和平仓写入继续被拒绝。
- 运行 RISEx 定向测试和项目全量测试，确认 Decibel 与 PopDEX 不受影响。

## 非目标

- 不为 REST 交易接口增加隐式写入重试。
- 不改变 HALTED 状态下现有紧急撤单边界。
- 不修改 AI 哨兵文案；其告警会随 RISEx 健康状态恢复而自然恢复。
