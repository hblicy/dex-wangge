import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RisexExchange } from '../src/exchange/rs/risex.js';

const ACCOUNT = '0x0000000000000000000000000000000000000001';
const SIGNER_KEY = `0x${'11'.repeat(32)}`;
const config = {
  account: ACCOUNT,
  signerKey: SIGNER_KEY,
  apiUrl: 'https://api.rise.trade',
  wsUrl: 'wss://api.rise.trade/ws/',
  network: 'mainnet',
};

const rawMarkets = [
  {
    market_id: '1', display_name: 'BTC-USD', base_asset_symbol: 'BTC', visible: true,
    last_price: '60000', mark_price: '60001',
    config: { step_size: '0.0001', step_price: '0.1', min_order_size: '0.001', max_leverage: '50' },
  },
  {
    market_id: '2', display_name: 'ETH-USD', base_asset_symbol: 'ETH', visible: true,
    last_price: '3000', mark_price: '3001',
    config: { step_size: '0.001', step_price: '0.01', min_order_size: '0.01', max_leverage: '50' },
  },
];

class FakeStream extends EventEmitter {
  constructor(events = [], trace = []) {
    super();
    this.events = events;
    this.trace = trace;
    this.authenticated = false;
  }

  beginBuffering() { this.trace.push('ws:buffer'); }
  async connect() { this.trace.push('ws:connect'); this.authenticated = true; }
  async waitForOrderSnapshot() { this.trace.push('ws:snapshot'); }
  drainBuffered() {
    this.trace.push('ws:drain');
    const drained = [...this.events];
    this.events = [];
    return drained;
  }
  releaseBuffer() { this.trace.push('ws:release'); }
  stop() { this.authenticated = false; }
}

function rawOpen(orderId = 'o1', marketId = 1) {
  return {
    order_id: orderId, resting_order_id: `r-${orderId}`, market_id: marketId,
    side: 0, order_type: 1, price_ticks: 600000, size_steps: 10,
    time_in_force: 0, post_only: false, reduce_only: false,
  };
}

function rawHistory(orderId, status, filledSize, avgPrice = '0') {
  return {
    order_id: orderId,
    market_id: '1',
    side: 0,
    size: '0.001',
    price: '60000',
    filled_size: String(filledSize),
    avg_price: String(avgPrice),
    status,
    timestamp: '20',
  };
}

function rawRestFill(orderId, fillId, size = '0.001', price = '59999') {
  return {
    fill_id: fillId,
    order_id: orderId,
    market_id: '1',
    side: 0,
    size,
    price,
    timestamp: '19',
  };
}

function wsOpen(orderId = 'o1', marketId = 1) {
  return {
    kind: 'order',
    data: {
      orderId, marketId, side: 'buy', sizeBase: 0.001, price: 60000,
      filledSize: 0, avgPrice: 0, status: 'OPEN', sender: ACCOUNT,
      cursor: { block: 1n, log: 0n, timestamp: 1n },
    },
  };
}

