import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBytes32String, encodeBytes32String, parseUnits } from 'ethers';
import { PopdexOwnershipStore } from '../src/exchange/px/ownership-store.js';
import { PopdexReconciler } from '../src/exchange/px/reconciler.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const QTY = parseUnits('0.0002', 18).toString();
const PRICE = parseUnits('60000', 18).toString();

function clientId(tag) {
  return encodeBytes32String(`dw-bb-${tag.repeat(24).slice(0, 24)}`).toLowerCase();
}

function ownedOrder(orderId = '1', overrides = {}) {
  return {
    orderId,
    clientOrderId: clientId(orderId),
    marketId: 20000,
    levelIndex: Number(orderId) - 1,
    side: 'buy',
    priceWad: PRICE,
    qtyWad: QTY,
    opening: true,
    reduceOnly: false,
    parentFillEventId: null,
    state: 'OPEN',
    filledQtyWad: '0',
    fillIds: [],
    terminalEvent: null,
    ...overrides,
  };
}

function restOrder(order = ownedOrder(), overrides = {}) {
  return {
    orderId: order.orderId,
    clientOid: decodeBytes32String(order.clientOrderId),
    symbolId: '20000',
    symbol: 'BTCUSDT',
    side: order.side === 'buy' ? 'Buy' : 'Sell',
    reduceOnly: order.reduceOnly,
    status: 'NewAccept',
    price: '60000',
    qty: '0.0002',
    filledQty: '0',
    remainingQty: '0.0002',
    cancelledQty: '0',
    ...overrides,
  };
}

function chainOrder(order = ownedOrder(), overrides = {}) {
  return {
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    symbolId: '20000',
    side: order.side === 'buy' ? '0' : '1',
    isReduceOnly: order.reduceOnly,
    priceWad: order.priceWad,
    qtyWad: order.qtyWad,
    filledQtyWad: '0',
    remainingQtyWad: order.qtyWad,
    cancelledQtyWad: '0',
    ...overrides,
  };
}

function fill(order = ownedOrder(), overrides = {}) {
  return {
    fillId: '9',
    orderId: order.orderId,
    symbol: 'BTCUSDT',
    side: order.side === 'buy' ? 'Buy' : 'Sell',
    execPrice: '60000',
    execQty: '0.0002',
    ...overrides,
  };
}

function position(overrides = {}) {
  return {
    positionId: '88',
    symbolId: '20000',
    side: '1',
    holdSizeWad: QTY,
    ...overrides,
  };
}

