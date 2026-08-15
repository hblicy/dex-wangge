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
  drainBuffered() { this.trace.push('ws:drain'); return [...this.events]; }
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
  sleep = async () => {},
} = {}) {
  const trace = [];
  const stream = new FakeStream(streamEvents, trace);
  const info = {
    async getMarkets() { trace.push('rest:markets'); return markets; },
    async getOpenOrders(_account, marketId) { trace.push(`rest:open:${marketId}`); return openByMarket.get(marketId) || []; },
    async getOrderHistory(_account, marketId) { trace.push(`rest:history:${marketId}`); return historyByMarket.get(marketId) || []; },
    async getAccountTradeHistory(_account, marketId) { trace.push(`rest:fills:${marketId}`); return fillsByMarket.get(marketId) || []; },
    async getAllPositions() { trace.push('rest:positions'); return positions; },
    async getPosition(marketId) {
      trace.push(`rest:position:${marketId}`);
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
  };
  const exchange = new RisexExchange(config, {
    packageVersion,
    infoFactory: () => info,
    clientFactory: () => client,
    streamFactory: () => stream,
    now: () => 1000,
    sleep,
    logger: { log() {}, error() {} },
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
  assert.deepEqual(called, [1, 3n]);
  assert.ok(trace.includes('rest:position:1'));
});
