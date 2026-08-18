import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBytes32String, encodeBytes32String, parseUnits } from 'ethers';
import { PopdexExchange } from '../src/exchange/px/popdex.js';
import { POPDEX_ORDER_EVENT_INTERFACE } from '../src/exchange/px/receipt-events.js';

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

function memoryJournal(initial = null) {
  let record = initial === null ? null : structuredClone(initial);
  const calls = [];
  return {
    calls,
    load() { calls.push('load'); return record === null ? null : structuredClone(record); },
    create(facts) {
      calls.push(`create:${facts.kind}`);
      if (record !== null) throw new Error('已有未完成操作');
      record = { ...structuredClone(facts), stage: 'PREPARED', txHash: null };
      return structuredClone(record);
    },
    advance(expected, next, fields = {}) {
      calls.push(`advance:${expected}:${next}`);
      assert.equal(record.stage, expected);
      record = { ...record, ...structuredClone(fields), stage: next };
      return structuredClone(record);
    },
    recordError(expected, error) {
      calls.push(`error:${expected}:${error?.message ?? error}`);
      assert.equal(record.stage, expected);
    },
    completePreparedWithoutBroadcast(outcome) {
      calls.push(`complete:${outcome}`);
      assert.equal(record.stage, 'PREPARED');
      record = { ...record, stage: 'CONFIRMED', txHash: null, outcome };
      return structuredClone(record);
    },
    clearConfirmed() {
      calls.push('clear');
      assert.equal(record.stage, 'CONFIRMED');
      record = null;
    },
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
  const journal = overrides.journal ?? memoryJournal();
  let receipt = overrides.receipt ?? null;
  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  let broadcastCalls = 0;
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
    async findUniqueOrderByClientId(_account, symbol, clientOrderId) {
      calls.push(`account:find:${symbol}`);
      const expected = decodeBytes32String(clientOrderId);
      const matches = (symbol === 'BTCUSDT' ? btcOrders : ethOrders)
        .filter((order) => order.clientOid === expected);
      if (matches.length !== 1) {
        const error = new Error('not found');
        error.code = 'POPDEX_ORDER_NOT_FOUND';
        throw error;
      }
      return structuredClone(matches[0]);
    },
  };
  const readRpc = {
    async getAllOpenPositions() {
      calls.push('rpc:positions');
      return structuredClone(positions);
    },
    async getReceipt() { calls.push('rpc:receipt'); return structuredClone(receipt); },
    async getAccountConfig() {
      calls.push('rpc:config');
      return { positionMode: '0', symbolLeverages: [{ symbolId: '20000', leverage: '1' }] };
    },
  };
  const tradingClient = {
    async preflight() {
      calls.push('trading:preflight');
      return { mainAccount: ACCOUNT, agent: AGENT, expiresAt: '1786950000000' };
    },
    async setAdapterBtcLeverageOne(operationJournal) {
      calls.push('trade:leverage');
      broadcastCalls += 1;
      operationJournal.advance('PREPARED', 'BROADCAST', { txHash: `0x${'11'.repeat(32)}` });
      operationJournal.advance('BROADCAST', 'CONFIRMED');
      return { leverage: '1', changed: true };
    },
    async placeAdapterOrder(plan, operationJournal) {
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      calls.push(`trade:place:${plan.side}`);
      broadcastCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      const orderId = String(90071992547409931234n + BigInt(broadcastCalls));
      operationJournal.advance('PREPARED', 'BROADCAST', { txHash: `0x${'22'.repeat(32)}` });
      operationJournal.advance('BROADCAST', 'CONFIRMED', { orderId });
      btcOrders.push(openOrder({
        orderId,
        clientOid: decodeBytes32String(plan.clientOrderId),
        side: plan.side === 'buy' ? 'Buy' : 'Sell',
        price: plan.price,
        qty: plan.qty,
        remainingQty: plan.qty,
      }));
      activeWrites -= 1;
      return {
        orderId,
        clientOrderId: plan.clientOrderId,
        walletId: ACCOUNT,
        symbolId: '20000',
        side: plan.side === 'buy' ? '0' : '1',
        isReduceOnly: false,
        priceWad: plan.priceWad,
        qtyWad: plan.qtyWad,
        filledQtyWad: '0',
        remainingQtyWad: plan.qtyWad,
        cancelledQtyWad: '0',
      };
    },
    async cancelAdapterOrder(order, operationJournal) {
      calls.push(`trade:cancel:${order.orderId}`);
      broadcastCalls += 1;
      operationJournal.advance('PREPARED', 'BROADCAST', { txHash: `0x${'33'.repeat(32)}` });
      operationJournal.advance('BROADCAST', 'CONFIRMED');
      btcOrders = btcOrders.filter((candidate) => candidate.orderId !== order.orderId);
      return { ...order, remainingQtyWad: '0', cancelledQtyWad: order.qtyWad };
    },
    async closeAdapterBtcLong(position, operationJournal) {
      calls.push(`trade:close:${position.positionId}`);
      broadcastCalls += 1;
      operationJournal.advance('PREPARED', 'BROADCAST', { txHash: `0x${'44'.repeat(32)}` });
      operationJournal.advance('BROADCAST', 'CONFIRMED', { closeOrderId: '99' });
      positions = [];
      return { closeOrderId: '99', positionQtyWad: '0' };
    },
  };
  return {
    calls,
    publicClient,
    accountClient,
    readRpc,
    tradingClient,
    journal,
    get maxConcurrentWrites() { return maxConcurrentWrites; },
    get broadcastCalls() { return broadcastCalls; },
    setBtcOrders(value) { btcOrders = value; },
    setOverview(value) { overview = value; },
    setPositions(value) { positions = value; },
    setReceipt(value) { receipt = value; },
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

test('live writes are serialized through one operation journal', async () => {
  const deps = dependencies();
  const ex = createLiveAdapter(deps);
  await ex.init();

  const first = ex.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002, reduceOnly: false,
  });
  const second = ex.placeLimitOrder({
    marketId: 20000, side: 'sell', price: 64000, sizeBase: 0.0002, reduceOnly: false,
  });
  const results = await Promise.all([first, second]);

  assert.equal(typeof results[0].orderId, 'string');
  assert.deepEqual(deps.calls.filter((entry) => entry.startsWith('trade:place:')), [
    'trade:place:buy',
    'trade:place:sell',
  ]);
  assert.equal(deps.maxConcurrentWrites, 1);
  assert.equal(deps.journal.load(), null);
});

