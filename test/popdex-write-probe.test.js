import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBytes32String, encodeBytes32String, parseUnits, Wallet } from 'ethers';
import { POPDEX_ORDER_EVENT_INTERFACE } from '../src/exchange/px/receipt-events.js';
import {
  main,
  parseArgs,
  runProbe,
} from '../src/exchange/px/write-probe.js';

const MAIN_ACCOUNT = '0x1111111111111111111111111111111111111111';
const AGENT_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const AGENT = new Wallet(AGENT_PRIVATE_KEY).address;
const CLIENT_ORDER_ID = encodeBytes32String('dw-bb-0123456789abcdef01234567');
const PLACE_TX_HASH = `0x${'34'.repeat(32)}`;
const ORDER_ID = '234237619377012736';

function successfulPlacementReceipt(overrides = {}) {
  const event = POPDEX_ORDER_EVENT_INTERFACE.encodeEventLog(
    POPDEX_ORDER_EVENT_INTERFACE.getEvent('OrderCreate'),
    [
      MAIN_ACCOUNT,
      '20000',
      ORDER_ID,
      CLIENT_ORDER_ID,
      parseUnits('60000', 18),
      parseUnits('0.0002', 18),
      0,
      2,
      true,
      0,
    ],
  );
  return {
    transactionHash: PLACE_TX_HASH,
    status: '0x1',
    logs: [{
      address: '0x0000000000000000000000000000000000001000',
      data: event.data,
      topics: event.topics,
    }],
    ...overrides,
  };
}