function makeHarness({
  markets = rawMarkets,
  openByMarket = new Map(),
  historyByMarket = new Map(),
  fillsByMarket = new Map(),
  positions = [],
  balance = '1000',
  streamEvents = [],
  signerRegistered = true,
  packageVersion = '0.1.11',
  placeOrderImpl,
  updateLeverageImpl,
  cancelOrderImpl,
  cancelAllImpl,
  openOrdersImpl,
  orderHistoryImpl,
  positionReadImpl,
  sleep = async () => {},
  now = () => 1000,
  setIntervalImpl,
  clearIntervalImpl,
  logger = { log() {}, error() {} },
} = {}) {
  const trace = [];
  const stream = new FakeStream(streamEvents, trace);
  const info = {
    async getMarkets() { trace.push('rest:markets'); return markets; },
    async getOrderbook(marketId) {
      trace.push(`rest:book:${marketId}`);
      const price = marketId === 1 ? 60000 : 3000;
      return { bids: [{ price: String(price - 1) }], asks: [{ price: String(price + 1) }] };
    },
    async getOpenOrders(_account, marketId) {
      trace.push(`rest:open:${marketId}`);
      return openOrdersImpl ? openOrdersImpl(marketId) : (openByMarket.get(marketId) || []);
    },
    async getOrderHistory(_account, marketId) {
      trace.push(`rest:history:${marketId}`);
      return orderHistoryImpl ? orderHistoryImpl(marketId) : (historyByMarket.get(marketId) || []);
    },
    async getAccountTradeHistory(_account, marketId) { trace.push(`rest:fills:${marketId}`); return fillsByMarket.get(marketId) || []; },
    async getAllPositions() { trace.push('rest:positions'); return positions; },
    async getPosition(marketId) {
      trace.push(`rest:position:${marketId}`);
      if (positionReadImpl) return positionReadImpl(marketId);
      return positions.find((position) => Number(position.market_id) === marketId) || null;
    },
    async getBalance() { trace.push('rest:balance'); return balance; },
  };
  const client = {
    info,
    signer: '0x0000000000000000000000000000000000000002',
    async init() { trace.push('client:init'); return this; },
    async isSignerRegistered() { trace.push('client:signer'); return signerRegistered; },
    async placeOrder(params) {
      trace.push('write:place');
      if (!placeOrderImpl) throw new Error('unexpected placeOrder');
      return placeOrderImpl(params, stream);
    },
    async updateLeverage(marketId, leverage) {
      trace.push('write:leverage');
      return updateLeverageImpl ? updateLeverageImpl(marketId, leverage) : { success: true };
    },
    async cancelOrder(params) {
      trace.push('write:cancel');
      if (!cancelOrderImpl) throw new Error('unexpected cancelOrder');
      return cancelOrderImpl(params, stream);
    },
    async cancelAllOrders(marketId) {
      trace.push('write:cancelAll');
      return cancelAllImpl ? cancelAllImpl(marketId, stream) : { success: true };
    },
  };
  const exchange = new RisexExchange(config, {
    packageVersion,
    infoFactory: () => info,
    clientFactory: () => client,
    streamFactory: () => stream,
    now,
    sleep,
    setInterval: setIntervalImpl,
    clearInterval: clearIntervalImpl,
    logger,
  });
  exchange.on('error', () => {});
  return { exchange, info, client, stream, trace };
}

test('RISEx init reaches READY only after signer, WS snapshot and REST reconciliation', async () => {
  const { exchange, trace } = makeHarness();
  await exchange.init();
  assert.equal(exchange.connectionState, 'READY');
  assert.equal(exchange.dataSource, 'real');
  assert.deepEqual((await exchange.getMarkets()).map((market) => market.displayName), ['BTC-PERP', 'ETH-PERP']);
  assert.ok(trace.indexOf('client:signer') < trace.indexOf('ws:connect'));
  assert.ok(trace.indexOf('ws:snapshot') < trace.indexOf('rest:open:1'));
  assert.ok(trace.indexOf('rest:balance') < trace.indexOf('ws:release'));
});

test('RISEx init rejects an unexpected dependency version', async () => {
  const { exchange } = makeHarness({ packageVersion: '0.1.12' });
  await assert.rejects(exchange.init(), /0\.1\.11.*0\.1\.12/);
  assert.equal(exchange.connectionState, 'HALTED');
});

test('RISEx init rejects an inactive session signer', async () => {
  const { exchange } = makeHarness({ signerRegistered: false });
  await assert.rejects(exchange.init(), /signer.*未注册|已失效/);
  assert.notEqual(exchange.connectionState, 'READY');
});

test('RISEx init requires valid and unique BTC-PERP and ETH-PERP markets', async () => {
  const missing = makeHarness({ markets: [rawMarkets[0]] }).exchange;
  await assert.rejects(missing.init(), /缺少 ETH-PERP/);

  const duplicate = makeHarness({ markets: [rawMarkets[0], { ...rawMarkets[0], market_id: '9' }, rawMarkets[1]] }).exchange;
  await assert.rejects(duplicate.init(), /BTC-PERP.*重复/);
});

test('RISEx init halts when an idle account has target-market open orders', async () => {
  const openByMarket = new Map([[1, [rawOpen()]]]);
  const { exchange } = makeHarness({ openByMarket, streamEvents: [wsOpen()] });
  await assert.rejects(exchange.init(), /没有运行快照.*遗留挂单/);
  assert.equal(exchange.connectionState, 'HALTED');
  assert.match(exchange.haltReason, /遗留挂单/);
});

test('RISEx init halts when an idle account has a target-market position', async () => {
  const { exchange } = makeHarness({
    positions: [{ market_id: '1', side: 0, size: '0.1', entry_price: '60000', unrealized_pnl: '1', leverage: '3' }],
  });
  await assert.rejects(exchange.init(), /没有运行快照.*遗留仓位/);
  assert.equal(exchange.connectionState, 'HALTED');
});