test('setLeverage allows only BTCUSDT exact 1x and rejects non-READY writes', async () => {
  const deps = dependencies();
  const ex = createLiveAdapter(deps);
  await ex.init();
  assert.equal(await ex.setLeverage(20000, 1), true);
  await assert.rejects(ex.setLeverage(20001, 1), /ETHUSDT.*实盘写操作/);
  await assert.rejects(ex.setLeverage(20000, 2), /只允许.*1x/);

  deps.accountClient.getAllOpenOrders = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(ex.refresh(), /fetch failed/);
  await assert.rejects(ex.setLeverage(20000, 1), /RECONCILING/);
});

test('placeLimitOrder rejects ETH precision min-notional and reduce-only before journal creation', async () => {
  const deps = dependencies();
  const ex = createLiveAdapter(deps);
  await ex.init();
  const before = deps.journal.calls.filter((entry) => entry.startsWith('create:')).length;

  await assert.rejects(ex.placeLimitOrder({
    marketId: 20001, side: 'buy', price: 1800, sizeBase: 0.01,
  }), /ETHUSDT.*实盘写操作/);
  await assert.rejects(ex.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 60000.5, sizeBase: 0.0002,
  }), /tickSize/);
  await assert.rejects(ex.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 100, sizeBase: 0.0001,
  }), /minNotional/);
  await assert.rejects(ex.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002, reduceOnly: true,
  }), /reduce-only.*未开放/);
  assert.equal(
    deps.journal.calls.filter((entry) => entry.startsWith('create:')).length,
    before,
  );
});

test('cancelAll cancels only adopted PopDEX orders and preserves manual orders', async () => {
  const robotClientId = encodeBytes32String('dw-bb-0102030405060708090a0b0c').toLowerCase();
  const robot = openOrder();
  const manual = openOrder({
    orderId: '90071992547409931299',
    clientOid: 'manual-order',
    price: '59000',
  });
  const deps = dependencies({ btcOrders: [robot, manual] });
  const ex = createLiveAdapter(deps);
  await ex.init();
  ex.adoptOrder({
    orderId: robot.orderId,
    marketId: 20000,
    clientOrderId: robotClientId,
    side: 'buy',
    price: 60000,
    sizeBase: 0.0002,
    levelIndex: 1,
  });

  assert.equal(await ex.cancelAll(20000), true);
  assert.deepEqual(
    deps.calls.filter((entry) => entry.startsWith('trade:cancel:')),
    [`trade:cancel:${robot.orderId}`],
  );
  assert.equal(ex.getOpenOrders(20000).some((order) => order.orderId === manual.orderId), true);
  await assert.rejects(ex.cancelOrder(20000, manual.orderId), /不属于适配器/);
});

