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
} = {}) {
  const trace = [];
  const info = {
    async getMarkets() { trace.push('rest:markets'); return markets; },
    async getOpenOrders(_account, marketId) { trace.push(`rest:open:${marketId}`); return openByMarket.get(marketId) || []; },
    async getOrderHistory(_account, marketId) { trace.push(`rest:history:${marketId}`); return historyByMarket.get(marketId) || []; },
    async getAccountTradeHistory(_account, marketId) { trace.push(`rest:fills:${marketId}`); return fillsByMarket.get(marketId) || []; },
    async getAllPositions() { trace.push('rest:positions'); return positions; },
    async getBalance() { trace.push('rest:balance'); return balance; },
  };
  const client = {
    info,
    signer: '0x0000000000000000000000000000000000000002',
    async init() { trace.push('client:init'); return this; },
    async isSignerRegistered() { trace.push('client:signer'); return signerRegistered; },
  };
  const stream = new FakeStream(streamEvents, trace);
  const exchange = new RisexExchange(config, {
    packageVersion,
    infoFactory: () => info,
    clientFactory: () => client,
    streamFactory: () => stream,
    now: () => 1000,
    sleep: async () => {},
    defer: queueMicrotask,
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
