# RISEx Reconnect Health and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让成功的 RISEx 重连立即恢复健康状态，修正私有只读验证仓位读取，并保留脱敏的底层网络错误链。

**Architecture:** 继续保留现有 `HALTED` 安全边界。成功的完整 REST/WS 同步作为清除旧只读错误的唯一屏障；验证器与运行时统一使用全持仓接口；新增一个无 I/O 的错误链格式化器供 REST 快照和私有认证 GET 使用。

**Tech Stack:** Node.js 20+、ES modules、node:test、risex-client 0.1.11

---

### Task 1: 成功重连清除旧健康错误

**Files:**
- Modify: `test/risex-adapter.test.js`
- Modify: `src/exchange/rs/risex.js`

- [ ] **Step 1: Write the failing test**

在重连测试中设置 `exchange._refreshError = 'fetch failed'`，执行 `reconnect()` 后断言 `getHealth().status === 'ok'` 且 `fetchOpenOrders(1)` 成功。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/risex-adapter.test.js`

Expected: FAIL，健康状态仍为 `error`。

- [ ] **Step 3: Write minimal implementation**

在 `_synchronizeLiveState` 完成 REST 快照、WS 缓冲合并和归属校验后、进入 `READY` 前执行：

```js
this._refreshError = null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/risex-adapter.test.js`

Expected: PASS。

### Task 2: 私有验证统一使用全持仓接口

**Files:**
- Modify: `test/risex-verify.test.js`
- Modify: `src/exchange/rs/verify.js`

- [ ] **Step 1: Write the failing test**

测试桩只实现 `getAllPositions(account)` 并让 `getPosition()` 抛错；断言私有验证只调用一次 `getAllPositions`，不调用 `getPosition`，BTC 仓位仍正确返回。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/risex-verify.test.js`

Expected: FAIL，旧实现调用 `getPosition`。

- [ ] **Step 3: Write minimal implementation**

在市场循环外读取并校验全持仓数组，使用市场价格映射调用 `normalizeRestPosition`，拒绝重复市场仓位，再由市场循环按 `marketId` 读取映射。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/risex-verify.test.js`

Expected: PASS。

### Task 3: 输出脱敏的网络错误链与失败阶段

**Files:**
- Create: `src/exchange/rs/error-details.js`
- Modify: `src/exchange/rs/risex.js`
- Modify: `src/exchange/rs/private-stream.js`
- Modify: `test/risex-adapter.test.js`
- Modify: `test/risex-private-stream.test.js`

- [ ] **Step 1: Write the failing tests**

构造外层 `TypeError('fetch failed')` 与内层 `Error('other side closed')`、`code='UND_ERR_SOCKET'`。断言 REST 快照错误和认证 GET 错误同时包含失败阶段、`UND_ERR_SOCKET` 与底层消息，且不包含账户和私钥。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/risex-adapter.test.js test/risex-private-stream.test.js`

Expected: FAIL，当前仅输出 `fetch failed`。

- [ ] **Step 3: Write minimal implementation**

新增纯函数遍历最多五层 `cause`，输出 `name`、`code`、脱敏后的 `message`；移除 URL 查询参数并遮蔽 40/64 字节十六进制值。REST 快照统一包装为 `RISEx REST 快照读取失败`，私有 GET 统一包装为 `RISEx GET <pathname> 失败`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/risex-adapter.test.js test/risex-private-stream.test.js`

Expected: PASS。

### Task 4: 完整验证

**Files:**
- Verify all modified files

- [ ] **Step 1: Run syntax checks**

Run: `node --check src/exchange/rs/error-details.js && node --check src/exchange/rs/risex.js && node --check src/exchange/rs/private-stream.js && node --check src/exchange/rs/verify.js`

- [ ] **Step 2: Run full tests**

Run: `node test/grid.test.js`，然后运行 `package.json` 中 `node --test` 的完整测试列表。

Expected: 所有测试通过，0 失败。

- [ ] **Step 3: Inspect final diff**

Run: `git diff --check` 和 `git status --short`。

Expected: 只有本计划列出的源代码、测试和文档发生变化。

