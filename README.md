# 三交易所整合网格交易机器人

一个跑在你自己电脑上的加密货币**永续合约网格交易机器人**，同时支持三家去中心化交易所：**Decibel**（Aptos 链）、**Extended**（Starknet 链）、**RISEx**。三个交易所可以同时各跑一个网格策略，统一在一个浏览器仪表盘里监控和操控；三所均支持模拟盘和实盘，RISEx 实盘仅开放 mainnet 的 BTC-PERP / ETH-PERP。

> ⚠️ **免责声明**：本程序仅供学习和研究。合约交易带高杠杆风险，可能损失全部本金。实盘前请务必先用模拟模式充分熟悉。使用本程序造成的任何盈亏由使用者自行承担。

---

## 目录

- [一、功能总览](#一功能总览)
- [二、三分钟快速上手（模拟模式）](#二三分钟快速上手模拟模式)
- [三、一键启动脚本做了什么](#三一键启动脚本做了什么)
- [四、手动安装（备选方案）](#四手动安装备选方案)
- [五、仪表盘使用教程](#五仪表盘使用教程)
- [六、网格策略原理与参数详解](#六网格策略原理与参数详解)
- [七、实盘模式：API 密钥获取与配置](#七实盘模式api-密钥获取与配置)
- [八、代理 / IP 配置](#八代理--ip-配置)
- [九、AI 助手配置](#九ai-助手配置)
- [十、通知推送（Telegram / Webhook）](#十通知推送telegram--webhook)
- [十一、.env 配置项完整对照表](#十一env-配置项完整对照表)
- [十二、断电 / 崩溃自动恢复机制](#十二断电--崩溃自动恢复机制)
- [十三、REST API 一览（进阶）](#十三rest-api-一览进阶)
- [十四、常见问题 FAQ](#十四常见问题-faq)
- [十五、项目结构](#十五项目结构)
- [十六、安全须知](#十六安全须知)

---

## 一、功能总览

### 交易核心

| 功能 | 说明 |
|---|---|
| 三交易所并行 | Decibel / Extended / RISEx 各自独立运行一个网格机器人，互不影响 |
| 双运行模式 | 三所均支持 `paper` 和 `live`；RISEx live 仅支持 mainnet BTC-PERP / ETH-PERP |
| 三种网格类型 | 中性（区间震荡双向吃单）、做多（低吸高抛）、做空（高抛低补） |
| 等差网格 | 在设定区间内均匀布单，每次成交后在相邻一格自动补反向单，赚取格差 |
| 智能填充参数 | 一键根据近期 K 线趋势分析，自动推荐网格类型、区间上下界、格数 |
| 稳健 / 激进两档 | 稳健 = 格距大成交少更安全；激进 = 格距小成交频繁风险高 |
| 区间外止损策略 | 价格冲出区间时可选：直接平仓停止，或只减仓回收阶梯（recover） |
| 在线调整区间 | 不停止网格的情况下平移 / 扩缩区间 |
| 风控内置 | 杠杆上限、保证金预检查、手续费/格距合理性校验、挂单定期对账 |
| 崩溃续跑 | 断电 / 崩溃后重启程序，自动接管交易所上还挂着的单继续跑 |

### 仪表盘（浏览器操作，无需改代码）

- 📊 **总览页**：三所余额、权益、总盈亏、已实现/未实现盈亏、收益率、成交量、完成格数实时刷新（SSE 秒级推送）
- 每个交易所独立**控制台**：选交易对、看 K 线趋势分析、启动 / 停止 / 撤单 / 平仓 / 重置统计 / 重连交易所
- ⚙ **IP 配置页**：在网页里直接设置全局或各所独立代理，检测出口 IP，写入 .env
- 🤖 **AI 助手页**：连接你自己的 AI 服务（DeepSeek / Kimi / OpenAI / Claude / Gemini / Ollama 等），提供五大能力：
  1. **风控哨兵**：定时巡检三所状态，发现异常推送告警
  2. **每日复盘日报**：每天定点生成交易总结
  3. **市况分析**：定时生成 BTC 市况报告
  4. **对话操控**：用自然语言问状态、下指令（如"把 Extended 上边界调到 66000"，AI 只提议，你点确认才执行）
  5. **出区间建议**：价格冲出网格区间时，AI 给出处置建议
- 📱 **通知推送**：Telegram 机器人 + 通用 Webhook，成交异常 / 哨兵告警 / 日报自动推送
- 🔐 **PopDEX Agent 页**：独立完成临时 Agent 的生成、钱包授权、链上回验、保存和撤销；另提供必须显式确认的 CLI 单笔下单—撤单探针，尚未开放 PopDEX 自动网格或网页交易

### 安全设计

- AI 永远不进交易快回路，下单补单对账全部是纯规则代码
- AI 对话只能"提议"操作，必须由你在网页上点确认才会执行
- 私钥只存在本机 `.env` 文件，程序不上传任何数据
- 仪表盘和全部 API 使用 HTTP Basic Auth；登录用户名固定为 `admin`，密码来自 `.env` 的 `DASHBOARD_TOKEN`
- 所有控制类 POST 请求都校验 JSON、自定义请求头和 Origin，页面不再运行时加载第三方 CDN 脚本
- 服务默认只监听 `127.0.0.1`，远程访问使用 SSH 隧道或 Tailscale Serve
- Linux/macOS 启动时强制检查 `.env` 为 `0600`，防止同机其他用户读取私钥
- PopDEX 主钱包私钥不会进入本程序；临时 Agent 授权交易只由浏览器钱包确认
- PopDEX 真实写入只允许由独立 CLI 的 `--confirm-mainnet-write` 显式触发；服务器、网页和 `GridBot` 均不能调用该写入边界

---

## 二、三分钟快速上手（模拟模式）

模拟模式**不需要交易所 API 密钥或账号**，用虚拟的 10000 USDC 和真实行情练手。仪表盘仍必须配置独立登录令牌，防止本机或代理误暴露后被他人操作。

1. **下载本项目**到电脑任意文件夹（如果是 zip 包，先解压）。
2. 第一次**双击 `一键启动.bat`**会创建 `.env`。脚本提示安全配置缺失时，按下面“首次启动认证配置”生成令牌并写入 `.env`。
3. 再次双击 `一键启动.bat`。脚本会完成环境和依赖准备，随后自动打开 `http://localhost:8080`。
4. 浏览器弹出登录框时，用户名输入 `admin`，密码输入你保存的 `DASHBOARD_TOKEN`。
5. 在网页里任选一个交易所（比如 Decibel），点 **🎯 智能填充参数**，再点 **启动 Decibel 网格**。
6. 完成！观察总览页的盈亏变化。想停就点 **停止 + 撤单 + 平仓**，想关程序就关掉那个黑色命令行窗口。

### 首次启动认证配置

在 PowerShell 运行以下命令生成 64 位随机十六进制令牌：

```powershell
$tokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tokenBytes)
-join ($tokenBytes | ForEach-Object { $_.ToString('x2') })
```

把输出值写入本机 `.env`，不要加到 README、截图或 Git 提交中：

```dotenv
DASHBOARD_TOKEN=这里粘贴刚生成的随机值
```

---

## 三、一键启动脚本做了什么

`一键启动.bat`（模拟模式）逐步执行以下动作，全程无需手动干预：

1. **检查 Node.js**
   - 已安装 → 直接进入下一步；
   - 未安装 → 自动调用 Windows 自带的 winget 静默安装 Node.js LTS 版；
   - winget 也不可用（老系统）→ 自动打开 Node.js 官网下载页 `https://nodejs.org/zh-cn/download`，你手动安装后重新双击脚本即可。
2. **初始化配置**：如果没有 `.env` 文件，自动从 `.env.example` 复制一份；若 `DASHBOARD_TOKEN` 未填写或不足 16 个字符，脚本会明确提示并停止，不会以无认证状态启动。
3. **安装依赖**：如果没有 `node_modules` 文件夹（首次运行），自动执行 `npm install`，约 1–3 分钟。失败时会提示切换国内 npm 镜像的命令。
4. **启动程序**：运行 `node src/server.js`，4 秒后自动打开浏览器仪表盘。

`实盘启动.bat` 多两个保护步骤：检查 `.env` 是否存在（实盘必须先配置密钥），以及要求你手动输入 `YES` 确认才会启动。

> 💡 关闭命令行窗口或停止 Node 进程**不会自动撤销交易所挂单**。正常停机应先在仪表盘执行“停止 / 一键撤单”，确认交易所挂单已清空，再结束进程；异常中断后的接管规则见[第十二节](#十二断电--崩溃自动恢复机制)。

---

## 四、手动安装（备选方案）

如果你不想用 bat 脚本，或在 Mac / Linux 上运行：

1. 安装 [Node.js](https://nodejs.org/zh-cn/download) v20 或更高版本。验证：终端执行 `node -v` 能显示版本号。
2. 在项目文件夹打开终端，执行：
   ```bash
   npm install        # 安装依赖
   umask 077
   cp .env.example .env   # Windows 用: copy .env.example .env
   chmod 600 .env     # Linux/macOS：只允许当前用户读取密钥
   openssl rand -hex 32   # 将输出写入 .env 的 DASHBOARD_TOKEN
   npm start              # 启动，等价于 node src/server.js
   ```
3. 浏览器打开 `http://localhost:8080`，用户名使用 `admin`，密码使用 `DASHBOARD_TOKEN`。
4. 运行测试（可选）：`npm test`。

### 4.1 VPS 安全部署：SSH 或 Tailscale

VPS 上仍保持服务只监听回环地址，不要把 8080 暴露到公网：

请为机器人创建独立的 Linux 服务用户，并确保项目目录和 `.env` 不允许其他用户读取。程序会在启动时拒绝权限宽于 `0600` 的 `.env`。

```dotenv
HOST=127.0.0.1
PORT=8080
DASHBOARD_TOKEN=使用_openssl_rand_hex_32_生成并只保存在VPS
MAX_SSE_CLIENTS=10
DASHBOARD_ORIGINS=https://your-vps.your-tailnet.ts.net
```

SSH 隧道访问：

```bash
ssh -L 8080:127.0.0.1:8080 user@vps
```

随后在本机浏览器访问 `http://127.0.0.1:8080`。

已在 VPS 安装并登录 Tailscale 时，可以把本机 8080 发布到 tailnet：

```bash
sudo tailscale up
sudo tailscale serve --bg 8080
tailscale serve status
```

访问命令输出的 `https://your-vps.your-tailnet.ts.net` 地址。Tailscale ACL/Grants 是外层访问控制，应用自身的 Basic Auth 仍然启用。不要使用 `tailscale funnel`，Funnel 会把服务发布到公网。8080 也不应在云安全组或 VPS 防火墙中开放。Tailscale Serve 的当前命令与行为以[官方文档](https://tailscale.com/docs/features/tailscale-serve)为准。

---

## 五、仪表盘使用教程

启动后浏览器打开 `http://localhost:8080`，顶部有总览、三个交易所控制台、PopDEX Agent、AI 助手和 IP 配置页签。

### 5.1 总览页

三张卡片分别对应三个交易所，实时显示（每秒刷新）：

- **运行状态**：是否在跑、paper/live 模式
- **余额 / 权益**：账户余额和含未实现盈亏的总权益
- **总盈亏** = 已实现盈亏 + 未实现盈亏，以及收益率百分比
- **成交量 / 完成格数**：累计成交额和已完成的"买-卖"完整来回次数
- **挂单数**：本地跟踪的挂单 vs 交易所实际挂单（对账用）
- **出区间警示**：价格冲出网格区间时高亮提醒

点"进入 XX 控制台 →"跳到对应交易所页面。

### 5.2 交易所控制台（三个所界面相同）

**第一步：选交易对**。下拉框列出该所全部可交易市场（如 BTC/USD、ETH/USD）。

**第二步：看趋势（可选）**。选择 K 线周期后，程序自动拉取近 200 根 K 线做趋势分析（涨/跌/震荡、强度、波动率 ATR），并给出推荐的网格类型。

**第三步：填参数**。两种方式：

- **🎯 智能填充参数**（推荐新手）：根据趋势分析自动填好网格类型、上下边界、网格数量、每格数量。你只需要检查一下再启动。还可以点"采用推荐策略 + 自动区间"完全托管。
- **手动填写**：
  | 参数 | 含义 |
  |---|---|
  | 网格类型 | 中性 / 做多 / 做空（详见第六节） |
  | 下边界 / 上边界 | 网格区间的最低价和最高价 |
  | 网格数量 | 区间内均分成多少格，格数越多格距越小、成交越频繁 |
  | 每格数量(币) | 每一格挂单的币数量（如 0.001 BTC） |
  | 杠杆 (x) | 使用的杠杆倍数，程序有保证金预检查，超了不让启动 |
  | 稳健 / 激进 | 快捷预设：稳健=成交少更安全，激进=成交频繁风险高 |
  | 区间外止损策略 | 价格冲出区间怎么办：`平仓` 或 `只减仓回收阶梯` |

**第四步：点"启动 XX 网格"**。程序会先做风控检查（保证金够不够、格距是否大于手续费成本），通过后一次性铺满区间挂单。

**运行中可用的操作**：

- **调整区间（不停止网格）**：直接改上下边界，程序增补/撤销对应挂单
- **撤销所有挂单（保留持仓）**：清掉挂单但不动仓位
- **停止 + 撤单 + 平仓**：完全退出，市价平掉持仓
- **重置统计（盈亏/成交量清零）**：只清显示数据，不动交易
- **🔌 重连交易所（不动挂单/持仓）**：网络闪断后重建连接并自动对账续跑

**遗留持仓处理**：如果程序重启后发现交易所上还有没处理完的持仓，界面会弹出三个选项：
① 只减仓回收阶梯（挂 reduce-only 单逐步退出）② 按现价重开网格 ③ 市价平仓。

### 5.3 ⚙ IP 配置页

给三个交易所配置网络代理（部分地区直连不了交易所 API 时需要）：

- **全局代理**：一个地址同时用于三个所（优先级最高）
- **各所独立代理**：给不同交易所配不同出口 IP
- **检测当前出口 IP**：验证代理是否生效
- 点"写入 .env"保存，重启程序后生效

格式见[第八节](#八代理--ip-配置)。

### 5.4 🔐 PopDEX 临时 Agent 授权页

这一页与 Decibel、Extended、RISEx 的机器人运行完全隔离，只负责 Agent 授权，不提供 PopDEX 下单按钮。主钱包私钥不要填写到 `.env`、网页或任何程序输入框；主钱包只在浏览器钱包弹窗中确认链上授权交易。

操作顺序：

1. 点“生成临时 Agent”，立即离线备份页面显示的一次性私钥。
2. 点“连接钱包并授权”，确认当前钱包是 `POPDEX_MAIN_ACCOUNT` 对应主账户，并在钱包中确认交易。
3. 页面完成链上回验后，点“验证并保存到 VPS”。只有这一步会把 Agent 私钥写入 `.env`，保存后页面立即清除内存中的私钥。
4. 不再使用时点“撤销 Agent 并清除本地私钥”。程序会先等待链上撤销回验成功，再清除 VPS 中的 Agent 私钥。

如果钱包提示未知网络，不要手填来历不明的 RPC 参数；先在 PopDEX 官方页面连接钱包并添加 PopDEX Mainnet，再回来重试。如果授权交易已成功但页面回验失败，保留已备份的 Agent 私钥并刷新状态，不要重复授权。

完成授权后，可在项目目录运行独立的单笔写入探针。它只支持 BTCUSDT / ETHUSDT，默认只做只读校验和交易编码，不发送交易：

```bash
npm run popdex:verify
npm run popdex:verify -- --account-env POPDEX_MAIN_ACCOUNT
npm run popdex:write-probe -- --symbol BTCUSDT --side buy --price <盘口外价格> --qty <满足10_USDT最小名义价值的数量>
```

dry-run 会额外显示 `availableMargin`。确认 `POPDEX_MAIN_ACCOUNT` 正是已入金的 PopDEX 主账户、可用保证金至少覆盖本次订单的完整名义金额，并确认网页没有未知挂单或持仓后，才可用同一组最小金额参数显式执行一次真实下单—撤单验收：

```bash
npm run popdex:write-probe -- --symbol BTCUSDT --side buy --price <同一价格> --qty <同一数量> --confirm-mainnet-write
```

最后一条命令会先读取官方账户概览；可用保证金不足时会在签名和广播前拒绝。通过后才向 PopDEX Mainnet 发送真实限价单，解析同一交易回执的 `OrderCreate` 事件，并用官方 REST 精确核对 `clientOid`、订单状态与数量，确认挂单后才自动尝试撤单；撤单同样需要 `OrderCancel` 回执和 REST 零成交终态共同确认。任何阶段失败都不要重复执行实盘命令；先到 PopDEX 网页核对挂单和持仓，再运行只读恢复检查：

```bash
npm run popdex:write-probe -- --resume
```

`--resume` 不会发送交易。成功下单回执与 REST 都表明订单仍活动时，它会输出 `active-manual-cancel-required`；只有 REST 明确返回 `Cancelled`、成交量为零且数量守恒时才会清除恢复记录。若下单回执明确失败，则还必须确认 REST 和预编译活动/完成查询都不存在该订单，才会输出 `reverted-placement-cleared`。回执缺失、格式不一致、查询冲突或任何成交都会保留记录并拒绝重试。

如果 PopDEX 网页无法连接钱包撤销探针遗留订单，可在普通 `--resume` 已确认 `source=receipt+REST`、REST 状态精确为 `NewAccept` 且成交量为零后，显式授权临时 Agent 只撤销恢复记录中唯一那一单：

```bash
npm run popdex:write-probe -- --resume --confirm-mainnet-cancel
```

这条命令会发送一笔 PopDEX Mainnet 撤单交易，但不会创建新订单。它会再次校验 Agent 授权、订单身份和零成交事实，广播一次撤单，随后通过 `OrderCancel` 回执和官方 REST 确认零成交终态；确认成功才清除恢复记录。若日志阶段已经是 `CANCEL_BROADCAST`，严禁再次执行该命令，只运行普通 `--resume` 查询既有撤单结果。任何成交、待发送/待确认/待撤状态、订单身份冲突或非 REST+回执事实都会在构造写客户端前拒绝。

建议先用 BTCUSDT 最小金额完成闭环，再单独验收 ETHUSDT。本阶段尚未开放 PopDEX 自动网格、服务器交易路由或网页交易；该探针不能替代实盘网格验收。

### 5.5 🤖 AI 助手页

见[第九节](#九ai-助手配置)。

---

## 六、网格策略原理与参数详解

### 6.1 网格是怎么赚钱的

在你设定的价格区间 `[下边界, 上边界]` 内均匀画出 N 条价格线（格线）。程序在现价**下方格线挂买单、上方格线挂卖单**。价格每穿过一条格线就会成交一单，成交后程序立刻在**相邻一格**挂出反向单：

- 买单成交 → 在上方一格挂卖单（等反弹卖出）
- 卖单成交 → 在下方一格挂买单（等回落买回）

每完成一次"买入→卖出"来回，就赚到 `格距 × 每格数量` 的差价（扣除手续费）。**震荡行情来回越多赚越多；单边行情冲出区间就会被套**，所以区间外策略和止损很重要。

### 6.2 三种网格类型

| 类型 | 挂单方式 | 适合行情 |
|---|---|---|
| 中性 | 现价下方挂买单、上方挂卖单，双向开仓 | 横盘震荡 |
| 做多 | 只在下方挂买单（低吸），涨上去只挂平多的卖单 | 震荡偏涨 |
| 做空 | 只在上方挂卖单（高抛），跌下来只挂平空的买单 | 震荡偏跌 |

做多网格的卖单、做空网格的买单都是 **reduce-only（只减仓）**，不会反向开仓。

### 6.3 参数选择建议

- **区间**：包住近期主要震荡范围。区间太窄容易冲出去，太宽则格距大、成交少。"智能填充"会按 ATR 波动率自动算。
- **格数**：格距 = (上边界 − 下边界) / 格数。**格距必须明显大于一来一回的手续费**，否则做一单亏一单——程序启动时会强制校验这一点。
- **每格数量**：决定资金占用。程序启动前做保证金预检查：所有格子同方向全部成交时所需保证金不能超过 `余额 × 杠杆`。
- **杠杆**：放大收益也放大爆仓风险。新手建议 ≤ 5x，先用模拟盘试。
- **区间外策略**：`平仓`（冲出区间立即撤单+平仓+停止，损失确定）或 `recover 只减仓回收`（挂 reduce-only 阶梯单等价格回来逐步退出，不追加风险但退出时间不确定）。

---

## 七、实盘模式：API 密钥获取与配置

> 当前三所均支持实盘。RISEx 只允许官方 mainnet，且只开放 BTC-PERP / ETH-PERP。

### 实盘启动检查清单

- 已执行 `npm ci` 和 `npm test`，全部通过。
- Linux/macOS 的 `.env` 已执行 `chmod 600 .env`，VPS 使用独立服务用户。
- `HOST=127.0.0.1`，只通过 SSH 隧道或 Tailscale Serve 访问；未开放 8080 公网端口、未启用 Funnel。
- 先在 paper 或交易所测试网验证相同参数，再从可承受损失的最小仓位开始。
- 首次只启用一家实盘交易所，并在交易所网页核对挂单、持仓和撤单结果。

### 7.0 总体步骤

1. 用记事本（或任何文本编辑器）打开项目文件夹里的 `.env` 文件（没有就先复制 `.env.example` 改名为 `.env`；注意文件名就是 `.env`，前面有个点，没有别的后缀）。
2. 把要实盘的交易所模式改为 `DE_MODE=live`（Decibel）、`EX_MODE=live`（Extended）或 `RS_MODE=live`（RISEx）。
3. 按下面各小节获取并填入对应凭据。
4. 保存 `.env`，双击 `实盘启动.bat`，输入 `YES` 确认启动。
5. 启动日志里看到 `[XX] ✓ 连接成功 [LIVE 模式]` 即成功。

> ⚠️ 填写规则：等号后面直接跟值，不要加空格和引号（例：`DECIBEL_API_KEY=abc123`）。私钥是极度敏感信息，`.env` 绝不要发给任何人、绝不要提交到 GitHub（本项目 `.gitignore` 已默认排除）。

### 7.1 Decibel（Aptos 链）

需要填 3 项：

```ini
DE_MODE=live
DECIBEL_API_KEY=       # ① API Key
DECIBEL_PRIVATE_KEY=   # ② API 钱包 Ed25519 私钥
DECIBEL_SUBACCOUNT=    # ③ Trading Account 地址
```

获取步骤：

1. **① API Key**：到 **geomi.dev**（Aptos 官方 API 网关，原 Aptos Build）注册账号 → 创建项目 → 生成 API Key。这是访问 Aptos 全节点 API 的通行证。
2. **② API 钱包私钥**：打开 **app.decibel.trade/api** → 连接你的钱包 → 创建 **API Wallet**，会生成一个 Ed25519 私钥。这个 API 钱包只有交易权限，不能提币，安全性比主钱包私钥高。复制生成的私钥填入。
3. **③ Trading Account 地址**：在 Decibel 交易界面里查看你的 **Trading Account（子账户）地址**（0x 开头的一长串），复制填入。
4. 确保该 Trading Account 里有 USDC 作为保证金。

### 7.2 Extended（Starknet 链）

需要填 4 项：

```ini
EX_MODE=live
EXTENDED_API_KEY=              # ① API Key
EXTENDED_VAULT=                # ② Vault ID
EXTENDED_STARK_PRIVATE_KEY=    # ③ Stark 私钥
EXTENDED_STARK_PUBLIC_KEY=     # ④ Stark 公钥
```

获取步骤：

1. 打开 **app.extended.exchange**，连接钱包并完成开户（首次会创建你的 Starknet 交易账户）。
2. 进入 **API Management**（一般在账户设置 / 头像菜单里）→ 点 **Create API Key**。
3. 页面会一次性展示 4 个值：**API Key、Vault（数字 ID）、Stark Private Key、Stark Public Key**。⚠️ 私钥只显示一次，务必当场复制保存。
4. 四个值对应填入 `.env`。`EXTENDED_MAX_FEE`（最大手续费率）保持默认 `0.0005` 即可。
5. 确保账户里有 USDC 保证金。

### 7.3 RISEx

RISEx live 只支持官方 mainnet 的 BTC-PERP / ETH-PERP。请使用独立的小资金 RISEx 账户，不要与人工交易或其他机器人共享；`RISEX_SIGNER_KEY` 必须是该账户已注册的 session signer 私钥。

```ini
RS_MODE=live
RS_NETWORK=mainnet
RISEX_ACCOUNT=0x你的独立RISEx账户地址
RISEX_SIGNER_KEY=0x已注册的session signer私钥
RISEX_API_URL=https://api.rise.trade
RISEX_WS_URL=wss://api.rise.trade/ws/
```

官方 endpoint 在 live 模式不可替换。适配器以私有 Orders/Fills WebSocket 与 REST 对账共同确认成交、撤单和持仓；无法确认或发现冲突时进入 `HALTED`，不会猜测订单状态或自动清理未知订单。

首次人工验收按顺序执行：

1. 创建独立 RISEx 小资金账户并注册 session signer，不要复用主钱包或共享账户。
2. 填写上面的环境变量；Linux/VPS 执行 `chmod 600 .env`。
3. 执行 `npm ci`、`npm test`，确认全部通过。
4. 执行 `npm run risex:verify`，确认官方 chain/domain、BTC/ETH 行情和公共 WebSocket 通过。
5. 由你本人执行 `npm run risex:verify -- --private`，只读确认 signer、余额、挂单、持仓和私有 Orders 快照；输出不会打印私钥、订单 ID 或 fill ID。
6. 启动服务后只选 BTC-PERP 或 ETH-PERP，用可承受全部损失的最小仓位和低杠杆启动第一个网格。
7. 在 RISEx 网页逐项核对挂单、成交、撤单和平仓；正常停机先在仪表盘停止并确认挂单清空，再结束 Node 进程。

### 7.4 测试网练手（可选）

Decibel 和 Extended 可先连测试网走完整下单流程：把对应的 `DE_NETWORK` / `EX_NETWORK` 改为 `testnet`，再使用测试网凭据。RISEx 适配器不支持 testnet，实盘验收必须按 7.3 的小资金人工步骤执行。

---

## 八、代理 / IP 配置

部分地区网络直连不了交易所 API，需要代理。两种配置方式：**仪表盘 ⚙ IP配置页**（推荐，可在线检测）或直接编辑 `.env`。

```ini
# 全局代理：三个所共用（优先级最高）
GLOBAL_PROXY=

# 各所独立代理（仅当 GLOBAL_PROXY 为空时生效）
DECIBEL_PROXY=
EXTENDED_PROXY=
RISEX_PROXY=
```

支持的格式：

| 格式 | 示例 |
|---|---|
| HTTP(S) 代理 | `http://127.0.0.1:7890` |
| SOCKS5 代理 | `socks5://127.0.0.1:1080` |
| 带账号密码 | `socks5://user:pass@host:port` |
| 简写格式 | `host:port:user:pass` |

启动时程序会自动检测代理连通性并打印出口 IP。**实盘模式下代理不通会直接中止启动**（防止断网状态下挂单失控）；模拟模式则继续运行但可能拿不到真实行情。

> 💡 用本机代理软件（如 Clash 默认 `http://127.0.0.1:7890`）时，请保证代理软件先启动。

---

## 九、AI 助手配置

AI 助手是**可选**功能，不配置完全不影响交易。它把你自己的大模型 API 接进来，提供风控哨兵、日报、市况分析、对话操控、出区间建议五个能力。

### 9.1 在仪表盘配置（推荐）

打开 **🤖 AI助手** 页签 → 选择**服务商**（会自动填好协议、接口地址、推荐模型）→ 填入 **API Key** → 点**测试连接** → 通过后点**保存配置**（自动写入 `.env`）。

### 9.2 支持的服务商与 Key 获取

`AI_PROVIDER` 只有三种协议：`openai`（所有 OpenAI 兼容服务都选它）、`anthropic`、`gemini`。

| 服务商 | AI_PROVIDER | AI_BASE_URL | Key 获取地址 |
|---|---|---|---|
| DeepSeek（便宜好用） | `openai` | `https://api.deepseek.com/v1` | platform.deepseek.com |
| Kimi / 月之暗面 | `openai` | `https://api.moonshot.cn/v1` | platform.moonshot.cn |
| 通义千问 | `openai` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 阿里云百炼控制台 |
| OpenAI | `openai` | 留空 | platform.openai.com |
| OpenRouter（聚合） | `openai` | `https://openrouter.ai/api/v1` | openrouter.ai |
| Claude / Anthropic | `anthropic` | 留空 | console.anthropic.com |
| Gemini / Google | `gemini` | 留空 | aistudio.google.com |
| Ollama（本地免费） | `openai` | `http://127.0.0.1:11434/v1` | 无需 Key，本地跑 |

通用流程：注册账号 → 控制台里找 **API Keys** → 创建 Key（一般 `sk-` 开头）→ 复制填入。多数国产服务需要先充值几块钱。

### 9.3 相关配置项

```ini
AI_PROVIDER=openai
AI_API_KEY=sk-xxxx
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat        # 主模型：复盘/分析/对话
AI_MODEL_SMALL=               # 小模型：哨兵高频巡检省钱，留空=同主模型
AI_SENTINEL_MINUTES=5         # 哨兵巡检间隔（分钟，0=关闭）
AI_MARKET_MINUTES=30          # BTC 市况报告间隔（分钟，0=关闭）
AI_REPORT_HOUR=20             # 每天几点生成日报（0-23 整点）
```

### 9.4 对话操控示例

在 AI 助手页的对话框输入自然语言，例如：

- "三个所现在整体情况怎么样？"
- "把 Extended 上边界调到 66000"
- "Decibel 该不该止损？"

涉及**写操作**（调区间、停止等）时 AI 只会提出建议，网页弹出确认框，你点确认才真正执行——AI 无法擅自动你的仓位。

---

## 十、通知推送（Telegram / Webhook）

配置后，哨兵告警、日报、重要事件会自动推送到你手机。不配则只在网页显示。

### Telegram 机器人（推荐）

1. 在 Telegram 搜索 **@BotFather** → 发送 `/newbot` → 按提示给机器人起名 → 得到 **Bot Token**（形如 `123456:ABC-xxx`），填入 `TELEGRAM_BOT_TOKEN`。
2. 获取你的 **Chat ID**：给刚创建的机器人随便发一条消息，然后浏览器打开 `https://api.telegram.org/bot<你的Token>/getUpdates`，返回 JSON 里 `"chat":{"id":123456789}` 的数字就是 Chat ID，填入 `TELEGRAM_CHAT_ID`。（或者直接给 @userinfobot 发消息查自己的 ID。）
3. 保存后在 AI 助手页可以点"立即巡检一次"测试推送。

### 通用 Webhook

`NOTIFY_WEBHOOK=https://你的接收地址`，程序会 POST `{"text": "消息内容"}`，可对接企业微信 / 钉钉 / 飞书机器人或自建服务。

---

## 十一、.env 配置项完整对照表

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 仪表盘端口，被占用时改成 8081 等 |
| `HOST` | `127.0.0.1` | 监听地址；VPS 保持回环监听 |
| `DASHBOARD_TOKEN` | 无，必填 | Basic Auth 密码，至少 16 字符；用户名固定 `admin` |
| `DASHBOARD_ORIGINS` | 空 | 允许的反向代理 Origin，多个值用英文逗号分隔 |
| `MAX_SSE_CLIENTS` | `10` | 每类 SSE 流最大连接数，范围 1-100 |
| `PAPER_BALANCE` | `10000` | 模拟模式初始虚拟余额（USDC） |
| `GLOBAL_PROXY` | 空 | 全局代理，见第八节 |
| `DECIBEL_PROXY` / `EXTENDED_PROXY` / `RISEX_PROXY` | 空 | 各所独立代理 |
| `DE_MODE` / `EX_MODE` / `RS_MODE` | `paper` | 各交易所独立选择 `paper` 或 `live` |
| `DE_NETWORK` / `EX_NETWORK` | `mainnet` | Decibel / Extended 主网或测试网 |
| `RS_NETWORK` | `mainnet` | RISEx 固定为 mainnet |
| `DECIBEL_API_KEY` | 空 | Decibel：geomi.dev 的 API Key |
| `DECIBEL_PRIVATE_KEY` | 空 | Decibel：API 钱包 Ed25519 私钥 |
| `DECIBEL_SUBACCOUNT` | 空 | Decibel：Trading Account 地址 |
| `DECIBEL_API_URL` | 官方默认 | 自定义 API 地址，一般不填 |
| `EXTENDED_API_KEY` | 空 | Extended：API Key |
| `EXTENDED_VAULT` | 空 | Extended：Vault ID |
| `EXTENDED_STARK_PRIVATE_KEY` / `EXTENDED_STARK_PUBLIC_KEY` | 空 | Extended：Stark 密钥对 |
| `EXTENDED_MAX_FEE` | `0.0005` | Extended 最大手续费率 |
| `EXTENDED_API_URL` | 官方默认 | 自定义 API 地址 |
| `POPDEX_MAIN_ACCOUNT` | 空 | PopDEX 公开主账户地址；用于只读验证和 Agent 授权回验 |
| `POPDEX_AGENT_PRIVATE_KEY` | 空 | 仅保存临时 Agent 私钥；建议由仪表盘授权页回验后写入，绝不是主钱包私钥 |
| `RISEX_ACCOUNT` | 空 | RISEx live 独立账户的 EVM 地址 |
| `RISEX_SIGNER_KEY` | 空 | RISEx live 已注册 session signer 的私钥 |
| `RISEX_API_URL` | `https://api.rise.trade` | RISEx 官方 REST 地址；live 不可替换 |
| `RISEX_WS_URL` | `wss://api.rise.trade/ws/` | RISEx 官方 WebSocket 地址；live 不可替换 |
| `AI_PROVIDER` | `openai` | AI 协议：`openai` / `anthropic` / `gemini` |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` / `AI_MODEL_SMALL` | 空 | 见第九节 |
| `AI_SENTINEL_MINUTES` | `5` | 哨兵巡检间隔（分钟，0=关） |
| `AI_MARKET_MINUTES` | `30` | 市况报告间隔（分钟，0=关） |
| `AI_REPORT_HOUR` | `20` | 日报生成时间（0-23 点） |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 空 | Telegram 推送，见第十节 |
| `NOTIFY_WEBHOOK` | 空 | 通用 Webhook 推送地址 |

---

## 十二、断电 / 崩溃自动恢复机制

程序每次状态变化都会把快照写入项目目录下的 `.state.json`（自动生成，含配置、挂单、累计统计）。重启后：

1. **上次是运行状态** → 按市场名称重新解析交易对，接管还挂着的单；首次对账成功后才恢复运行。RISEx 必须同时完成私有 Orders 快照与 REST 对账屏障。
2. **实盘交易所初始化失败** → 整个服务停止启动，不会把离线交易所伪装成可用状态；现有挂单保持不动，需先到交易所网页确认。
3. **续跑或首次对账失败** → 服务停止启动并打印原因；RISEx 会进入 `HALTED`，不会根据订单消失推测成交，也不会自动撤销无法确认归属的订单。
4. **发现遗留持仓** → 界面弹三选项：只减仓回收 / 按现价重开网格 / 市价平仓。

累计盈亏、成交量等统计也随快照保留，跨重启连续显示。想清零就点"重置统计"。

---

## 十三、REST API 一览（进阶）

服务是纯 HTTP + SSE，可以自行编程调用。`{ex}` 为 `de` / `ex` / `rs`。所有请求都需要 HTTP Basic Auth（用户名 `admin`）；所有 POST 还必须使用 `Content-Type: application/json` 并携带 `X-Dex-Request: 1`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/overview` | 三所总览 |
| GET | `/api/overview/stream` | 总览 SSE 实时流 |
| GET | `/api/{ex}/markets` | 市场列表 |
| GET | `/api/{ex}/trend?marketId=&intervalSec=` | K 线 + 趋势分析 |
| GET | `/api/{ex}/state` | 机器人当前状态 |
| GET | `/api/{ex}/stream` | 单所 SSE 实时流 |
| POST | `/api/{ex}/start` | 启动网格（JSON：marketId, mode, lower, upper, gridCount, sizeBase, leverage, outOfRangeAction） |
| POST | `/api/{ex}/stop` | 停止（`{"closePosition": true/false}`） |
| POST | `/api/{ex}/adjust` | 在线调整区间 |
| POST | `/api/{ex}/cancel-orders` | 撤所有挂单 |
| POST | `/api/{ex}/close-position` | 市价平仓 |
| POST | `/api/{ex}/start-recovery` | 启动只减仓回收阶梯 |
| POST | `/api/{ex}/reset` | 重置统计 |
| POST | `/api/{ex}/reconnect` | 重连交易所 |
| GET/POST | `/api/px/agent/status`, `/api/px/agent/prepare-approval`, `/api/px/agent/verify`, `/api/px/agent/save`, `/api/px/agent/prepare-revoke`, `/api/px/agent/clear` | PopDEX 临时 Agent 独立授权流程；不提供交易操作 |
| GET/POST | `/api/ai/status`, `/api/ai/test`, `/api/ai/chat`, `/api/ai/analyze`, `/api/ai/report`, `/api/ai/sentinel-run`, `/api/ai/market-run` | AI 助手相关 |
| GET | `/api/proxy-check`, `/api/proxy-config` | 代理检测 / 查询 |
| POST | `/api/env` | 写入白名单内的 .env 配置（代理 / AI / 通知类，交易密钥不允许通过此接口修改） |

---

## 十四、常见问题 FAQ

**Q：双击 bat 窗口一闪而过？**
右键 bat → 编辑，确认文件完整；或先打开 cmd，把 bat 拖进去回车运行，即可看到报错信息。

**Q：提示"端口 8080 已被占用"？**
上一个程序窗口没关，先关掉；或编辑 `.env` 把 `PORT=8080` 改成 `8081`，重启后访问 `http://localhost:8081`。

**Q：npm install 很慢或失败？**
执行 `npm config set registry https://registry.npmmirror.com` 切换国内镜像后重试。

**Q：交易所显示"初始化失败 / ENOTFOUND / 连接超时"？**
网络问题。到 ⚙ IP配置页配置代理（见第八节），点"检测当前出口 IP"验证，然后点 🔌 重连交易所。

**Q：模拟模式的行情是真的吗？**
是。paper 模式拉真实行情、用虚拟资金撮合；拿不到行情时会退化为合成数据（界面会标注 dataSource）。

**Q：启动网格时报"格距过小"之类的错误？**
格距不够覆盖手续费。减少网格数量或扩大区间。

**Q：启动时报保证金不足？**
降低每格数量、减少格数，或提高杠杆（谨慎）。

**Q：想同时实盘 A 所、模拟 B 所可以吗？**
可以，三个所的 `*_MODE` 各自独立。

**Q：程序会把我的私钥传到哪里吗？**
不会。私钥只在本机 `.env`，仅用于给交易请求签名。代码全部开源可审计。

**Q：怎么彻底重置程序？**
关程序 → 删除 `.state.json`（和 `.env` 如果想清配置）→ 重新启动。

---

## 十五、项目结构

```
├── 一键启动.bat          # 模拟模式一键启动（自动装环境）
├── 实盘启动.bat          # 实盘模式启动（带确认）
├── .env.example          # 配置模板（复制为 .env 使用）
├── package.json          # 依赖与脚本定义
├── public/
│   └── index.html        # 仪表盘前端（单文件，无构建）
├── src/
│   ├── server.js         # HTTP/SSE 服务器与路由
│   ├── bot.js            # 网格机器人核心（下单/补单/风控/恢复）
│   ├── grid.js           # 网格纯函数（铺单/补单规则）
│   ├── config.js         # .env 加载与三所配置
│   ├── trend.js          # K 线趋势分析（智能填充用）
│   ├── indicators.js     # 技术指标
│   ├── proxy.js          # 代理设置与检测
│   ├── persist.js        # 状态快照持久化
│   ├── ai/               # AI 助手（provider 适配 + 服务）
│   └── exchange/
    │       ├── de/           # Decibel 接入（live + paper）
    │       ├── ex/           # Extended 接入（live + paper + Stark 签名）
    │       ├── px/           # PopDEX 只读 + Agent 授权 + 独立 CLI 单笔下单撤单探针
    │       └── rs/           # RISEx 接入（live + paper + 私有 WS / 订单状态机）
└── test/
    └── grid.test.js      # 网格逻辑单元测试
```

---

## 十六、安全须知

1. **`.env` 是最高机密**：里面的私钥等于你的资金控制权。不要截图、不要发群、不要提交到任何代码仓库（`.gitignore` 已默认排除，fork 后请保留）。
2. **`DASHBOARD_TOKEN` 也属于机密**：使用随机值，不要与交易所或 VPS 登录密码复用，泄露后立即更换并重启服务。
3. **优先使用交易所的 API 钱包 / API Key**，而不是主钱包私钥——API 凭据通常只有交易权限、无提币权限，泄露损失可控。
4. **实盘前先模拟**：同样的参数先在 paper 模式跑几天，理解成交节奏和风险再上真钱。
5. **小资金起步**：首次实盘用你亏得起的钱。
6. **仪表盘默认只监听本机**（localhost）。VPS 通过 SSH 隧道或 Tailscale Serve 访问，不要在安全组或防火墙公开 8080，也不要使用 Tailscale Funnel。
7. **VPS 使用独立服务用户**，并执行 `chmod 600 .env`；程序会拒绝读取权限过宽的密钥文件。
8. **RISEx 使用独立小资金账户**：不得与人工交易或其他机器人共享；私有日志保存在本机终端/进程管理器日志中，排障时不要公开 `.env`、签名或账户敏感信息。
9. **RISEx 实盘先完成人工七步验收**：程序不会自动发送真实验证订单；任何 `HALTED` 都应先到交易所网页核对挂单和持仓。
10. **PopDEX 探针不是网格机器人**：只用最小金额人工执行一次；看到失败或 `.popdex-write-probe.json` 时禁止重新下单，先核对网页并运行只读 `--resume`。仅当网页无法撤单且只读恢复严格确认 `NewAccept` 零成交时，才可显式执行 `--resume --confirm-mainnet-cancel` 撤销恢复记录中的唯一订单。
11. 本程序没有远程服务器、不上传任何数据，所有状态都在你本机。

---

祝交易顺利 📈
