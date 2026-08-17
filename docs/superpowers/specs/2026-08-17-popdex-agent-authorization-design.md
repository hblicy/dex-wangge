# PopDEX 临时 Agent 授权阶段设计

日期：2026-08-17

## 目标

在不注册 PopDEX 交易所、不启动 PopDEX 网格、不修改 Decibel/RISEx 运行路径的前提下，提供一条可审计的临时 Agent 生命周期：浏览器本地生成 Agent、主钱包链上授权、后端只读回验、用户明确保存到 VPS，以及主钱包链上撤销。

本阶段完成后只能证明 Agent 授权闭环正确，不能证明 PopDEX 下单、撤单、成交、杠杆或平仓可用。

## 硬隔离边界

- 不修改 `config.de`、`config.rs`、`/api/de/*`、`/api/rs/*`、Decibel/RISEx 适配器或 Bot 实例。
- 不增加 PopDEX `GridBot`，不增加 `.state.json` 的 PopDEX 快照，不加入总览、AI 巡检或 SSE 交易状态。
- 不替换或删除 Extended；最终迁移留到 PopDEX 交易闭环全部验收后。
- Agent API 只能准备授权/撤销 calldata、执行只读链上查询和保存明确提交的 Agent 配置；服务端不得广播交易。
- 自动测试必须证明现有 Decibel、RISEx、Bot、启动、持久化和安全测试无回归。

## 组件

### `src/exchange/px/agent.js`

只包含 PopDEX Account 预编译的确定性协议逻辑：

- 固定预编译地址 `0x0000000000000000000000000000000000001008`。
- 使用官方 ABI 编解码 `approveAgent`、`replaceAgent`、`revokeAgent`、`getAgentInfo` 和 `getAgents`。
- 授权参数由服务端生成：`initialNonce=floor(Date.now()/1000)`、`expiresAt=Date.now()+2592e6`、名称 `UI_<dashboard hostname>`、`isGlobal=false`。
- 同一名称已有 Agent 时准备 `replaceAgent`；否则准备 `approveAgent`。
- 私钥只用于派生 Agent 地址，不参与授权交易，不进入错误文本或日志。

### `src/exchange/px/agent-service.js`

编排只读 RPC、配置保存和状态输出：

- `prepareApproval`：读取现有同名 Agent，返回待主钱包签名的 legacy 交易字段，不广播。
- `verifyAuthorization`：调用 `getAgentInfo`，要求 `exists=true`、`isExpired=false`、delegator 与主账户一致、`isGlobal=false`。
- `save`：从提交的 Agent 私钥派生地址，再次链上回验；只有成功后才将 `POPDEX_MAIN_ACCOUNT` 和 `POPDEX_AGENT_PRIVATE_KEY` 写入 `.env`。
- `status`：如已配置，派生 Agent 地址并回验；返回公开地址和授权状态，不返回私钥。
- `prepareRevoke`：只返回 `revokeAgent` calldata；浏览器完成交易并确认链上状态后，再清除 VPS 中的 Agent 私钥。
- `.env` 写入沿用 `writeEnvFile`，POSIX 权限保持 `0600`，落盘成功后才更新 `process.env`。

### 服务端专用 API

新增的路由不进入通用交易所 handler：

- `GET /api/px/agent/status`
- `POST /api/px/agent/prepare-approval`
- `POST /api/px/agent/verify`
- `POST /api/px/agent/save`
- `POST /api/px/agent/prepare-revoke`
- `POST /api/px/agent/clear`

所有路由继续经过现有 Basic Auth、Origin、`Content-Type: application/json` 和 `X-Dex-Request: 1` 安全边界。敏感请求正文不写日志，错误响应不得包含私钥。

### 仪表盘 Agent 页面

新增独立“PopDEX Agent”页签，不改现有三个交易所页签：

1. 浏览器通过本地固定版本的 ethers 生成随机 Agent 私钥和地址。
2. 私钥只在当前页面显示一次，不写入 Local Storage、Session Storage、Cookie 或页面状态快照。
3. 页面连接注入式 EVM 钱包并只请求切换到 `0x888`；钱包未配置 PopDEX 网络时明确提示用户先通过 PopDEX 官方页面添加，不猜测原生币或浏览器参数。
4. 服务端准备 calldata，主钱包通过 `eth_sendTransaction` 签名并广播，页面等待成功回执。
5. 页面调用后端只读回验，回验成功后才启用“保存到 VPS”。
6. 保存成功后清除页面中的私钥文本和内存引用，后端以后只显示“已配置”及公开 Agent 地址。
7. 撤销必须由当前主钱包发送 `revokeAgent`，链上回验为不存在/已失效后才清除 VPS 私钥。

页面不提供下单、启动网格、杠杆或平仓按钮。

## 失败处理与可观测性

- 用户拒签、链错误、回执失败、RPC 解码变化、delegator 不匹配、授权过期或全局 Agent 均直接失败，不自动重试或降级为已授权。
- 授权交易已成功但保存失败时，页面明确提示“链上已授权、本地未保存”，不得重新发授权交易。
- 保存成功但随后只读状态异常时显示“已配置但不可验证”，不删除配置、不开放交易。
- 日志只记录阶段、公开的 Agent 尾号、交易哈希掩码和失败类别；本阶段默认不记录请求正文。

## 测试与验收

自动测试覆盖：

- 官方 ABI 编解码、时间单位、`isGlobal=false`、approve/replace 分支。
- Agent 私钥严格校验、地址派生和错误脱敏。
- `getAgentInfo/getAgents` 大整数保持字符串，授权过期或 delegator 不匹配时失败。
- 未链上授权不能保存；保存后 `.env` 为 `0600` 且状态 API 不返回私钥。
- 撤销未确认不能清除；确认撤销后只清除 `POPDEX_AGENT_PRIVATE_KEY`。
- 页面不使用浏览器持久化，不存在 PopDEX 下单入口，所有 API 使用统一安全助手。
- 全量测试继续包含 Decibel、RISEx、Bot、启动、持久化和安全测试。

主网人工验收只执行：生成 Agent、主钱包授权、只读回验、保存、重启后状态回验、主钱包撤销、撤销回验和本地清除。任何下单测试属于下一阶段，必须再次获得明确批准。

## 完成标准

- Agent 生命周期各阶段有明确状态且失败可追踪。
- 主钱包私钥从未进入应用；Agent 私钥只在生成时显示并仅在明确保存时发送一次。
- 服务端不广播交易，PopDEX 不出现在网格运行注册表。
- Decibel、RISEx 的代码和自动化行为无变化，全量回归通过。
- 文档明确说明本阶段尚不可启动 PopDEX 实盘。
