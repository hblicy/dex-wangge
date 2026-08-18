# PopDEX Reduce-Only Market Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the disproven PopDEX `placeReverseOrder(Long=1)` Stage 5 close with the exact official `placeOrder` market-sell, reduce-only, Net-position close proven by Mainnet transaction `0xbb8f…1e50`, while preserving limit-grid behavior and crash-safe no-retry recovery.

**Architecture:** Keep ordinary grid/order encoding unchanged and add a dedicated fixed close encoder beside the Stage 5 codec. Persist the close client identity, exact quantity, deterministic transaction hash, and receipt-derived order ID through a versioned journal state machine; confirm completion from the exact close fills plus zero open orders and zero on-chain positions. All server, UI, GridBot, Decibel, and RISEx paths remain isolated from PopDEX write code.

**Tech Stack:** Node.js 20+ ESM, ethers 6.13.5 ABI utilities, built-in `node:test`, existing PopDEX RPC/REST clients and atomic JSON journal.

---

## File map

- Modify `src/exchange/px/fill-close-codec.js`: authoritative fixed close calldata encoder and deterministic close client ID.
- Modify `src/exchange/px/fill-close-journal.js`: version-2 close facts, `CLOSE_SETTLING`, and strict version-1 recovery migration.
- Modify `src/exchange/px/fill-close-state.js`: exact close-order/fill/final-flat classifier.
- Modify `src/exchange/px/trading-client.js`: submit the reduce-only market `placeOrder`, persist identity before broadcast, parse `OrderCreate`.
- Modify `src/exchange/px/fill-close-probe.js`: dry-run preview, live orchestration, read-only recovery, explicit CLI gates.
- Modify `test/popdex-fill-close-codec.test.js`: exact successful Mainnet calldata vector and unchanged limit encoding.
- Modify `test/popdex-fill-close-journal.test.js`: version-2 transitions and version-1 recovery compatibility.
- Modify `test/popdex-fill-close-state.test.js`: exact close fill classification and conflict rejection.
- Modify `test/popdex-fill-close-trading.test.js`: serialized Agent transaction and receipt identity tests.
- Modify `test/popdex-fill-close-probe.test.js`: full/partial/recovery orchestration and no-repeat-write tests.
- Modify `test/popdex-agent-isolation.test.js`: retain CLI-only write isolation.
- Modify `AGENTS.md`, `docs/protocol/popdex-mainnet-validation.md`, and `docs/superpowers/specs/2026-08-18-popdex-stage5-fill-close-design.md`: living protocol facts.

### Task 1: Checkpoint the failed-close safety baseline

**Files:**
- Modify: `src/exchange/px/fill-close-probe.js`
- Modify: `test/popdex-fill-close-probe.test.js`
- Modify: `AGENTS.md`
- Modify: `docs/protocol/popdex-mainnet-validation.md`
- Modify: `docs/superpowers/specs/2026-08-18-popdex-stage5-fill-close-design.md`

- [ ] **Step 1: Review the already-tested safety diff**

Confirm the diff contains only these existing protections:

```text
- --confirm-mainnet-fill-close and --resume --confirm-mainnet-close are blocked.
- A failed close receipt remains unresolved while a BTCUSDT position exists.
- A failed close receipt can be cleared by ordinary --resume only after openOrders=[] and positions=[] prove manual flat.
- The recovery output includes the exact flatness failure reason.
```

Run:

```bash
git diff -- src/exchange/px/fill-close-probe.js test/popdex-fill-close-probe.test.js AGENTS.md docs/protocol/popdex-mainnet-validation.md docs/superpowers/specs/2026-08-18-popdex-stage5-fill-close-design.md
```

Expected: no close write is enabled and no unrelated exchange file is changed.

- [ ] **Step 2: Re-run the focused safety test**

Run:

```bash
node --test test/popdex-fill-close-probe.test.js
```

Expected: 16 tests pass, including `failed close receipt clears the journal only after read-only facts prove manual flat`.

- [ ] **Step 3: Commit the safety baseline**

```bash
git add AGENTS.md docs/protocol/popdex-mainnet-validation.md docs/superpowers/specs/2026-08-18-popdex-stage5-fill-close-design.md src/exchange/px/fill-close-probe.js test/popdex-fill-close-probe.test.js
git commit -m "修复：保护PopDEX失败平仓恢复"
```

### Task 2: Encode the exact official reduce-only market close

**Files:**
- Modify: `test/popdex-fill-close-codec.test.js`
- Modify: `src/exchange/px/fill-close-codec.js`

- [ ] **Step 1: Write the failing authoritative calldata test**

Replace reverse-interface assertions with a test importing the wished-for API:

```js
import {
  POPDEX_REDUCE_ONLY_MARKET_PARAMS,
  encodeReduceOnlyMarketClose,
  prepareFillClosePlan,
} from '../src/exchange/px/fill-close-codec.js';

const MAINNET_ACCOUNT = '0xdA1efA6fc801D6788Cc785405610462f99CCb3e8';
const MAINNET_CLOSE_CLIENT_ID =
  '0x7765622d31373837303334333039323331000000000000000000000000000000';
const MAINNET_CLOSE_CALLDATA =
  '0x0f05a9d9'
  + '000000000000000000000000da1efa6fc801d6788cc785405610462f99ccb3e8'
  + '7765622d31373837303334333039323331000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000004e20'
  + '0201010000000100000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000b5e620f48000'
  + '000000000000000000000000000000000000000000000000006a94d74f430000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000';

test('reduce-only market close exactly matches the successful Mainnet calldata', () => {
  assert.equal(
    encodeReduceOnlyMarketClose({
      mainAccount: MAINNET_ACCOUNT,
      closeClientOrderId: MAINNET_CLOSE_CLIENT_ID,
      closeQtyWad: '200000000000000',
    }),
    MAINNET_CLOSE_CALLDATA,
  );
  assert.equal(
    POPDEX_REDUCE_ONLY_MARKET_PARAMS,
    '0x0201010000000100000000000000000000000000000000000000000000000000',
  );
});

test('fill-close plan creates distinct deterministic entry and close client IDs', () => {
  const prepared = plan();
  assert.equal(decodeBytes32String(prepared.clientOrderId),
    'dw-bb-0102030405060708090a0b0c');
  assert.equal(decodeBytes32String(prepared.closeClientOrderId),
    'dw-bc-0102030405060708090a0b0c');
  assert.notEqual(prepared.clientOrderId, prepared.closeClientOrderId);
});
```

Retain the existing entry-order assertions and add:

```js
import {
  encodeOrderParams,
  POPDEX_ORDER_INTERFACE,
} from '../src/exchange/px/order-codec.js';

assert.equal(entry.orderParams, encodeOrderParams('buy'));
assert.equal(entry.price.toString(), prepared.priceWad);
assert.equal(entry.slippage, 0n);
```