function memoryFs() {
  const files = new Map();
  return {
    readFileSync(file) {
      if (!files.has(file)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    writeFileSync(file, text) { files.set(file, text); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    chmodSync() {},
    statSync() { return { mode: 0o600 }; },
  };
}

function fixture({
  owned = [], restOpen = [], history = [], fills = [], active = [], completed = [],
  positions = [], nowRef = { value: 0 }, overrides = {},
} = {}) {
  const store = new PopdexOwnershipStore({
    file: 'ownership.json',
    mainAccount: ACCOUNT,
    fsImpl: memoryFs(),
    platform: 'linux',
    now: () => nowRef.value,
  });
  for (const order of owned) store.upsertOrder(order);
  const calls = [];
  const accountClient = {
    async getAllOpenOrders() { calls.push('restOpen'); return restOpen; },
    async getAllOrderHistory() { calls.push('history'); return history; },
    async getAllFills() { calls.push('fills'); return fills; },
  };
  const readRpc = {
    async getAllActiveOrders() { calls.push('active'); return active; },
    async getAllCompletedOrders() { calls.push('completed'); return completed; },
    async getAllOpenPositions() { calls.push('positions'); return positions; },
  };
  const reconciler = new PopdexReconciler({
    mainAccount: ACCOUNT,
    accountClient,
    readRpc,
    ownershipStore: store,
    now: () => nowRef.value,
    settleMs: 30_000,
    ...overrides,
  });
  return { reconciler, store, calls, accountClient, readRpc, nowRef };
}

test('reconciler adopts exact active orders and queues one offline fill', async () => {
  const first = ownedOrder('1');
  const second = ownedOrder('2');
  const target = fixture({
    owned: [first, second],
    restOpen: [restOrder(first)],
    active: [chainOrder(first)],
    completed: [chainOrder(second, {
      filledQtyWad: QTY, remainingQtyWad: '0', cancelledQtyWad: '0',
    })],
    fills: [fill(second)],
    positions: [position()],
  });

  const result = await target.reconciler.reconcile({ reason: 'startup' });
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.activeOrders.map((order) => order.orderId), ['1']);
  assert.equal(result.pendingEvents.length, 1);
  assert.equal(result.pendingEvents[0].orderId, '2');
  assert.deepEqual(target.calls.sort(), ['active', 'completed', 'fills', 'history', 'positions', 'restOpen']);
});

test('reconciler preserves the durable stop suppression policy on later refreshes', async () => {
  const one = ownedOrder('1');
  const terminal = chainOrder(one, {
    filledQtyWad: QTY, remainingQtyWad: '0', cancelledQtyWad: '0',
  });
  const target = fixture({
    owned: [one], completed: [terminal], fills: [fill(one)], positions: [position()],
  });

  await target.reconciler.reconcile({ reason: 'stop', suppressRequote: true });
  assert.equal(target.store.pendingEvents()[0].suppressRequote, true);

  const refreshed = await target.reconciler.reconcile({ reason: 'refresh' });
  assert.equal(refreshed.status, 'READY');
  assert.equal(target.store.pendingEvents()[0].suppressRequote, true);
});

test('reconciler rejects external and duplicate official order identities', async () => {
  const external = ownedOrder('9');
  await assert.rejects(
    fixture({ restOpen: [restOrder(external)], active: [chainOrder(external)] })
      .reconciler.reconcile({ reason: 'startup' }),
    (error) => error.code === 'POPDEX_EXTERNAL_ORDER',
  );

  const one = ownedOrder('1');
  await assert.rejects(
    fixture({ owned: [one], restOpen: [restOrder(one), restOrder(one)], active: [chainOrder(one)] })
      .reconciler.reconcile({ reason: 'refresh' }),
    (error) => error.code === 'POPDEX_IDENTITY_CONFLICT',
  );
});

test('missing terminal facts remain RECONCILING then fail after the settle deadline', async () => {
  const target = fixture({ owned: [ownedOrder('1')] });
  const first = await target.reconciler.reconcile({ reason: 'refresh' });
  assert.equal(first.status, 'RECONCILING');
  target.nowRef.value = 30_001;
  await assert.rejects(
    target.reconciler.reconcile({ reason: 'refresh' }),
    (error) => error.code === 'POPDEX_UNKNOWN_TERMINAL',
  );
});

test('REST and chain activity propagation mismatch is transient but not READY', async () => {
  const one = ownedOrder('1');
  const target = fixture({ owned: [one], restOpen: [restOrder(one)], active: [] });
  const result = await target.reconciler.reconcile({ reason: 'refresh' });
  assert.equal(result.status, 'RECONCILING');
  assert.deepEqual(result.activeOrders.map((order) => order.orderId), ['1']);
});

test('opening fills require a confirmed long position of sufficient size', async () => {
  const one = ownedOrder('1');
  const completed = chainOrder(one, {
    filledQtyWad: QTY, remainingQtyWad: '0', cancelledQtyWad: '0',
  });
  await assert.rejects(
    fixture({ owned: [one], completed: [completed], fills: [fill(one)] })
      .reconciler.reconcile({ reason: 'refresh' }),
    (error) => error.code === 'POPDEX_POSITION_MISMATCH',
  );
  await assert.rejects(
    fixture({
      owned: [one], completed: [completed], fills: [fill(one)],
      positions: [position({ side: '2' })],
    }).reconciler.reconcile({ reason: 'refresh' }),
    (error) => error.code === 'POPDEX_POSITION_MISMATCH',
  );
});

test('concurrent reconciliation calls share one complete read round', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const target = fixture();
  let restOpenCalls = 0;
  target.accountClient.getAllOpenOrders = async () => {
    restOpenCalls += 1;
    await gate;
    return [];
  };
  const one = target.reconciler.reconcile({ reason: 'refresh' });
  const two = target.reconciler.reconcile({ reason: 'refresh' });
  assert.equal(one, two);
  release();
  await Promise.all([one, two]);
  assert.equal(restOpenCalls, 1);
});

test('read failures preserve the original network cause', async () => {
  const target = fixture();
  const cause = new Error('connection reset');
  target.accountClient.getAllFills = async () => {
    throw new TypeError('fetch failed', { cause });
  };
  await assert.rejects(
    target.reconciler.reconcile({ reason: 'refresh' }),
    (error) => error.message === 'fetch failed' && error.cause === cause,
  );
});

test('durable exact cancellation proof closes an order absent from official snapshots', async () => {
  const one = ownedOrder('1');
  const target = fixture({ owned: [one] });
  target.store.recordCancelProof(one.orderId, {
    orderId: one.orderId,
    clientOrderId: one.clientOrderId,
    filledQtyWad: '0',
  });

  const result = await target.reconciler.reconcile({ reason: 'cancel:1', suppressRequote: true });
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.activeOrders, []);
  assert.equal(target.store.listOrders()[0].state, 'CANCELLED');
});

test('cancellation proof conflicts fail closed on a delayed fill or active order', async () => {
  const one = ownedOrder('1');
  const delayedFill = fixture({ owned: [one], fills: [fill(one)], positions: [position()] });
  delayedFill.store.recordCancelProof(one.orderId, {
    orderId: one.orderId,
    clientOrderId: one.clientOrderId,
    filledQtyWad: '0',
  });
  await assert.rejects(
    delayedFill.reconciler.reconcile({ reason: 'refresh' }),
    /撤单证明成交量不匹配/,
  );

  const activeConflict = fixture({
    owned: [one],
    restOpen: [restOrder(one)],
    active: [chainOrder(one)],
  });
  activeConflict.store.recordCancelProof(one.orderId, {
    orderId: one.orderId,
    clientOrderId: one.clientOrderId,
    filledQtyWad: '0',
  });
  await assert.rejects(
    activeConflict.reconciler.reconcile({ reason: 'refresh' }),
    (error) => error.code === 'POPDEX_IDENTITY_CONFLICT',
  );
});