function restProbeOrder(overrides = {}) {
  return {
    walletId: MAIN_ACCOUNT,
    orderId: ORDER_ID,
    clientOid: decodeBytes32String(CLIENT_ORDER_ID),
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

function options(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'buy',
    price: '60000',
    qty: '0.0002',
    confirmMainnetWrite: false,
    resume: false,
    ...overrides,
  };
}

function notFound() {
  const error = new Error('not found');
  error.code = 'POPDEX_ORDER_NOT_FOUND';
  return error;
}

function fakeDependencies(overrides = {}) {
  const calls = [];
  const journal = {
    record: null,
    load() { calls.push('journal:load'); return this.record; },
    create(plan) {
      calls.push('journal:create');
      this.record = { stage: 'PREPARED', ...plan };
      return this.record;
    },
    completeFromChain(orderId) {
      calls.push(`journal:complete:${orderId}`);
      this.record = { ...this.record, stage: 'CANCEL_CONFIRMED', orderId, recoveredFromChain: true };
    },
    clearCompleted() { calls.push('journal:clear'); this.record = null; },
    clearPrepared() { calls.push('journal:clear-prepared'); this.record = null; },
    clearRevertedPlacement(txHash) {
      calls.push(`journal:clear-reverted:${txHash}`);
      this.record = null;
    },
  };
  return {
    calls,
    env: {
      POPDEX_MAIN_ACCOUNT: MAIN_ACCOUNT,
      POPDEX_AGENT_PRIVATE_KEY: AGENT_PRIVATE_KEY,
    },
    now: () => 1786946400000,
    randomBytesImpl: () => Uint8Array.from({ length: 16 }, (_, index) => index + 1),
    publicClient: {
      async getMarkets() {
        calls.push('public:markets');
        return [
          { name: 'BTCUSDT', marketId: 20000, stepPrice: 1, stepSize: 0.0001, minOrderSize: 0.0001, minNotional: 10 },
          { name: 'ETHUSDT', marketId: 20001, stepPrice: 0.1, stepSize: 0.001, minOrderSize: 0.001, minNotional: 10 },
        ];
      },
      async getTicker(symbol) {
        calls.push(`public:ticker:${symbol}`);
        return { bid: 62900, ask: 62901, last: 62900.5, index: 62910, mark: 62900.5 };
      },
    },
    accountClient: {
      async getOverview(account) {
        calls.push(`account:overview:${account}`);
        return {
          accountEquity: '100.00',
          availableMargin: '100.00',
          totalCollateral: '100.00',
          balances: [{ balance: '100.00' }],
        };
      },
      async findUniqueOrderByClientId() { throw notFound(); },
    },
    readRpc: {
      async verifyChain() { calls.push('read:chain'); return 2184n; },
      async getAgentInfo(agent) {
        calls.push(`read:agent:${agent}`);
        return {
          exists: true,
          expiresAt: '1789531200000',
          isExpired: false,
          delegator: MAIN_ACCOUNT,
          isGlobal: false,
        };
      },
      async findUniqueOrderByClientId() { throw notFound(); },
      async getReceipt(txHash) { calls.push(`read:receipt:${txHash}`); return null; },
      async getTransactionFailure(txHash) { calls.push(`read:failure:${txHash}`); return null; },
    },
    journal,
    createWriteRpc() { calls.push('write:create'); return { name: 'writeRpc' }; },
    createTradingClient() {
      calls.push('trading:create');
      return {
        async placeAndConfirm(plan) {
          calls.push('trading:place');
          return {
            walletId: MAIN_ACCOUNT,
            orderId: '90071992547409931234',
            clientOrderId: plan.clientOrderId,
            symbolId: plan.symbolId,
            side: '0',
            isReduceOnly: false,
            priceWad: plan.priceWad,
            qtyWad: plan.qtyWad,
            filledQtyWad: '0',
            remainingQtyWad: plan.qtyWad,
            cancelledQtyWad: '0',
          };
        },
        async cancelAndConfirm(open) {
          calls.push('trading:cancel');
          return {
            ...open,
            filledQtyWad: '0',
            remainingQtyWad: '0',
            cancelledQtyWad: open.qtyWad,
          };
        },
      };
    },
    log() {},
    error() {},
    ...overrides,
  };
}

test('parseArgs accepts one exact dry-run, live or resume command', () => {
  assert.deepEqual(parseArgs([
    '--symbol', 'BTCUSDT', '--side', 'buy', '--price', '60000', '--qty', '0.0002',
  ]), options());
  assert.equal(parseArgs([
    '--symbol', 'ETHUSDT', '--side', 'sell', '--price', '2000.1', '--qty', '0.006',
    '--confirm-mainnet-write',
  ]).confirmMainnetWrite, true);
  assert.deepEqual(parseArgs(['--resume']), {
    symbol: null, side: null, price: null, qty: null,
    confirmMainnetWrite: false, resume: true,
  });
});

test('parseArgs rejects missing, duplicate, unknown and conflicting arguments', () => {
  assert.throws(() => parseArgs(['--symbol', 'BTCUSDT']), /缺少.*--side/);
  assert.throws(() => parseArgs([
    '--symbol', 'BTCUSDT', '--symbol', 'ETHUSDT',
    '--side', 'buy', '--price', '1', '--qty', '1',
  ]), /重复.*--symbol/);
  assert.throws(() => parseArgs(['--unknown']), /不支持.*--unknown/);
  assert.throws(() => parseArgs(['--resume', '--confirm-mainnet-write']), /--resume.*互斥/);
  assert.throws(() => parseArgs(['--resume', '--symbol', 'BTCUSDT']), /--resume.*互斥/);
});

test('dry-run verifies market, book and Agent without constructing a write client', async () => {
  const deps = fakeDependencies();
  const result = await runProbe(options(), deps);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.symbol, 'BTCUSDT');
  assert.equal(result.agent, AGENT);
  assert.match(result.clientOrderId, /^0x[0-9a-f]{64}$/);
  assert.match(result.calldataHash, /^0x[0-9a-f]{64}$/);
  assert.equal(result.availableMargin, '100.00');
  assert.ok(deps.calls.includes('read:chain'));
  assert.ok(deps.calls.includes(`account:overview:${MAIN_ACCOUNT}`));
  assert.ok(deps.calls.includes(`read:agent:${AGENT}`));
  assert.ok(!deps.calls.includes('write:create'));
  assert.ok(!deps.calls.includes('trading:create'));
});

