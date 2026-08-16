import assert from 'node:assert/strict';
import test from 'node:test';
import {
  main,
  verifyPopdexAccount,
  verifyPopdexPublic,
} from '../src/exchange/px/verify.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const CONFIG = { candleInterval: '1H', candleLimit: 2 };
const REQUIRED_TOKENS = [
  'approveAgent', 'revokeAgent', 'placeOrder', 'cancelOrder',
  'updateLeverage', 'closePosition', 'clientOrderId',
  '0x0000000000000000000000000000000000001000',
  '0x0000000000000000000000000000000000001008',
];

function fakeDependencies(calls = []) {
  return {
    rpcClient: {
      async verifyChain() { calls.push('rpc:verifyChain'); return 2184n; },
    },
    publicClient: {
      async getMarkets() {
        calls.push('public:getMarkets');
        return [
          {
            marketId: 20000, name: 'BTCUSDT', displayName: 'BTCUSDT', symbol: 'BTC',
            stepPrice: 1, stepSize: 0.0001, minOrderSize: 0.0001,
            minNotional: 10, defaultLeverage: 20,
          },
          {
            marketId: 20001, name: 'ETHUSDT', displayName: 'ETHUSDT', symbol: 'ETH',
            stepPrice: 0.1, stepSize: 0.001, minOrderSize: 0.001,
            minNotional: 10, defaultLeverage: 20,
          },
        ];
      },
      async getTicker(symbol) {
        calls.push(`public:getTicker:${symbol}`);
        return { bid: 100, ask: 101, last: 100.5, index: 100.6, mark: 100.4 };
      },
      async getCandles(symbol, interval, limit) {
        calls.push(`public:getCandles:${symbol}:${interval}:${limit}`);
        return [{ time: '1786800000000', open: 100, high: 101, low: 99, close: 100.5 }];
      },
    },
    inspectArtifacts: async () => {
      calls.push('artifacts:inspect');
      return {
        fetchedAt: '2026-08-16T00:00:00.000Z',
        appUrl: 'https://app.popdex.xyz/',
        scripts: [{ path: '/app.js', sha256: 'a'.repeat(64), bytes: 100 }],
        matches: REQUIRED_TOKENS.map((token, offset) => ({
          path: '/app.js', token, offset, context: token,
        })),
      };
    },
    accountClient: {
      async getOpenOrders(account, symbol) {
        calls.push(`account:orders:${account}:${symbol}`);
        return symbol === 'BTCUSDT' ? [{ orderId: '90071992547409931234' }] : [];
      },
      async getFills(account, symbol) {
        calls.push(`account:fills:${account}:${symbol}`);
        return symbol === 'BTCUSDT' ? [{ fillId: '90071992547409939999' }] : [];
      },
      async getOverview(account) {
        calls.push(`account:overview:${account}`);
        return { balances: [] };
      },
      async getPositions(account) {
        calls.push(`account:positions:${account}`);
        return [];
      },
    },
  };
}

test('public verification checks chain markets tickers candles and official artifacts', async () => {
  const calls = [];
  const result = await verifyPopdexPublic(CONFIG, fakeDependencies(calls));
  assert.equal(result.chainId, '2184');
  assert.deepEqual(result.markets.map((market) => market.name), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(result.writeMethodsCalled, 0);
  assert.deepEqual(calls, [
    'rpc:verifyChain',
    'public:getMarkets',
    'public:getTicker:BTCUSDT',
    'public:getCandles:BTCUSDT:1H:2',
    'public:getTicker:ETHUSDT',
    'public:getCandles:ETHUSDT:1H:2',
    'artifacts:inspect',
  ]);
});

test('account verification reads exact orders fills overview and positions without Agent key', async () => {
  const calls = [];
  const result = await verifyPopdexAccount(
    { ...CONFIG, account: ACCOUNT },
    fakeDependencies(calls),
  );
  assert.equal(result.account, ACCOUNT);
  assert.equal(result.agentKeyRequired, false);
  assert.equal(result.writeMethodsCalled, 0);
  assert.equal(result.markets[0].openOrders, 1);
  assert.equal(result.markets[0].fills, 1);
  assert.ok(calls.includes(`account:overview:${ACCOUNT}`));
  assert.ok(calls.includes(`account:positions:${ACCOUNT}`));
});

test('verification fails when official artifacts do not expose required protocol evidence', async () => {
  const deps = fakeDependencies();
  deps.inspectArtifacts = async () => ({
    fetchedAt: '2026-08-16T00:00:00.000Z',
    appUrl: 'https://app.popdex.xyz/',
    scripts: [],
    matches: REQUIRED_TOKENS
      .filter((token) => token !== 'approveAgent')
      .map((token) => ({ path: '/app.js', token, offset: 0, context: token })),
  });
  await assert.rejects(verifyPopdexPublic(CONFIG, deps), /approveAgent.*未找到/);
});

test('main accepts only POPDEX_MAIN_ACCOUNT and masks it in output', async () => {
  const output = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const result = await main(['--account-env', 'POPDEX_MAIN_ACCOUNT'], {
      ...fakeDependencies(),
      env: { POPDEX_MAIN_ACCOUNT: ACCOUNT },
      log: (line) => output.push(String(line)),
      error: (line) => output.push(String(line)),
    });
    assert.equal(process.exitCode, 0);
    assert.equal(result.account.account, ACCOUNT);
    const rendered = output.join('\n');
    assert.match(rendered, /0x1111…1111/);
    assert.doesNotMatch(rendered, new RegExp(ACCOUNT, 'i'));

    process.exitCode = undefined;
    await main(['--account-env', 'OTHER_ACCOUNT'], {
      ...fakeDependencies(), env: {}, log() {}, error() {},
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('main rejects every trading or private-key flag before constructing clients', async () => {
  for (const flag of ['--agent-key', '--private-key', '--place', '--cancel', '--leverage', '--close']) {
    const output = [];
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await main([flag], {
        log: (line) => output.push(String(line)),
        error: (line) => output.push(String(line)),
      });
      assert.equal(process.exitCode, 1);
      assert.match(output.join('\n'), /只读.*拒绝/);
    } finally {
      process.exitCode = previousExitCode;
    }
  }
});