test('adoptOrder rejects incomplete or conflicting ownership metadata', async () => {
  const deps = dependencies({ btcOrders: [openOrder()] });
  const ex = createLiveAdapter(deps);
  await ex.init();
  assert.throws(() => ex.adoptOrder({ orderId: openOrder().orderId }), /完整.*元数据/);
  assert.throws(() => ex.adoptOrder({
    orderId: openOrder().orderId,
    marketId: 20000,
    clientOrderId: encodeBytes32String('dw-bb-0102030405060708090a0b0c'),
    side: 'sell',
    price: 60000,
    sizeBase: 0.0002,
    levelIndex: 1,
  }), /side.*冲突/);
});

test('closePosition accepts only one confirmed BTC long and reaches official flat', async () => {
  const deps = dependencies({ positions: [longPosition()] });
  const ex = createLiveAdapter(deps);
  await ex.init();
  assert.equal(await ex.closePosition(20000), true);
  assert.equal(ex.getPosition(20000), null);

  const shortDeps = dependencies({ positions: [longPosition({ side: '2' })] });
  const short = createLiveAdapter(shortDeps);
  await short.init();
  await assert.rejects(short.closePosition(20000), /只允许.*多仓/);
  await assert.rejects(short.closePosition(20001), /ETHUSDT.*实盘写操作/);
});

function broadcastPlaceRecord(overrides = {}) {
  return {
    kind: 'place',
    stage: 'BROADCAST',
    mainAccount: ACCOUNT,
    agentAddress: AGENT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    side: 'buy',
    price: '60000',
    qty: '0.0002',
    clientOrderId: encodeBytes32String('dw-bb-0102030405060708090a0b0c').toLowerCase(),
    orderId: null,
    closeOrderId: null,
    positionId: null,
    leverage: null,
    closeClientOrderId: null,
    txHash: `0x${'55'.repeat(32)}`,
    outcome: null,
    ...overrides,
  };
}

function placeReceipt(record) {
  const event = POPDEX_ORDER_EVENT_INTERFACE.encodeEventLog(
    POPDEX_ORDER_EVENT_INTERFACE.getEvent('OrderCreate'),
    [
      ACCOUNT,
      20000,
      '90071992547409931234',
      record.clientOrderId,
      parseUnits(record.price, 18),
      parseUnits(record.qty, 18),
      0,
      2,
      true,
      0,
    ],
  );
  return {
    transactionHash: record.txHash,
    status: '0x1',
    logs: [{
      address: '0x0000000000000000000000000000000000001000',
      data: event.data,
      topics: event.topics,
    }],
  };
}

test('BROADCAST place recovery confirms official facts and never broadcasts again', async () => {
  const record = broadcastPlaceRecord();
  const journal = memoryJournal(record);
  const deps = dependencies({
    journal,
    btcOrders: [openOrder()],
    receipt: placeReceipt(record),
  });
  const ex = createLiveAdapter(deps);

  await ex.reconnect();
  assert.equal(deps.broadcastCalls, 0);
  assert.equal(ex.getHealth().state, 'READY');
  assert.equal(journal.load(), null);
  assert.ok(journal.calls.includes('advance:BROADCAST:CONFIRMED'));
});

test('PREPARED recovery completes safely without broadcast', async () => {
  const record = { ...broadcastPlaceRecord(), stage: 'PREPARED', txHash: null };
  const journal = memoryJournal(record);
  const deps = dependencies({ journal });
  const ex = createLiveAdapter(deps);

  await ex.reconnect();
  assert.equal(deps.broadcastCalls, 0);
  assert.equal(journal.load(), null);
  assert.ok(journal.calls.includes('complete:safe-no-broadcast'));
});

test('unresolved BROADCAST recovery enters HALTED and retains the journal', async () => {
  const record = broadcastPlaceRecord();
  const journal = memoryJournal(record);
  const deps = dependencies({ journal, receipt: null });
  const ex = createLiveAdapter(deps);

  await assert.rejects(ex.reconnect(), /BROADCAST.*回执.*不可用/);
  assert.equal(ex.getHealth().state, 'HALTED');
  assert.equal(journal.load().stage, 'BROADCAST');
  assert.equal(deps.broadcastCalls, 0);
});

test('post-confirmation refresh failure retains CONFIRMED journal for reconnect', async () => {
  const journal = memoryJournal();
  const deps = dependencies({ journal });
  const ex = createLiveAdapter(deps);
  await ex.init();
  const original = deps.tradingClient.placeAdapterOrder;
  deps.tradingClient.placeAdapterOrder = async (...args) => {
    const result = await original(...args);
    deps.accountClient.getAllOpenOrders = async () => { throw new TypeError('fetch failed'); };
    return result;
  };

  await assert.rejects(ex.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002,
  }), /fetch failed/);
  assert.equal(ex.getHealth().state, 'HALTED');
  assert.equal(journal.load().stage, 'CONFIRMED');
});
