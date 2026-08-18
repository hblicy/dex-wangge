import test from 'node:test';
import assert from 'node:assert/strict';
import { GridBot } from '../src/bot.js';
import { FakeExchange } from './helpers/fake-exchange.js';

const config = {
  marketId: 1,
  mode: 'neutral',
  lower: 90,
  upper: 110,
  gridCount: 4,
  sizeBase: 1,
  leverage: 2,
  outOfRangeAction: 'close',
};

test('adjustRange keeps tracking and does not reseed when cancelAll fails', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start(config);
  exchange.cancelResult = false;

  await assert.rejects(bot.adjustRange({ lower: 88, upper: 112 }), /撤单失败/);

  assert.equal(exchange.orders.size, 4);
  assert.equal(bot.active.size, 4);
  assert.deepEqual([bot.config.lower, bot.config.upper], [90, 110]);
});

test('stop stays running and keeps tracking when cancelAll fails', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start(config);
  exchange.cancelResult = false;

  await assert.rejects(bot.stop({ closePosition: false }), /撤单失败/);

  assert.equal(bot.running, true);
  assert.equal(bot.active.size, 4);
});

test('Decibel cancellation requires two consecutive valid empty snapshots', async () => {
  const live = [{ orderId: '1', price: 95, side: 'buy' }];
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  exchange.cancelAll = async () => true;
  const snapshots = [[], live, [], []];
  exchange.fetchOpenOrders = async () => snapshots.shift();
  let forgot = 0;
  exchange.forgetOrders = () => { forgot++; };
  const bot = new GridBot(exchange, {
    cancelVerifyAttempts: 4, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2,
  });

  await bot._requireCancelAll(1, '测试');

  assert.equal(snapshots.length, 0);
  assert.equal(forgot, 1);
});

test('Decibel cancellation keeps state when snapshots are malformed', async () => {
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  exchange.cancelAll = async () => true;
  exchange.fetchOpenOrders = async () => null;
  const bot = new GridBot(exchange, {
    cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2,
  });

  await assert.rejects(bot._requireCancelAll(1, '测试'), /无法从交易所读取挂单快照/);
});

test('Decibel cancellation waits for pending placements before cancelAll', async () => {
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  let cancelCalls = 0;
  exchange.cancelAll = async () => { cancelCalls++; exchange.orders.clear(); return true; };
  const bot = new GridBot(exchange, {
    cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2,
  });
  let release;
  const placement = new Promise((resolve) => { release = resolve; });
  bot._pendingLevels.set(2, placement);

  const cancelling = bot._requireCancelAll(1, '测试');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 0);
  bot._pendingLevels.delete(2);
  release();
  await cancelling;
  assert.equal(cancelCalls, 1);
});

test('Decibel stop never closes a position when cancellation confirmation fails', async () => {
  const live = [{ orderId: '1', price: 95, side: 'buy' }];
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  exchange.cancelAll = async () => true;
  exchange.fetchOpenOrders = async () => live;
  let closeCalls = 0;
  exchange.closePosition = async () => { closeCalls++; return true; };
  const bot = new GridBot(exchange, {
    cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2,
  });
  bot.running = true;
  bot.config = { ...config };
  bot.active.set('1', { levelIndex: 1, side: 'buy', price: 95, placedAt: 1 });

  await assert.rejects(bot.stop({ closePosition: true }), /撤单未完成确认/);

  assert.equal(bot.running, true);
  assert.equal(bot.active.size, 1);
  assert.equal(closeCalls, 0);
});

test('start rejects a price outside the grid before placing orders', async () => {
  const exchange = new FakeExchange({ price: 80 });
  const bot = new GridBot(exchange);

  await assert.rejects(bot.start(config), /网格区间之外/);

  assert.equal(exchange.orders.size, 0);
  assert.equal(bot.running, false);
});

for (const invalid of [
  { name: 'fractional gridCount', patch: { gridCount: 2.5 } },
  { name: 'NaN sizeBase', patch: { sizeBase: Number.NaN } },
  { name: 'NaN leverage', patch: { leverage: Number.NaN } },
]) {
  test(`start rejects ${invalid.name}`, async () => {
    const bot = new GridBot(new FakeExchange());
    await assert.rejects(bot.start({ ...config, ...invalid.patch }), /参数/);
  });
}

