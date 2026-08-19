# PopDEX Stop Close Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist verified PopDEX stop-close exposure facts, make final reconciliation accept only proven-flat exposure, guarantee failed stop sessions release resources, and recover the observed completed-flat incident without chain writes.

**Architecture:** Extend the existing ownership store with a backward-compatible, strictly validated `settledExposureEvents` collection. PopDEX prepares the exact unresolved opening exposure before broadcasting a close, records the close proof only after the official snapshot is flat, and replays that persistence step from a confirmed operation journal after a crash. The reconciler excludes only exact settled events; the grid-probe CLI keeps strict manual recovery checks and closes its timer/lock on every terminal stop failure.

**Tech Stack:** Node.js ES modules, `node:test`, `node:assert/strict`, ethers v6 integer/bytes32 utilities, atomic JSON ownership files.

---

### Task 1: Add durable settled-exposure facts to the ownership store

**Files:**
- Modify: `test/popdex-ownership-store.test.js`
- Modify: `src/exchange/px/ownership-store.js`

- [ ] **Step 1: Write failing ownership schema and transition tests**

Add tests that create one completed suppressed opening event and assert the wished-for API:

```js
const plan = store.planFlatExposureSettlement(parseUnits('0.0002', 18).toString());
assert.deepEqual(plan, [{
  fillEventId: EVENT_ID,
  orderId: '123',
  filledQtyWad: parseUnits('0.0002', 18).toString(),
}]);

store.recordFlatExposureSettlement(plan, {
  closeOrderId: '456',
  closeClientOrderId: encodeBytes32String('dw-bc-111111111111111111111111').toLowerCase(),
  closeTxHash: `0x${'34'.repeat(32)}`,
  positionId: '88',
  closeQtyWad: parseUnits('0.0002', 18).toString(),
  reason: 'stop-close',
});

assert.equal(store.listSettledExposureEvents()[0].fillEventId, EVENT_ID);
```

Also assert:

- legacy version-1 files without `settledExposureEvents` load as an empty collection;
- the same exact proof is idempotent;
- an unsuppressed event, incomplete event, reduce-only order, replacement-covered event, quantity mismatch, or conflicting second proof throws;
- failed persistence preserves the preceding durable snapshot.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/popdex-ownership-store.test.js
```

Expected: FAIL because `planFlatExposureSettlement`, `recordFlatExposureSettlement`, and `listSettledExposureEvents` do not exist.

- [ ] **Step 3: Implement strict backward-compatible proof storage**

In `ownership-store.js`:

- add `settledExposureEvents` to allowed root keys, but normalize a missing legacy field to `[]` before required-key validation;
- validate each proof using exact `fillEventId`, positive integer order/position/quantity IDs, bytes32 close client ID, 32-byte transaction hash, fixed reason `stop-close`, and canonical ISO `confirmedAt`;
- validate unique `fillEventId` values and exact references to an opening, non-reduce-only terminal event;
- implement `planFlatExposureSettlement(closeQtyWad)` to select only completed suppressed opening events not covered by reduce-only children and not already settled, then require the exact sum to equal `closeQtyWad`;
- implement `recordFlatExposureSettlement(plan, closeFacts)` as one atomic `#change`, validating the plan again before appending every proof;
- make an identical already-recorded close proof idempotent and reject conflicting facts;
- expose cloned proofs through `listSettledExposureEvents()`.

The persisted proof shape is:

```js
{
  fillEventId,
  orderId,
  filledQtyWad,
  closeOrderId,
  closeClientOrderId,
  closeTxHash,
  positionId,
  closeQtyWad,
  reason: 'stop-close',
  confirmedAt,
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node --test test/popdex-ownership-store.test.js
```

Expected: all ownership-store tests pass.

- [ ] **Step 5: Commit the ownership model**

```powershell
git add src/exchange/px/ownership-store.js test/popdex-ownership-store.test.js
git commit -m "修复：持久化PopDEX停止平仓事实"
```

### Task 2: Make reconciliation consume only exact close proofs

**Files:**
- Modify: `test/popdex-reconciler.test.js`
- Modify: `src/exchange/px/reconciler.js`

- [ ] **Step 1: Write failing reconciler tests**

Extend the existing `opening fills require a confirmed long position` coverage with three cases:

```js
await assert.rejects(
  target.reconciler.reconcile({ reason: 'refresh', suppressRequote: true }),
  (error) => error.code === 'POPDEX_POSITION_MISMATCH',
);

target.store.completeSuppressedEvent(eventId);
const plan = target.store.planFlatExposureSettlement(QTY);
target.store.recordFlatExposureSettlement(plan, closeFacts);
const result = await target.reconciler.reconcile({ reason: 'probe-stop-final' });
assert.equal(result.status, 'READY');
assert.equal(result.diagnostics.settledExposureEvents, 1);
assert.equal(result.diagnostics.requiredLongQtyWad, '0');
```

