# PopDEX Stage 6 Adapter and Paper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build isolated PopDEX live and paper `IExchange` adapters plus a crash-safe generic operation journal, without registering PopDEX in the Bot, server, config, API, or frontend.

**Architecture:** Add a composition-based live facade over the already verified PopDEX public, account, RPC, write RPC, codec, receipt, and trading clients. Add a separate official-market-data paper simulator and a strict single-operation journal for leverage/place/cancel/close recovery. Keep all new runtime entry points under `src/exchange/px/` and prove by tests that existing exchanges and application entry points remain unchanged.

**Tech Stack:** Node.js 20+ ESM, `node:test`, `node:assert/strict`, `EventEmitter`, ethers 6, existing PopDEX strict clients, synchronous atomic JSON journals.

---

## File map

**Create:**

- `src/exchange/px/operation-journal.js` — strict schema and atomic persistence for one live adapter write.
- `src/exchange/px/popdex.js` — live `IExchange` facade, snapshots, health, serialization, ownership, and recovery.
- `src/exchange/px/paper.js` — PopDEX-official-data paper simulator.
- `src/exchange/px/index.js` — isolated live/paper factory.
- `test/popdex-operation-journal.test.js` — journal schema, permissions, transitions, and crash facts.
- `test/popdex-adapter.test.js` — live read/state/write/recovery contract.
- `test/popdex-paper.test.js` — paper market data, matching, positions, and stale-data behavior.
- `test/popdex-factory.test.js` — factory and application-isolation boundary.

**Modify:**

- `src/exchange/px/order-codec.js` — expose a production-named limit-order planner while preserving probe compatibility.
- `src/exchange/px/fill-close-codec.js` — expose exact BTC 1x leverage calldata and close client-order identity helpers.
- `src/exchange/px/trading-client.js` — add generic adapter operations using explicit journal stages without changing probe behavior.
- `test/popdex-order-codec.test.js` — prove the production planner is byte-identical to the validated probe planner.
- `test/popdex-fill-close-codec.test.js` — prove extracted leverage/close helpers preserve mainnet vectors.
- `test/popdex-trading-client.test.js` — prove adapter journal stages and official terminal confirmation.
- `test/popdex-agent-isolation.test.js` — keep PopDEX Stage 6 outside Bot/server/config/frontend.
- `package.json` — add the four new test files to the explicit test command.
- `AGENTS.md` — record Stage 6 implementation and the remaining Stage 7 live-grid gate.
- `README.md` — state that adapter/Paper exist but live grid remains unavailable.

## Task 1: Generic operation journal

**Files:**

- Create: `src/exchange/px/operation-journal.js`
- Create: `test/popdex-operation-journal.test.js`

- [ ] **Step 1: Write the failing schema and lifecycle tests**

Create tests covering each kind and the one-active-record invariant:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexOperationJournal } from '../src/exchange/px/operation-journal.js';

test('operation journal persists one strict place operation atomically', () => {
  const fs = memoryFs();
  const journal = new PopdexOperationJournal({
    file: '/state/popdex-operation.json',
    fsImpl: fs,
    platform: 'linux',
    now: () => 1786946400000,
  });
  journal.create({
    kind: 'place',
    mainAccount: MAIN,
    agentAddress: AGENT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    side: 'buy',
    price: '60000',
    qty: '0.0002',
    clientOrderId: CLIENT_ID,
  });
  journal.advance('PREPARED', 'BROADCAST', { txHash: TX_HASH });
  journal.advance('BROADCAST', 'CONFIRMED', { orderId: '90071992547409931234' });

  assert.equal(journal.load().stage, 'CONFIRMED');
  assert.equal(fs.mode('/state/popdex-operation.json'), 0o600);
  assert.deepEqual(fs.renames, [
    ['/state/popdex-operation.json.tmp', '/state/popdex-operation.json'],
    ['/state/popdex-operation.json.tmp', '/state/popdex-operation.json'],
    ['/state/popdex-operation.json.tmp', '/state/popdex-operation.json'],
  ]);
});