test('RISEx init adopts only snapshot-owned open orders', async () => {
  const openByMarket = new Map([[1, [rawOpen()]]]);
  const { exchange } = makeHarness({ openByMarket, streamEvents: [wsOpen()] });
  exchange.setRecoverySnapshot({
    running: true,
    config: { marketId: 99, displayName: 'BTC-PERP', sizeBase: 0.001 },
    active: [['o1', { side: 'buy', price: 60000, sizeBase: 0.001, levelIndex: 2 }]],
  });
  await exchange.init();
  assert.equal(exchange.connectionState, 'READY');
  assert.deepEqual((await exchange.fetchOpenOrders(1)).map((order) => order.orderId), ['o1']);
});

test('RISEx init halts on snapshot-external or unconfirmed orders', async () => {
  const externalOpen = new Map([[1, [rawOpen('external')]]]);
  const external = makeHarness({ openByMarket: externalOpen, streamEvents: [wsOpen('external')] }).exchange;
  external.setRecoverySnapshot({
    running: true, config: { displayName: 'BTC-PERP', sizeBase: 0.001 }, active: [],
  });
  await assert.rejects(external.init(), /快照外订单 external/);

  const missing = makeHarness().exchange;
  missing.setRecoverySnapshot({
    running: true,
    config: { displayName: 'BTC-PERP', sizeBase: 0.001 },
    active: [['missing', { side: 'buy', price: 60000, sizeBase: 0.001, levelIndex: 2 }]],
  });
  await assert.rejects(missing.init(), /订单 missing.*无法确认/);
});

test('RISEx init fails instead of hiding a REST snapshot error', async () => {
  const { exchange, info } = makeHarness();
  info.getBalance = async () => { throw new Error('balance unavailable'); };
  await assert.rejects(exchange.init(), /balance unavailable/);
  assert.notEqual(exchange.connectionState, 'READY');
});

function liveOrder(orderId, status = 'OPEN', filledSize = 0, avgPrice = 0, block = 10) {
  return {
    orderId, marketId: 1, side: 'buy', sizeBase: 0.001, price: 60000,
    filledSize, avgPrice, status, sender: ACCOUNT,
    cursor: { block: BigInt(block), log: 0n, timestamp: BigInt(block) },
  };
}

function liveFill(orderId, fillId = 'f1', sizeBase = 0.001, price = 59999, block = 9) {
  return {
    fillId, orderId, marketId: 1, side: 'buy', sizeBase, price, fee: 0,
    cursor: { block: BigInt(block), log: 0n, timestamp: BigInt(block) },
  };
}

test('RISEx place rejects non-READY state and non-whitelisted markets', async () => {
  const cold = makeHarness().exchange;
  await assert.rejects(cold.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 }), /RECONCILING/);

  const { exchange } = makeHarness();
  await exchange.init();
  await assert.rejects(exchange.placeLimitOrder({ marketId: 9, side: 'buy', price: 1, sizeBase: 1 }), /只允许 BTC-PERP\/ETH-PERP/);
});

test('RISEx place sends aligned Limit GTC params and a random uint64 client ID', async () => {
  let received;
  const { exchange } = makeHarness({
    placeOrderImpl: async (params, stream) => {
      received = params;
      stream.emit('order', liveOrder('90071992547409931234'));
      return { order_id: '90071992547409931234', tx_hash: '0xtx' };
    },
  });
  await exchange.init();
  const result = await exchange.placeLimitOrder({
    marketId: 1, side: 'buy', price: 60000.04, sizeBase: 0.00104,
    levelIndex: 2, reduceOnly: false,
  });
  assert.deepEqual(result, { orderId: '90071992547409931234' });
  assert.equal(received.market_id, 1);
  assert.equal(received.side, 0);
  assert.equal(received.order_type, 1);
  assert.equal(received.price_ticks, 600000);
  assert.equal(received.size_steps, 10);
  assert.equal(received.time_in_force, 0);
  assert.equal(received.post_only, false);
  assert.equal(received.reduce_only, false);
  assert.equal(received.stp_mode, 1);
  assert.match(received.client_order_id, /^\d+$/);
  assert.ok(BigInt(received.client_order_id) >= 0n && BigInt(received.client_order_id) <= 0xffffffffffffffffn);
});

test('RISEx serializes concurrent permit writes', async () => {
  let active = 0;
  let maxActive = 0;
  let next = 0;
  const releases = [];
  const { exchange } = makeHarness({
    placeOrderImpl: async (_params, stream) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const orderId = `o${++next}`;
      await new Promise((resolve) => releases.push(resolve));
      stream.emit('order', liveOrder(orderId));
      active -= 1;
      return { order_id: orderId };
    },
  });
  await exchange.init();
  const first = exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 });
  const second = exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 });
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
});

