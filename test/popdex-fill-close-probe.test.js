import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet } from 'ethers';
import {
  parseArgs,
  runProbe,
} from '../src/exchange/px/fill-close-probe.js';

const MAIN_ACCOUNT = '0x1111111111111111111111111111111111111111';
const AGENT_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const AGENT = new Wallet(AGENT_PRIVATE_KEY).address;
const NOW = 1787032800000;

test('fill-close CLI accepts only explicit non-overlapping modes', () => {
  assert.deepEqual(parseArgs([]), { mode: 'dry-run' });
  assert.deepEqual(parseArgs(['--confirm-mainnet-fill-close']), { mode: 'fill-close' });
  assert.deepEqual(parseArgs(['--resume']), { mode: 'resume' });
  assert.deepEqual(parseArgs(['--resume', '--confirm-mainnet-cancel']), {
    mode: 'resume-cancel',
  });
  assert.deepEqual(parseArgs(['--resume', '--confirm-mainnet-close']), {
    mode: 'resume-close',
  });
  assert.throws(() => parseArgs(['--confirm-mainnet-write']), /不支持参数/);
  assert.throws(
    () => parseArgs(['--resume', '--confirm-mainnet-fill-close']),
    /互斥/,
  );
  assert.throws(
    () => parseArgs(['--confirm-mainnet-close']),
    /必须与 --resume/,
  );
  assert.throws(() => parseArgs(['--resume', '--resume']), /重复参数/);
});

function dependencies({
  positionMode = '0',
  leverage = '20',
  openOrders = [],
  positions = [],
  availableMargin = '799',
} = {}) {
  const calls = [];
  let broadcasts = 0;
  let journalCreates = 0;
  return {
    calls,
    get broadcasts() { return broadcasts; },
    get journalCreates() { return journalCreates; },
    mainAccount: MAIN_ACCOUNT,
    agentAddress: AGENT,
    now: () => NOW,
    randomBytesImpl: () => Uint8Array.from(
      { length: 16 },
      (_unused, index) => index + 1,
    ),
    readRpc: {
      async verifyChain() { calls.push('read:chain'); return 2184n; },
      async getAgentInfo() {
        calls.push('read:agent');
        return {
          exists: true,
          expiresAt: String(NOW + 60000),
          isExpired: false,
          delegator: MAIN_ACCOUNT,
          name: `0x${'00'.repeat(32)}`,
          isGlobal: false,
        };
      },
      async getAccountConfig() {
        calls.push('read:config');
        return {
          status: '0',
          vipLevel: '0',
          positionMode,
          bizPermissionCode: '0',
          symbolLeverages: [{ symbolId: '20000', leverage }],
          tokenLeverages: [],
        };
      },
      async getAllOpenPositions() { calls.push('read:positions'); return positions; },
    },
    writeRpc: {
      async verifyChain() { calls.push('write:chain'); return 2184n; },
      async simulate(transaction) {
        calls.push(`write:simulate:${transaction.to}`);
        return '0x';
      },
      async broadcast() { broadcasts += 1; throw new Error('must not broadcast'); },
    },
    publicClient: {
      async getMarkets() {
        calls.push('public:markets');
        return [{
          marketId: 20000,
          name: 'BTCUSDT',
          stepPrice: 1,
          stepSize: 0.0001,
          minOrderSize: 0.0001,
          minNotional: 10,
        }];
      },
      async getTicker() {
        calls.push('public:ticker');
        return { bid: 62999, ask: 63000, last: 63000, index: 63000, mark: 63000 };
      },
    },
    accountClient: {
      async getAllOpenOrders() { calls.push('account:orders'); return openOrders; },
      async getOverview() {
        calls.push('account:overview');
        return { availableMargin };
      },
    },
    journal: {
      create() { journalCreates += 1; },
    },
  };
}

test('fill-close dry-run verifies all facts and never signs broadcasts or writes journal', async () => {
  const deps = dependencies();
  const result = await runProbe({ mode: 'dry-run' }, deps);
  assert.equal(result.status, 'dry-run-ready');
  assert.equal(result.symbol, 'BTCUSDT');
  assert.equal(result.currentLeverage, '20');
  assert.equal(result.targetLeverage, '1');
  assert.equal(result.price, '63189');
  assert.equal(result.qty, '0.0002');
  assert.match(result.calldataHashes.leverage, /^0x[0-9a-f]{64}$/);
  assert.match(result.calldataHashes.entry, /^0x[0-9a-f]{64}$/);
  assert.match(result.calldataHashes.close, /^0x[0-9a-f]{64}$/);
  assert.equal(deps.broadcasts, 0);
  assert.equal(deps.journalCreates, 0);
  assert.equal(deps.calls.filter((call) => call.startsWith('write:simulate:')).length, 3);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(AGENT_PRIVATE_KEY.slice(2), 'i'));
  assert.deepEqual(deps.calls.slice(0, 9), [
    'read:chain',
    'write:chain',
    'read:agent',
    'public:markets',
    'public:ticker',
    'read:config',
    'account:orders',
    'read:positions',
    'account:overview',
  ]);
});

test('fill-close dry-run fails before simulation on unsafe account facts', async () => {
  for (const [options, expected] of [
    [{ positionMode: '1' }, /OneWay.*0/],
    [{ openOrders: [{ symbol: 'BTCUSDT', orderId: '9' }] }, /活动订单/],
    [{ positions: [{ symbolId: '20000', side: '1', holdSizeWad: '1' }] }, /持仓/],
    [{ availableMargin: '1' }, /availableMargin.*名义金额/],
  ]) {
    const deps = dependencies(options);
    await assert.rejects(runProbe({ mode: 'dry-run' }, deps), expected);
    assert.equal(deps.broadcasts, 0);
    assert.equal(deps.journalCreates, 0);
    assert.equal(deps.calls.some((call) => call.startsWith('write:simulate:')), false);
  }
});
