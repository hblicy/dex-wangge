# PopDEX Agent Recovery Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit Agent-signed recovery command that cancels only the one zero-fill `NewAccept` PopDEX order proven by the existing journal, placement receipt, and official REST.

**Architecture:** Keep plain `--resume` read-only. The new `--resume --confirm-mainnet-cancel` path first reuses the read-only recovery proof, requires the `receipt+REST` source and exact `NewAccept` status, validates the Agent before changing journal stage, then reuses `PopdexTradingClient.cancelAndConfirm` for deterministic single broadcast, `OrderCancel` parsing, REST terminal confirmation, and journal cleanup.

**Tech Stack:** Node.js 20+, ESM, ethers 6.13.5, node:test, existing PopDEX write journal/RPC/trading clients.

---

### Task 1: Parse the explicit recovery-cancel command

**Files:**
- Modify: `src/exchange/px/write-probe.js`
- Test: `test/popdex-write-probe.test.js`

- [ ] **Step 1: Write failing argument tests**

Add assertions that the exact pair is accepted and conflicting forms are rejected:

```js
assert.deepEqual(parseArgs(['--resume', '--confirm-mainnet-cancel']), {
  symbol: null, side: null, price: null, qty: null,
  confirmMainnetWrite: false,
  confirmMainnetCancel: true,
  resume: true,
});
assert.throws(() => parseArgs(['--confirm-mainnet-cancel']), /必须与 --resume/);
assert.throws(
  () => parseArgs(['--resume', '--confirm-mainnet-cancel', '--confirm-mainnet-write']),
  /互斥/,
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="parseArgs" test/popdex-write-probe.test.js`

Expected: FAIL because `--confirm-mainnet-cancel` is not supported.

- [ ] **Step 3: Implement minimal parsing**

Track the new boolean separately, require `resume=true`, and keep all order flags plus `--confirm-mainnet-write` mutually exclusive:

```js
if (arg === '--confirm-mainnet-cancel') confirmMainnetCancel = true;
if (confirmMainnetCancel && !resume) {
  throw new Error('PopDEX --confirm-mainnet-cancel 必须与 --resume 同时使用。');
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test --test-name-pattern="parseArgs" test/popdex-write-probe.test.js`

Expected: all matching argument tests pass.

### Task 2: Produce an exact cancellable recovery fact without writing

**Files:**
- Modify: `src/exchange/px/write-probe.js`
- Test: `test/popdex-write-probe.test.js`

- [ ] **Step 1: Write failing recovery-fact tests**

Extend the successful placement receipt + REST test to require an internal canonical order and REST status:

```js
assert.equal(result.source, 'receipt+REST');
assert.equal(result.restStatus, 'NewAccept');
assert.deepEqual(result.openOrder, {
  walletId: MAIN_ACCOUNT,
  orderId: ORDER_ID,
  clientOrderId: CLIENT_ORDER_ID,
  symbolId: '20000',
  side: '0',
  priceWad: parseUnits('60000', 18).toString(),
  qtyWad: parseUnits('0.0002', 18).toString(),
  filledQtyWad: '0',
  remainingQtyWad: parseUnits('0.0002', 18).toString(),
  cancelledQtyWad: '0',
  isReduceOnly: false,
});
```