test('RISEx rejects a queued placement if the private stream disconnects before execution', async () => {
  let releaseFirst;
  let calls = 0;
  const { exchange, stream } = makeHarness({
    placeOrderImpl: async (_params, privateStream) => {
      calls += 1;
      const orderId = `queued-${calls}`;
      if (calls === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      privateStream.emit('order', liveOrder(orderId));
      return { order_id: orderId };
    },
  });
  await exchange.init();

  const first = exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 });
  await new Promise((resolve) => setImmediate(resolve));

  stream.authenticated = false;
  stream.emit('disconnected', { code: 1006 });
  releaseFirst();

  await first;
  await assert.rejects(second, /RECONCILING/);
  assert.equal(calls, 1);
});

test('RISEx place halts when the SDK response loses the string order ID', async () => {
  const { exchange } = makeHarness({ placeOrderImpl: async () => ({ order_id: 9007199254740992 }) });
  await exchange.init();
  await assert.rejects(
    exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 }),
    /非空字符串订单 ID/,
  );
  assert.equal(exchange.connectionState, 'HALTED');
});

test('RISEx buffers an immediate terminal event until place tracking exists', async () => {
  const { exchange } = makeHarness({
    placeOrderImpl: async (_params, stream) => {
      stream.emit('fill', liveFill('o-fast'));
      stream.emit('order', liveOrder('o-fast', 'FILLED', 0.001, 59999, 10));
      return { order_id: 'o-fast' };
    },
  });
  await exchange.init();
  const emitted = [];
  let placeResolved = false;
  exchange.on('fill', (fill) => emitted.push({ fill, placeResolved }));
  const placed = exchange.placeLimitOrder({
    marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001, levelIndex: 2,
  }).then((result) => { placeResolved = true; return result; });
  assert.deepEqual(await placed, { orderId: 'o-fast' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].placeResolved, true);
  assert.equal(emitted[0].fill.sizeBase, 0.001);
  assert.equal(emitted[0].fill.levelIndex, 2);
});

test('RISEx partial updates do not emit until the official terminal order', async () => {
  const { exchange, stream } = makeHarness({
    placeOrderImpl: async (_params, liveStream) => {
      liveStream.emit('order', liveOrder('o-partial'));
      return { order_id: 'o-partial' };
    },
  });
  await exchange.init();
  const emitted = [];
  exchange.on('fill', (fill) => emitted.push(fill));
  await exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001, levelIndex: 2 });
  stream.emit('fill', liveFill('o-partial', 'f-partial', 0.00025, 59999, 11));
  stream.emit('order', liveOrder('o-partial', 'PARTIAL', 0.00025, 59999, 12));
  assert.equal(emitted.length, 0);
  stream.emit('order', liveOrder('o-partial', 'CANCELLED', 0.00025, 59999, 13));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].sizeBase, 0.00025);
});

test('RISEx place confirmation timeout queries REST then halts when still unknown', async () => {
  const { exchange } = makeHarness({
    placeOrderImpl: async () => ({ order_id: 'o-missing' }),
    sleep: async () => {},
  });
  await exchange.init();
  await assert.rejects(
    exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 }),
    /o-missing.*REST.*无法确认/,
  );
  assert.equal(exchange.connectionState, 'HALTED');
});

test('RISEx setLeverage uses the write queue and reads back an existing position', async () => {
  let called;
  const { exchange, trace } = makeHarness({
    positions: [{ market_id: '1', side: 0, size: '0.1', entry_price: '60000', unrealized_pnl: '1', leverage: '3' }],
    updateLeverageImpl: async (marketId, leverage) => { called = [marketId, leverage]; return { success: true }; },
  });
  exchange.setRecoverySnapshot({ running: true, config: { displayName: 'BTC-PERP', sizeBase: 0.001 }, active: [] });
  await exchange.init();
  assert.equal(await exchange.setLeverage(1, 3), true);
  assert.deepEqual(called, [1, 3_000_000_000_000_000_000n]);
  assert.ok(trace.includes('rest:position:1'));
});

function setOwnedOpenSnapshot(exchange, orderId = 'o1', overrides = {}) {
  exchange.setRecoverySnapshot({
    running: true,
    config: { displayName: 'BTC-PERP', sizeBase: 0.001 },
    active: [[orderId, {
      side: 'buy', price: 60000, sizeBase: 0.001, levelIndex: 2, ...overrides,
    }]],
  });
}

