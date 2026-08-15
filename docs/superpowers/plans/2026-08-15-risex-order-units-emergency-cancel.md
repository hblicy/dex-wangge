# RISEx Order Units and Emergency Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse the decimal order values returned by the current RISEx mainnet and allow a strictly bounded cancel-all operation while the adapter is `HALTED` so accepted orders are not stranded.

**Architecture:** Keep numeric parsing specific to each transport: Orders WebSocket and order history/by-id use strict decimal strings, open orders use ticks/steps, and positions remain WAD. Add one risk-reducing exception to the write boundary for `cancelAll`: it reads the real open-order set first, cancels through the existing serialized permit path, confirms every affected terminal by exact ID, and never changes `HALTED` back to `READY`.

**Tech Stack:** Node.js ESM, `node:test`, `EventEmitter`, `risex-client 0.1.11`, RISEx REST and private WebSocket.

---

## File map

- `src/exchange/rs/normalize.js`: strict source-specific numeric conversion.
- `src/exchange/rs/private-stream.js`: private Orders parse diagnostics without credentials or signatures.
- `src/exchange/rs/risex.js`: write boundary, exact order reads, and confirmed emergency cancel-all.
- `test/risex-normalize.test.js`: production-shaped decimal order payload regression.
- `test/risex-private-stream.test.js`: decimal Orders transport and diagnostic regression.
- `test/risex-adapter.test.js`: order-history fixtures plus `HALTED` emergency cancellation behavior.
- `src/bot.js`: preserve both the startup failure and cleanup failure in the surfaced error.
- `test/bot.test.js`: startup rollback error-chain regression.
- `AGENTS.md`: current mainnet unit and emergency-write invariants.
- `docs/superpowers/specs/2026-08-15-risex-mainnet-adapter-design.md`: approved design source; no further semantic changes expected.

### Task 1: Parse current mainnet order values as strict decimal strings

**Files:**
- Modify: `test/risex-normalize.test.js:28-33,96-133,148-203`
- Modify: `test/risex-private-stream.test.js:150-190`
- Modify: `test/risex-adapter.test.js:15-23,67-80`
- Modify: `src/exchange/rs/normalize.js:13-22,138-165,209-230`

- [ ] **Step 1: Replace the Orders regression fixture with the observed mainnet payload**

Use a decimal payload in `test/risex-normalize.test.js`:

```js
const rawOrder = {
  id: '0x00000000000125b1000000000124ded20000000000000125',
  market_id: '1',
  side: 'BUY',
  size: '0.004447',
  price: '61000',
  filled_size: '0',
  avg_price: '0',
  status: 'ORDER_STATUS_OPEN',
  sender: '0xAbC',
  block_number: '12',
  log_index: '3',
};
```

Rename the test to `orders parser accepts current mainnet decimal values and preserves cursor` and assert:

```js
assert.equal(order.orderId, rawOrder.id);
assert.equal(order.status, 'OPEN');
assert.equal(order.sizeBase, 0.004447);
assert.equal(order.price, 61000);
assert.equal(order.filledSize, 0);
assert.equal(order.avgPrice, 0);
```

- [ ] **Step 2: Add strict invalid-type and range cases**

Extend the existing parser rejection test:

```js
assert.throws(
  () => parseOrderEnvelope(orderEnvelope({ ...rawOrder, size: 0.004447 })),
  /size.*十进制数字字符串/,
);
assert.throws(
  () => parseOrderEnvelope(orderEnvelope({ ...rawOrder, price: '6.1e4' })),
  /price.*十进制数字字符串/,
);
assert.throws(
  () => parseOrderEnvelope(orderEnvelope({ ...rawOrder, filled_size: '0.005' })),
  /超过订单总量/,
);
```

Update the REST order-history example to `size: '0.004447'`, `price: '61000'`, `filled_size: '0.001'`, and `avg_price: '60999.5'`; keep position fixtures in WAD.

- [ ] **Step 3: Run the normalizer test and verify RED**

Run:

```bash
node --test test/risex-normalize.test.js
```

Expected: FAIL with `size 必须是 18 位 WAD 整数字符串` for the observed order.

- [ ] **Step 4: Add one strict decimal-string helper and use it only for order objects**

Add beside `decimal` in `src/exchange/rs/normalize.js`:

```js
function decimalString(value, field, options = {}) {
  if (typeof value !== 'string') fail(field, '必须是十进制数字字符串。');
  return decimal(value, field, options);
}
```

Change Orders WebSocket parsing to:

```js
const sizeBase = decimalString(raw.size, `订单 ${orderId} size`, { min: 0, allowZero: false });
const price = decimalString(raw.price, `订单 ${orderId} price`, { min: 0 });
const filledSize = decimalString(raw.filled_size, `订单 ${orderId} filled_size`, { min: 0 });
const avgPrice = decimalString(raw.avg_price, `订单 ${orderId} avg_price`, { min: 0 });
```

