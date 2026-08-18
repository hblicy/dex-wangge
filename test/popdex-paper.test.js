import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexPaperExchange } from '../src/exchange/px/paper.js';

function markets() {
  return [
    {
      marketId: 20000, name: 'BTCUSDT', displayName: 'BTCUSDT', symbol: 'BTC',
      stepPrice: 1, stepSize: 0.0001, minOrderSize: 0.0001, minNotional: 10,
      defaultLeverage: 1,
    },
    {
      marketId: 20001, name: 'ETHUSDT', displayName: 'ETHUSDT', symbol: 'ETH',
      stepPrice: 0.1, stepSize: 0.001, minOrderSize: 0.001, minNotional: 10,
      defaultLeverage: 1,
    },
  ];
}

function dependencies() {
  let btc = { bid: 62900, ask: 62901, last: 62900.5, index: 62900.4, mark: 62900.5 };
  let eth = { bid: 1878.8, ask: 1878.9, last: 1878.85, index: 1878.8, mark: 1878.85 };
  let failure = null;
  const calls = [];
  const publicClient = {
    async getMarkets() { calls.push('markets'); return markets(); },
    async getTicker(symbol) {
      calls.push(`ticker:${symbol}`);
      if (failure) throw failure;
      return structuredClone(symbol === 'BTCUSDT' ? btc : eth);
    },
    async getCandles(symbol, interval, limit) {
      calls.push(`candles:${symbol}:${interval}:${limit}`);
      return [{ time: '1786946400000', open: 1, high: 2, low: 1, close: 2 }];
    },
  };
  return {
    publicClient,
    calls,
    setTicker(symbol, ticker) { if (symbol === 'BTCUSDT') btc = ticker; else eth = ticker; },
    setFailure(error) { failure = error; },
  };
}

function createPaper(deps = dependencies(), overrides = {}) {
  let now = 1786946400000;
  const timers = [];
  const cleared = [];
  const exchange = new PopdexPaperExchange({
    publicClient: deps.publicClient,
    feeRate: 0.0005,
    startBalance: 1000,
    now: () => now,
    pollMs: 1000,
    staleMs: 5000,
    setIntervalImpl(callback, ms) {
      const timer = { callback, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) { cleared.push(timer); },
    ...overrides,
  });
  return {
    exchange,
    timers,
    cleared,
    setNow(value) { now = value; },
  };
}

test('paper requires explicit fee rate and complete official markets', async () => {
  const deps = dependencies();
  assert.throws(() => new PopdexPaperExchange({ publicClient: deps.publicClient }), /feeRate.*显式/);
  assert.throws(
    () => new PopdexPaperExchange({ publicClient: deps.publicClient, feeRate: -1 }),
    /feeRate.*非负/,
  );
  const { exchange } = createPaper(deps);
  await exchange.init();
  assert.deepEqual((await exchange.getMarkets()).map((market) => market.marketId), [20000, 20001]);
  assert.equal(exchange.getHealth().dataSource, 'popdex-public');
  assert.equal(exchange.balance, 1000);
});

test('paper fills crossed limits once and preserves exact grid metadata', async () => {
  const deps = dependencies();
  const { exchange } = createPaper(deps);
  await exchange.init();
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));
  const { orderId } = await exchange.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002,
    levelIndex: 3, clientOrderId: 'paper-grid-3', reduceOnly: false,
  });
  deps.setTicker('BTCUSDT', {
    bid: 59999, ask: 60000, last: 60000, index: 60000, mark: 60000,
  });
  await exchange.refresh();
  await exchange.refresh();
  assert.equal(fills.length, 1);
  assert.deepEqual(fills[0], {
    orderId, marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002,
    levelIndex: 3, clientOrderId: 'paper-grid-3', fee: 0.006,
  });
  assert.equal(exchange.getPosition(20000).sizeBase, 0.0002);
});

test('paper maintains weighted entry, partial reduction, realized PnL and fees', async () => {
  const deps = dependencies();
  const { exchange } = createPaper(deps);
  await exchange.init();
  await exchange.placeLimitOrder({ marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002 });
  await exchange.placeLimitOrder({ marketId: 20000, side: 'buy', price: 59000, sizeBase: 0.0002 });
  deps.setTicker('BTCUSDT', { bid: 58999, ask: 59000, last: 59000, index: 59000, mark: 59000 });
  await exchange.refresh();
  assert.equal(exchange.getPosition(20000).entryPrice, 59500);

  await exchange.placeLimitOrder({
    marketId: 20000, side: 'sell', price: 61000, sizeBase: 0.0002, reduceOnly: true,
  });
  deps.setTicker('BTCUSDT', { bid: 61000, ask: 61001, last: 61000, index: 61000, mark: 61000 });
  await exchange.refresh();
  assert.equal(exchange.getPosition(20000).sizeBase, 0.0002);
  assert.ok(Math.abs(exchange.realizedPnl - (0.3 - 0.018)) < 1e-12);
  assert.ok(Math.abs(exchange.balance - (1000 + 0.3 - 0.018)) < 1e-12);
});