test('operation journal refuses overwrite and clears only CONFIRMED', () => {
  const journal = createJournal();
  journal.create(placeFacts());
  assert.throws(() => journal.create(placeFacts()), /已有未完成操作/);
  assert.throws(() => journal.clearConfirmed(), /只有 CONFIRMED/);
});
```

Add separate tests for `leverage`, `cancel`, and `close`, unknown keys, unsafe order/position IDs, malformed bytes32 values, invalid stage transitions, invalid POSIX permissions, JSON corruption, write/rename failures, `recordError()`, and `completePreparedWithoutBroadcast()`.

- [ ] **Step 2: Run the journal test and verify RED**

Run:

```bash
node --test test/popdex-operation-journal.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `operation-journal.js`.

- [ ] **Step 3: Implement the strict journal**

Use one explicit record shape with kind-specific validation. Define these constants exactly:

```js
const KINDS = new Set(['leverage', 'place', 'cancel', 'close']);
const STAGES = new Set(['PREPARED', 'BROADCAST', 'CONFIRMED']);
const NEXT = Object.freeze({ PREPARED: 'BROADCAST', BROADCAST: 'CONFIRMED' });
```

Export `PopdexOperationJournal` with exactly these public methods: `constructor`, `load`, `create`, `advance`, `recordError`, `completePreparedWithoutBroadcast`, and `clearConfirmed`. `load()` returns `null` only for `ENOENT`; every other read, permission, JSON, and schema error throws. `create()` persists `PREPARED` and rejects any existing record. `advance()` accepts only the transition in `NEXT`. `completePreparedWithoutBroadcast()` writes `CONFIRMED`, `txHash: null`, and outcome `safe-no-broadcast`. `clearConfirmed()` calls `unlinkSync` only after loading a valid `CONFIRMED` record.

Persist through `<file>.tmp` followed by `renameSync`, create files with mode `0o600`, call `chmodSync(file, 0o600)` on POSIX, and never auto-delete a `BROADCAST` record. Validate required fields by kind:

- `leverage`: BTCUSDT/20000 and leverage `1`.
- `place`: BTCUSDT/20000, side, price, qty, clientOrderId; `orderId` becomes required at `CONFIRMED`.
- `cancel`: BTCUSDT/20000, orderId and clientOrderId.
- `close`: BTCUSDT/20000, positionId, positive qty, closeClientOrderId; `closeOrderId` becomes required at `CONFIRMED`.

- [ ] **Step 4: Run the journal test and verify GREEN**

Run:

```bash
node --test test/popdex-operation-journal.test.js
```

Expected: all journal tests PASS.

- [ ] **Step 5: Commit the journal**

```bash
git add src/exchange/px/operation-journal.js test/popdex-operation-journal.test.js
git commit -m "实现：新增PopDEX通用操作日志"
```

## Task 2: Production codecs and adapter-safe trading operations

**Files:**

- Modify: `src/exchange/px/order-codec.js`
- Modify: `src/exchange/px/fill-close-codec.js`
- Modify: `src/exchange/px/trading-client.js`
- Modify: `test/popdex-order-codec.test.js`
- Modify: `test/popdex-fill-close-codec.test.js`
- Modify: `test/popdex-trading-client.test.js`

- [ ] **Step 1: Write failing compatibility tests for production-named codecs**

Add assertions that new helpers preserve the validated bytes exactly:

```js
const probe = prepareProbeOrder(input);
const production = prepareLimitOrder(input);
assert.deepEqual(production, probe);

assert.equal(
  encodeBtcLeverageOne(MAIN_ACCOUNT),
  '0x75a358124ff6d9dac768951aa74a4cf82bd2862958e195aeed7e7b6c559b6e6c',
);
assert.match(createBtcCloseClientOrderId(fixedEntropy), /^0x[0-9a-f]{64}$/);
```

- [ ] **Step 2: Write failing adapter-stage trading tests**

Add tests that use a fake generic journal with `PREPARED -> BROADCAST -> CONFIRMED`:

```js
test('placeAdapterOrder uses generic stages and confirms exact REST identity', async () => {
  const journal = genericJournal('place');
  const result = await createClient(deps).placeAdapterOrder(plan(), journal);
  assert.equal(result.orderId, ORDER_ID);
  assert.deepEqual(journal.transitions, ['BROADCAST', 'CONFIRMED']);
});

test('closeAdapterBtcLong confirms receipt fill and zero official position', async () => {
  const journal = genericJournal('close');
  const result = await createClient(closeDeps).closeAdapterBtcLong({
    positionId: POSITION_ID,
    qtyWad: '200000000000000',
    closeClientOrderId: CLOSE_CLIENT_ID,
  }, journal);
  assert.equal(result.positionQtyWad, '0');
  assert.equal(journal.stage, 'CONFIRMED');
});
```