The first assertion proves suppression alone remains insufficient. Add corrupt-proof fixture assertions that fail during ownership load rather than silently weakening position checks.

- [ ] **Step 2: Run the reconciler test and verify RED**

Run:

```powershell
node --test test/popdex-reconciler.test.js
```

Expected: FAIL because the reconciler still requires the settled opening quantity and lacks proof diagnostics.

- [ ] **Step 3: Implement proof-aware position verification**

Change `verifyPositions` to accept `settledExposureEvents`. Build a map by `fillEventId`, require every proof to match its exact ownership order and terminal event, and exclude only those matched events from `requiredLongQty`. Keep reduce-only child coverage unchanged. Return diagnostics containing:

```js
{
  actualLongQtyWad: longQty.toString(),
  requiredLongQtyWad: requiredLongQty.toString(),
  settledExposureEvents: settledIds.size,
}
```

Merge these fields into the existing reconcile diagnostics. Do not treat `suppressRequote` or `EVENT_COMPLETED` as proof by themselves.

- [ ] **Step 4: Run the reconciler test and verify GREEN**

Run:

```powershell
node --test test/popdex-reconciler.test.js
```

Expected: all reconciler tests pass, including the original mismatch test.

- [ ] **Step 5: Commit reconciler support**

```powershell
git add src/exchange/px/reconciler.js test/popdex-reconciler.test.js
git commit -m "修复：按平仓证明闭合PopDEX持仓对账"
```

### Task 3: Persist close proof before clearing the operation journal

**Files:**
- Modify: `test/popdex-adapter.test.js`
- Modify: `src/exchange/px/popdex.js`

- [ ] **Step 1: Write failing live-close and crash-recovery tests**

Extend the adapter ownership double with the three new ownership methods. Add a close test that verifies this order:

```js
assert.deepEqual(
  ownershipStore.calls.filter((call) => call.startsWith('flat-') || call === 'journal-clear'),
  ['flat-plan:200000000000000', 'flat-record:456', 'journal-clear'],
);
```

Assert the recorded close identity comes from the `CONFIRMED` journal (`txHash`, `closeOrderId`, client ID, position ID and quantity), and no proof is recorded while the official refreshed position still exists.

Add a recovery test with a `CONFIRMED kind=close` journal and official flat snapshot. `init()` must record the same proof before clearing the recovered journal. A second recovery after a simulated crash between proof persistence and journal cleanup must be idempotent and must not broadcast another close.

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```powershell
node --test test/popdex-adapter.test.js
```

Expected: FAIL because live and recovered close paths clear the journal without an ownership close proof.

- [ ] **Step 3: Implement the live and recovery ordering**

In `PopdexExchange.closePosition`:

1. call `planFlatExposureSettlement(position.holdSizeWad)` before journal creation or broadcast;
2. broadcast and confirm the close through the existing trading client;
3. refresh the official snapshot without clearing the journal;
4. require zero BTCUSDT open orders and no BTCUSDT position;
5. load the `CONFIRMED kind=close` record and atomically call `recordFlatExposureSettlement`;
6. only then call `journal.clearConfirmed()`.

In journal recovery, after a close operation is confirmed and the rebuilt snapshot is published flat, execute the same proof persistence helper before journal cleanup. Keep the journal intact when proof persistence fails so restart can retry without broadcasting.

Log the settled event count and total quantity through the existing logger without exposing keys or signatures.

- [ ] **Step 4: Run adapter and operation-journal tests**

Run:

```powershell
node --test test/popdex-adapter.test.js test/popdex-operation-journal.test.js
```

Expected: both test files pass.

- [ ] **Step 5: Commit close-path persistence**

```powershell
git add src/exchange/px/popdex.js test/popdex-adapter.test.js
git commit -m "修复：平仓确认后再清理PopDEX写日志"
```

### Task 4: Ensure failed stop releases timers and the process lock

**Files:**
- Modify: `test/popdex-grid-probe.test.js`
- Modify: `src/exchange/px/grid-probe.js`

- [ ] **Step 1: Strengthen the existing failing-final-reconcile test**

After `session.executeCommand('stop')` rejects, assert:

```js
assert.equal(adapter.stopCalls, 1);
assert.equal(fs.existsSync(files.lock), false);
assert.equal(fs.existsSync(files.state), true);
assert.equal(fs.existsSync(files.ownership), true);
await assert.rejects(started.session.executeCommand('status'), /会话已结束/);
assert.ok(output.includes('[PopDEX stop] 失败后已关闭交易所刷新并释放进程锁。'));
```

Add a cleanup-failure test only if the injectable fake can make `exchange.stop()` or lock release throw; it must report both the original stop failure and cleanup failure without deleting recovery files.

