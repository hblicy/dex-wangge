# Dex Wangge 安全加固设计

日期：2026-08-14

## 目标

修复已确认的五个安全问题，同时保持现有三交易所网格、AI 助手、代理配置、浏览器 SSE 实时状态和默认回环部署方式可用：

1. 交易控制与配置 API 未鉴权。
2. 危险 POST 接口缺少 CSRF 防护。
3. 外部交易所与网络错误文本未经转义进入 `innerHTML`。
4. 高权限仪表盘运行时加载无完整性约束的第三方 CDN 脚本。
5. SSE 连接数量和慢客户端写缓冲没有边界。

## 方案选择

### 认证方案

- 采用：应用内 HTTP Basic Auth，用户名固定为 `admin`，密码来自 `.env` 的 `DASHBOARD_TOKEN`。
- 未采用会话 Cookie：需要登录页、会话存储、过期与注销机制，超出本次最小修复范围。
- 未采用仅由 Nginx、Caddy 或 Tailscale 认证：外部代理配置失误会重新暴露项目本身的未鉴权控制面。

Basic Auth 原生适用于静态页面、普通 `fetch` 和 `EventSource`，不需要把令牌放进 URL。服务端使用恒定时间比较校验凭据。`DASHBOARD_TOKEN` 必填且至少 16 个字符；不满足要求时服务端明确报错并拒绝启动。

### Chart.js 供应链方案

- 采用：将 Chart.js `4.4.1` 固定为 npm 生产依赖，并仅通过服务端固定路由 `/vendor/chart.js` 提供 `node_modules/chart.js/dist/chart.umd.js`。
- 未采用继续使用 cdnjs 加 SRI：仍依赖第三方运行时可用性，并需要人工维护 CDN 摘要。
- 未采用把压缩产物直接复制进仓库：会增加难以审查和更新的大型生成文件。

## 服务端安全边界

### 启动配置

`src/config.js` 增加：

- `dashboardToken`：读取 `DASHBOARD_TOKEN`。
- `dashboardOrigins`：读取逗号分隔的 `DASHBOARD_ORIGINS`，解析为允许的绝对 HTTP/HTTPS Origin。
- `maxSseClients`：读取 `MAX_SSE_CLIENTS`，默认每类流最多 10 个连接。

无效值必须导致启动失败，不允许静默降级为不安全配置。

### HTTP Basic Auth

`src/security.js` 提供纯函数和小型边界助手：

- 解析 Basic Authorization。
- 固定用户名 `admin`。
- 使用 `crypto.timingSafeEqual` 比较完整凭据。
- 未认证响应统一返回 `401`，带 `WWW-Authenticate: Basic realm="dex-wangge"`。

认证放在 `http.createServer` 路由分派之前，因此静态页面、所有 `/api/*`、SSE 和本地 vendor 资源使用同一控制边界。

### CSRF 防护

所有状态变更请求必须同时满足：

1. 方法为 POST 时，`Content-Type` 必须是 `application/json`。
2. 必须携带 `X-Dex-Request: 1`。
3. 如果请求带 `Origin`，其规范化 Origin 必须等于请求 `Host` 推导出的本地 Origin，或位于 `DASHBOARD_ORIGINS` 白名单。

浏览器仪表盘通过统一 `apiFetch` 助手给同源 POST 添加 `X-Dex-Request`。跨站页面无法在没有成功 CORS 预检的情况下添加该自定义头；本服务不开放 CORS。CLI 客户端可在正确 Basic Auth 下显式发送该头，因此仍保留自动化能力。

对于非法 JSON、超限请求体或错误 Content-Type，`readBody` 必须显式失败并返回 4xx，不再把错误正文解释为空对象。这样 `stop({ closePosition = true })` 不会因畸形请求被意外触发。

### Tailscale Serve

项目继续监听 `127.0.0.1:8080`。VPS 上使用：

```bash
sudo tailscale serve --bg 8080
tailscale serve status
```

浏览器通过 `https://<device>.<tailnet>.ts.net` 访问。将该完整 HTTPS Origin 写入：