Also test BTC leverage readback, exact cancel terminal state, positive execution-price close receipt, unknown receipt/fill/position facts retaining `BROADCAST`, and no second broadcast attempt.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test test/popdex-order-codec.test.js test/popdex-fill-close-codec.test.js test/popdex-trading-client.test.js
```

Expected: FAIL because `prepareLimitOrder`, `encodeBtcLeverageOne`, `createBtcCloseClientOrderId`, and adapter trading methods do not exist.

- [ ] **Step 4: Extract production helpers without changing probe vectors**

In `order-codec.js`, make the validated implementation production-named and retain the old export as a compatibility wrapper:

```js
export function prepareLimitOrder(input) {
  // existing prepareProbeOrder body, unchanged
}

export function prepareProbeOrder(input) {
  return prepareLimitOrder(input);
}
```

In `fill-close-codec.js`, extract exact helpers used by both probe and adapter:

```js
export function encodeBtcLeverageOne(mainAccount) {
  const account = strictAddress(mainAccount, 'mainAccount');
  return POPDEX_USER_CONFIG_INTERFACE.encodeFunctionData('updateLeverage', [
    account,
    [1, 20000, ZeroAddress, 2],
  ]);
}

export function createBtcCloseClientOrderId(randomBytesImpl = randomBytes) {
  const entropy = exactEntropy(randomBytesImpl);
  return encodeBytes32String(`dw-bc-${hexlify(entropy.slice(0, 12)).slice(2)}`).toLowerCase();
}
```

Make `prepareFillClosePlan()` call these helpers so the existing mainnet test vectors remain the single source of truth.

- [ ] **Step 5: Refactor TradingClient around explicit stage maps**

Introduce internal stage maps and make the existing place implementation accept a stage map:

```js
const PROBE_PLACE_STAGES = Object.freeze({ prepared: 'PREPARED', broadcast: 'BROADCAST', confirmed: 'OPEN_CONFIRMED' });
const ADAPTER_STAGES = Object.freeze({ prepared: 'PREPARED', broadcast: 'BROADCAST', confirmed: 'CONFIRMED' });