test('mainnet mode rejects zero available margin before creating a write client or journal', async () => {
  const deps = fakeDependencies();
  deps.accountClient.getOverview = async () => ({
    accountEquity: '0.00',
    availableMargin: '0.00',
    totalCollateral: '0.00',
    balances: [],
  });

  await assert.rejects(
    runProbe(options({ confirmMainnetWrite: true }), deps),
    /availableMargin=0\.00.*无法下单/,
  );

  assert.ok(!deps.calls.includes('write:create'));
  assert.ok(!deps.calls.includes('journal:create'));
});

test('explicit mainnet mode creates the journal before place, then cancels and clears', async () => {
  const deps = fakeDependencies();
  const result = await runProbe(options({ confirmMainnetWrite: true }), deps);
  assert.equal(result.mode, 'mainnet-write');
  assert.deepEqual(
    deps.calls.filter((entry) => /^(?:journal|write|trading):/.test(entry)),
    [
      'journal:load', 'write:create', 'trading:create', 'journal:create',
      'trading:place', 'trading:cancel', 'journal:clear',
    ],
  );
});

test('explicit mainnet mode clears PREPARED after a proven pre-broadcast failure', async () => {
  const deps = fakeDependencies();
  deps.createTradingClient = () => ({
    async placeAndConfirm() { throw new Error('simulation rejected'); },
  });
  await assert.rejects(
    runProbe(options({ confirmMainnetWrite: true }), deps),
    /simulation rejected/,
  );
  assert.ok(deps.calls.includes('journal:create'));
  assert.ok(deps.calls.includes('journal:clear-prepared'));
  assert.equal(deps.journal.record, null);
});

test('new probe refuses missing credentials and any existing recovery record', async () => {
  const missing = fakeDependencies({ env: { POPDEX_MAIN_ACCOUNT: MAIN_ACCOUNT } });
  await assert.rejects(runProbe(options(), missing), /POPDEX_AGENT_PRIVATE_KEY/);

  const existing = fakeDependencies();
  existing.journal.record = { stage: 'BROADCAST', clientOrderId: CLIENT_ORDER_ID };
  await assert.rejects(runProbe(options(), existing), /已有.*--resume/);
  assert.ok(!existing.calls.includes('write:create'));
});

test('resume reports an active order and never constructs a write client', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: null,
  };
  deps.readRpc.findUniqueOrderByClientId = async (_account, _clientOrderId, query) => {
    if (query.completed) throw notFound();
    return {
      walletId: MAIN_ACCOUNT, orderId: '9', clientOrderId: CLIENT_ORDER_ID,
      symbolId: '20000', side: '0', priceWad: '60000000000000000000000',
      qtyWad: '200000000000000', filledQtyWad: '0', remainingQtyWad: '200000000000000',
      cancelledQtyWad: '0', isReduceOnly: false,
    };
  };
  const result = await runProbe(options({ resume: true, symbol: null, side: null, price: null, qty: null }), deps);
  assert.equal(result.mode, 'resume');
  assert.equal(result.status, 'active-manual-cancel-required');
  assert.equal(result.orderId, '9');
  assert.ok(!deps.calls.includes('write:create'));
  assert.ok(!deps.calls.includes('journal:clear'));
});

test('resume clears only an authoritative zero-fill completed order', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: null,
  };
  deps.readRpc.findUniqueOrderByClientId = async (_account, _clientOrderId, query) => {
    if (!query.completed) throw notFound();
    return {
      walletId: MAIN_ACCOUNT, orderId: '9', clientOrderId: CLIENT_ORDER_ID,
      symbolId: '20000', side: '0', priceWad: '60000000000000000000000',
      qtyWad: '200000000000000', filledQtyWad: '0', remainingQtyWad: '0',
      cancelledQtyWad: '200000000000000', isReduceOnly: false,
    };
  };
  const result = await runProbe(options({ resume: true, symbol: null, side: null, price: null, qty: null }), deps);
  assert.equal(result.status, 'completed-zero-fill-cleared');
  assert.ok(deps.calls.includes('journal:complete:9'));
  assert.ok(deps.calls.includes('journal:clear'));
  assert.ok(!deps.calls.includes('write:create'));
});