test('RISEx cancel uses the REST resting ID and waits for an official terminal state', async () => {
  let received;
  const openByMarket = new Map([[1, [rawOpen('o-cancel')]]]);
  const { exchange } = makeHarness({
    openByMarket,
    streamEvents: [wsOpen('o-cancel')],
    cancelOrderImpl: async (params, stream) => {
      received = params;
      stream.emit('order', liveOrder('o-cancel', 'CANCELLED', 0, 0, 11));
      return { success: true };
    },
  });
  setOwnedOpenSnapshot(exchange, 'o-cancel');
  await exchange.init();

  assert.equal(await exchange.cancelOrder(1, 'o-cancel'), true);
  assert.deepEqual(received, { market_id: 1, order_id: 'o-cancel', resting_order_id: 'r-o-cancel' });
  assert.equal(exchange.orderState.get('o-cancel').status, 'CANCELLED');
  assert.equal(exchange.getOpenOrders(1).length, 0);
});

test('RISEx cancel failures and unknown terminal states preserve tracking', async () => {
  for (const [name, cancelOrderImpl, expected] of [
    ['request', async () => ({ success: false }), /撤单请求未成功/],
    ['terminal', async () => ({ success: true }), /未确认终态/],
  ]) {
    const openByMarket = new Map([[1, [rawOpen(`o-${name}`)]]]);
    const { exchange } = makeHarness({
      openByMarket,
      streamEvents: [wsOpen(`o-${name}`)],
      cancelOrderImpl,
    });
    setOwnedOpenSnapshot(exchange, `o-${name}`);
    await exchange.init();
    await assert.rejects(exchange.cancelOrder(1, `o-${name}`), expected);
    assert.equal(exchange.orderState.get(`o-${name}`).status, 'OPEN');
    assert.equal(exchange.getOpenOrders(1).length, 1);
  }
});

test('RISEx cancel accepts a FILLED race and emits the actual fill once', async () => {
  const openByMarket = new Map([[1, [rawOpen('o-race')]]]);
  const { exchange } = makeHarness({
    openByMarket,
    streamEvents: [wsOpen('o-race')],
    cancelOrderImpl: async (_params, stream) => {
      stream.emit('fill', liveFill('o-race', 'f-race', 0.001, 59999, 11));
      stream.emit('order', liveOrder('o-race', 'FILLED', 0.001, 59999, 12));
      return { success: true };
    },
  });
  setOwnedOpenSnapshot(exchange, 'o-race');
  await exchange.init();
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));

  assert.equal(await exchange.cancelOrder(1, 'o-race'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].sizeBase, 0.001);
});

test('RISEx bulk cancel blocks placements and returns only after REST open orders reach zero', async () => {
  let openReads = 0;
  let releaseCancel;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const { exchange } = makeHarness({
    streamEvents: [wsOpen('o-bulk')],
    openOrdersImpl: (marketId) => {
      if (marketId !== 1) return [];
      openReads += 1;
      return openReads <= 2 ? [rawOpen('o-bulk')] : [];
    },
    cancelAllImpl: async () => { await cancelGate; return { success: true }; },
  });
  setOwnedOpenSnapshot(exchange, 'o-bulk');
  await exchange.init();

  const cancelling = exchange.cancelAll(1);
  await assert.rejects(
    exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 }),
    /批量撤单/,
  );
  releaseCancel();
  assert.equal(await cancelling, true);
  assert.ok(openReads >= 3);
  assert.equal(exchange.getOpenOrders(1).length, 0);
});

test('RISEx bulk-cancel terminal fills suppress re-quoting', async () => {
  let openReads = 0;
  const { exchange } = makeHarness({
    streamEvents: [wsOpen('o-bulk-fill')],
    openOrdersImpl: (marketId) => {
      if (marketId !== 1) return [];
      return openReads++ === 0 ? [rawOpen('o-bulk-fill')] : [];
    },
    cancelAllImpl: async (_marketId, stream) => {
      stream.emit('fill', liveFill('o-bulk-fill', 'f-bulk', 0.001, 59999, 11));
      stream.emit('order', liveOrder('o-bulk-fill', 'FILLED', 0.001, 59999, 12));
      return { success: true };
    },
  });
  setOwnedOpenSnapshot(exchange, 'o-bulk-fill');
  await exchange.init();
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));

  assert.equal(await exchange.cancelAll(1), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].suppressRequote, true);
});