async #placeAndConfirm(plan, journal, stages) {
  return this.#submitPlaceAndPollRest(plan, journal, stages);
}
async placeAndConfirm(plan, journal) { return this.#placeAndConfirm(plan, journal, PROBE_PLACE_STAGES); }
async placeAdapterOrder(plan, journal) { return this.#placeAndConfirm(plan, journal, ADAPTER_STAGES); }
```

Name the extracted private method `#submitPlaceAndPollRest`; move the current `placeAndConfirm()` validation, `#submit()`, `parseOrderCreateReceipt()`, `#pollOpenConfirmation()`, immutable identity checks, and journal confirmation into it without changing their order. Apply the same shared-core pattern to cancel with `#cancelAndPollTerminal(openOrder, journal, stages)`.

Add `setAdapterBtcLeverageOne(journal)`, `cancelAdapterOrder(openOrder, journal)`, and `closeAdapterBtcLong(position, journal)`. The leverage method uses `encodeBtcLeverageOne()`, `parseLeverageUpdatedReceipt()`, and exact `getAccountConfig()` readback. The cancel method calls `#cancelAndPollTerminal()` with `ADAPTER_STAGES`. The close method verifies the exact BTC long position ID/quantity, uses `createBtcCloseClientOrderId()` and `encodeReduceOnlyMarketClose()`, accepts only a positive execution-price receipt, then requires a matching close fill and zero BTC position before advancing `BROADCAST -> CONFIRMED`.

The private `#submit()` must continue persisting the locally computed transaction hash before calling `broadcast()`. Do not change existing probe method outputs or stages.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test test/popdex-order-codec.test.js test/popdex-fill-close-codec.test.js test/popdex-trading-client.test.js test/popdex-fill-close-trading.test.js test/popdex-write-probe.test.js test/popdex-fill-close-probe.test.js
```

Expected: all tests PASS, including all pre-existing probe tests.

- [ ] **Step 7: Commit codec and trading-client changes**

```bash
git add src/exchange/px/order-codec.js src/exchange/px/fill-close-codec.js src/exchange/px/trading-client.js test/popdex-order-codec.test.js test/popdex-fill-close-codec.test.js test/popdex-trading-client.test.js
git commit -m "重构：复用PopDEX实盘交易边界"
```

## Task 3: Live read snapshots, state machine, and health

**Files:**

- Create: `src/exchange/px/popdex.js`
- Create: `test/popdex-adapter.test.js`

- [ ] **Step 1: Write failing initialization and state tests**

Build injected fake clients and assert atomic snapshot behavior:

```js
test('live init publishes one complete verified BTC and ETH snapshot', async () => {
  const ex = createLiveAdapter();
  await ex.init();
  assert.deepEqual((await ex.getMarkets()).map((m) => m.marketId), [20000, 20001]);
  assert.equal(ex.getHealth().state, 'READY');
  assert.equal(ex.getPosition(20000), null);
  assert.equal(ex.equity, 799.23);
});

test('failed refresh retains the previous snapshot and enters RECONCILING', async () => {
  const ex = createLiveAdapter();
  await ex.init();
  const before = ex.getOpenOrders(20000);
  deps.accountClient.getAllOpenOrders = async () => { throw new Error('fetch failed'); };
  await assert.rejects(ex.refresh(), /账户刷新.*fetch failed/);
  assert.deepEqual(ex.getOpenOrders(20000), before);
  assert.equal(ex.getHealth().state, 'RECONCILING');
});
```

Add tests for malformed market/overview/position data entering `HALTED`, transient network recovery returning to `READY`, `HALTED` refusing timer-based recovery, manual `reconnect()` recovery, no half-snapshot publication, strict candle interval mapping, and sanitized health errors.

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```bash
node --test test/popdex-adapter.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `popdex.js`.

- [ ] **Step 3: Implement the live facade read boundary**

Create `PopdexExchange extends EventEmitter` with constructor dependencies `mainAccount`, `publicClient`, `accountClient`, `readRpc`, `tradingClient`, `journal`, `now`, `setIntervalImpl`, `clearIntervalImpl`, `pollMs`, and `staleMs`. Expose the exact public method list from the approved design. `init()` calls `#reconcile('init', false)`, `reconnect()` calls `#reconcile('manual-reconnect', true)`, and `refresh()` returns the single in-flight refresh promise. `getMarkets()`, `getOpenOrders()`, `getPosition()`, and `getHealth()` return clones, never the internal maps. `fetchOpenOrders()` waits for `refresh()` before returning. `start()` creates one unref'd timer and `stop()` clears only that timer.

Refresh public markets/tickers, `tradingClient.preflight()`, overview, both markets' paginated open orders, and `readRpc.getAllOpenPositions()` into local variables. Validate the complete candidate, then replace `this.snapshot` once. Classify network/timeout errors as `RECONCILING`; classify schema, identity, duplicate, journal, receipt, and position conflicts as `HALTED`.

- [ ] **Step 4: Run adapter read tests and verify GREEN**

Run:

```bash
node --test test/popdex-adapter.test.js
```

Expected: all read/state/health tests PASS.

- [ ] **Step 5: Commit live read/state implementation**

```bash
git add src/exchange/px/popdex.js test/popdex-adapter.test.js
git commit -m "实现：新增PopDEX实盘只读适配器"
```

## Task 4: Live writes, ownership, serialization, and read-only recovery

**Files:**

- Modify: `src/exchange/px/popdex.js`
- Modify: `test/popdex-adapter.test.js`

- [ ] **Step 1: Write failing safety-boundary tests**

Add tests for every write method and rejection path:

```js
test('live writes are serialized through one operation journal', async () => {
  const ex = await readyAdapter();
  const first = ex.placeLimitOrder(BTC_BUY);
  const second = ex.placeLimitOrder(BTC_SELL);
  await first;
  await second;
  assert.deepEqual(deps.calls.filter((x) => x.startsWith('trade:')), [
    'trade:place:buy', 'trade:place:sell',
  ]);
  assert.equal(deps.maxConcurrentWrites, 1);
});

test('cancelAll cancels only adopted PopDEX orders', async () => {
  const ex = await readyAdapter({ officialOrders: [ROBOT_ORDER, MANUAL_ORDER] });
  ex.adoptOrder(ROBOT_META);
  await ex.cancelAll(20000);
  assert.deepEqual(deps.cancelledIds, [ROBOT_ORDER.orderId]);
  assert.equal(ex.getOpenOrders(20000).some((o) => o.orderId === MANUAL_ORDER.orderId), true);
});

test('BROADCAST recovery never broadcasts again', async () => {
  const ex = recoveryAdapter({ journal: broadcastPlaceRecord(), officialOrder: ROBOT_ORDER });
  await ex.reconnect();
  assert.equal(deps.broadcastCalls, 0);
  assert.equal(ex.getHealth().state, 'READY');
  assert.equal(deps.journal.load(), null);
});
```

Also test `setLeverage(20000, 1)`, ETH write rejection, leverage other than 1 rejection, non-READY rejection, precision/min-notional rejection before journal creation, external order cancellation rejection, BTC short close rejection, BTC long close confirmation, PREPARED safe completion without broadcast, unresolved BROADCAST entering `HALTED`, and snapshot-refresh failure preserving `CONFIRMED` journal for reconnect.

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```bash
node --test test/popdex-adapter.test.js
```

Expected: FAIL on missing write methods and recovery behavior.

- [ ] **Step 3: Implement ownership and serialized writes**

Use a promise tail that stays usable after a rejected operation:

```js
#enqueueWrite(label, task) {
  const run = this.writeTail.then(async () => {
    this.#assertReadyForWrite(label);
    this.writeInFlight = label;
    try {
      return await task();
    } catch (error) {
      this.#recordWriteFailure(label, error);
      throw error;
    } finally {
      this.writeInFlight = null;
    }
  });
  this.writeTail = run.catch((error) => {
    this.lastQueueError = this.#sanitizedError(error);
  });
  return run;
}
```

`#recordWriteFailure()` must update health/state and emit the adapter error event before the returned `run` rejects; `lastQueueError` is exposed by `getHealth()`. The tail rejection handler exists only to keep later queued operations reachable and must not hide the failure from the caller or health state.

Implement all six write/ownership methods from the approved design with these exact restrictions: `setLeverage()` accepts only market `20000` and leverage `1`; `placeLimitOrder()` accepts only precision-aligned, minimum-notional BTC orders and returns a string `orderId`; `cancelOrder()` requires a matching entry in `ownedOrders`; `cancelAll()` snapshots owned IDs and cancels them sequentially; `adoptOrder()` requires complete order/client/market/side/price/qty metadata and rejects conflicts; `closePosition()` accepts only a currently confirmed BTC long and returns success only after the official position is zero. Every method except `adoptOrder()` runs through `#enqueueWrite()` and the generic journal.

Maintain an `ownedOrders` map keyed by official string order ID. Never infer ownership from price. `fetchOpenOrders()` returns official orders; `cancelAll()` intersects them with `ownedOrders`.

- [ ] **Step 4: Implement read-only journal recovery**

At `init()`/`reconnect()`, inspect `journal.load()` before entering `READY`:

- `PREPARED`: prove no transaction hash exists, transition to `CONFIRMED` with `safe-no-broadcast`, clear, then reconcile.
- `BROADCAST leverage`: read receipt and exact leverage readback.
- `BROADCAST place`: read receipt, parse exact `OrderCreate`, find exact REST order.
- `BROADCAST cancel`: read receipt, parse exact `OrderCancel`, confirm exact terminal/absence facts.
- `BROADCAST close`: read receipt, parse positive execution-price close order, confirm exact fill and zero BTC position.
- Any ambiguous or conflicting fact: retain journal, transition `HALTED`, and do not broadcast.
- `CONFIRMED`: perform a complete snapshot refresh, then clear.

- [ ] **Step 5: Run live adapter tests and focused PopDEX regressions**

Run:

```bash
node --test test/popdex-operation-journal.test.js test/popdex-adapter.test.js test/popdex-trading-client.test.js test/popdex-write-probe.test.js test/popdex-fill-close-probe.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit live writes and recovery**

```bash
git add src/exchange/px/popdex.js test/popdex-adapter.test.js
git commit -m "实现：完成PopDEX适配器写入与恢复边界"
```

## Task 5: Official-data Paper adapter

**Files:**

- Create: `src/exchange/px/paper.js`
- Create: `test/popdex-paper.test.js`

- [ ] **Step 1: Write failing Paper contract tests**

Use an injected `PopdexPublicClient` fake and deterministic clock:

```js
test('paper requires an explicit non-negative fee rate and official markets', async () => {
  assert.throws(() => new PopdexPaperExchange({ publicClient }), /feeRate.*显式/);
  const ex = new PopdexPaperExchange({ publicClient, feeRate: 0.0005, startBalance: 1000, now });
  await ex.init();
  assert.deepEqual((await ex.getMarkets()).map((m) => m.marketId), [20000, 20001]);
  assert.equal(ex.getHealth().dataSource, 'popdex-public');
});

test('paper fills crossed limits and emits exact grid metadata once', async () => {
  const ex = await readyPaper();
  const { orderId } = await ex.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002,
    levelIndex: 3, clientOrderId: 'paper-grid-3', reduceOnly: false,
  });
  const fills = [];
  ex.on('fill', (fill) => fills.push(fill));
  await publishTicker(ex, { bid: 59999, ask: 60000, last: 60000, mark: 60000 });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].orderId, orderId);
  assert.equal(ex.getPosition(20000).sizeBase, 0.0002);
});
```

Add tests for sell fills, weighted entry, partial position reduction, realized PnL and explicit fees, reduce-only refusing to increase/reverse a position, local cancel/cancelAll, closePosition, adoptOrder validation, stale ticker blocking `getPrice()` and new orders, read failure stopping matching, no synthetic fallback, start/stop timer idempotence, candles, and health fields.

- [ ] **Step 2: Run the Paper test and verify RED**

Run:

```bash
node --test test/popdex-paper.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `paper.js`.