test('resume clears a BROADCAST journal only after the recorded placement receipt reverted', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: null, placeTxHash: PLACE_TX_HASH,
  };
  deps.readRpc.getReceipt = async (txHash) => {
    deps.calls.push(`read:receipt:${txHash}`);
    return { transactionHash: txHash, status: '0x0' };
  };
  deps.readRpc.getTransactionFailure = async (txHash) => {
    deps.calls.push(`read:failure:${txHash}`);
    return { message: '[13004] Quantity exceeds maximum' };
  };

  const result = await runProbe(
    options({ resume: true, symbol: null, side: null, price: null, qty: null }),
    deps,
  );

  assert.equal(result.status, 'reverted-placement-cleared');
  assert.equal(result.txHash, PLACE_TX_HASH);
  assert.equal(result.failure, '[13004] Quantity exceeds maximum');
  assert.ok(deps.calls.includes(`journal:clear-reverted:${PLACE_TX_HASH}`));
  assert.equal(deps.journal.record, null);
  assert.ok(!deps.calls.includes('write:create'));
});

test('resume never clears a failed receipt when REST still reports the client order ID', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: null, placeTxHash: PLACE_TX_HASH,
  };
  deps.readRpc.getReceipt = async () => ({ transactionHash: PLACE_TX_HASH, status: '0x0' });
  deps.accountClient.findUniqueOrderByClientId = async () => restProbeOrder();

  await assert.rejects(
    runProbe(options({ resume: true, symbol: null, side: null, price: null, qty: null }), deps),
    /失败下单回执与订单查询事实冲突/,
  );
  assert.equal(deps.journal.record.stage, 'BROADCAST');
  assert.ok(!deps.calls.some((call) => call.startsWith('journal:clear-reverted:')));
});

test('resume keeps an unresolved BROADCAST journal without a transaction receipt', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: null, placeTxHash: PLACE_TX_HASH,
  };
  deps.readRpc.getReceipt = async () => null;

  const result = await runProbe(
    options({ resume: true, symbol: null, side: null, price: null, qty: null }),
    deps,
  );

  assert.equal(result.status, 'order-fact-unresolved');
  assert.equal(deps.journal.record.stage, 'BROADCAST');
  assert.ok(!deps.calls.some((call) => call.startsWith('journal:clear-reverted:')));
});

test('resume rejects a malformed successful placement receipt instead of hiding it', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: null, placeTxHash: PLACE_TX_HASH,
  };
  deps.readRpc.getReceipt = async () => ({ transactionHash: PLACE_TX_HASH, status: '0x1' });

  await assert.rejects(
    runProbe(options({ resume: true, symbol: null, side: null, price: null, qty: null }), deps),
    /OrderCreate.*logs.*数组/,
  );
  assert.equal(deps.journal.record.stage, 'BROADCAST');
});

test('resume uses a successful OrderCreate receipt plus REST when precompile order pages are empty', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: null, placeTxHash: PLACE_TX_HASH,
  };
  deps.readRpc.getReceipt = async () => successfulPlacementReceipt();
  deps.accountClient.findUniqueOrderByClientId = async (account, symbol, clientOrderId) => {
    assert.equal(account, MAIN_ACCOUNT);
    assert.equal(symbol, 'BTCUSDT');
    assert.equal(clientOrderId, CLIENT_ORDER_ID);
    return restProbeOrder();
  };

  const result = await runProbe(
    options({ resume: true, symbol: null, side: null, price: null, qty: null }),
    deps,
  );

  assert.equal(result.status, 'active-manual-cancel-required');
  assert.equal(result.orderId, ORDER_ID);
  assert.equal(result.source, 'receipt+REST');
  assert.equal(deps.journal.record.stage, 'BROADCAST');
  assert.ok(!deps.calls.includes('journal:clear'));
});

