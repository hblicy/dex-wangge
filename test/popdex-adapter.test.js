import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexExchange } from '../src/exchange/px/popdex.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';

function markets() {
  return [
    {
      marketId: 20000,
      name: 'BTCUSDT',
      displayName: 'BTCUSDT',
      symbol: 'BTC',
      stepPrice: 1,
      stepSize: 0.0001,
      minOrderSize: 0.0001,
      minNotional: 10,
      defaultLeverage: 1,
    },
    {
      marketId: 20001,
      name: 'ETHUSDT',
      displayName: 'ETHUSDT',
      symbol: 'ETH',
      stepPrice: 0.1,
      stepSize: 0.001,
      minOrderSize: 0.001,
      minNotional: 10,
      defaultLeverage: 1,
    },
  ];
}

function openOrder(overrides = {}) {
  return {
    walletId: ACCOUNT,
    orderId: '90071992547409931234',
    clientOid: 'dw-bb-0102030405060708090a0b0c',
    symbolId: '20000',
    symbol: 'BTCUSDT',
    side: 'Buy',
    status: 'NewAccept',
    price: '60000',
    qty: '0.0002',
    filledQty: '0',
    remainingQty: '0.0002',
    cancelledQty: '0',
    reduceOnly: false,
    ...overrides,
  };
}