- [ ] **Step 2: Run the grid-probe test and verify RED**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: FAIL because the current catch block only logs and rethrows, leaving the session open and lock present.

- [ ] **Step 3: Implement terminal failure cleanup**

In the `stop` catch path:

```js
exchange.stop();
releaseLock();
closed = true;
output('[PopDEX stop] 失败后已关闭交易所刷新并释放进程锁。');
throw error;
```

Wrap cleanup so a cleanup error is surfaced together with the original error as an `AggregateError`. Never call `removeCompletedFiles` from the failure path.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: all grid-probe tests pass and retained-file assertions remain true.

- [ ] **Step 5: Commit CLI lifecycle cleanup**

```powershell
git add src/exchange/px/grid-probe.js test/popdex-grid-probe.test.js
git commit -m "修复：停止失败时释放PopDEX验收会话"
```

### Task 5: Recover the observed stopped/completed-flat incident

**Files:**
- Modify: `test/popdex-grid-probe.test.js`
- Modify: `src/exchange/px/grid-probe.js`

- [ ] **Step 1: Write the exact incident fixture and failing recovery test**

Create a fixture matching the supplied VPS facts:

```js
snapshot.running = false;
snapshot.active = [];
snapshot.processedFillEventIds = [eventId];
order.state = 'FILLED';
order.filledQtyWad = '200000000000000';
order.terminalEvent.stage = 'EVENT_COMPLETED';
order.terminalEvent.suppressRequote = true;
order.terminalEvent.replacementOrderId = null;
```

With official REST/chain open orders empty, BTCUSDT positions empty, no operation journal, and exact official fill identity, assert `--confirm-manual-flat-order <orderId>` archives state and ownership with `writes=0` and returns `recoveryShape: 'stopped-completed-flat'`.

Add rejection tests for a processed event different from the terminal event, more than one processed event, `running=true` with an already-completed event, a non-suppressed completed event, a replacement order ID, official exposure, operation journal, and fill mismatch.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: FAIL because current validation only accepts `running=true`, zero processed events and `EVENT_PENDING`.

- [ ] **Step 3: Implement two explicit manual-flat shapes**

Refactor `validateManualFlatState` to select exactly one of:

- `pending-manual-flat`: the existing `running=true / EVENT_PENDING / unsuppressed / processed=[]` shape;
- `stopped-completed-flat`: `running=false / EVENT_COMPLETED / suppressed / processed=[eventId]`.

Both paths must continue using the same exact order, official open-order, chain active-order, position, fill-ID and fill-quantity checks. Return the selected shape and include it in the recovery result and CLI output. Do not accept any mixed shape and do not change ordinary `--resume`.

- [ ] **Step 4: Run grid-probe tests and verify GREEN**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: all grid-probe tests pass, including legacy manual-flat recovery.

- [ ] **Step 5: Commit incident recovery support**

```powershell
git add src/exchange/px/grid-probe.js test/popdex-grid-probe.test.js
git commit -m "修复：归档PopDEX已停止人工平仓状态"
```

### Task 6: Update design consistency and run full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-19-popdex-stop-close-proof-design.md`
- Modify: `docs/superpowers/plans/2026-08-19-popdex-stop-close-proof.md`

- [ ] **Step 1: Align the design with the crash-safe journal ordering**

Clarify that proof persistence is internal to `PopdexExchange.closePosition` and journal recovery: the close operation journal remains durable until the official flat snapshot and ownership close proof are both persisted. This preserves the public `closePosition()` interface and avoids any Decibel/RISEx changes.

- [ ] **Step 2: Run whitespace and focused verification**

Run:

```powershell
git diff --check
node --test test/popdex-ownership-store.test.js test/popdex-reconciler.test.js test/popdex-adapter.test.js test/popdex-operation-journal.test.js test/popdex-grid-probe.test.js
```

Expected: exit code 0 and no failing tests.

- [ ] **Step 3: Run the complete project suite**

Run:

```powershell
npm test
```

Expected: exit code 0, zero failed tests, and existing Decibel/RISEx suites remain green.

- [ ] **Step 4: Review the final diff and scope**

Run:

```powershell
git status --short --branch
git diff --stat main...HEAD
git diff main...HEAD -- src/exchange/px test docs/superpowers
```

Confirm there are no `.env`, state, ownership, journal, private key, unrelated frontend, Decibel, or RISEx changes.

- [ ] **Step 5: Commit documentation and final consistency changes**

```powershell
git add docs/superpowers/specs/2026-08-19-popdex-stop-close-proof-design.md docs/superpowers/plans/2026-08-19-popdex-stop-close-proof.md
git commit -m "文档：完善PopDEX停止平仓修复计划"
```