- [ ] **Step 2: Run the codec test and verify RED**

Run:

```bash
node --test test/popdex-fill-close-codec.test.js
```

Expected: FAIL because `POPDEX_REDUCE_ONLY_MARKET_PARAMS` and `encodeReduceOnlyMarketClose` do not exist and the plan lacks `closeClientOrderId`.

- [ ] **Step 3: Implement the fixed close encoder**

In `src/exchange/px/fill-close-codec.js`, remove `POPDEX_REVERSE_INTERFACE`, import `strictIntegerString`, and add:

```js
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const CLOSE_SLIPPAGE_WAD = 30_000_000_000_000_000n;

export const POPDEX_REDUCE_ONLY_MARKET_PARAMS =
  '0x0201010000000100000000000000000000000000000000000000000000000000';

function exactBytes32(value, field) {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw new Error(`PopDEX ${field} 必须是精确 bytes32 十六进制字符串。`);
  }
  return value.toLowerCase();
}

export function encodeReduceOnlyMarketClose({
  mainAccount,
  closeClientOrderId,
  closeQtyWad,
}) {
  const account = strictAddress(mainAccount, 'close.mainAccount');
  const clientOrderId = exactBytes32(closeClientOrderId, 'closeClientOrderId');
  const qty = BigInt(strictIntegerString(closeQtyWad, 'closeQtyWad'));
  if (qty <= 0n) throw new Error('PopDEX closeQtyWad 必须大于 0。');
  return POPDEX_ORDER_INTERFACE.encodeFunctionData('placeOrder', [
    account,
    clientOrderId,
    20000,
    POPDEX_REDUCE_ONLY_MARKET_PARAMS,
    0n,
    qty,
    CLOSE_SLIPPAGE_WAD,
    ZeroAddress,
    0n,
  ]);
}
```

In `prepareFillClosePlan`, derive both IDs from the same validated entropy with different prefixes and expose only a dry-run preview for the planned quantity:

```js
const entropyHex = hexlify(entropy.slice(0, 12)).slice(2);
const clientOrderId = encodeBytes32String(`dw-bb-${entropyHex}`).toLowerCase();
const closeClientOrderId = encodeBytes32String(`dw-bc-${entropyHex}`).toLowerCase();
const closePreviewData = encodeReduceOnlyMarketClose({
  mainAccount: account,
  closeClientOrderId,
  closeQtyWad: qtyWad.toString(),
});
```

Return `closeClientOrderId` and `closePreviewData`; remove the reverse-order `closeData`.

- [ ] **Step 4: Run codec and ordinary order tests**

Run:

```bash
node --test test/popdex-fill-close-codec.test.js test/popdex-order-codec.test.js
```

Expected: PASS; the Mainnet vector matches byte-for-byte and ordinary limit-order vectors remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/exchange/px/fill-close-codec.js test/popdex-fill-close-codec.test.js
git commit -m "修复：按官方交易编码PopDEX只减仓平仓"
```

### Task 3: Version the close journal and add `CLOSE_SETTLING`

**Files:**
- Modify: `test/popdex-fill-close-journal.test.js`
- Modify: `src/exchange/px/fill-close-journal.js`

- [ ] **Step 1: Write failing journal transition and migration tests**

Update `initial()` to include `closeClientOrderId`, then assert the new path and its method discriminator:

```js
import { decodeBytes32String, parseUnits } from 'ethers';

const CLOSE_CLIENT_ORDER_ID = `0x${'34'.repeat(32)}`;

function initial(overrides = {}) {
  return {
    mainAccount: ACCOUNT,
    agentAddress: AGENT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    positionMode: '0',
    leverage: '1',
    priceWad: '63189000000000000000000',
    qtyWad: '200000000000000',
    clientOrderId: CLIENT_ORDER_ID,
    closeClientOrderId: CLOSE_CLIENT_ORDER_ID,
    ...overrides,
  };
}

test('fill-close journal persists exact close identity through settling', () => {
  const target = journal();
  target.create(initial());
  target.advance('PREPARED', 'LEVERAGE_CONFIRMED');
  target.advance('LEVERAGE_CONFIRMED', 'ENTRY_BROADCAST', { entryTxHash: HASH('2') });
  target.advance('ENTRY_BROADCAST', 'ENTRY_SETTLING', { orderId: '9' });
  target.advance('ENTRY_SETTLING', 'POSITION_CONFIRMED', {
    filledQtyWad: '200000000000000',
    remainingQtyWad: '0',
    positionId: '7',
    positionQtyWad: '200000000000000',
  });
  target.advance('POSITION_CONFIRMED', 'CLOSE_BROADCAST', {
    closeKind: 'reduce-only-market',
    closeTxHash: HASH('4'),
    closeQtyWad: '200000000000000',
  });
  const settling = target.advance('CLOSE_BROADCAST', 'CLOSE_SETTLING', {
    closeOrderId: '10',
  });
  assert.equal(settling.closeOrderId, '10');
  assert.equal(settling.closeQtyWad, '200000000000000');
  assert.equal(target.advance('CLOSE_SETTLING', 'COMPLETED', {
    outcome: 'completed-flat',
    positionQtyWad: '0',
  }).stage, 'COMPLETED');
});
```

Add this compatibility fixture and test for the user's existing failed reverse record:

```js
function legacyRecord(overrides = {}) {
  return {
    version: 1,
    stage: 'CLOSE_BROADCAST',
    mainAccount: ACCOUNT,
    agentAddress: AGENT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    positionMode: '0',
    leverage: '1',
    priceWad: '63189000000000000000000',
    qtyWad: '200000000000000',
    clientOrderId: CLIENT_ORDER_ID,
    orderId: '9',
    positionId: '7',
    leverageTxHash: null,
    entryTxHash: HASH('2'),
    cancelTxHash: null,
    closeTxHash: HASH('4'),
    filledQtyWad: '200000000000000',
    remainingQtyWad: '0',
    positionQtyWad: '200000000000000',
    outcome: null,
    lastError: 'PopDEX placeReverseOrder receipt failed',
    updatedAt: '2026-08-18T06:00:00.000Z',
    ...overrides,
  };
}

