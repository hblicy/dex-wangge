import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet } from 'ethers';
import {
  main,
  parseArgs,
  runProbe,
} from '../src/exchange/px/write-probe.js';

const MAIN_ACCOUNT = '0x1111111111111111111111111111111111111111';
const AGENT_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const AGENT = new Wallet(AGENT_PRIVATE_KEY).address;
const CLIENT_ORDER_ID = `0x${'12'.repeat(32)}`;

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
  assert.ok(deps.calls.includes('read:chain'));
  assert.ok(deps.calls.includes(`read:agent:${AGENT}`));
  assert.ok(!deps.calls.includes('write:create'));
  assert.ok(!deps.calls.includes('trading:create'));
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