test('start rejects leverage setup failure before placing orders', async () => {
  const exchange = new FakeExchange();
  exchange.setLeverage = async () => false;
  const bot = new GridBot(exchange);

  await assert.rejects(bot.start(config), /杠杆设置失败/);

  assert.equal(exchange.orders.size, 0);
  assert.equal(bot.running, false);
});

test('start aborts and cancels accepted seed orders after a placement failure', async () => {
  const exchange = new FakeExchange();
  const original = exchange.placeLimitOrder.bind(exchange);
  exchange.placeLimitOrder = async (order) => (
    exchange.nextId === 1 ? Promise.reject(new Error('rejected')) : original(order)
  );
  const bot = new GridBot(exchange);

  await assert.rejects(bot.start(config), /初始挂单失败/);

  assert.equal(exchange.orders.size, 0);
  assert.equal(bot.running, false);
});

test('start keeps managing accepted seed orders when cleanup cannot be confirmed', async () => {
  const exchange = new FakeExchange();
  const original = exchange.placeLimitOrder.bind(exchange);
  exchange.placeLimitOrder = async (order) => {
    if (exchange.nextId === 1) {
      exchange.cancelResult = false;
      throw new Error('rejected');
    }
    return original(order);
  };
  const bot = new GridBot(exchange);

  await assert.rejects(bot.start(config));

  assert.equal(exchange.orders.size, 1);
  assert.equal(bot.active.size, 1);
  assert.equal(bot.running, true);
  assert.equal(exchange.listenerCount('fill'), 1);
  assert.equal(exchange.listenerCount('price'), 1);
  bot._stopReconcileTimer();
});

test('close confirmation reports failure when closePosition throws', async () => {
  const exchange = new FakeExchange();
  let reads = 0;
  exchange.getPosition = () => (++reads === 1 ? { sizeBase: 1 } : null);
  exchange.closePosition = async () => { throw new Error('close rejected'); };
  const bot = new GridBot(exchange);

  assert.equal(await bot._closeWithConfirm(1, { attempts: 1, waitMs: 0 }), false);
});

test('automatic out-of-range stop records cancellation failure', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start(config);
  exchange.cancelResult = false;

  const originalError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    bot._handlePrice({ marketId: 1, price: 111 });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }

  assert.match(bot.alerts.map((item) => item.message).join('\n'), /自动停止失败.*撤单失败/);
  assert.match(errors.join('\n'), /自动停止失败.*撤单失败/);
  assert.equal(bot.running, true);
});

test('resume rolls back listeners and running state when initial reconciliation fails', async () => {
  const exchange = new FakeExchange();
  exchange.fetchOpenOrders = async () => { throw new Error('reconcile failed'); };
  const bot = new GridBot(exchange);
  const snapshot = {
    running: true,
    config: { ...config, displayName: 'TEST-USD' },
    active: [],
  };

  await assert.rejects(bot.resume(snapshot), /reconcile failed/);

  assert.equal(bot.running, false);
  assert.equal(bot._reconTimer, null);
  assert.equal(exchange.listenerCount('fill'), 0);
  assert.equal(exchange.listenerCount('price'), 0);
});

test('recovery start aborts before placing orders when initial reconciliation fails', async () => {
  const exchange = new FakeExchange({
    position: { sizeBase: 2, entryPrice: 95, leverage: 2 },
  });
  exchange.fetchOpenOrders = async () => { throw new Error('reconcile failed'); };
  const bot = new GridBot(exchange);

  await assert.rejects(bot.startRecovery({ marketId: 1, spacing: 1, sizeBase: 0.5 }), /reconcile failed/);

  assert.equal(exchange.orders.size, 0);
  assert.equal(bot.running, false);
  assert.equal(bot.recovery, false);
  assert.equal(exchange.listenerCount('fill'), 0);
  assert.equal(exchange.listenerCount('price'), 0);
});