- [ ] **Step 3: Implement the Paper exchange**

Create `PopdexPaperExchange extends EventEmitter` with constructor dependencies `publicClient`, explicit `feeRate`, `startBalance`, `now`, `pollMs`, `staleMs`, `setIntervalImpl`, and `clearIntervalImpl`. Implement the exact `IExchange` method list from the approved design. `init()` requires both official markets and initial tickers; `reconnect()` repeats that full read while retaining simulation state; candles always delegate to the official public client; `getPrice()` rejects missing or stale tickers; leverage is local and bounded by the official market; orders require aligned precision and minimum notional; cancel methods modify only local orders; position getters return clones with current unrealized PnL; `start()`/`stop()` manage only the ticker timer; health identifies `popdex-public` and the last public error.

On ticker success, replace the price, emit `price`, and match orders. On failure, set health to unavailable and do not call matching. Use order price as the simulated fill price. Apply fee exactly once per fill. A reduce-only fill quantity is capped to the reducible position and can never cross through zero.

- [ ] **Step 4: Run Paper tests and verify GREEN**

Run:

```bash
node --test test/popdex-paper.test.js
```

Expected: all Paper tests PASS.

- [ ] **Step 5: Commit Paper implementation**

```bash
git add src/exchange/px/paper.js test/popdex-paper.test.js
git commit -m "实现：新增PopDEX官方行情Paper模式"
```