Use the same four conversions in `normalizeRestOrderHistory`. Do not modify `wadToNumber`, `normalizeRestOpenOrder`, or `normalizeRestPosition`.

- [ ] **Step 5: Update all order-history and private Orders fixtures to the decimal contract**

In `test/risex-adapter.test.js`, change `rawHistory` to return the supplied values directly:

```js
function rawHistory(orderId, status, filledSize, avgPrice = '0') {
  return {
    id: orderId,
    market_id: '1',
    side: 'BUY',
    size: '0.001',
    price: '60000',
    filled_size: String(filledSize),
    avg_price: String(avgPrice),
    status,
    created_at: '20',
    block_number: '2',
    log_index: '0',
  };
}
```

Keep `toWad` for position fixtures only. Replace private Orders raw message sizes/prices in `test/risex-private-stream.test.js` with decimal strings such as `size: '0.001'`, `price: '60000'`, `filled_size: '0'`, `avg_price: '0'`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test test/risex-normalize.test.js test/risex-private-stream.test.js test/risex-adapter.test.js test/risex-verify.test.js
```

Expected: all focused tests PASS with zero failures.

- [ ] **Step 7: Commit the unit correction**

```bash
git add src/exchange/rs/normalize.js test/risex-normalize.test.js test/risex-private-stream.test.js test/risex-adapter.test.js
git commit -m "修复：按主网十进制解析RISEx订单"
```

### Task 2: Make Orders parse failures observable without exposing credentials

**Files:**
- Modify: `test/risex-private-stream.test.js`
- Modify: `src/exchange/rs/private-stream.js:250-295`

- [ ] **Step 1: Write a failing diagnostic test**

Using the existing fake socket harness, send an Orders update whose `size` is the number `0.001` instead of a string. Capture the `fatal` error and assert:

```js
assert.match(fatal.message, /Orders 解析失败/);
assert.match(fatal.message, /type=update/);
assert.match(fatal.message, /order=o-invalid/);
assert.match(fatal.message, /size:number/);
assert.match(fatal.message, /price:string/);
assert.doesNotMatch(fatal.message, /signature|permit|signerKey/i);
```

- [ ] **Step 2: Run the diagnostic test and verify RED**

Run:

```bash
node --test --test-name-pattern="Orders parse diagnostics" test/risex-private-stream.test.js
```

Expected: FAIL because the current fatal error contains only the normalizer message.

- [ ] **Step 3: Wrap Orders parse errors with bounded schema metadata**

In the `_handleMessage` catch block, special-case only `message.channel === 'orders'`:

```js
if (message?.channel === 'orders') {
  const row = Array.isArray(message.data) ? message.data[0] : null;
  const orderId = typeof row?.id === 'string' && row.id ? row.id : '(unknown)';
  const fields = ['size', 'price', 'filled_size', 'avg_price']
    .map((name) => `${name}:${row?.[name] === null ? 'null' : typeof row?.[name]}`)
    .join(',');
  this._fatal(new Error(
    `RISEx Orders 解析失败 type=${String(message.type || '(unknown)')} order=${orderId} fields=${fields}：${error.message}`,
    { cause: error },
  ));
  return;
}
this._fatal(error);
```

Do not log the complete message, account, signature, permit, or field values.

- [ ] **Step 4: Run the private-stream suite and verify GREEN**

Run:

```bash
node --test test/risex-private-stream.test.js
```

Expected: all private-stream tests PASS.

- [ ] **Step 5: Commit diagnostics**

```bash
git add src/exchange/rs/private-stream.js test/risex-private-stream.test.js
git commit -m "日志：补充RISEx订单解析诊断"
```

### Task 3: Permit only confirmed cancel-all while `HALTED`

**Files:**
- Modify: `test/risex-adapter.test.js`
- Modify: `src/exchange/rs/risex.js:401-446,973-985,1034-1069`

- [ ] **Step 1: Write a failing orphan-order emergency-cancel test**

Initialize the harness with no orders, then expose one REST order only after initialization, emit a fatal stream error, and call `cancelAll(1)`:

```js
test('RISEx HALTED emergency cancel removes an untracked REST order and stays HALTED', async () => {
  let open = false;
  const { exchange, stream, trace } = makeHarness({
    openOrdersImpl: (marketId) => (open && marketId === 1 ? [rawOpen('o-orphan')] : []),
    cancelAllImpl: async () => { open = false; return { success: true }; },
    orderByIdImpl: () => rawHistory('o-orphan', 'ORDER_STATUS_CANCELLED', '0'),
  });
  await exchange.init();
  open = true;
  stream.emit('fatal', new Error('observed schema mismatch'));

  assert.equal(exchange.connectionState, 'HALTED');
  assert.equal(await exchange.cancelAll(1), true);
  assert.equal(exchange.connectionState, 'HALTED');
  assert.equal(exchange.orderState.get('o-orphan'), null);
  assert.ok(trace.includes('write:cancelAll'));
  assert.ok(trace.includes('read:order:o-orphan:1'));
});
```

- [ ] **Step 2: Add assertions that every other write stays blocked**

In the same `HALTED` state, use a separate harness/test and assert:

```js
await assert.rejects(exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 }), /HALTED/);
await assert.rejects(exchange.setLeverage(1, 3), /HALTED/);
await assert.rejects(exchange.closePosition(1), /HALTED/);
await assert.rejects(exchange.cancelOrder(1, 'o1'), /HALTED/);
```

- [ ] **Step 3: Run the emergency test and verify RED**

Run:

```bash
node --test --test-name-pattern="HALTED emergency cancel" test/risex-adapter.test.js
```

Expected: FAIL with `RISEx 批量撤单被拒绝：HALTED`.

- [ ] **Step 4: Split exact REST reading from tracked-state application**

Refactor `src/exchange/rs/risex.js`:

```js
async _readOrderFromRest(orderId, marketId) {
  const raw = await this._client.getOrderById(orderId, marketId);
  this.lastRestAt = this._now();
  if (raw == null) return null;
  const confirmed = normalizeRestOrderHistory(raw);
  if (confirmed.orderId !== orderId || confirmed.marketId !== marketId) {
    throw new Error(`RISEx 订单 ${orderId} 单笔确认身份不匹配。`);
  }
  return confirmed;
}