test('recovery start waits until its initial reduce-only ladder is placed', async () => {
  const exchange = new FakeExchange({
    position: { sizeBase: 1, entryPrice: 95, leverage: 2 },
  });
  const original = exchange.placeLimitOrder.bind(exchange);
  let releasePlacement;
  const placementGate = new Promise((resolve) => { releasePlacement = resolve; });
  exchange.placeLimitOrder = async (order) => {
    await placementGate;
    return original(order);
  };
  const bot = new GridBot(exchange);
  let resolved = false;
  const starting = bot.startRecovery({ marketId: 1, spacing: 1, sizeBase: 0.5 })
    .then((state) => { resolved = true; return state; });

  await new Promise((resolve) => setImmediate(resolve));
  const resolvedBeforePlacement = resolved;
  releasePlacement();
  await starting;

  assert.equal(resolvedBeforePlacement, false);
  assert.ok(bot.active.size > 0);
  bot._stopReconcileTimer();
});

test('concurrent recovery updates cannot over-provision the ladder', async () => {
  const exchange = new FakeExchange({
    position: { sizeBase: 1, entryPrice: 95, leverage: 2 },
  });
  const original = exchange.placeLimitOrder.bind(exchange);
  exchange.placeLimitOrder = async (order) => {
    await new Promise((resolve) => setImmediate(resolve));
    return original(order);
  };
  const bot = new GridBot(exchange);
  bot.config = {
    ...config,
    mode: 'recovery',
    spacing: 1,
    sizeBase: 0.5,
  };
  bot.running = true;
  bot.recovery = true;
  bot.lastPrice = 100;

  const firstUpdate = bot._manageRecoveryStandalone();
  let secondResolved = false;
  const secondUpdate = bot._manageRecoveryStandalone().then(() => { secondResolved = true; });
  await Promise.resolve();
  const secondResolvedBeforeFirst = secondResolved;
  await Promise.all([firstUpdate, secondUpdate]);

  assert.equal(secondResolvedBeforeFirst, false);
  assert.equal(exchange.orders.size, 2);
  assert.equal(bot.active.size, 2);
});

test('recovery finish keeps running and tracking when cancellation fails', async () => {
  const exchange = new FakeExchange({ cancelResult: false });
  const bot = new GridBot(exchange);
  bot.config = { ...config, mode: 'recovery' };
  bot.running = true;
  bot.recovery = true;
  bot.active.set('recovery-order', { recovery: true, levelIndex: 1 });

  await assert.rejects(bot._finishRecovery());

  assert.equal(bot.running, true);
  assert.equal(bot.recovery, true);
  assert.equal(bot.active.has('recovery-order'), true);
});

test('recovery ladder keeps all tracking when an individual cancellation is unconfirmed', async () => {
  const exchange = new FakeExchange();
  exchange.cancelOrder = async () => false;
  const bot = new GridBot(exchange);
  bot.config = { ...config, mode: 'recovery' };
  bot.active.set('recovery-order', { recovery: true, levelIndex: 1 });

  await assert.rejects(bot._cancelRecoveryLadder());

  assert.equal(bot.active.has('recovery-order'), true);
});

test('price returning into range does not claim recovery cancellation succeeded when it failed', async () => {
  const exchange = new FakeExchange();
  exchange.cancelOrder = async () => false;
  const bot = new GridBot(exchange);
  bot.config = { ...config, outOfRangeAction: 'recover' };
  bot.running = true;
  bot.outOfRange = true;
  bot.active.set('recovery-order', { recovery: true, levelIndex: 1 });
  const originalError = console.error;
  console.error = () => {};
  try {
    bot._handlePrice({ marketId: 1, price: 100 });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }

  assert.equal(bot.outOfRange, true);
  assert.equal(bot.active.has('recovery-order'), true);
  assert.doesNotMatch(bot.alerts.map((item) => item.message).join('\n'), /恢复正常网格运行/);
});

test('returning into range waits for in-flight recovery placement before cancellation', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start({ ...config, outOfRangeAction: 'recover' });
  exchange.position = { sizeBase: 1, entryPrice: 95, leverage: 2 };
  const original = exchange.placeLimitOrder.bind(exchange);
  let releasePlacement;
  const placementGate = new Promise((resolve) => { releasePlacement = resolve; });
  exchange.placeLimitOrder = async (order) => {
    if (order.reduceOnly) await placementGate;
    return original(order);
  };

  bot._handlePrice({ marketId: 1, price: 80 });
  await new Promise((resolve) => setImmediate(resolve));
  bot._handlePrice({ marketId: 1, price: 100 });
  releasePlacement();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bot.outOfRange, false);
  assert.equal([...bot.active.values()].some((order) => order.recovery), false);
  bot._stopReconcileTimer();
});

