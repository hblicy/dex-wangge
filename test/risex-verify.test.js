import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { main, verifyRisexPrivate, verifyRisexPublic } from '../src/exchange/rs/verify.js';

const ACCOUNT = '0x0000000000000000000000000000000000000001';
const SIGNER = '0x0000000000000000000000000000000000000002';
const SIGNER_KEY = `0x${'11'.repeat(32)}`;
const API = 'https://api.rise.trade';
const WS = 'wss://api.rise.trade/ws/';
const WAD = 10n ** 18n;
const wad = (value) => (BigInt(value) * WAD).toString();

const rawMarkets = [
  {
    market_id: '1', display_name: 'BTC/USDC', base_asset_symbol: 'BTC/USDC',
    mark_price: '60000', config: { name: 'BTC/USDC', unlocked: true, step_size: '0.0001', step_price: '0.1', min_order_size: '0.001', max_leverage: '50' },
  },
  {
    market_id: '2', display_name: 'ETH/USDC', base_asset_symbol: 'ETH/USDC',
    mark_price: '3000', config: { name: 'ETH/USDC', unlocked: true, step_size: '0.001', step_price: '0.01', min_order_size: '0.01', max_leverage: '50' },
  },
];

function makeInfo(calls) {
  return {
    async getEip712Domain() {
      calls.push('getEip712Domain');
      return {
        name: 'RISEx', version: '1', chainId: 4153n,
        verifyingContract: '0x0000000000000000000000000000000000000003',
      };
    },
    async getMarkets() { calls.push('getMarkets'); return rawMarkets; },
    async getOrderbook(marketId) {
      calls.push(`getOrderbook:${marketId}`);
      const price = marketId === 1 ? 60000 : 3000;
      return { bids: [{ price: String(price - 1) }], asks: [{ price: String(price + 1) }] };
    },
    async getSessionKeyStatus(account, signer) {
      calls.push(`getSessionKeyStatus:${account}:${signer}`);
      return { status: 1 };
    },
    async getBalance(account) { calls.push(`getBalance:${account}`); return '123.45'; },
    async getOpenOrders(account, marketId) {
      calls.push(`getOpenOrders:${account}:${marketId}`);
      return marketId === 1 ? [{
        order_id: 'hidden-order', resting_order_id: 'hidden-resting', market_id: '1',
        side: 0, price_ticks: 600000, size_steps: 10, reduce_only: false,
      }] : [];
    },
    async getAllPositions(account) {
      calls.push(`getAllPositions:${account}`);
      return [{
        market_id: '1', side: 'BUY', size: (WAD / 100n).toString(),
        avg_entry_price: wad(60000), unrealized_pnl: wad(1), leverage: wad(3),
      }];
    },
    async getPosition() {
      throw new Error('private verification must use getAllPositions');
    },
    async getAccountTradeHistory(account, marketId) {
      calls.push(`getAccountTradeHistory:${account}:${marketId}`);
      return marketId === 1 ? [{
        id: 'hidden-fill', order_id: 'hidden-order', market_id: '1', side: 'BUY',
        size: '0.001', price: '60000', fee: '0', time: '20',
        blockchain_data: { block_number: '2', log_index: '0' },
      }] : [];
    },
  };
}

class FakePublicWs extends EventEmitter {
  constructor(calls) { super(); this.calls = calls; }
  async connect() { this.calls.push('publicWs:connect'); }
  subscribe(params) {
    this.calls.push(`publicWs:subscribe:${params.channel}:${params.market_ids.join(',')}`);
    queueMicrotask(() => this.emit('message', { channel: 'orderbook', type: 'snapshot', data: { market_id: 1 } }));
  }
  disconnect() { this.calls.push('publicWs:disconnect'); }
}

class FakePrivateStream {
  constructor(calls) { this.calls = calls; this.authenticated = false; }
  beginBuffering() { this.calls.push('privateWs:buffer'); }
  async connect() { this.calls.push('privateWs:connect'); this.authenticated = true; }
  async waitForOrderSnapshot() { this.calls.push('privateWs:snapshot'); }
  stop() { this.calls.push('privateWs:stop'); this.authenticated = false; }
}

test('public verification checks official dependency, domain, markets, books and public WS only', async () => {
  const calls = [];
  const result = await verifyRisexPublic({
    packageVersion: '0.1.11',
    infoFactory: () => makeInfo(calls),
    publicWsFactory: () => new FakePublicWs(calls),
    exchangeFactory: () => { throw new Error('ExchangeClient must not be constructed'); },
  });
  assert.equal(result.mode, 'public');
  assert.equal(result.chainId, '4153');
  assert.deepEqual(result.markets.map((market) => market.name), ['BTC-PERP', 'ETH-PERP']);
  assert.deepEqual(calls, [
    'getEip712Domain', 'getMarkets', 'getOrderbook:1', 'getOrderbook:2',
    'publicWs:connect', 'publicWs:subscribe:orderbook:1', 'publicWs:disconnect',
  ]);
  assert.equal(calls.some((call) => /Session|Balance|OpenOrders|Position|Trade|place|cancel/i.test(call)), false);
});

test('private verification authenticates and reads account state without ExchangeClient writes', async () => {
  const calls = [];
  const result = await verifyRisexPrivate({
    account: ACCOUNT, signerKey: SIGNER_KEY, apiUrl: API, wsUrl: WS,
  }, {
    packageVersion: '0.1.11',
    infoFactory: () => makeInfo(calls),
    walletFactory: () => ({ address: SIGNER }),
    privateStreamFactory: () => new FakePrivateStream(calls),
    exchangeFactory: () => { throw new Error('ExchangeClient must not be constructed'); },
  });
  assert.equal(result.mode, 'private');
  assert.equal(result.signer, '0x…000002');
  assert.equal(result.markets[0].openOrders, 1);
  assert.equal(result.markets[0].trades, 1);
  assert.equal(result.markets[0].position.sizeBase, 0.01);
  assert.ok(calls.includes('privateWs:connect'));
  assert.ok(calls.includes('privateWs:snapshot'));
  assert.equal(calls.filter((call) => call.startsWith('getAllPositions:')).length, 1);
  assert.equal(calls.some((call) => call.startsWith('getPosition:')), false);
  assert.equal(calls.some((call) => /place|cancel|leverage|close/i.test(call)), false);
});

test('main output is masked and sets exit code 0/1 deterministically', async () => {
  const calls = [];
  const output = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await main(['--private'], {
      env: { RISEX_ACCOUNT: ACCOUNT, RISEX_SIGNER_KEY: SIGNER_KEY },
      loadEnv: () => {},
      log: (line) => output.push(String(line)),
      error: (line) => output.push(String(line)),
      packageVersion: '0.1.11',
      infoFactory: () => makeInfo(calls),
      walletFactory: () => ({ address: SIGNER }),
      privateStreamFactory: () => new FakePrivateStream(calls),
    });
    assert.equal(process.exitCode, 0);
    const rendered = output.join('\n');
    assert.match(rendered, /0x…000002/);
    assert.doesNotMatch(rendered, new RegExp(SIGNER_KEY.slice(2), 'i'));
    assert.doesNotMatch(rendered, /signature|auth_v2|hidden-order|hidden-fill/i);

    process.exitCode = undefined;
    await main(['--private'], {
      env: {}, loadEnv: () => {}, log() {}, error() {},
    });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