test('version-1 failed reverse close loads for read-only manual-flat recovery', () => {
  const legacy = legacyRecord();
  const loaded = journal(memoryFs(JSON.stringify(legacy))).load();
  assert.equal(loaded.version, 2);
  assert.equal(loaded.closeTxHash, HASH('4'));
  assert.equal(loaded.closeKind, 'legacy-reverse');
  assert.equal(loaded.closeClientOrderId, null);
  assert.equal(loaded.closeOrderId, null);
  assert.equal(loaded.closeQtyWad, null);
});
```

Reject every other version-1 stage instead of guessing missing close identity:

```js
test('version-1 records outside the known failed reverse close are rejected', () => {
  const legacy = legacyRecord({ stage: 'POSITION_CONFIRMED', closeTxHash: null });
  assert.throws(
    () => journal(memoryFs(JSON.stringify(legacy))).load(),
    /version 1 只允许恢复 CLOSE_BROADCAST/,
  );
});
```

Keep the existing secret/unknown-field rejection test and add an unsupported `version: 3` assertion.

- [ ] **Step 2: Run the journal test and verify RED**

Run:

```bash
node --test test/popdex-fill-close-journal.test.js
```

Expected: FAIL because `closeClientOrderId`, `closeOrderId`, `closeQtyWad`, version 2, and `CLOSE_SETTLING` are unsupported.

- [ ] **Step 3: Implement strict version-2 schema and version-1 migration**

Change the journal constants to include:

```js
const STAGES = new Set([
  'PREPARED',
  'LEVERAGE_BROADCAST',
  'LEVERAGE_CONFIRMED',
  'ENTRY_BROADCAST',
  'ENTRY_SETTLING',
  'REMAINDER_CANCEL_BROADCAST',
  'POSITION_CONFIRMED',
  'CLOSE_BROADCAST',
  'CLOSE_SETTLING',
  'COMPLETED',
]);
const OUTCOMES = new Set([
  'completed-flat',
  'completed-flat-manual',
  'zero-fill-cleared',
  'safe-no-exposure',
]);

POSITION_CONFIRMED: new Set(['CLOSE_BROADCAST']),
CLOSE_BROADCAST: new Set(['CLOSE_SETTLING', 'COMPLETED']),
CLOSE_SETTLING: new Set(['COMPLETED']),
```

Add `closeKind`, `closeClientOrderId`, `closeOrderId`, and `closeQtyWad` to the strict record/advance keys. New records initialize `closeKind: null`. Require:

```js
const isNewClose = value.closeKind === 'reduce-only-market';
const isLegacyClose = value.closeKind === 'legacy-reverse';
if (value.closeKind !== null && !isNewClose && !isLegacyClose) {
  throw new Error(`PopDEX fill-close journal closeKind 无效：${String(value.closeKind)}。`);
}
if (isLegacyClose) {
  if (!['CLOSE_BROADCAST', 'COMPLETED'].includes(value.stage)
      || value.closeTxHash === null
      || value.closeClientOrderId !== null || value.closeOrderId !== null
      || value.closeQtyWad !== null) {
    throw new Error('PopDEX legacy-reverse 只允许保留旧失败平仓恢复事实。');
  }
  if (value.stage === 'COMPLETED' || value.outcome !== null) {
    if (value.stage !== 'COMPLETED'
        || value.outcome !== 'completed-flat-manual'
        || value.positionQtyWad !== '0') {
      throw new Error('PopDEX legacy-reverse 只允许以人工空仓事实完成。');
    }
  }
}
if (isNewClose && ['CLOSE_BROADCAST', 'CLOSE_SETTLING', 'COMPLETED'].includes(value.stage)) {
  if (value.closeClientOrderId === null || value.closeQtyWad === null
      || value.closeTxHash === null) {
    throw new Error(`PopDEX fill-close journal ${value.stage} 缺少平仓订单事实。`);
  }
  if (value.closeQtyWad !== value.positionQtyWad) {
    throw new Error('PopDEX fill-close journal 平仓量与已确认持仓量不一致。');
  }
}
if (value.stage === 'CLOSE_SETTLING' && value.closeOrderId === null) {
  throw new Error('PopDEX fill-close journal CLOSE_SETTLING 缺少 closeOrderId。');
}
```

Create version-2 records with `closeKind: null`, null close order/quantity/hash fields, and the plan-provided `closeClientOrderId`. Normalize only the known version-1 failed reverse record before `validateRecord`:

```js
function normalizeLoadedRecord(parsed) {
  if (parsed?.version !== 1) return parsed;
  if (parsed.stage !== 'CLOSE_BROADCAST' || parsed.closeTxHash === null) {
    throw new Error(
      'PopDEX fill-close journal version 1 只允许恢复 CLOSE_BROADCAST 失败平仓记录。',
    );
  }
  return {
    ...parsed,
    version: 2,
    closeKind: 'legacy-reverse',
    closeClientOrderId: null,
    closeOrderId: null,
    closeQtyWad: null,
  };
}
```

Call `validateRecord(normalizeLoadedRecord(parsed))` from `load()`. Do not migrate any other version-1 stage, unknown version, or unknown field. Update the completion guard so `completed-flat` is accepted only from `CLOSE_SETTLING`, while `completed-flat-manual` is accepted only from `CLOSE_BROADCAST` after the recovery layer has proven a failed receipt and final flatness. A successful new reduce-only close can never skip `CLOSE_SETTLING`. Every new close broadcast must set `closeKind: 'reduce-only-market'` atomically with the predicted transaction hash.

```js
if (fields.outcome === 'completed-flat' && expectedStage !== 'CLOSE_SETTLING') {
  throw new Error('PopDEX completed-flat 只允许从 CLOSE_SETTLING 完成。');
}
if (fields.outcome === 'completed-flat-manual' && expectedStage !== 'CLOSE_BROADCAST') {
  throw new Error('PopDEX completed-flat-manual 只允许从 CLOSE_BROADCAST 完成。');
}
```

Also add `CLOSE_SETTLING` to every `afterEntry`, `afterOrder`, and confirmed-position stage set so it retains and validates the original entry/position facts. For any `completed-flat-manual` record, require a non-null `closeTxHash` and `positionQtyWad === '0'` before `clearCompleted()`.

- [ ] **Step 4: Run journal tests**

Run:

```bash
node --test test/popdex-fill-close-journal.test.js
```

Expected: PASS, including strict version-1 recovery migration and the new close path.

- [ ] **Step 5: Commit**

```bash
git add src/exchange/px/fill-close-journal.js test/popdex-fill-close-journal.test.js
git commit -m "修复：持久化PopDEX平仓订单状态"
```

### Task 4: Classify exact close fills and final flatness

**Files:**
- Modify: `test/popdex-fill-close-state.test.js`
- Modify: `src/exchange/px/fill-close-state.js`

- [ ] **Step 1: Write failing close-classifier tests**

Import `classifyClose`, add `decodeBytes32String` to the existing ethers import, and use exact normalized REST objects:

```js
const CLOSE_CLIENT_ORDER_ID = `0x${'34'.repeat(32)}`;