test('RISEx bulk cancel halts when bounded REST checks still show open orders', async () => {
  const { exchange } = makeHarness({
    streamEvents: [wsOpen('o-stuck')],
    openOrdersImpl: (marketId) => (marketId === 1 ? [rawOpen('o-stuck')] : []),
  });
  setOwnedOpenSnapshot(exchange, 'o-stuck');
  await exchange.init();

  await assert.rejects(exchange.cancelAll(1), /仍有挂单.*o-stuck/);
  assert.equal(exchange.connectionState, 'HALTED');
  assert.equal(exchange.orderState.get('o-stuck').status, 'OPEN');
});

for (const [label, side, expectedSide] of [['long', 0, 1], ['short', 1, 0]]) {
  test(`RISEx close confirms ${label} is flat twice and always sends reduce-only`, async () => {
    const rawPosition = {
      market_id: '1', side, size: '0.001', entry_price: '60000',
      unrealized_pnl: '0', leverage: '3',
    };
    const positionReads = [rawPosition, null, null];
    let placed;
    const { exchange } = makeHarness({
      positions: [rawPosition],
      positionReadImpl: () => positionReads.shift(),
      placeOrderImpl: async (params) => { placed = params; return { order_id: `close-${label}` }; },
    });
    exchange.setRecoverySnapshot({
      running: true, config: { displayName: 'BTC-PERP', sizeBase: 0.001 }, active: [],
    });
    await exchange.init();

    assert.equal(await exchange.closePosition(1), true);
    assert.equal(placed.side, expectedSide);
    assert.equal(placed.order_type, 0);
    assert.equal(placed.price_ticks, 0);
    assert.equal(placed.size_steps, 10);
    assert.equal(placed.time_in_force, 3);
    assert.equal(placed.reduce_only, true);
    assert.equal(placed.post_only, false);
    assert.equal(placed.stp_mode, 1);
  });
}

test('RISEx close halts when REST never confirms a flat position', async () => {
  const rawPosition = {
    market_id: '1', side: 0, size: '0.001', entry_price: '60000',
    unrealized_pnl: '0', leverage: '3',
  };
  const { exchange } = makeHarness({
    positions: [rawPosition],
    positionReadImpl: () => rawPosition,
    placeOrderImpl: async () => ({ order_id: 'close-stuck' }),
  });
  exchange.setRecoverySnapshot({
    running: true, config: { displayName: 'BTC-PERP', sizeBase: 0.001 }, active: [],
  });
  await exchange.init();

  await assert.rejects(exchange.closePosition(1), /仓位仍未归零/);
  assert.equal(exchange.connectionState, 'HALTED');
});

test('RISEx close halts when the REST position read fails after submission', async () => {
  const rawPosition = {
    market_id: '1', side: 0, size: '0.001', entry_price: '60000',
    unrealized_pnl: '0', leverage: '3',
  };
  let reads = 0;
  const { exchange } = makeHarness({
    positions: [rawPosition],
    positionReadImpl: () => {
      reads += 1;
      if (reads === 1) return rawPosition;
      throw new Error('position unavailable');
    },
    placeOrderImpl: async () => ({ order_id: 'close-rest-error' }),
  });
  exchange.setRecoverySnapshot({
    running: true, config: { displayName: 'BTC-PERP', sizeBase: 0.001 }, active: [],
  });
  await exchange.init();

  await assert.rejects(exchange.closePosition(1), /position unavailable/);
  assert.equal(exchange.connectionState, 'HALTED');
});

test('RISEx disconnect rejects writes until authenticated REST/WS reconciliation completes', async () => {
  const { exchange, stream, info } = makeHarness();
  await exchange.init();
  stream.authenticated = false;
  stream.emit('disconnected', { code: 1006 });
  assert.equal(exchange.connectionState, 'RECONCILING');
  await assert.rejects(
    exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 }),
    /RECONCILING/,
  );
  await assert.rejects(exchange.setLeverage(1, 3), /RECONCILING/);
  await assert.rejects(exchange.cancelAll(1), /RECONCILING/);

  let releaseBalance;
  info.getBalance = async () => new Promise((resolve) => { releaseBalance = resolve; });
  stream.authenticated = true;
  stream.emit('authenticated');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exchange.connectionState, 'RECONCILING');
  releaseBalance('1000');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exchange.connectionState, 'READY');
});

test('RISEx reconnect reconciliation halts on REST/WS identity conflicts', async () => {
  const openByMarket = new Map([[1, [rawOpen('o-conflict')]]]);
  const { exchange, stream } = makeHarness({ openByMarket, streamEvents: [wsOpen('o-conflict')] });
  setOwnedOpenSnapshot(exchange, 'o-conflict');
  await exchange.init();
  stream.authenticated = false;
  stream.emit('disconnected', { code: 1006 });
  stream.events = [{
    ...wsOpen('o-conflict'),
    data: { ...wsOpen('o-conflict').data, sizeBase: 0.002, cursor: { block: 20n, log: 0n, timestamp: 20n } },
  }];
  stream.authenticated = true;
  stream.emit('authenticated');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exchange.connectionState, 'HALTED');
  assert.match(exchange.haltReason, /总量发生变化/);
});