```dotenv
HOST=127.0.0.1
PORT=8080
DASHBOARD_ORIGINS=https://<device>.<tailnet>.ts.net
```

Basic Auth 继续启用，Tailscale ACL/Grants 作为外层访问控制。禁止使用 `tailscale funnel`，因为 Funnel 会把服务公开到互联网。

## 浏览器输出安全

`public/index.html` 保留只用于固定模板和已验证数值的 `innerHTML`。跨越网络或配置边界的字符串改为 DOM API：

- 市场下拉框使用 `document.createElement('option')` 和 `textContent`。
- 告警列表使用 `document.createElement('div')` 和 `textContent`。
- 代理 IP、代理错误、保存配置错误使用 `textContent` 与明确的 class。
- AI 返回的等级先映射到固定枚举，再设置 class 和文本。

同时复查所有现存 `innerHTML`，外部市场名、交易所错误、代理响应、AI 输出和用户输入不得未经编码进入 HTML 上下文。

## 本地 Chart.js

`package.json` 将 `chart.js` 固定为 `4.4.1`。`src/server.js` 只为 `/vendor/chart.js` 映射一个已知绝对文件，不提供通用 `node_modules` 静态目录。`public/index.html` 改为：

```html
<script src="/vendor/chart.js"></script>
```

此资源和其他页面一样需要 Basic Auth。删除对 cdnjs 的运行时请求。

## SSE 资源限制

每个交易所流和总览流各自最多允许 `MAX_SSE_CLIENTS` 个连接。达到上限时，在发送 SSE 头之前返回 `503` JSON 错误。

广播时若 `response.write()` 返回 `false`，立即结束并移除该慢客户端，避免写缓冲持续增长。`close` 和 `error` 都执行幂等清理。日志记录拒绝连接和慢客户端断开事件，但不记录认证凭据。

## 错误语义和兼容性

- 缺失或无效认证：`401`。
- CSRF、Origin 或 Content-Type 不合法：`403` 或 `415`。
- JSON 无效或请求体超限：`400` 或 `413`。
- SSE 达到连接上限：`503`。
- 合法、已认证的原有页面和 API 请求保持原响应结构。
- 服务重启后浏览器可能再次弹出 Basic Auth 登录框，这是无服务器会话设计的预期行为。

## 测试策略

先增加失败测试，再实现代码：

1. Basic Auth：缺失、错误、正确凭据；确认使用固定用户名和最短令牌规则。
2. CSRF：拒绝表单正文、缺失自定义头、错误 Origin；接受本机 Origin 和配置的 Tailscale Origin。
3. 请求体：非法 JSON 和超限正文不能进入交易处理器。
4. XSS：恶意市场名、告警和代理错误只能作为文本；源文件不再包含对应的不安全 `innerHTML` 数据流。
5. Chart.js：页面只引用 `/vendor/chart.js`，依赖版本固定，vendor 路由不能读取其他 `node_modules` 文件。
6. SSE：达到上限时拒绝新连接，连接关闭后释放配额，背压客户端被移除。
7. 回归：现有 16 项测试继续通过，执行语法检查、依赖审计和完整安全测试。

## 文档与部署变化

更新 `.env.example`、README 和 Windows 启动说明，明确：

- 首次启动前必须生成强随机 `DASHBOARD_TOKEN`。
- 浏览器用户名固定为 `admin`。
- VPS 保持 `HOST=127.0.0.1`。
- SSH 隧道和 Tailscale Serve 都受支持。
- Tailscale Serve 使用 tailnet HTTPS 地址和 `DASHBOARD_ORIGINS`；不使用 Funnel。
- 8080 不应在云安全组或主机防火墙中公开。

## 验收条件

- 未认证客户端不能读取页面、状态或执行任何 API。
- 跨站表单和不符合约束的 POST 不产生交易或配置副作用。
- 已确认的外部字符串到 `innerHTML` 路径全部切断。
- 页面运行时不请求 cdnjs。
- SSE 连接与缓冲消耗有确定上限。
- 通过 SSH 隧道和配置白名单后的 Tailscale Serve HTTPS 地址均可正常登录和操作。