function longPosition(overrides = {}) {
  return {
    walletId: ACCOUNT,
    positionId: '90071992547409931235',
    symbolId: '20000',
    side: '1',
    holdSizeWad: '200000000000000',
    avgOpenPriceWad: '60000000000000000000000',
    closeSizeWad: '0',
    lockedSizeWad: '0',
    realizedPnlWad: '100000000000000000',
    createdTime: '1786946300',
    updatedTime: '1786946400',
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const calls = [];
  let btcOrders = overrides.btcOrders ?? [];
  let ethOrders = overrides.ethOrders ?? [];
  let overview = overrides.overview ?? {
    accountEquity: '799.23',
    availableMargin: '799.23',
    totalCollateral: '799.23',
  };
  let positions = overrides.positions ?? [];
  const publicClient = {
    async getMarkets() { calls.push('public:markets'); return markets(); },
    async getTicker(symbol) {
      calls.push(`public:ticker:${symbol}`);
      return symbol === 'BTCUSDT'
        ? { bid: 62900, ask: 62901, last: 62900.5, index: 62900.4, mark: 62900.5 }
        : { bid: 1878.8, ask: 1878.9, last: 1878.85, index: 1878.8, mark: 1878.85 };
    },
    async getCandles(symbol, interval, limit) {
      calls.push(`public:candles:${symbol}:${interval}:${limit}`);
      return [{ time: '1786946400000', open: 1, high: 2, low: 1, close: 2 }];
    },
  };
  const accountClient = {
    async getAllOpenOrders(_account, symbol) {
      calls.push(`account:orders:${symbol}`);
      return structuredClone(symbol === 'BTCUSDT' ? btcOrders : ethOrders);
    },
    async getOverview() { calls.push('account:overview'); return structuredClone(overview); },
  };
  const readRpc = {
    async getAllOpenPositions() {
      calls.push('rpc:positions');
      return structuredClone(positions);
    },
  };
  const tradingClient = {
    async preflight() {
      calls.push('trading:preflight');
      return { mainAccount: ACCOUNT, agent: AGENT, expiresAt: '1786950000000' };
    },
  };
  const journal = { load() { calls.push('journal:load'); return null; } };
  return {
    calls,
    publicClient,
    accountClient,
    readRpc,
    tradingClient,
    journal,
    setBtcOrders(value) { btcOrders = value; },
    setOverview(value) { overview = value; },
    setPositions(value) { positions = value; },
    ...overrides.dependencies,
  };
}

function createLiveAdapter(deps = dependencies(), overrides = {}) {
  return new PopdexExchange({
    mainAccount: ACCOUNT,
    publicClient: deps.publicClient,
    accountClient: deps.accountClient,
    readRpc: deps.readRpc,
    tradingClient: deps.tradingClient,
    journal: deps.journal,
    now: () => 1786946400000,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl() {},
    pollMs: 1000,
    staleMs: 5000,
    ...overrides,
  });
}

test('live init publishes one complete verified BTC and ETH snapshot', async () => {
  const ex = createLiveAdapter();
  await ex.init();

  assert.deepEqual((await ex.getMarkets()).map((market) => market.marketId), [20000, 20001]);
  assert.equal(ex.getHealth().state, 'READY');
  assert.equal(ex.getHealth().dataSource, 'real');
  assert.equal(ex.getPosition(20000), null);
  assert.equal(ex.equity, 799.23);
  assert.equal(ex.balance, 799.23);
  assert.equal(await ex.getPrice(20000), 62900.5);
});

test('failed refresh retains the previous snapshot and enters RECONCILING', async () => {
  const deps = dependencies({ btcOrders: [openOrder()] });
  const ex = createLiveAdapter(deps);
  await ex.init();
  const before = ex.getOpenOrders(20000);
  deps.accountClient.getAllOpenOrders = async () => { throw new TypeError('fetch failed'); };

  await assert.rejects(ex.refresh(), /账户刷新.*fetch failed/);
  assert.deepEqual(ex.getOpenOrders(20000), before);
  assert.equal(ex.getHealth().state, 'RECONCILING');
});

test('a complete refresh recovers RECONCILING to READY without publishing half a snapshot', async () => {
  const deps = dependencies({ btcOrders: [openOrder()] });
  const ex = createLiveAdapter(deps);
  await ex.init();
  const original = deps.accountClient.getAllOpenOrders;
  deps.publicClient.getTicker = async (symbol) => ({
    bid: symbol === 'BTCUSDT' ? 64000 : 1900,
    ask: symbol === 'BTCUSDT' ? 64001 : 1901,
    last: symbol === 'BTCUSDT' ? 64000.5 : 1900.5,
    index: symbol === 'BTCUSDT' ? 64000.4 : 1900.4,
    mark: symbol === 'BTCUSDT' ? 64000.5 : 1900.5,
  });
  deps.accountClient.getAllOpenOrders = async () => { throw new TypeError('network timeout'); };

  await assert.rejects(ex.refresh(), /账户刷新/);
  assert.equal(await ex.getPrice(20000), 62900.5);
  deps.accountClient.getAllOpenOrders = original;
  await ex.refresh();
  assert.equal(ex.getHealth().state, 'READY');
  assert.equal(await ex.getPrice(20000), 64000.5);
});

test('schema conflict enters HALTED and only manual reconnect can recover it', async () => {
  const deps = dependencies();
  const ex = createLiveAdapter(deps);
  await ex.init();
  deps.setOverview({ accountEquity: 'NaN', availableMargin: '1', totalCollateral: '1' });

  await assert.rejects(ex.refresh(), /overview\.accountEquity/);
  assert.equal(ex.getHealth().state, 'HALTED');
  deps.setOverview({ accountEquity: '799.23', availableMargin: '799.23', totalCollateral: '799.23' });
  await assert.rejects(ex.refresh(), /HALTED.*人工重连/);
  await ex.reconnect();
  assert.equal(ex.getHealth().state, 'READY');
});

test('malformed or conflicting position facts halt without replacing the prior snapshot', async () => {
  const deps = dependencies();
  const ex = createLiveAdapter(deps);
  await ex.init();
  deps.setPositions([longPosition({ walletId: AGENT })]);

  await assert.rejects(ex.refresh(), /position\.walletId.*主账户/);
  assert.equal(ex.getPosition(20000), null);
  assert.equal(ex.getHealth().state, 'HALTED');
});

test('signed realized PnL remains exact while normalizing a valid position', async () => {
  const deps = dependencies({
    positions: [longPosition({ realizedPnlWad: '-100000000000000000' })],
  });
  const ex = createLiveAdapter(deps);
  await ex.init();
  assert.equal(ex.getPosition(20000).realizedPnl, -0.1);
  assert.equal(ex.realizedPnl, -0.1);
});

test('snapshot getters return clones and preserve exact string order IDs', async () => {
  const deps = dependencies({ btcOrders: [openOrder()] });
  const ex = createLiveAdapter(deps);
  await ex.init();
  const first = ex.getOpenOrders(20000);
  assert.equal(first[0].orderId, '90071992547409931234');
  first[0].price = 1;
  assert.equal(ex.getOpenOrders(20000)[0].price, 60000);
  const marketList = await ex.getMarkets();
  marketList[0].name = 'changed';
  assert.equal((await ex.getMarkets())[0].name, 'BTCUSDT');
});

test('fetchOpenOrders waits for one official refresh and never hides its failure', async () => {
  const deps = dependencies({ btcOrders: [openOrder()] });
  const ex = createLiveAdapter(deps);
  await ex.init();
  deps.setBtcOrders([]);
  assert.deepEqual(await ex.fetchOpenOrders(20000), []);
  deps.accountClient.getAllOpenOrders = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(ex.fetchOpenOrders(20000), /账户刷新.*fetch failed/);
});

test('candle intervals are exact and unsupported mappings fail before public I/O', async () => {
  const deps = dependencies();
  const ex = createLiveAdapter(deps);
  await ex.init();
  assert.deepEqual(await ex.getCandles(20000, 3600, 200), [{
    time: 1786946400000, open: 1, high: 2, low: 1, close: 2,
  }]);
  assert.ok(deps.calls.includes('public:candles:BTCUSDT:1H:200'));
  const before = deps.calls.length;
  await assert.rejects(ex.getCandles(20000, 120, 200), /intervalSec 120 不受支持/);
  assert.equal(deps.calls.length, before);
});

test('HALTED health keeps sanitized diagnostics without secret-like hex or newlines', async () => {
  const deps = dependencies();
  const ex = createLiveAdapter(deps);
  await ex.init();
  const secret = `0x${'ab'.repeat(32)}`;
  deps.accountClient.getOverview = async () => {
    throw new Error(`schema conflict ${secret}\nsecond line`);
  };
  await assert.rejects(ex.refresh(), /schema conflict/);
  const health = ex.getHealth();
  assert.equal(health.state, 'HALTED');
  assert.equal(health.lastErrorStage, 'account-refresh');
  assert.doesNotMatch(health.lastErrorMessage, new RegExp(secret, 'i'));
  assert.doesNotMatch(health.lastErrorMessage, /[\r\n]/);
});

test('start owns one unref timer and stop performs no exchange write', async () => {
  const deps = dependencies();
  const timers = [];
  const cleared = [];
  const ex = createLiveAdapter(deps, {
    setIntervalImpl(callback, ms) {
      const timer = { callback, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) { cleared.push(timer); },
  });
  await ex.init();
  ex.start();
  ex.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  assert.equal(timers[0].unrefCalled, true);
  ex.stop();
  assert.deepEqual(cleared, [timers[0]]);
  assert.equal(deps.calls.some((call) => call.startsWith('write:')), false);
});
