# RISEx Transient Auth Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a previously healthy RISEx private stream from entering permanent `HALTED` because one automatic re-authentication request returned a transient `fetch failed`.

**Architecture:** Add one shared, cause-chain-aware network error classifier to the RISEx error module. The private stream records whether it has ever authenticated; only an already authenticated stream may convert transient re-authentication failures into a closed socket plus the existing exponential reconnect loop. Initial startup, private verification, manual client rebuild, and deterministic authentication/data errors remain fail-fast.

**Tech Stack:** Node.js ES modules, `EventEmitter`, Undici WebSocket/fetch, `node:test`, `node:assert/strict`.

---

## File map

- Modify `src/exchange/rs/error-details.js`: classify transient transport failures across bounded error cause chains while preserving the existing sanitizer.
- Modify `src/exchange/rs/private-stream.js`: distinguish runtime re-authentication transport failures from deterministic fatal errors.
- Modify `test/risex-private-stream.test.js`: reproduce the VPS `fetch failed`, verify reconnect recovery, and preserve initial/fatal boundaries.
- Modify `AGENTS.md`: record the RISEx automatic reconnect safety boundary as project truth.

### Task 1: Classify RISEx transient network failures

**Files:**
- Modify: `src/exchange/rs/error-details.js:1-27`
- Test: `test/risex-private-stream.test.js:1-4`

- [x] **Step 1: Import and test the wished-for classifier**

Change the test import and add one focused test near the constants:

```js
import { RisexPrivateStream } from '../src/exchange/rs/private-stream.js';
import { isTransientNetworkError } from '../src/exchange/rs/error-details.js';

test('RISEx transient network classification follows nested causes but rejects HTTP failures', () => {
  const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const fetchError = new TypeError('fetch failed', { cause: socketError });

  assert.equal(isTransientNetworkError(fetchError), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(isTransientNetworkError(new Error('RISEx GET /v1/auth/nonce 失败：HTTP 403。')), false);
  assert.equal(isTransientNetworkError(new Error('RISEx auth_v2 EIP-712 domain 名称或版本不匹配。')), false);
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/risex-private-stream.test.js
```

Expected: FAIL at module loading because `error-details.js` does not export `isTransientNetworkError`.

- [x] **Step 3: Implement the bounded classifier**

Add to `src/exchange/rs/error-details.js` without changing `describeError()`:

```js
const TRANSIENT_CODES = /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_[A-Z_]+)$/i;
const TRANSIENT_MESSAGES = /fetch failed|network error|socket (?:hang up|closed|error)|other side closed|connection (?:reset|refused|closed)|timed?\s*out|超时|连接.*(?:中断|断开|重置|拒绝)/i;

export function isTransientNetworkError(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current != null && depth < 5 && !seen.has(current); depth += 1) {
    if ((typeof current === 'object' || typeof current === 'function') && current !== null) {
      seen.add(current);
    }
    if (current?.name === 'AbortError') return true;
    if (TRANSIENT_CODES.test(String(current?.code ?? ''))) return true;
    if (TRANSIENT_MESSAGES.test(String(current?.message ?? current))) return true;
    current = current?.cause;
  }
  return false;
}
```