test('stop waits for in-flight recovery placement before cancelling all orders', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start({ ...config, outOfRangeAction: 'recover' });
  exchange.position = { sizeBase: 1, entryPrice: 95, leverage: 2 };
  const original = exchange.placeLimitOrder.bind(exchange);
  let releasePlacement;
  const placementGate = new Promise((resolve) => { releasePlacement = resolve; });
  exchange.placeLimitOrder = async (order) => {
    if (order.reduceOnly) await placementGate;
    return original(order);
  };

  bot._handlePrice({ marketId: 1, price: 80 });
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = bot.stop({ closePosition: false });
  releasePlacement();
  await stopping;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(exchange.orders.size, 0);
  assert.equal(bot.active.size, 0);
  assert.equal(bot.running, false);
});

test('stray-order recovery reports cancellation failure and keeps tracking', async () => {
  const exchange = new FakeExchange({ cancelResult: false });
  const bot = new GridBot(exchange);
  bot.config = { ...config, displayName: 'TEST-USD' };
  bot.active.set('old-order', { levelIndex: 1, side: 'buy', price: 95 });

  await assert.rejects(bot.recoverStrayOrders(), /撤单失败/);

  assert.equal(bot.active.has('old-order'), true);
  assert.doesNotMatch(bot.alerts.map((item) => item.message).join('\n'), /已撤销/);
});

test('start cancels accepted orders when durable state cannot be written', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange, { onChange: () => { throw new Error('disk full'); } });

  await assert.rejects(bot.start(config), /disk full/);

  assert.equal(exchange.orders.size, 0);
  assert.equal(bot.active.size, 0);
  assert.equal(bot.running, false);
  assert.equal(exchange.listenerCount('fill'), 0);
  assert.equal(exchange.listenerCount('price'), 0);
});

test('start preserves both persistence and cleanup failure causes', async () => {
  const exchange = new FakeExchange();
  let cancelCalls = 0;
  exchange.cancelAll = async () => {
    cancelCalls += 1;
    if (cancelCalls === 1) {
      exchange.orders.clear();
      return true;
    }
    throw new Error('HALTED schema mismatch');
  };
  const bot = new GridBot(exchange, { onChange: () => { throw new Error('disk full'); } });

  await assert.rejects(
    bot.start(config),
    /启动失败：disk full；且已接受挂单无法确认撤销：.*HALTED schema mismatch/,
  );
});

test('bulk-cancel fill is accounted but never re-quoted', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start(config);
  const [orderId, order] = [...bot.active.entries()][0];
  for (const id of [...bot.active.keys()]) {
    if (id === orderId) continue;
    bot.active.delete(id);
    exchange.orders.delete(id);
  }
  const beforePlacements = exchange.nextId;
  exchange.emit('fill', {
    orderId,
    marketId: config.marketId,
    side: order.side,
    price: order.price,
    sizeBase: 0.25,
    levelIndex: order.levelIndex,
    suppressRequote: true,
  });
  await bot._fillQueue;
  assert.equal(exchange.nextId, beforePlacements);
  assert.equal(bot.fills[0].size, 0.25);
  bot._stopReconcileTimer();
});

test('fill persistence waits for the confirmed replacement order', async () => {
  const snapshots = [];
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange, {
    onChange: (snapshot) => snapshots.push(snapshot),
    logger: { log() {} },
  });
  await bot.start(config);
  const [orderId, order] = [...bot.active].find(([, item]) => item.levelIndex === 1);
  exchange.orders.delete(orderId);
  const original = exchange.placeLimitOrder.bind(exchange);
  let releasePlacement;
  const placementGate = new Promise((resolve) => { releasePlacement = resolve; });
  exchange.placeLimitOrder = async (next) => {
    await placementGate;
    return original(next);
  };

  exchange.emit('fill', {
    orderId,
    marketId: config.marketId,
    side: order.side,
    price: order.price,
    sizeBase: order.sizeBase,
    levelIndex: order.levelIndex,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(snapshots.at(-1).active.length, 4);

  releasePlacement();
  await bot._fillQueue;
  assert.equal(snapshots.at(-1).active.length, 4);
  bot._stopReconcileTimer();
});

test('same-level placement waits for the in-flight equivalent order', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  bot.config = { ...config };
  bot.running = true;
  let releasePlacement;
  const placementGate = new Promise((resolve) => { releasePlacement = resolve; });
  const original = exchange.placeLimitOrder.bind(exchange);
  exchange.placeLimitOrder = async (order) => {
    await placementGate;
    return original(order);
  };
  const intent = { levelIndex: 2, side: 'sell', price: 100, sizeBase: 1, opening: false };

  const first = bot._place(intent);
  const second = bot._place(intent);
  let secondDone = false;
  second.then(() => { secondDone = true; });
  await Promise.resolve();

  assert.equal(secondDone, false);

  releasePlacement();
  assert.equal((await first).status, 'placed');
  assert.equal((await second).status, 'covered');
  assert.equal(exchange.orders.size, 1);
});