test('RISEx HALTED state does not auto-recover when the socket authenticates', async () => {
  const { exchange, stream } = makeHarness();
  await exchange.init();
  stream.emit('fatal', new Error('private stream corrupt'));
  assert.equal(exchange.connectionState, 'HALTED');
  stream.authenticated = true;
  stream.emit('authenticated');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exchange.connectionState, 'HALTED');
});

test('RISEx reconnect rebuilds clients and stream without cancelling orders or positions', async () => {
  const { exchange, trace } = makeHarness();
  await exchange.init();
  await exchange.reconnect();
  assert.equal(exchange.connectionState, 'READY');
  assert.equal(trace.filter((item) => item === 'client:init').length, 2);
  assert.equal(trace.filter((item) => item === 'ws:connect').length, 2);
  assert.equal(trace.some((item) => item.startsWith('write:cancel')), false);
  assert.equal(trace.some((item) => item === 'write:place'), false);
});

test('RISEx health exposes stale private/REST data and blocks new risk', async () => {
  let now = 1_000;
  const { exchange } = makeHarness({ now: () => now });
  await exchange.init();
  exchange.lastOrderAt = now;
  now += 31_001;
  let health = exchange.getHealth();
  assert.equal(health.status, 'error');
  assert.ok(health.lastOrderAgeMs > 30_000);
  assert.ok(health.lastRestAgeMs > 30_000);
  await assert.rejects(
    exchange.placeLimitOrder({ marketId: 1, side: 'buy', price: 60000, sizeBase: 0.001 }),
    /健康|过期|超时/,
  );
  exchange.lastRestAt = now;
  health = exchange.getHealth();
  assert.equal(health.status, 'warn');
});

test('RISEx init starts read-only refresh before a grid is started', async () => {
  let now = 1_000;
  let tick;
  const { exchange } = makeHarness({
    now: () => now,
    setIntervalImpl: (fn) => { tick = fn; return 7; },
    clearIntervalImpl: () => {},
  });
  await exchange.init();
  assert.equal(typeof tick, 'function');

  now += 31_001;
  await tick();
  assert.equal(exchange.getHealth().status, 'warn');
  assert.equal(exchange.getHealth().lastRestAgeMs, 0);
});

test('RISEx read-only refresh failures are observable and stop performs no writes', async () => {
  let tick;
  const { exchange, info, trace } = makeHarness({
    setIntervalImpl: (fn) => { tick = fn; return 7; },
    clearIntervalImpl: () => {},
  });
  await exchange.init();
  const errors = [];
  exchange.on('error', (error) => errors.push(error));
  info.getBalance = async () => { throw new Error('refresh balance unavailable'); };
  exchange.start();
  await tick();
  assert.match(exchange.lastError, /refresh balance unavailable/);
  assert.equal(exchange.getHealth().status, 'error');
  assert.equal(errors.length, 1);
  exchange.stop();
  assert.equal(trace.some((item) => item.startsWith('write:')), false);
});

test('RISEx reconciliation logs are traceable without exposing the signer key', async () => {
  const logs = [];
  const logger = {
    log: (message) => logs.push(String(message)),
    error: (message) => logs.push(String(message)),
  };
  const openByMarket = new Map([[1, [rawOpen('o-log')]]]);
  const { exchange, stream } = makeHarness({
    openByMarket,
    streamEvents: [wsOpen('o-log')],
    logger,
  });
  setOwnedOpenSnapshot(exchange, 'o-log');
  await exchange.init();
  stream.events = [wsOpen('o-log')];
  await exchange.reconnect();

  const text = logs.join('\n');
  assert.match(text, /状态 .*READY/);
  assert.match(text, /order o-log.*cursor=/);
  assert.match(text, /REST open=1.*WS buffered=1/);
  assert.doesNotMatch(text, new RegExp(SIGNER_KEY.slice(2), 'i'));
  assert.doesNotMatch(text, /signature/i);
});