test('reduce-only cannot increase or reverse a paper position', async () => {
  const deps = dependencies();
  const { exchange } = createPaper(deps);
  await exchange.init();
  const faults = [];
  exchange.on('fault', (error) => faults.push(error.message));
  await exchange.placeLimitOrder({
    marketId: 20000, side: 'sell', price: 64000, sizeBase: 0.0002, reduceOnly: true,
  });
  deps.setTicker('BTCUSDT', { bid: 64000, ask: 64001, last: 64000, index: 64000, mark: 64000 });
  await exchange.refresh();
  assert.equal(exchange.getPosition(20000), null);
  assert.equal(exchange.getOpenOrders(20000).length, 0);
  assert.match(faults[0], /reduce-only.*不能减少仓位/);

  await exchange.placeLimitOrder({ marketId: 20000, side: 'buy', price: 63000, sizeBase: 0.0002 });
  deps.setTicker('BTCUSDT', { bid: 62999, ask: 63000, last: 63000, index: 63000, mark: 63000 });
  await exchange.refresh();
  await exchange.placeLimitOrder({
    marketId: 20000, side: 'sell', price: 64000, sizeBase: 0.0004, reduceOnly: true,
  });
  deps.setTicker('BTCUSDT', { bid: 64000, ask: 64001, last: 64000, index: 64000, mark: 64000 });
  await exchange.refresh();
  assert.equal(exchange.getPosition(20000), null);
});

test('ordinary paper fills may reverse a position at the new fill price', async () => {
  const deps = dependencies();
  const { exchange } = createPaper(deps);
  await exchange.init();
  await exchange.placeLimitOrder({ marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002 });
  deps.setTicker('BTCUSDT', { bid: 59999, ask: 60000, last: 60000, index: 60000, mark: 60000 });
  await exchange.refresh();
  await exchange.placeLimitOrder({ marketId: 20000, side: 'sell', price: 62000, sizeBase: 0.0004 });
  deps.setTicker('BTCUSDT', { bid: 62000, ask: 62001, last: 62000, index: 62000, mark: 62000 });
  await exchange.refresh();
  assert.equal(exchange.getPosition(20000).sizeBase, -0.0002);
  assert.equal(exchange.getPosition(20000).entryPrice, 62000);
});

test('paper rejects invalid orders and validates adopted metadata', async () => {
  const { exchange } = createPaper();
  await exchange.init();
  await assert.rejects(exchange.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 60000.5, sizeBase: 0.0002,
  }), /tickSize/);
  await assert.rejects(exchange.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 100, sizeBase: 0.0001,
  }), /minNotional/);
  assert.throws(() => exchange.adoptOrder({ orderId: 'paper-external' }), /完整.*元数据/);
  assert.equal(exchange.adoptOrder({
    orderId: 'paper-external', marketId: 20001, side: 'sell', price: 2000,
    sizeBase: 0.01, levelIndex: 4, clientOrderId: 'paper-grid-4', reduceOnly: false,
  }).orderId, 'paper-external');
  assert.equal(exchange.getOpenOrders(20001).length, 1);
});

test('paper cancel methods and closePosition change only local state', async () => {
  const { exchange } = createPaper();
  await exchange.init();
  const one = await exchange.placeLimitOrder({ marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002 });
  await exchange.placeLimitOrder({ marketId: 20001, side: 'buy', price: 1800, sizeBase: 0.01 });
  assert.equal(await exchange.cancelOrder(20000, one.orderId), true);
  assert.equal(await exchange.cancelAll(20001), true);
  assert.equal(exchange.getOpenOrders(20000).length, 0);
  assert.equal(exchange.getOpenOrders(20001).length, 0);

  await exchange.placeLimitOrder({ marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002 });
  await exchange.closePosition(20000);
  assert.equal(exchange.getPosition(20000), null);
});

test('paper public failure and stale ticker stop matching without synthetic fallback', async () => {
  const deps = dependencies();
  const context = createPaper(deps);
  await context.exchange.init();
  await context.exchange.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002,
  });
  deps.setTicker('BTCUSDT', { bid: 59999, ask: 60000, last: 60000, index: 60000, mark: 60000 });
  deps.setFailure(new TypeError('fetch failed'));
  await assert.rejects(context.exchange.refresh(), /fetch failed/);
  assert.equal(context.exchange.getOpenOrders(20000).length, 1);
  assert.equal(context.exchange.getHealth().status, 'error');

  deps.setFailure(null);
  context.setNow(1786946406000);
  await assert.rejects(context.exchange.getPrice(20000), /过期/);
  await assert.rejects(context.exchange.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 59000, sizeBase: 0.0002,
  }), /行情.*过期/);
  await context.exchange.reconnect();
  assert.equal(context.exchange.getOpenOrders(20000).length, 0);
});

test('paper delegates candles and owns one stoppable timer', async () => {
  const deps = dependencies();
  const { exchange, timers, cleared } = createPaper(deps);
  await exchange.init();
  exchange.start();
  exchange.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].unrefCalled, true);
  const candles = await exchange.getCandles(20000, 3600, 10);
  assert.equal(candles.length, 1);
  assert.ok(deps.calls.includes('candles:BTCUSDT:1H:10'));
  exchange.stop();
  assert.deepEqual(cleared, [timers[0]]);
});