test('a burst of adjacent fills vacates every terminal level before replacements', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange, { logger: { log() {} } });
  await bot.start(config);
  const buys = [...bot.active.entries()]
    .filter(([, order]) => order.side === 'buy')
    .sort((left, right) => left[1].levelIndex - right[1].levelIndex);

  for (const [orderId, order] of buys) {
    exchange.orders.delete(orderId);
    exchange.emit('fill', {
      orderId,
      marketId: config.marketId,
      side: order.side,
      price: order.price,
      sizeBase: order.sizeBase,
      levelIndex: order.levelIndex,
    });
  }
  await bot._fillQueue;

  assert.equal(bot.active.size, 4);
  assert.deepEqual([...bot.active.values()].map((order) => order.levelIndex).sort(), [1, 2, 3, 4]);
  bot._stopReconcileTimer();
});

test('adapter health fields pass through while generic bot counters remain', () => {
  const exchange = new FakeExchange();
  exchange.getHealth = () => ({
    status: 'error',
    reason: 'RISEx 私有流断开',
    privateStream: 'disconnected',
    reconciling: true,
    unknownOrders: 1,
    lastOrderAgeMs: 31_000,
    lastRestAgeMs: 1_000,
  });
  const bot = new GridBot(exchange);
  const health = bot.getState().health;
  assert.equal(health.status, 'error');
  assert.equal(health.privateStream, 'disconnected');
  assert.equal(health.reconciling, true);
  assert.equal(health.unknownOrders, 1);
  assert.equal(health.placeFails, 0);
  assert.equal(Object.hasOwn(health, 'exchangeOpenOrders'), true);
});

test('reconcile does not resend an accepted Decibel duplicate cancellation', async () => {
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  exchange.orders = new Map([
    ['survivor', { price: 95, side: 'buy' }],
    ['duplicate', { price: 95, side: 'buy' }],
  ]);
  let cancelCalls = 0;
  exchange.cancelOrder = async () => { cancelCalls++; return true; };
  const forgotten = [];
  exchange.forgetOrder = (orderId) => forgotten.push(String(orderId));
  const bot = new GridBot(exchange);
  bot.running = true;
  bot.config = { ...config };
  bot.grid = { levels: [90, 95, 100, 105], spacing: 5, count: 4 };

  await bot.reconcileOpenOrders();
  await bot.reconcileOpenOrders();

  assert.equal(cancelCalls, 1);
  assert.equal(bot._pendingCancelOrders.has('duplicate'), true);

  exchange.orders.delete('duplicate');
  await bot.reconcileOpenOrders();
  await bot.reconcileOpenOrders();

  assert.deepEqual(forgotten, ['duplicate']);
  assert.equal(bot._pendingCancelOrders.size, 0);
});