function closePlan(overrides = {}) {
  return {
    mainAccount: ACCOUNT,
    closeOrderId: '10',
    closeClientOrderId: CLOSE_CLIENT_ORDER_ID,
    closeQtyWad: '200000000000000',
    ...overrides,
  };
}

function longPosition(holdSizeWad) {
  return {
    walletId: ACCOUNT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    side: '1',
    holdSizeWad,
  };
}

function closeOrder(overrides = {}) {
  return {
    walletId: ACCOUNT,
    orderId: '10',
    clientOid: decodeBytes32String(CLOSE_CLIENT_ORDER_ID),
    symbol: 'BTCUSDT',
    symbolId: '20000',
    side: 'Sell',
    reduceOnly: true,
    ...overrides,
  };
}

test('close classifier completes only exact sell reduce-only fill and flat account', () => {
  const result = classifyClose({
    mainAccount: ACCOUNT,
    closeOrderId: '10',
    closeClientOrderId: CLOSE_CLIENT_ORDER_ID,
    closeQtyWad: '200000000000000',
  }, {
    fills: [{
      fillId: '2',
      orderId: '10',
      symbol: 'BTCUSDT',
      side: 'Sell',
      execQty: '0.0002',
    }],
    openOrders: [],
    positions: [],
  });
  assert.deepEqual(result, {
    kind: 'completed-flat',
    closeOrderId: '10',
    filledQtyWad: '200000000000000',
    remainingPositionQtyWad: '0',
  });
});

test('close classifier exposes partial fill without permitting a retry', () => {
  const result = classifyClose(closePlan(), {
    fills: [{ fillId: '2', orderId: '10', symbol: 'BTCUSDT', side: 'Sell', execQty: '0.0001' }],
    openOrders: [],
    positions: [longPosition('100000000000000')],
  });
  assert.equal(result.kind, 'partial-unresolved');
  assert.equal(result.filledQtyWad, '100000000000000');
  assert.equal(result.remainingPositionQtyWad, '100000000000000');
});
```

Add these exact conflict checks:

```js
const completeFacts = {
  fills: [{ fillId: '2', orderId: '10', symbol: 'BTCUSDT', side: 'Sell', execQty: '0.0002' }],
  openOrders: [],
  positions: [],
};
assert.throws(() => classifyClose(closePlan(), {
  ...completeFacts,
  fills: [completeFacts.fills[0], { ...completeFacts.fills[0] }],
}), /close fillId 2 重复/);
assert.throws(() => classifyClose(closePlan(), {
  ...completeFacts,
  fills: [{ ...completeFacts.fills[0], symbol: 'ETHUSDT' }],
}), /平仓成交身份不匹配/);
assert.throws(() => classifyClose(closePlan(), {
  ...completeFacts,
  fills: [{ ...completeFacts.fills[0], side: 'Buy' }],
}), /平仓成交身份不匹配/);
assert.throws(() => classifyClose(closePlan(), {
  ...completeFacts,
  fills: [{ ...completeFacts.fills[0], execQty: '0.0003' }],
}), /成交量超过委托量/);
assert.throws(() => classifyClose(closePlan(), {
  ...completeFacts,
  openOrders: [closeOrder({ orderId: '11' })],
}), /不属于本次平仓/);
assert.throws(() => classifyClose(closePlan(), {
  ...completeFacts,
  positions: [longPosition('1'), longPosition('2')],
}), /冲突的 BTCUSDT 持仓/);
const inconsistent = classifyClose(closePlan(), {
  fills: [{ ...completeFacts.fills[0], execQty: '0.0001' }],
  openOrders: [],
  positions: [longPosition('50000000000000')],
});
assert.equal(inconsistent.kind, 'settling');
```

- [ ] **Step 2: Run state tests and verify RED**

Run:

```bash
node --test test/popdex-fill-close-state.test.js
```

Expected: FAIL because `classifyClose` is not exported.

- [ ] **Step 3: Implement `classifyClose`**

Add this dedicated export:

```js
export function classifyClose(plan, { fills, openOrders, positions } = {}) {
  if (!plan || typeof plan !== 'object'
      || !Array.isArray(fills) || !Array.isArray(openOrders) || !Array.isArray(positions)) {
    throw new Error('PopDEX 平仓快照格式无效。');
  }
  const closeOrderId = strictIntegerString(plan.closeOrderId, 'close.orderId');
  const closeQty = integerWad(plan.closeQtyWad, 'close.qtyWad');
  const expectedClientOid = decodeBytes32String(plan.closeClientOrderId);
  if (closeQty <= 0n) throw new Error('PopDEX 平仓数量必须大于 0。');

  const btcOpen = openOrders.filter(isBtc);
  for (const item of btcOpen) {
    const wallet = strictAddress(item.walletId, 'close order.walletId');
    if (!sameAddress(wallet, strictAddress(plan.mainAccount, 'close.mainAccount'))
        || String(item.orderId) !== closeOrderId
        || item.clientOid !== expectedClientOid
        || item.side !== 'Sell'
        || item.reduceOnly !== true) {
      throw new Error('PopDEX 出现不属于本次平仓的 BTCUSDT 活动订单。');
    }
  }
  if (btcOpen.length > 1) throw new Error('PopDEX 平仓活动订单重复。');

  const seen = new Set();
  let fillQty = 0n;
  for (const item of fills) {
    if (String(item?.orderId) !== closeOrderId) continue;
    const fillId = strictIntegerString(item.fillId, 'close fill.fillId');
    if (seen.has(fillId)) throw new Error(`PopDEX close fillId ${fillId} 重复。`);
    seen.add(fillId);
    if (item.symbol !== BTC_SYMBOL || item.side !== 'Sell') {
      throw new Error('PopDEX 平仓成交身份不匹配。');
    }
    fillQty += decimalWad(item.execQty, 'close fill.execQty');
  }
  if (fillQty > closeQty) throw new Error('PopDEX 平仓成交量超过委托量。');

  const nonzero = positions.filter((item) => isBtc(item)
    && integerWad(item.holdSizeWad, 'close position.holdSizeWad') > 0n);
  if (nonzero.length > 1 || nonzero.some((item) => item.side !== LONG_POSITION_SIDE)) {
    throw new Error('PopDEX 平仓后出现冲突的 BTCUSDT 持仓。');
  }
  if (nonzero.length === 1) {
    const wallet = strictAddress(nonzero[0].walletId, 'close position.walletId');
    if (!sameAddress(wallet, strictAddress(plan.mainAccount, 'close.mainAccount'))) {
      throw new Error('PopDEX 平仓剩余仓位账户不匹配。');
    }
  }
  const remaining = nonzero.length === 0
    ? 0n
    : integerWad(nonzero[0].holdSizeWad, 'close position.holdSizeWad');

  if (fillQty === closeQty && remaining === 0n && btcOpen.length === 0) {
    return {
      kind: 'completed-flat',
      closeOrderId,
      filledQtyWad: fillQty.toString(),
      remainingPositionQtyWad: '0',
    };
  }
  if (fillQty > 0n && fillQty + remaining === closeQty && btcOpen.length === 0) {
    return {
      kind: 'partial-unresolved',
      closeOrderId,
      filledQtyWad: fillQty.toString(),
      remainingPositionQtyWad: remaining.toString(),
    };
  }
  return {
    kind: 'settling',
    closeOrderId,
    filledQtyWad: fillQty.toString(),
    remainingPositionQtyWad: remaining.toString(),
  };
}
```

Use the existing `decimalWad`, `integerWad`, `isBtc`, address validation, and duplicate-fill pattern from `classifyEntry`; do not convert IDs or WAD values to JavaScript numbers.

- [ ] **Step 4: Run state tests**

Run:

```bash
node --test test/popdex-fill-close-state.test.js
```

Expected: PASS for complete, partial, settling, and conflict cases.

- [ ] **Step 5: Commit**

```bash
git add src/exchange/px/fill-close-state.js test/popdex-fill-close-state.test.js
git commit -m "修复：严格确认PopDEX平仓成交与空仓"
```

### Task 5: Submit and identify the close order through the trading boundary

**Files:**
- Modify: `test/popdex-fill-close-trading.test.js`
- Modify: `src/exchange/px/trading-client.js`

- [ ] **Step 1: Replace reverse-order trading tests with failing `placeOrder` tests**

The serialized close transaction test must decode with `POPDEX_ORDER_INTERFACE` and assert:

```js
const receiptOrder = await client(closeDeps).closeFillCloseLong(plan, {
  closeClientOrderId: plan.closeClientOrderId,
  closeQtyWad: '200000000000000',
  positionQtyWad: '200000000000000',
  positionId: '7',
}, closeJournal);
const tx = Transaction.from(closeDeps.serialized[0]);
const parsed = POPDEX_ORDER_INTERFACE.parseTransaction({ data: tx.data });
assert.equal(parsed.name, 'placeOrder');
assert.equal(parsed.args.account, MAIN_ACCOUNT);
assert.equal(parsed.args.symbolId.toString(), '20000');
assert.equal(parsed.args.clientOrderId, plan.closeClientOrderId);
assert.equal(parsed.args.orderParams,
  '0x0201010000000100000000000000000000000000000000000000000000000000');