Also assert that pending or partially filled REST facts never become cancellable.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="resume uses a successful|pending|fill" test/popdex-write-probe.test.js`

Expected: FAIL because `restStatus` and `openOrder` are not returned.

- [ ] **Step 3: Return the validated canonical fact**

For `active-manual-cancel-required`, preserve existing public fields and add internal data:

```js
return {
  mode: 'resume',
  status: 'active-manual-cancel-required',
  source: 'receipt+REST',
  restStatus: order.status,
  orderId: order.orderId,
  clientOrderId: record.clientOrderId,
  openOrder: { ...order, status: undefined },
};
```

Build `openOrder` explicitly so no REST-only or undefined fields cross the boundary.

- [ ] **Step 4: Run recovery tests and verify GREEN**

Run: `node --test test/popdex-write-probe.test.js`

Expected: all recovery tests pass.

### Task 3: Execute one guarded Agent cancellation

**Files:**
- Modify: `src/exchange/px/write-probe.js`
- Modify: `test/popdex-write-probe.test.js`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write failing successful-path test**

Create a `BROADCAST` journal with a successful placement receipt and REST `NewAccept`. Execute `runProbe` with `confirmMainnetCancel=true` and assert exact ordering:

```js
assert.deepEqual(
  deps.calls.filter((entry) => /^(?:journal|write|trading):/.test(entry)),
  [
    'journal:load',
    'trading:create',
    'trading:preflight',
    `journal:advance:BROADCAST:OPEN_CONFIRMED:${ORDER_ID}`,
    'trading:cancel',
    'journal:clear',
  ],
);
assert.equal(result.status, 'cancelled-zero-fill-cleared');
```

- [ ] **Step 2: Run successful-path test and verify RED**

Run: `node --test --test-name-pattern="explicit Agent recovery cancel" test/popdex-write-probe.test.js`

Expected: FAIL because the cancel mode is not implemented.

- [ ] **Step 3: Implement the minimal guarded path**

After `runResume` returns, require every gate before constructing a write client:

```js
if (result.status !== 'active-manual-cancel-required'
    || result.source !== 'receipt+REST'
    || result.restStatus !== 'NewAccept'
    || !result.openOrder) {
  throw new Error('PopDEX 恢复撤单只允许回执与 REST 已确认的 NewAccept 零成交订单。');
}
const current = journal.load();
if (current.stage === 'CANCEL_BROADCAST') {
  throw new Error('PopDEX 撤单已经广播，禁止重复广播；请运行普通 --resume。');
}
const trading = create the existing PopdexTradingClient;
await trading.preflight();
if (current.stage === 'BROADCAST') {
  journal.advance('BROADCAST', 'OPEN_CONFIRMED', { orderId: result.orderId });
}
const cancelled = await trading.cancelAndConfirm(result.openOrder, journal);
journal.clearCompleted();
return { mode: 'resume-cancel', status: 'cancelled-zero-fill-cleared', ... };
```

- [ ] **Step 4: Add failing safety tests one at a time**

Cover each forbidden path and verify it fails before `write:create` or `trading:create`:

```js
// no record
// REST PendingNew or PendingCancel
// any filled quantity
// source is legacy precompile rather than receipt+REST
// journal already CANCEL_BROADCAST
// Agent preflight failure preserves OPEN_CONFIRMED and sends nothing
// cancel failure preserves CANCEL_BROADCAST and does not clear
```

- [ ] **Step 5: Implement only the validation needed for each RED test**

Do not add retries or a generic cancel API. Keep the command scoped to the one recovery record.

- [ ] **Step 6: Update output and documentation**

Render the successful result with order ID, cancel transaction result, and zero-fill confirmation. Document:

```bash
npm run popdex:write-probe -- --resume --confirm-mainnet-cancel
```

State that the command is a real mainnet write, ordinary `--resume` remains read-only, and a `CANCEL_BROADCAST` record must never be rebroadcast.

- [ ] **Step 7: Run focused and full verification**

Run:

```bash
node --test test/popdex-write-probe.test.js test/popdex-trading-client.test.js
npm test
git diff --check
```

Expected: grid tests pass, all Node tests pass, and diff check emits no errors.

- [ ] **Step 8: Commit the implementation**

```bash
git add AGENTS.md README.md src/exchange/px/write-probe.js test/popdex-write-probe.test.js docs/superpowers/specs/2026-08-17-popdex-agent-recovery-cancel-design.md docs/superpowers/plans/2026-08-17-popdex-agent-recovery-cancel.md
git commit -m "功能：增加PopDEX Agent恢复撤单命令"
```