function strictExchange(overrides = {}) {
  const exchange = new FakeExchange({
    strictOrderRecovery: true,
    requiresDurableFillAck: true,
  });
  exchange.calls = [];
  exchange.haltReason = null;
  exchange.adoptCalls = 0;
  exchange.placeLimitOrder = async (order) => {
    exchange.calls.push('placeLimitOrder');
    const orderId = String(++exchange.nextId);
    const result = {
      orderId,
      clientOrderId: `0x${orderId.padStart(64, '0')}`,
      marketId: order.marketId,
      side: order.side,
      price: order.price,
      sizeBase: order.sizeBase,
      reduceOnly: order.reduceOnly,
      levelIndex: order.levelIndex,
      opening: order.opening,
      parentFillEventId: order.parentFillEventId ?? null,
    };
    exchange.orders.set(orderId, result);
    return result;
  };
  exchange.recoverOwnedOrders = async () => {
    exchange.calls.push('recoverOwnedOrders');
    return { activeOrders: [], pendingEvents: [] };
  };
  exchange.reconcileOwnedOrders = async () => {
    exchange.calls.push('reconcileOwnedOrders');
    return { activeOrders: [...exchange.orders.values()], pendingEvents: [] };
  };
  exchange.releaseRecoveredEvents = () => { exchange.calls.push('releaseRecoveredEvents'); };
  exchange.acknowledgeFillEvent = (eventId, orderId) => {
    exchange.calls.push(`acknowledgeFillEvent:${eventId}:${String(orderId)}`);
  };
  exchange.adoptOrder = () => { exchange.adoptCalls++; };
  exchange.haltFromBot = (error) => { exchange.haltReason ??= error?.message ?? String(error); };
  exchange.start = () => { exchange.calls.push('start'); };
  return Object.assign(exchange, overrides);
}

const strictConfig = {
  ...config,
  mode: 'long',
  leverage: 1,
};

test('strict bot persists gridRunId before placement and stores complete adapter order identity', async () => {
  const callOrder = [];
  const exchange = strictExchange();
  const originalPlace = exchange.placeLimitOrder;
  exchange.placeLimitOrder = async (order) => {
    callOrder.push('placeLimitOrder');
    return originalPlace(order);
  };
  const bot = new GridBot(exchange, {
    onChange: () => callOrder.push('persistSnapshot'),
  });

  await bot.start(strictConfig);
  const snapshot = bot.snapshot();
  assert.match(snapshot.config.gridRunId, /^[0-9a-f-]{36}$/);
  assert.equal(callOrder[0], 'persistSnapshot');
  const [, active] = snapshot.active[0];
  assert.match(active.clientOrderId, /^0x[0-9a-f]{64}$/);
  assert.equal(active.reduceOnly, false);
  assert.equal(active.opening, true);
  assert.equal(active.parentFillEventId, null);
  bot._stopReconcileTimer();
});

test('strict resume replaces stale active orders without adoption or price guessing', async () => {
  const exchange = strictExchange();
  const recoveredOrder = {
    orderId: '123',
    clientOrderId: `0x${'12'.repeat(32)}`,
    marketId: 1,
    side: 'buy',
    price: 95,
    sizeBase: 1,
    reduceOnly: false,
    levelIndex: 1,
    opening: true,
    parentFillEventId: null,
  };
  exchange.recoverOwnedOrders = async () => {
    exchange.calls.push('recoverOwnedOrders');
    return { activeOrders: [recoveredOrder], pendingEvents: [] };
  };
  exchange.reconcileOwnedOrders = async () => {
    exchange.calls.push('reconcileOwnedOrders');
    return { activeOrders: [recoveredOrder], pendingEvents: [] };
  };
  exchange.releaseRecoveredEvents = () => {
    assert.equal(exchange.listenerCount('fill'), 1);
    exchange.calls.push('releaseRecoveredEvents');
  };
  const bot = new GridBot(exchange);
  await bot.resume({
    running: true,
    config: { ...strictConfig, displayName: 'TEST-USD', gridRunId: 'run-1' },
    active: [['stale', { levelIndex: 3, side: 'sell', price: 105 }]],
  });

  assert.deepEqual([...bot.active.keys()], ['123']);
  assert.equal(bot.active.get('123').clientOrderId, recoveredOrder.clientOrderId);
  assert.equal(exchange.adoptCalls, 0);
  assert.deepEqual(exchange.calls, [
    'recoverOwnedOrders', 'start', 'reconcileOwnedOrders', 'releaseRecoveredEvents',
  ]);
  bot._stopReconcileTimer();
});