assert.equal(parsed.args.price, 0n);
assert.equal(parsed.args.qty, 200000000000000n);
assert.equal(parsed.args.slippage, 30000000000000000n);
assert.equal(receiptOrder.orderId, ORDER_ID);
assert.equal(closeJournal.stage, 'CLOSE_SETTLING');
```

Add concrete preflight and receipt failures:

```js
await assert.rejects(
  client(dependencies()).closeFillCloseLong(plan, {
    closeClientOrderId: plan.closeClientOrderId,
    closeQtyWad: '100000000000000',
    positionQtyWad: '200000000000000',
    positionId: '7',
  }, fakeJournal('POSITION_CONFIRMED')),
  /数量.*不匹配/,
);

const failed = dependencies({ receiptStatus: '0x0' });
const failedJournal = fakeJournal('POSITION_CONFIRMED');
await assert.rejects(
  client(failed).closeFillCloseLong(plan, {
    closeClientOrderId: plan.closeClientOrderId,
    closeQtyWad: '200000000000000',
    positionQtyWad: '200000000000000',
    positionId: '7',
  }, failedJournal),
  /status=0x1/,
);
assert.equal(failed.serialized.length, 1);
assert.equal(failedJournal.stage, 'CLOSE_BROADCAST');
```

Extend `dependencies()` with `orderEventOverrides = [{}]`, then build the order receipt logs from each override:

```js
logs: orderEventOverrides.map((overrides) => eventLog(
  POPDEX_ORDER_EVENT_INTERFACE,
  'OrderCreate',
  [
    overrides.account ?? parsed.args.account,
    overrides.symbolId ?? parsed.args.symbolId,
    overrides.orderId ?? ORDER_ID,
    overrides.clientOrderId ?? parsed.args.clientOrderId,
    overrides.price ?? parsed.args.price,
    overrides.qty ?? parsed.args.qty,
    0,
    2,
    true,
    0,
  ],
  ORDER_PRECOMPILE,
)),
```

Add the concrete rejection assertions:

```js
for (const orderEventOverrides of [
  [{}, {}],
  [{ orderId: '234237619377012737' }],
  [{ qty: 100000000000000n }],
]) {
  const deps = dependencies({ orderEventOverrides });
  const journal = fakeJournal('POSITION_CONFIRMED');
  await assert.rejects(
    client(deps).closeFillCloseLong(plan, {
      closeClientOrderId: plan.closeClientOrderId,
      closeQtyWad: '200000000000000',
      positionQtyWad: '200000000000000',
      positionId: '7',
    }, journal),
    /OrderCreate/,
  );
  assert.equal(journal.stage, 'CLOSE_BROADCAST');
}
```

- [ ] **Step 2: Run trading tests and verify RED**

Run:

```bash
node --test test/popdex-fill-close-trading.test.js
```

Expected: FAIL because the current method serializes `placeReverseOrder` and never parses a close `OrderCreate`.

- [ ] **Step 3: Allow atomic pre-broadcast journal fields**

Extend `#submit` with `journalFields = {}` and persist them with the predicted hash in one transition:

```js
async #submit({
  data,
  functionName,
  journal,
  expectedStage,
  nextStage,
  txHashField,
  journalFields = {},
  to = POPDEX_ORDER_PRECOMPILE,
  simulationInterface = null,
}) {
  const calldata = exactHex(data, `${functionName} calldata`);
  const target = this.#allowedTarget(to);
  const simulated = await this.writeRpc.simulate({
    from: this.wallet.address,
    to: target,
    data: calldata,
    value: '0x0',
  });
  if (simulationInterface === null) this.#verifySimulation(functionName, simulated);
  else verifyStage5Simulation(simulated, simulationInterface, functionName);
  const serialized = await this.#sign(target, calldata);
  const localTxHash = keccak256(serialized).toLowerCase();
  journal.advance(expectedStage, nextStage, {
    ...journalFields,
    [txHashField]: localTxHash,
  });
  try {
    const remoteTxHash = (await this.writeRpc.broadcast(serialized)).toLowerCase();
    if (remoteTxHash !== localTxHash) {
      throw new Error(
        `PopDEX ${functionName} RPC txHash 不匹配：local=${localTxHash} remote=${remoteTxHash}。`,
      );
    }
    return exactReceiptHash(
      await this.writeRpc.waitForReceipt(localTxHash),
      localTxHash,
      functionName,
    );
  } catch (error) {
    safeJournalError(journal, nextStage, error);
    throw error;
  }
}
```