## Task 6: Isolated factory and application boundary

**Files:**

- Create: `src/exchange/px/index.js`
- Create: `test/popdex-factory.test.js`
- Modify: `test/popdex-agent-isolation.test.js`

- [ ] **Step 1: Write failing factory and isolation tests**

```js
test('PopDEX factory creates only explicit paper or live adapters', () => {
  assert.ok(createExchange({ mode: 'paper', publicClient, feeRate: 0.0005 }) instanceof PopdexPaperExchange);
  assert.ok(createExchange(liveConfig) instanceof PopdexExchange);
  assert.throws(() => createExchange({ mode: 'unknown' }), /mode.*paper.*live/);
});

test('Stage 6 remains absent from Bot server config API and frontend', () => {
  for (const file of APPLICATION_ENTRY_FILES) {
    assert.doesNotMatch(read(file), /exchange\/px\/index|createPopdexExchange|PX_MODE/);
  }
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test test/popdex-factory.test.js test/popdex-agent-isolation.test.js
```

Expected: factory test FAIL because `px/index.js` does not exist; isolation tests continue to pass.

- [ ] **Step 3: Implement the isolated factory**

```js
export function createExchange(cfg, deps = {}) {
  if (cfg?.mode === 'paper') {
    return new PopdexPaperExchange({
      publicClient: deps.publicClient ?? new PopdexPublicClient(),
      feeRate: cfg.feeRate,
      startBalance: cfg.startBalance,
    });
  }
  if (cfg?.mode === 'live') {
    const publicClient = deps.publicClient ?? new PopdexPublicClient();
    const accountClient = deps.accountClient ?? new PopdexAccountClient();
    const readRpc = deps.readRpc ?? new PopdexRpcClient();
    const writeRpc = deps.writeRpc ?? new PopdexWriteRpcClient();
    const tradingClient = deps.tradingClient ?? new PopdexTradingClient({
      mainAccount: cfg.mainAccount,
      agentPrivateKey: cfg.agentPrivateKey,
      readRpc,
      accountClient,
      writeRpc,
    });
    const journal = deps.journal ?? new PopdexOperationJournal({ file: cfg.journalFile });
    return new PopdexExchange({
      mainAccount: cfg.mainAccount,
      publicClient,
      accountClient,
      readRpc,
      tradingClient,
      journal,
    });
  }
  throw new Error('PopDEX mode 必须是 paper 或 live。');
}
```