test('resume clears a successful placement only after REST proves zero-fill cancellation', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: null, placeTxHash: PLACE_TX_HASH,
  };
  deps.readRpc.getReceipt = async () => successfulPlacementReceipt();
  deps.accountClient.findUniqueOrderByClientId = async () => restProbeOrder({
    status: 'Cancelled',
    remainingQty: '0',
    cancelledQty: '0.0002',
  });

  const result = await runProbe(
    options({ resume: true, symbol: null, side: null, price: null, qty: null }),
    deps,
  );

  assert.equal(result.status, 'completed-zero-fill-cleared');
  assert.equal(result.source, 'receipt+REST');
  assert.ok(deps.calls.includes(`journal:complete:${ORDER_ID}`));
  assert.ok(deps.calls.includes('journal:clear'));
  assert.equal(deps.journal.record, null);
});

test('resume preserves the journal when REST proves a fill after successful placement', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: null, placeTxHash: PLACE_TX_HASH,
  };
  deps.readRpc.getReceipt = async () => successfulPlacementReceipt();
  deps.accountClient.findUniqueOrderByClientId = async () => restProbeOrder({
    status: 'PartiallyFilledCancelled',
    filledQty: '0.0001',
    remainingQty: '0',
    cancelledQty: '0.0001',
  });

  const result = await runProbe(
    options({ resume: true, symbol: null, side: null, price: null, qty: null }),
    deps,
  );

  assert.equal(result.status, 'filled-manual-position-required');
  assert.equal(result.filledQtyWad, '100000000000000');
  assert.equal(result.source, 'receipt+REST');
  assert.equal(deps.journal.record.stage, 'BROADCAST');
  assert.ok(!deps.calls.includes('journal:clear'));
});

test('resume preserves the journal and requires manual position handling after any fill', async () => {
  const deps = fakeDependencies();
  deps.journal.record = {
    stage: 'CANCEL_BROADCAST', symbol: 'BTCUSDT', side: 'buy', price: '60000', qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID, orderId: '9',
  };
  deps.readRpc.findUniqueOrderByClientId = async (_account, _clientOrderId, query) => {
    if (!query.completed) throw notFound();
    return {
      walletId: MAIN_ACCOUNT, orderId: '9', clientOrderId: CLIENT_ORDER_ID,
      symbolId: '20000', side: '0', priceWad: '60000000000000000000000',
      qtyWad: '200000000000000', filledQtyWad: '100000000000000', remainingQtyWad: '0',
      cancelledQtyWad: '100000000000000', isReduceOnly: false,
    };
  };
  const result = await runProbe(options({ resume: true, symbol: null, side: null, price: null, qty: null }), deps);
  assert.equal(result.status, 'filled-manual-position-required');
  assert.equal(result.filledQtyWad, '100000000000000');
  assert.ok(!deps.calls.includes('journal:clear'));
});

test('main masks addresses and never prints the Agent private key or raw calldata', async () => {
  const output = [];
  const deps = fakeDependencies({
    log: (line) => output.push(String(line)),
    error: (line) => output.push(String(line)),
  });
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const result = await main([
      '--symbol', 'BTCUSDT', '--side', 'buy', '--price', '60000', '--qty', '0.0002',
    ], deps);
    assert.equal(process.exitCode, 0);
    assert.equal(result.mode, 'dry-run');
    const rendered = output.join('\n');
    assert.match(rendered, /0x1111…1111/);
    assert.match(rendered, /dry-run/i);
    assert.doesNotMatch(rendered, new RegExp(AGENT_PRIVATE_KEY.slice(2), 'i'));
    assert.doesNotMatch(rendered, /serializedTransaction|raw transaction/i);
  } finally {
    process.exitCode = previousExitCode;
  }
});