test('strict terminal fill persists replacement before durable event acknowledgement', async () => {
  const callOrder = [];
  const exchange = strictExchange();
  const originalPlace = exchange.placeLimitOrder;
  exchange.placeLimitOrder = async (order) => {
    callOrder.push('placeLimitOrder');
    return originalPlace(order);
  };
  exchange.acknowledgeFillEvent = (eventId, orderId) => {
    callOrder.push(`acknowledgeFillEvent:${eventId}:${orderId}`);
  };
  const bot = new GridBot(exchange, {
    onChange: () => callOrder.push('persistSnapshot'),
    logger: { log() {} },
  });
  bot.config = { ...strictConfig, displayName: 'TEST-USD', gridRunId: 'run-1' };
  bot.grid = { levels: [90, 95, 100, 105, 110], spacing: 5, count: 4 };
  bot.running = true;
  bot.active.set('old', {
    levelIndex: 1, side: 'buy', price: 95, sizeBase: 1, opening: true,
    clientOrderId: `0x${'11'.repeat(32)}`, reduceOnly: false, parentFillEventId: null,
  });
  exchange.on('fill', bot._onFill);
  const eventId = `px-fill-${'a'.repeat(64)}`;
  exchange.emit('fill', {
    fillEventId: eventId,
    orderId: 'old', marketId: 1, side: 'buy', price: 95, sizeBase: 1, levelIndex: 1,
    suppressRequote: false,
  });
  await bot._fillQueue;

  assert.deepEqual(callOrder.map((entry) => entry.split(':')[0]), [
    'placeLimitOrder', 'persistSnapshot', 'acknowledgeFillEvent',
  ]);
  assert.equal(bot.stats.buys, 1);
  assert.equal(bot.fills.length, 1);
  exchange.off('fill', bot._onFill);
});

test('strict replacement failure halts without stats mutation or generic retry', async () => {
  const exchange = strictExchange();
  exchange.placeLimitOrder = async () => { throw new Error('write failed'); };
  const bot = new GridBot(exchange, { logger: { log() {} } });
  bot.config = { ...strictConfig, displayName: 'TEST-USD', gridRunId: 'run-1' };
  bot.grid = { levels: [90, 95, 100, 105, 110], spacing: 5, count: 4 };
  bot.running = true;
  bot.active.set('old', {
    levelIndex: 1, side: 'buy', price: 95, sizeBase: 1, opening: true,
    clientOrderId: `0x${'11'.repeat(32)}`, reduceOnly: false, parentFillEventId: null,
  });
  exchange.on('fill', bot._onFill);
  exchange.emit('fill', {
    fillEventId: `px-fill-${'b'.repeat(64)}`,
    orderId: 'old', marketId: 1, side: 'buy', price: 95, sizeBase: 1, levelIndex: 1,
    suppressRequote: false,
  });
  await bot._fillQueue;

  assert.equal(bot._retryQueue.length, 0);
  assert.equal(bot.stats.buys, 0);
  assert.equal(bot.fills.length, 0);
  assert.match(exchange.haltReason, /write failed/);
  exchange.off('fill', bot._onFill);
});