`createLiveExchange()` must require main account, Agent private key, and operation journal file; instantiate only fixed official Mainnet endpoints unless explicit test clients are injected. Do not import this factory from any application entry point in this stage.

- [ ] **Step 4: Run factory and isolation tests and verify GREEN**

Run:

```bash
node --test test/popdex-factory.test.js test/popdex-agent-isolation.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit factory and isolation boundary**

```bash
git add src/exchange/px/index.js test/popdex-factory.test.js test/popdex-agent-isolation.test.js
git commit -m "实现：新增隔离的PopDEX适配器工厂"
```

## Task 7: Test wiring and living documentation

**Files:**

- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `README.md`

- [ ] **Step 1: Write the documentation assertions before editing docs**

Extend `test/popdex-agent-isolation.test.js` to require these exact facts:

```js
assert.match(agents, /Stage 6.*IExchange.*Paper/);
assert.match(agents, /Stage 7.*成交补单.*恢复/);
assert.match(readme, /PopDEX 网格尚未开放/);
assert.doesNotMatch(readme, /PopDEX.*可上实盘网格/);
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```bash
node --test test/popdex-agent-isolation.test.js
```

Expected: FAIL because Stage 6 and Stage 7 status text is absent.

- [ ] **Step 3: Update package test wiring**

Append these files to the explicit `node --test` list in `package.json`:

```text
test/popdex-operation-journal.test.js
test/popdex-adapter.test.js
test/popdex-paper.test.js
test/popdex-factory.test.js
```

Do not add a live-grid script or change `start`.

- [ ] **Step 4: Update AGENTS and README**

Record:

- Stage 5 mainnet close loop is verified.
- Stage 6 live facade, operation journal, and Paper mode exist in isolation.
- PopDEX is still not registered in Bot/server/config/frontend.
- Stage 7 must complete fill identity, replacement orders, restart adoption, disconnect reconciliation, and BTC small-grid acceptance before live grid is available.

- [ ] **Step 5: Run documentation and isolation tests**

Run:

```bash
node --test test/popdex-agent-isolation.test.js test/popdex-factory.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit test wiring and documentation**

```bash
git add package.json AGENTS.md README.md test/popdex-agent-isolation.test.js
git commit -m "文档：记录PopDEX第六阶段安全边界"
```

## Task 8: Full verification and handoff

**Files:**

- Verify only; modify files only if a test exposes a root-cause defect.

- [ ] **Step 1: Run whitespace and repository checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and no unrelated files.

- [ ] **Step 2: Run the complete test suite**

```bash
npm test
```

Expected: existing 17 grid tests and every Node test PASS with zero failures.

- [ ] **Step 3: Run focused Stage 5/6 regressions**

```bash
node --test test/popdex-operation-journal.test.js test/popdex-adapter.test.js test/popdex-paper.test.js test/popdex-factory.test.js test/popdex-trading-client.test.js test/popdex-write-probe.test.js test/popdex-fill-close-probe.test.js
```

Expected: all tests PASS and no test performs a real network write.

- [ ] **Step 4: Confirm application isolation**

```bash
git diff --name-only main...HEAD
```

Expected: no changes under server routes, application config, dashboard HTML, Bot implementation, Decibel, Extended, or RISEx runtime files.

- [ ] **Step 5: Prepare VPS read-only acceptance commands**

After the branch is merged and pulled on the VPS, run only:

```bash
cd ~/dex-wangge
npm test
npm run popdex:verify -- --account-env POPDEX_MAIN_ACCOUNT
```

Expected: full automated tests pass; public/account read-only verification reports BTCUSDT and ETHUSDT with `writeMethodsCalled=0`. Do not run `--confirm-mainnet-fill-close` and do not expose a PopDEX grid start button.