The HTTP 403 fixture must remain false because it contains no transport code/cause and no transient phrase.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
node --test test/risex-private-stream.test.js
```

Expected: all private-stream tests pass.

- [x] **Step 5: Commit the classifier**

```bash
git add src/exchange/rs/error-details.js test/risex-private-stream.test.js
git commit -m "修复：识别RISEx临时网络错误"
```

### Task 2: Recover runtime signer-check fetch failures without HALTED

**Files:**
- Modify: `src/exchange/rs/private-stream.js:3,76-91,158-162,320-329,380-408`
- Test: `test/risex-private-stream.test.js:225-237`

- [x] **Step 1: Write the runtime re-authentication regression test**

Add after the existing disconnect test:

```js
test('runtime signer-check fetch failure reconnects without fatal and later authenticates', async () => {
  let failSignerCheck = false;
  const logs = [];
  const harness = makeHarness({
    isSignerRegistered: async () => {
      if (!failSignerCheck) return true;
      const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
      throw new TypeError('fetch failed', { cause: socketError });
    },
    logger: { log() {}, error(message) { logs.push(message); } },
  });
  let fatals = 0;
  harness.stream.on('fatal', () => { fatals += 1; });

  const firstSocket = await openAndAuthenticate(harness);
  firstSocket.emit('close', { code: 1006, reason: 'network' });
  failSignerCheck = true;

  const failedRetry = harness.scheduled.at(-1).fn();
  const failedConnect = harness.stream._connectPromise;
  const failedSocket = FakeSocket.instances.at(-1);
  failedSocket.emit('open');
  await assert.rejects(failedConnect, /fetch failed/);
  await failedRetry;
  await waitFor(() => harness.scheduled.length >= 2);

  assert.equal(fatals, 0);
  assert.equal(harness.stream.authenticated, false);
  assert.match(logs.join('\n'), /临时认证错误/);
  assert.match(logs.join('\n'), /UND_ERR_SOCKET/);

  failSignerCheck = false;
  const recoveredRetry = harness.scheduled.at(-1).fn();
  const recoveredSocket = FakeSocket.instances.at(-1);
  recoveredSocket.emit('open');
  await waitFor(() => recoveredSocket.sent.length === 1);
  recoveredSocket.message({ method: 'auth_v2', status: 'success' });
  await recoveredRetry;

  assert.equal(harness.stream.authenticated, true);
  assert.equal(fatals, 0);
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/risex-private-stream.test.js
```

Expected: FAIL because the signer-check exception calls `_fatal()`, increments `fatals`, sets `_stopped`, and does not schedule a second reconnect.

- [x] **Step 3: Add the authenticated-history and failure-routing state**

Update imports and constructor state:

```js
import { describeError, isTransientNetworkError } from './error-details.js';

this.authenticated = false;
this._everAuthenticated = false;
```

Route authentication errors through a new method and record successful history:

```js
socket.addEventListener('open', () => {
  this._logger.log?.('[RISEx WS] 已连接，开始 auth_v2。');
  this._authenticate().catch((error) => this._handleConnectionFailure(error));
});

_authSucceeded() {
  if (this.authenticated) return;
  this.authenticated = true;
  this._everAuthenticated = true;
  // keep the remaining existing method body unchanged
}
```

Reset `_everAuthenticated` only in the existing explicit `stop()` path so an intentionally stopped stream cannot later inherit runtime-reconnect privileges:

```js
stop() {
  this._stopped = true;
  this.authenticated = false;
  this._everAuthenticated = false;
  // keep the remaining existing method body unchanged
}
```

- [x] **Step 4: Implement recoverable reconnect handling**

Add immediately before `_fatal()`:

```js
_handleConnectionFailure(error) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (!this._everAuthenticated || !isTransientNetworkError(normalized)) {
    this._fatal(normalized);
    return;
  }
  this._logger.error?.(`[RISEx WS] 临时认证错误：${describeError(normalized)}`);
  this.authenticated = false;
  this._rejectSnapshotWaiters(normalized);
  this._rejectConnect(normalized);
  const socket = this._socket;
  this._socket = null;
  socket?.close?.();
  this._scheduleReconnect();
}
```

Do not set `_stopped`, emit `fatal`, clear buffers, or mark authentication successful.

- [x] **Step 5: Run private stream and adapter tests**

Run:

```bash
node --test test/risex-private-stream.test.js test/risex-adapter.test.js
```

Expected: PASS; the new regression test reconnects, and existing tests still prove writes remain blocked during `RECONCILING` and exact REST/WS reconciliation is required before `READY`.

- [x] **Step 6: Commit the runtime reconnect fix**

```bash
git add src/exchange/rs/private-stream.js test/risex-private-stream.test.js
git commit -m "修复：恢复RISEx运行中认证网络故障"
```

### Task 3: Apply the same boundary to runtime authentication timeouts

**Files:**
- Modify: `src/exchange/rs/private-stream.js:427-432`
- Test: `test/risex-private-stream.test.js:239-253,272-297`

- [x] **Step 1: Add initial fail-fast and runtime timeout tests**

Extend the existing initial timeout test with a fatal assertion:

```js
let initialFatal = null;
harness.stream.once('fatal', (error) => { initialFatal = error; });
deadline.fn();
await assert.rejects(connecting, /认证 20ms 超时/);
assert.match(initialFatal?.message || '', /认证 20ms 超时/);
```

Add a runtime timeout test:

```js
test('runtime authentication timeout reconnects while initial timeout remains fatal', async () => {
  const deadlines = [];
  const harness = makeHarness({
    connectTimeoutMs: 20,
    setDeadline: (fn, ms) => { deadlines.push({ fn, ms }); return deadlines.length; },
    clearDeadline() {},
  });
  let fatals = 0;
  harness.stream.on('fatal', () => { fatals += 1; });
  const firstSocket = await openAndAuthenticate(harness);
  firstSocket.emit('close', { code: 1006, reason: 'network' });

  const reconnecting = harness.scheduled.at(-1).fn();
  const runtimeConnect = harness.stream._connectPromise;
  const runtimeDeadline = deadlines.at(-1);
  runtimeDeadline.fn();
  await assert.rejects(runtimeConnect, /认证 20ms 超时/);
  await reconnecting;
  await waitFor(() => harness.scheduled.length >= 2);

  assert.equal(fatals, 0);
  assert.equal(harness.stream.authenticated, false);
});
```

- [x] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test test/risex-private-stream.test.js
```

Expected: initial timeout assertion passes, but runtime timeout test fails because `_startConnectDeadline()` calls `_fatal()` directly.

- [x] **Step 3: Route the connection deadline through the classifier**

Change only the deadline callback:

```js
this._connectDeadline = this._setDeadline(() => {
  this._connectDeadline = null;
  this._handleConnectionFailure(
    new Error(`RISEx 私有 WebSocket 认证 ${this._connectTimeoutMs}ms 超时。`),
  );
}, this._connectTimeoutMs);
```

Because `_everAuthenticated` is false during initial startup, the same error remains fatal there. After a successful historical authentication it is transient and enters the reconnect path.

- [x] **Step 4: Run all RISEx tests**

Run:

```bash
node --test test/risex-normalize.test.js test/risex-order-state.test.js test/risex-private-stream.test.js test/risex-mainnet-client.test.js test/risex-adapter.test.js test/risex-verify.test.js
```

Expected: all RISEx tests pass with zero failures.

- [x] **Step 5: Commit timeout handling**

```bash
git add src/exchange/rs/private-stream.js test/risex-private-stream.test.js
git commit -m "修复：重试RISEx运行中认证超时"
```

### Task 4: Record the safety boundary and verify the repository

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-08-19-risex-transient-auth-reconnect.md`

- [x] **Step 1: Update the project source of truth**

Add one RISEx rule to `AGENTS.md`:

```md
- RISEx 已成功认证后的私有流自动重连若遇到可证明的临时网络错误，必须保持 `RECONCILING`、禁止新增风险写入并按 1–30 秒指数退避持续重试；只有完成新的 REST/WS 所有权对账才可恢复 `READY`。初次启动、私有验证、人工重建客户端及 signer/签名/domain/nonce/schema/身份冲突仍须 fail-fast 或进入 `HALTED`，不得把 HTTP 拒绝或确定性错误伪装成网络抖动。
```

- [x] **Step 2: Run static scope checks**

Run:

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

Expected: only the design/plan, `AGENTS.md`, two RISEx source files, and one RISEx test file appear; no `.env`, state files, credentials, Decibel, PopDEX, bot, server, or frontend files appear.

- [x] **Step 3: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all tests pass, `fail 0`, with no unhandled exception.

- [x] **Step 4: Mark this plan complete and commit documentation**

Change every completed checkbox in this plan from `[ ]` to `[x]`, then run:

```bash
git add AGENTS.md docs/superpowers/plans/2026-08-19-risex-transient-auth-reconnect.md
git commit -m "文档：记录RISEx认证重连安全边界"
```

- [x] **Step 5: Inspect the final branch**

Run:

```bash
git status --short
git log --oneline main..HEAD
```

Expected: clean worktree with focused Chinese commits for design, classifier, runtime reconnect, timeout handling, and final documentation.