test('strict equivalent level is covered only by the same parent fill intent', async () => {
  const exchange = strictExchange();
  const bot = new GridBot(exchange);
  bot.config = { ...strictConfig, gridRunId: 'run-1' };
  bot.running = true;
  bot.active.set('other', {
    levelIndex: 2, side: 'sell', price: 100, sizeBase: 1, opening: false,
    parentFillEventId: `px-fill-${'c'.repeat(64)}`,
  });
  const result = await bot._place({
    levelIndex: 2, side: 'sell', price: 100, sizeBase: 1, opening: false,
    parentFillEventId: `px-fill-${'d'.repeat(64)}`,
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /补单意图冲突/);
});

test('strict suppressed fill persists statistics before acknowledging without replacement', async () => {
  const callOrder = [];
  const exchange = strictExchange();
  exchange.acknowledgeFillEvent = (eventId, orderId) => {
    callOrder.push(`acknowledgeFillEvent:${eventId}:${String(orderId)}`);
  };
  const bot = new GridBot(exchange, {
    onChange: () => callOrder.push('persistSnapshot'),
  });
  bot.config = { ...strictConfig, displayName: 'TEST-USD', gridRunId: 'run-1' };
  bot.grid = { levels: [90, 95, 100, 105, 110], spacing: 5, count: 4 };
  bot.running = true;
  const eventId = `px-fill-${'e'.repeat(64)}`;

  await bot._handleStrictFill({
    fillEventId: eventId,
    orderId: 'old', marketId: 1, side: 'sell', price: 100, sizeBase: 1,
    levelIndex: 2, suppressRequote: true,
  }, {
    levelIndex: 2, side: 'sell', price: 100, sizeBase: 1, opening: false,
    recovery: false,
  });

  assert.deepEqual(callOrder, [
    'persistSnapshot',
    `acknowledgeFillEvent:${eventId}:null`,
  ]);
  assert.equal(bot.stats.sells, 1);
  assert.equal(bot.stats.completedRungs, 1);
  assert.equal(exchange.orders.size, 0);
});

test('strict processed fill replay only acknowledges its existing replacement', async () => {
  const exchange = strictExchange();
  const eventId = `px-fill-${'f'.repeat(64)}`;
  const replacementId = 'replacement-order';
  const bot = new GridBot(exchange);
  bot.config = { ...strictConfig, displayName: 'TEST-USD', gridRunId: 'run-1' };
  bot.grid = { levels: [90, 95, 100, 105, 110], spacing: 5, count: 4 };
  bot.running = true;
  bot.stats.buys = 1;
  bot._processedFillEventIds.add(eventId);
  bot.active.set(replacementId, {
    levelIndex: 2, side: 'sell', price: 100, sizeBase: 1, opening: false,
    parentFillEventId: eventId,
  });

  await bot._handleStrictFill({
    fillEventId: eventId,
    orderId: 'old', marketId: 1, side: 'buy', price: 95, sizeBase: 1,
    levelIndex: 1, suppressRequote: false,
  }, null);

  assert.equal(bot.stats.buys, 1);
  assert.equal(bot.fills.length, 0);
  assert.equal(exchange.orders.size, 0);
  assert.deepEqual(exchange.calls, [
    `acknowledgeFillEvent:${eventId}:${replacementId}`,
  ]);
});

test('strict placement rejects incomplete adapter identity and halts without retry', async () => {
  const exchange = strictExchange({
    placeLimitOrder: async () => ({ orderId: 'incomplete' }),
  });
  const bot = new GridBot(exchange, { logger: { log() {} } });
  bot.config = { ...strictConfig, gridRunId: 'run-1' };
  bot.running = true;

  await assert.rejects(
    bot._place({ levelIndex: 1, side: 'buy', price: 95, sizeBase: 1, opening: true }),
    /严格下单响应缺少完整订单元数据/,
  );
  assert.match(exchange.haltReason, /严格下单响应缺少完整订单元数据/);
  assert.equal(bot._retryQueue.length, 0);
  assert.equal(bot.active.size, 0);
});

test('strict invalid fill event halts before any accounting or acknowledgement', async () => {
  const exchange = strictExchange();
  const bot = new GridBot(exchange);
  bot.config = { ...strictConfig, gridRunId: 'run-1' };
  bot.running = true;

  await assert.rejects(
    bot._handleStrictFill({
      fillEventId: 'invalid', marketId: 1, side: 'buy', price: 95,
      sizeBase: 1, levelIndex: 1, suppressRequote: false,
    }, null),
    /缺少有效 fillEventId/,
  );
  assert.match(exchange.haltReason, /缺少有效 fillEventId/);
  assert.equal(bot.stats.buys, 0);
  assert.equal(exchange.calls.length, 0);
});

test('strict snapshot failure after replacement preserves recoverable order and pending event', async () => {
  const exchange = strictExchange();
  const bot = new GridBot(exchange, {
    onChange: () => { throw new Error('snapshot write failed'); },
    logger: { log() {} },
  });
  bot.config = { ...strictConfig, displayName: 'TEST-USD', gridRunId: 'run-1' };
  bot.grid = { levels: [90, 95, 100, 105, 110], spacing: 5, count: 4 };
  bot.running = true;
  const eventId = `px-fill-${'1'.repeat(64)}`;

  await assert.rejects(bot._handleStrictFill({
    fillEventId: eventId,
    orderId: 'old', marketId: 1, side: 'buy', price: 95, sizeBase: 1,
    levelIndex: 1, suppressRequote: false,
  }, {
    levelIndex: 1, side: 'buy', price: 95, sizeBase: 1, opening: true,
    recovery: false,
  }), /snapshot write failed/);

  assert.equal(exchange.orders.size, 1);
  assert.equal([...exchange.orders.values()][0].parentFillEventId, eventId);
  assert.equal(bot.stats.buys, 0);
  assert.equal(bot.fills.length, 0);
  assert.equal(bot._processedFillEventIds.has(eventId), false);
  assert.equal(exchange.calls.some((call) => call.startsWith('acknowledgeFillEvent:')), false);
  assert.match(exchange.haltReason, /snapshot write failed/);
});