- [ ] **Step 4: Implement the official close submission**

Replace `closeFillCloseLong` with:

```js
async closeFillCloseLong(plan, position, journal) {
  this.#assertFillClosePlan(plan);
  if (!position || position.closeClientOrderId !== plan.closeClientOrderId
      || position.positionQtyWad !== position.closeQtyWad
      || typeof position.positionId !== 'string') {
    throw new Error('PopDEX Stage 5 平仓身份或数量与已确认持仓不匹配。');
  }
  await this.preflight();
  const [openOrders, positions] = await Promise.all([
    this.accountClient.getAllOpenOrders(this.mainAccount, 'BTCUSDT'),
    this.readRpc.getAllOpenPositions(this.mainAccount),
  ]);
  const livePosition = assertConfirmedLong(
    plan,
    { openOrders, positions },
    position.positionQtyWad,
  );
  if (String(livePosition.positionId) !== position.positionId) {
    throw new Error('PopDEX Stage 5 平仓前持仓 ID 与 journal 不匹配。');
  }
  const data = encodeReduceOnlyMarketClose({
    mainAccount: this.mainAccount,
    closeClientOrderId: position.closeClientOrderId,
    closeQtyWad: position.closeQtyWad,
  });
  const receipt = await this.#submit({
    data,
    functionName: 'placeOrder',
    journal,
    expectedStage: 'POSITION_CONFIRMED',
    nextStage: 'CLOSE_BROADCAST',
    txHashField: 'closeTxHash',
    journalFields: {
      closeKind: 'reduce-only-market',
      closeClientOrderId: position.closeClientOrderId,
      closeQtyWad: position.closeQtyWad,
    },
    simulationInterface: POPDEX_ORDER_INTERFACE,
  });
  try {
    const order = parseOrderCreateReceipt(receipt, {
      account: plan.mainAccount,
      symbolId: plan.symbolId,
      clientOrderId: position.closeClientOrderId,
      priceWad: '0',
      qtyWad: position.closeQtyWad,
    });
    journal.advance('CLOSE_BROADCAST', 'CLOSE_SETTLING', {
      closeOrderId: order.orderId,
    });
    return order;
  } catch (error) {
    safeJournalError(journal, 'CLOSE_BROADCAST', error);
    throw error;
  }
}
```

Remove the reverse-interface import. Keep entry and ordinary limit methods unchanged.

Import `assertConfirmedLong` beside `exactBtcLeverage`. In the trading test dependency factory, expose the fresh pre-broadcast facts and pass the account client into `PopdexTradingClient`:

```js
const livePosition = {
  walletId: MAIN_ACCOUNT,
  positionId: '7',
  symbolId: '20000',
  side: '1',
  holdSizeWad: '200000000000000',
};
```

Replace the current `dependencies` parameter list with:

```js
function dependencies({
  initialLeverage = '20',
  readbackLeverage = '1',
  leverageEvent = {},
  simulation = '0x',
  receiptStatus = '0x1',
  orderEventOverrides = [{}],
  openOrders = [],
  positions = [livePosition],
  agentInfoOverrides = {},
} = {}) {
```

Replace `readRpc.getAgentInfo`, add `readRpc.getAllOpenPositions`, create the account client before the return, and return it:

```js
async getAgentInfo() { return { ...agentInfo(), ...agentInfoOverrides }; },
async getAllOpenPositions() { return positions; },

const accountClient = {
  async getAllOpenOrders() { return openOrders; },
};

return { readRpc, accountClient, writeRpc, serialized };

// client(deps)
accountClient: deps.accountClient,
```

Default `openOrders = []` and `positions = [livePosition]`. Add a no-sign table proving active orders, a Short position, a changed quantity, and a changed position ID all fail before serialization:

```js
for (const options of [
  { openOrders: [{ symbol: 'BTCUSDT', orderId: '99' }] },
  { positions: [] },
  { positions: [{ ...livePosition, side: '2' }] },
  { positions: [livePosition, { ...livePosition, positionId: '8' }] },
  { positions: [{ ...livePosition, holdSizeWad: '100000000000000' }] },
  { positions: [{ ...livePosition, positionId: '8' }] },
]) {
  const deps = dependencies(options);
  await assert.rejects(client(deps).closeFillCloseLong(plan, {
    closeClientOrderId: plan.closeClientOrderId,
    closeQtyWad: '200000000000000',
    positionQtyWad: '200000000000000',
    positionId: '7',
  }, fakeJournal('POSITION_CONFIRMED')), /活动订单|Long=1|持仓量|持仓 ID/);
  assert.equal(deps.serialized.length, 0);
}

const wrongAccountDeps = dependencies();
await assert.rejects(client(wrongAccountDeps).closeFillCloseLong({
  ...plan,
  mainAccount: '0x2222222222222222222222222222222222222222',
}, {
  closeClientOrderId: plan.closeClientOrderId,
  closeQtyWad: '200000000000000',
  positionQtyWad: '200000000000000',
  positionId: '7',
}, fakeJournal('POSITION_CONFIRMED')), /mainAccount/);
assert.equal(wrongAccountDeps.serialized.length, 0);

const expiredAgentDeps = dependencies({ agentInfoOverrides: { isExpired: true } });
await assert.rejects(client(expiredAgentDeps).closeFillCloseLong(plan, {
  closeClientOrderId: plan.closeClientOrderId,
  closeQtyWad: '200000000000000',
  positionQtyWad: '200000000000000',
  positionId: '7',
}, fakeJournal('POSITION_CONFIRMED')), /Agent.*过期/);
assert.equal(expiredAgentDeps.serialized.length, 0);
```

- [ ] **Step 5: Run trading, receipt, and write-boundary tests**

Run:

```bash
node --test test/popdex-fill-close-trading.test.js test/popdex-receipt-events.test.js test/popdex-write-rpc-client.test.js
```

Expected: PASS; close uses one `placeOrder`, exact `OrderCreate`, and one broadcast.

- [ ] **Step 6: Commit**

```bash
git add src/exchange/px/trading-client.js test/popdex-fill-close-trading.test.js
git commit -m "修复：通过PopDEX只减仓市价单平仓"
```

### Task 6: Integrate close settling and read-only recovery in the probe

**Files:**
- Modify: `test/popdex-fill-close-probe.test.js`
- Modify: `src/exchange/px/fill-close-probe.js`

- [ ] **Step 1: Write failing orchestration tests**

Update fake trading with this exact close implementation and make `getAllFills()` return the close fill after `phase === 'closed'`:

```js
async closeFillCloseLong(_plan, position, targetJournal) {
  closeCalls += 1;
  flow.push('trading:close');
  assert.equal(position.closeClientOrderId, _plan.closeClientOrderId);
  assert.equal(position.closeQtyWad, position.positionQtyWad);
  assert.equal(position.positionId, '7');
  targetJournal.advance('POSITION_CONFIRMED', 'CLOSE_BROADCAST', {
    closeKind: 'reduce-only-market',
    closeTxHash: `0x${'44'.repeat(32)}`,
    closeQtyWad: position.closeQtyWad,
  });
  targetJournal.advance('CLOSE_BROADCAST', 'CLOSE_SETTLING', {
    closeOrderId: '10',
  });
  phase = 'closed';
  return { orderId: '10' };
}

// Append this item to the existing entry fills only after the close was accepted.
if (phase === 'closed') {
  fills.push({
    fillId: '2',
    orderId: '10',
    symbol: 'BTCUSDT',
    side: 'Sell',
    execPrice: '63000',
    execQty: kind === 'full' ? '0.0002' : '0.0001',
  });
}
```

Assert:

```js
assert.equal(result.status, 'completed-flat');
assert.equal(result.closeOrderId, '10');
assert.deepEqual(scenario.counts, {
  leverageCalls: 0,
  entryCalls: 1,
  cancelCalls: 0,
  closeCalls: 1,
});
assert.ok(scenario.flow.indexOf('journal:CLOSE_SETTLING')
  < scenario.flow.indexOf('journal:COMPLETED'));
```

Add table-driven read-only recovery assertions:

```js
function closeFill(execQty) {
  return {
    fillId: '2',
    orderId: '10',
    symbol: 'BTCUSDT',
    side: 'Sell',
    execQty,
  };
}

function longPosition(holdSizeWad) {
  return {
    walletId: MAIN_ACCOUNT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    side: '1',
    holdSizeWad,
  };
}

const pending = recoveryDependencies('CLOSE_BROADCAST', { receiptStatus: null });
assert.equal((await runProbe({ mode: 'resume' }, pending.deps)).status,
  'close-receipt-pending');
assert.equal(pending.closeCalls, 0);

const partial = recoveryDependencies('CLOSE_SETTLING', {
  fills: [closeFill('0.0001')],
  positions: [longPosition('100000000000000')],
});
const partialResult = await runProbe({ mode: 'resume' }, partial.deps);
assert.equal(partialResult.status, 'partial-close-unresolved');
assert.equal(partial.closeCalls, 0);
assert.equal(partial.journal.load().stage, 'CLOSE_SETTLING');

const complete = recoveryDependencies('CLOSE_SETTLING', {
  fills: [closeFill('0.0002')],
  positions: [],
  openOrders: [],
});
assert.equal((await runProbe({ mode: 'resume' }, complete.deps)).status,
  'completed-flat');
assert.equal(complete.journal.load(), null);
```

Restore the CLI parsing expectations only after the corrected paths exist:

```js
assert.deepEqual(parseArgs(['--confirm-mainnet-fill-close']), { mode: 'fill-close' });
assert.deepEqual(parseArgs(['--resume', '--confirm-mainnet-close']), {
  mode: 'resume-close',
});
```

- [ ] **Step 2: Run probe tests and verify RED**

Run:

```bash
node --test test/popdex-fill-close-probe.test.js
```

Expected: FAIL because dry-run/recovery still reference `placeReverseOrder`, no `CLOSE_SETTLING` classifier exists, and live flags remain suspended.

- [ ] **Step 3: Update dry-run and result rendering**

Use `plan.closePreviewData` with `POPDEX_ORDER_INTERFACE` and `placeOrder`. Return both entry and close client IDs and hash only the preview:

```js
calldataHashes: {
  leverage: keccak256(plan.leverageData),
  entry: keccak256(plan.entryData),
  closePreview: keccak256(plan.closePreviewData),
},
closeClientOrderId: plan.closeClientOrderId,
```

Dry-run remains non-authoritative for business execution and performs no writes or journal creation.

When live mode creates the version-2 journal, persist the prepared close identity with the existing entry fields:

```js
journal.create({
  mainAccount,
  agentAddress,
  symbol: plan.symbol,
  symbolId: plan.symbolId,
  positionMode: plan.positionMode,
  leverage: plan.leverage,
  priceWad: plan.priceWad,
  qtyWad: plan.qtyWad,
  clientOrderId: plan.clientOrderId,
  closeClientOrderId: plan.closeClientOrderId,
});
```

- [ ] **Step 4: Update live close orchestration**

After `POSITION_CONFIRMED`, call:

```js
const closeOrder = await trading.closeFillCloseLong(plan, {
  closeClientOrderId: plan.closeClientOrderId,
  closeQtyWad: position.holdSizeWad,
  positionQtyWad: position.holdSizeWad,
  positionId: String(position.positionId),
}, journal);
```

Poll exact close facts containing all fills, BTC open orders, and on-chain positions with the existing bounded poll helper:

```js
const closeResult = await pollUntil({
  read: async () => {
    const facts = await recoveryFacts({ accountClient, readRpc, record: journal.load() });
    return { facts, result: classifyClose(journal.load(), facts) };
  },
  done: ({ result }) => result.kind !== 'settling',
  now,
  sleep,
  timeoutMs,
  pollMs,
  label: '平仓终态确认',
});
if (closeResult.result.kind !== 'completed-flat') {
  throw new Error(
    `PopDEX 平仓终态未完成：txHash=${journal.load().closeTxHash} `
    + `orderId=${journal.load().closeOrderId} kind=${closeResult.result.kind} `
    + `filledQtyWad=${closeResult.result.filledQtyWad} `
    + `remainingPositionQtyWad=${closeResult.result.remainingPositionQtyWad}。`,
  );
}
journal.advance('CLOSE_SETTLING', 'COMPLETED', {
  outcome: 'completed-flat',
  positionQtyWad: '0',
});
journal.clearCompleted();
```

On timeout, record the exact diagnostic at `CLOSE_SETTLING` and never invoke `closeFillCloseLong` again.

- [ ] **Step 5: Update recovery plan and stages**

Reconstruct close identity without any reverse interface. The known legacy record has no close client ID, so do not invent one:

```js
closeClientOrderId: record.closeClientOrderId,
closePreviewData: record.closeClientOrderId === null || record.closeQtyWad === null
  ? null
  : encodeReduceOnlyMarketClose({
    mainAccount: record.mainAccount,
    closeClientOrderId: record.closeClientOrderId,
    closeQtyWad: record.closeQtyWad,
  }),
```

Branch on `record.closeKind` before decoding a receipt: `legacy-reverse` may only use the failed-receipt/manual-flat read-only cleanup; it must never be decoded as `OrderCreate` and must never submit another transaction. For `reduce-only-market` `CLOSE_BROADCAST`, parse the saved receipt:

```js
if (record.closeKind === 'legacy-reverse' || receipt.status === '0x0') {
  if (record.closeKind === 'legacy-reverse' && receipt.status !== '0x0') {
    throw new Error('PopDEX legacy-reverse 恢复记录必须对应失败回执 status=0x0。');
  }
  const facts = await recoveryFacts({ accountClient, readRpc, record });
  try {
    assertCompletedFlat(facts);
  } catch (cause) {
    return {
      status: 'close-receipt-failed',
      stage: record.stage,
      action: null,
      facts,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  journal.advance('CLOSE_BROADCAST', 'COMPLETED', {
    outcome: 'completed-flat-manual',
    positionQtyWad: '0',
  });
  journal.clearCompleted();
  return { status: 'completed-flat-manual', stage: record.stage, action: null, facts };
}
const order = parseOrderCreateReceipt(receipt, {
  account: record.mainAccount,
  symbolId: record.symbolId,
  clientOrderId: record.closeClientOrderId,
  priceWad: '0',
  qtyWad: record.closeQtyWad,
});
journal.advance('CLOSE_BROADCAST', 'CLOSE_SETTLING', {
  closeOrderId: order.orderId,
});
```

For `CLOSE_SETTLING`, read exact close facts and invoke `classifyClose`; clear only on `completed-flat`, otherwise return `close-settling` or `partial-close-unresolved` with exact WAD quantities. Ordinary `--resume` must never instantiate `PopdexTradingClient`.

- [ ] **Step 6: Restore only the explicit corrected write gates**

Remove the temporary blanket suspension in `parseArgs` after all corrected paths are present. Retain mutual exclusion, duplicate-flag rejection, `--resume` requirements, and existing-hash no-repeat guards. No server/UI route is added.

- [ ] **Step 7: Run probe and state-machine tests**

Run:

```bash
node --test test/popdex-fill-close-probe.test.js test/popdex-fill-close-journal.test.js test/popdex-fill-close-state.test.js test/popdex-fill-close-trading.test.js
```

Expected: PASS for full, partial, zero-fill, crash recovery, legacy manual-flat cleanup, and no-repeat-write cases.

- [ ] **Step 8: Commit**

```bash
git add src/exchange/px/fill-close-probe.js test/popdex-fill-close-probe.test.js
git commit -m "修复：完成PopDEX只减仓平仓恢复闭环"
```

### Task 7: Preserve isolation and update living documentation

**Files:**
- Modify: `test/popdex-agent-isolation.test.js`
- Modify: `AGENTS.md`
- Modify: `docs/protocol/popdex-mainnet-validation.md`
- Modify: `docs/superpowers/specs/2026-08-18-popdex-stage5-fill-close-design.md`

- [ ] **Step 1: Strengthen the failing isolation assertion**

Add source assertions that Stage 5 no longer imports or calls the reverse interface and remains outside runtime routes:

```js
const codec = fs.readFileSync('src/exchange/px/fill-close-codec.js', 'utf8');
const trading = fs.readFileSync('src/exchange/px/trading-client.js', 'utf8');
assert.doesNotMatch(codec, /POPDEX_REVERSE_INTERFACE|placeReverseOrder/);
assert.doesNotMatch(trading, /POPDEX_REVERSE_INTERFACE|placeReverseOrder/);
assert.doesNotMatch(serverSource, /fill-close-probe|closeFillCloseLong/);
```

- [ ] **Step 2: Run the isolation test**

Run:

```bash
node --test test/popdex-agent-isolation.test.js
```

Expected before final cleanup: FAIL if any reverse-order reference or runtime route remains; otherwise PASS without changing runtime behavior.

- [ ] **Step 3: Update protocol facts**

Document these exact facts without claiming unperformed Bot-Agent Mainnet validation:

```text
- Official UI successful close tx: 0xbb8f…1e50.
- Close primitive: placeOrder selector 0x0f05a9d9.
- Params: Market Sell, ReduceOnly=1, Net=0, price=0, qty=exact position, slippage=3%.
- Failed primitive: placeReverseOrder selector 0xc808820f with Long=1, error [15200].
- Normal grid remains LIMIT + GTC.
- Corrected Bot-Agent close is implemented and offline-tested; one explicit bounded Mainnet validation remains required before IExchange integration.
```

Remove stale statements that describe `placeReverseOrder(Long=1)` as implemented or valid. Keep automatic PopDEX grid and server routes disabled.

- [ ] **Step 4: Run documentation and isolation tests**

Run:

```bash
node --test test/popdex-agent-isolation.test.js test/popdex-official-artifacts.test.js test/popdex-agent-ui.test.js
```

Expected: PASS; the UI still exposes Agent authorization only and no PopDEX trading action.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/protocol/popdex-mainnet-validation.md docs/superpowers/specs/2026-08-18-popdex-stage5-fill-close-design.md test/popdex-agent-isolation.test.js
git commit -m "文档：记录PopDEX官方平仓协议事实"
```

### Task 8: Full verification and VPS handoff

**Files:**
- Verify only; no new production file.

- [ ] **Step 1: Run whitespace and secret checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors, no `.env`, journal, private key, or temporary inspection script staged.

- [ ] **Step 2: Run the complete project suite**

Run:

```bash
npm test
```

Expected: all legacy grid tests and all Node tests pass with zero failures.

- [ ] **Step 3: Verify the write boundary is still isolated**

Run:

```bash
node --test test/security.test.js test/popdex-agent-isolation.test.js test/popdex-write-rpc-client.test.js
```

Expected: PASS; only `write-rpc-client.js` broadcasts raw transactions and no server/GridBot path imports the Stage 5 client.

- [ ] **Step 4: Verify the current failed record clears read-only on VPS**

After code publication and VPS update, run only:

```bash
npm run popdex:fill-close-probe -- --resume
npm run popdex:fill-close-probe -- --resume
```

Expected first output: `status=completed-flat-manual` after official reads confirm order `0` and position `0`. Expected second output: `status=no-record`. Do not delete `.popdex-fill-close-probe.json` manually.

- [ ] **Step 5: Run the read-only dry probe**

Run:

```bash
npm run popdex:fill-close-probe
```

Expected: `dry-run-ready`, `writeMethodsCalled=0` where reported, distinct entry/close client IDs, and a `closePreview` calldata hash. No journal or transaction is created.

- [ ] **Step 6: Stop before any Mainnet write**

Do not run `--confirm-mainnet-fill-close` or `--resume --confirm-mainnet-close` during automated verification. Present the passing tests, exact diff, and remaining Mainnet gate to the user; a future bounded live run requires a new explicit user instruction.