test('RISEx adopt enriches a snapshot-owned OPEN order and keeps it fetchable', async () => {
  const openByMarket = new Map([[1, [rawOpen('o-adopt-open')]]]);
  const { exchange } = makeHarness({ openByMarket, streamEvents: [wsOpen('o-adopt-open')] });
  setOwnedOpenSnapshot(exchange, 'o-adopt-open');
  await exchange.init();

  exchange.adoptOrder({
    orderId: 'o-adopt-open', marketId: 1, side: 'buy', price: 60000,
    sizeBase: 0.001, levelIndex: 4, clientOrderId: 'client-open',
  });
  const [open] = await exchange.fetchOpenOrders(1);
  assert.equal(open.orderId, 'o-adopt-open');
  assert.equal(open.levelIndex, 4);
  assert.equal(open.clientOrderId, 'client-open');
});

test('RISEx adopt dispatches one downtime FILLED event after listener attachment', async () => {
  const historyByMarket = new Map([[1, [rawHistory('o-downtime-fill', 'FILLED', '0.001', '59999')]]]);
  const fillsByMarket = new Map([[1, [rawRestFill('o-downtime-fill', 'f-downtime')]]]);
  const { exchange } = makeHarness({ historyByMarket, fillsByMarket });
  setOwnedOpenSnapshot(exchange, 'o-downtime-fill');
  await exchange.init();

  const active = new Map([['o-downtime-fill', { levelIndex: 2 }]]);
  const seen = [];
  exchange.adoptOrder({
    orderId: 'o-downtime-fill', marketId: 1, side: 'buy', price: 60000,
    sizeBase: 0.001, levelIndex: 2, clientOrderId: 'client-fill',
  });
  exchange.on('fill', (fill) => seen.push({ fill, tracked: active.has(fill.orderId) }));
  await new Promise((resolve) => setImmediate(resolve));
  exchange.adoptOrder({
    orderId: 'o-downtime-fill', marketId: 1, side: 'buy', price: 60000,
    sizeBase: 0.001, levelIndex: 2, clientOrderId: 'client-fill',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].tracked, true);
  assert.equal(seen[0].fill.sizeBase, 0.001);
  assert.equal(seen[0].fill.price, 59999);
  assert.equal(seen[0].fill.levelIndex, 2);
});

test('RISEx adopt dispatches a downtime partial-CANCELLED fill with actual size', async () => {
  const historyByMarket = new Map([[1, [rawHistory('o-downtime-partial', 'CANCELLED', '0.00025', '59999')]]]);
  const fillsByMarket = new Map([[1, [rawRestFill('o-downtime-partial', 'f-partial-rest', '0.00025')]]]);
  const { exchange } = makeHarness({ historyByMarket, fillsByMarket });
  setOwnedOpenSnapshot(exchange, 'o-downtime-partial', { levelIndex: 3 });
  await exchange.init();
  const seen = [];

  exchange.adoptOrder({
    orderId: 'o-downtime-partial', marketId: 1, side: 'buy', price: 60000,
    sizeBase: 0.001, levelIndex: 3,
  });
  exchange.on('fill', (fill) => seen.push(fill));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sizeBase, 0.00025);
  assert.equal(seen[0].levelIndex, 3);
});

test('RISEx adopt removes downtime zero-fill CANCELLED orders without a fill event', async () => {
  const historyByMarket = new Map([[1, [rawHistory('o-downtime-cancel', 'CANCELLED', '0')]]]);
  const { exchange } = makeHarness({ historyByMarket });
  setOwnedOpenSnapshot(exchange, 'o-downtime-cancel', { levelIndex: 1 });
  await exchange.init();
  const seen = [];

  exchange.adoptOrder({
    orderId: 'o-downtime-cancel', marketId: 1, side: 'buy', price: 60000,
    sizeBase: 0.001, levelIndex: 1,
  });
  exchange.on('fill', (fill) => seen.push(fill));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 0);
  assert.equal((await exchange.fetchOpenOrders(1)).length, 0);
});

test('RISEx recovery failures never issue cleanup writes and stale open data is rejected', async () => {
  const missing = makeHarness();
  setOwnedOpenSnapshot(missing.exchange, 'o-unknown-downtime');
  await assert.rejects(missing.exchange.init(), /无法确认开放或终态/);
  assert.equal(missing.trace.some((item) => item.startsWith('write:')), false);

  let now = 1_000;
  const openByMarket = new Map([[1, [rawOpen('o-stale-open')]]]);
  const stale = makeHarness({ openByMarket, streamEvents: [wsOpen('o-stale-open')], now: () => now });
  setOwnedOpenSnapshot(stale.exchange, 'o-stale-open');
  await stale.exchange.init();
  now += 31_001;
  await assert.rejects(stale.exchange.fetchOpenOrders(1), /过期|健康|30 秒/);
});