async _confirmOrderFromRest(orderId, marketId) {
  const confirmed = await this._readOrderFromRest(orderId, marketId);
  if (confirmed == null) return false;
  const result = this.orderState.applyOrder(confirmed);
  this._handleOrderResult(result, confirmed);
  this._syncOfficialOrder(orderId);
  return true;
}
```

The read helper must not adopt an untracked order into the grid state.

- [ ] **Step 5: Add the private write-boundary option**

Extend `_assertWriteBoundary` with `allowHaltedCancelAll = false`:

```js
const haltedCancelAll = this.connectionState === 'HALTED' && allowHaltedCancelAll;
if (this.connectionState !== 'READY' && !haltedCancelAll) {
  throw new Error(`RISEx ${action}被拒绝：${this.connectionState} ${this.haltReason || ''}`.trim());
}
```

Only `cancelAll` may pass this option. `RECONCILING` remains rejected.

- [ ] **Step 6: Pre-read, cancel, and confirm the affected ID union**

At the start of `cancelAll`, validate through `_assertWriteBoundary(id, '批量撤单', { allowHaltedCancelAll: true })`, ensure `_info` and `_client` exist, set `_bulkCancel`, and read REST open orders before signing.

Build the affected IDs from local open records plus the pre-read REST snapshot. When the call began in `READY`, fail before writing if the REST snapshot contains an untracked order. When it began in `HALTED`, include those external IDs for cancellation confirmation but never call `orderState.track` for them.

Pass both options through the serialized operation:

```js
{
  allowBulkCancel: true,
  allowHaltedCancelAll: true,
}
```

During confirmation:

```js
const tracked = this.orderState.get(orderId);
if (tracked) {
  await this._confirmOrderFromRest(orderId, id);
  const current = this.orderState.get(orderId);
  if (current?.status !== 'FILLED' && current?.status !== 'CANCELLED') unresolved.push(orderId);
} else {
  const external = await this._readOrderFromRest(orderId, id);
  if (!external || (external.status !== 'FILLED' && external.status !== 'CANCELLED')) {
    unresolved.push(orderId);
  } else {
    this._suppressRequoteOrderIds.delete(orderId);
  }
}
```

Skip `_replaceOfficialOpenFromRest` only for the `HALTED` emergency path so external orders are not adopted. Keep the existing five bounded confirmation attempts and leave state as `HALTED` after success.

- [ ] **Step 7: Run the emergency tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern="HALTED emergency cancel" test/risex-adapter.test.js
```

Expected: emergency cancel tests PASS; blocked-write assertions PASS.

- [ ] **Step 8: Commit the emergency boundary**

```bash
git add src/exchange/rs/risex.js test/risex-adapter.test.js
git commit -m "安全：允许RISEx熔断后确认撤单"
```

### Task 4: Cover failure, delayed fill, and logging behavior

**Files:**
- Modify: `test/risex-adapter.test.js`
- Modify: `src/exchange/rs/risex.js:401-446`
- Modify: `test/bot.test.js:344-355`
- Modify: `src/bot.js:220-239`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write failing tests for preserved state and delayed fills**

Add two adapter tests:

1. A tracked order remains `OPEN` and the adapter remains `HALTED` when `cancelAllOrders` returns `{ success: false }`.
2. A tracked order filled during emergency cancel emits one fill with `suppressRequote === true`, returns only after exact terminal confirmation, and remains `HALTED`.

For the second case, use the existing `liveFill`, `liveOrder`, and `rawHistory` helpers; assert the fill quantity is the actual executed quantity.

- [ ] **Step 2: Add a failing emergency-log assertion**

Inject a logger whose `log` method appends strings, then assert at least one line matches:

```js
/HALTED 紧急撤单.*market 1.*受影响订单.*1/
```

- [ ] **Step 3: Run focused tests and verify RED where behavior is missing**

Run:

```bash
node --test --test-name-pattern="emergency|紧急撤单" test/risex-adapter.test.js
```

Expected before the logging implementation: FAIL on the explicit emergency log assertion.

- [ ] **Step 4: Add the emergency lifecycle log and preserve failure semantics**

When `cancelAll` begins in `HALTED`, log after the pre-read snapshot:

```js
this._logger.log?.(
  `[RISEx] HALTED 紧急撤单 market ${id}，受影响订单：${affectedOrderIds.length}`,
);
```

Do not catch or downgrade REST, permit, or terminal-confirmation failures. The existing `finally` must clear only `_bulkCancel`; it must not clear tracked records, switch to `READY`, or suppress the original exception.

- [ ] **Step 5: Preserve both startup and cleanup failure causes**

Add a bot regression in which durable persistence throws `disk full` and cleanup throws `HALTED schema mismatch`. Assert that the final message contains both causes:

```js
await assert.rejects(
  bot.start(config),
  /启动失败：disk full；且已接受挂单无法确认撤销：.*HALTED schema mismatch/,
);
```

Change the cleanup-failure branch in `src/bot.js` to preserve both messages:

```js
throw new AggregateError(
  [cause, cleanupCause],
  `启动失败：${cause.message}；且已接受挂单无法确认撤销：${cleanupCause.message}`,
);
```

- [ ] **Step 6: Update the living project boundary**

Replace the existing unconditional unknown-order sentence and add the unit boundary in `AGENTS.md`:

```markdown
- RISEx Orders WebSocket、订单历史和单笔订单接口的价量字段按当前主网人类可读十进制字符串解析；开放订单仍按 ticks/steps，仓位仍按已验证的 WAD 结构，禁止按字符串长度猜单位。
- 禁止根据订单消失推测成交或在正常状态自动撤销未知订单；唯一例外是用户已批准的 RISEx `HALTED` 紧急 `cancelAll`，它必须经过 REST 前置快照和逐单终态确认。成功后仍保持 `HALTED`，其他写操作继续禁止。
```

- [ ] **Step 7: Run adapter, bot, startup, and persistence tests**

Run:

```bash
node --test test/risex-adapter.test.js test/bot.test.js test/startup.test.js test/persist.test.js
```

Expected: all tests PASS with zero failures.

- [ ] **Step 8: Commit the safety regressions and documentation**

```bash
git add src/exchange/rs/risex.js test/risex-adapter.test.js src/bot.js test/bot.test.js AGENTS.md
git commit -m "测试：覆盖RISEx熔断紧急撤单"
```

### Task 5: Full verification and update PR #9

**Files:**
- Verify only; no production file is expected to change.

- [ ] **Step 1: Run the full local suite**

Run:

```bash
npm test
```

Expected: legacy grid tests and all Node TAP tests PASS with zero failures.

- [ ] **Step 2: Run the mainnet public read-only verifier**

Run:

```bash
npm run risex:verify
```

Expected: chain ID, BTC-PERP/ETH-PERP books, and public orderbook WebSocket PASS. This command must not load private credentials or issue writes.

- [ ] **Step 3: Check formatting, scope, and secrets**

Run:

```bash
git diff --check origin/codex/risex-mainnet-adapter...HEAD
git status --short --branch
git grep -n -E "RISEX_SIGNER_KEY=0x|PRIVATE_KEY=0x" -- ':!README.md' ':!.env.example'
```

Expected: no whitespace errors, only intended commits ahead of the remote branch, and no committed credentials.

- [ ] **Step 4: Push the verified branch**

Run:

```bash
git push origin codex/risex-mainnet-adapter
```

Expected: remote branch advances to the local HEAD.

- [ ] **Step 5: Read back PR #9 through GitHub CLI**

Run:

```bash
gh pr view 9 --repo hblicy/dex-wangge --json number,title,state,isDraft,url,headRefOid
```

Expected: PR #9 is open, remains Draft unless the user explicitly changes it, and `headRefOid` equals local `HEAD`.

Do not run `npm run risex:verify -- --private`, place an order, change leverage, cancel an order, or close a position automatically.
