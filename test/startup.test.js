import test from 'node:test';
import assert from 'node:assert/strict';
import { createExchange as createRsExchange } from '../src/exchange/rs/index.js';
import { initializeExchange, prepareExchangeRecovery } from '../src/startup.js';
import { remapSnapshotMarket, resumeRunningSnapshot } from '../src/recovery.js';

test('RISEx live requires mainnet account and signer credentials', () => {
  assert.throws(
    () => createRsExchange({ mode: 'live', network: 'mainnet' }),
    /RISEX_ACCOUNT.*RISEX_SIGNER_KEY/,
  );
});

test('RISEx live rejects non-mainnet network and non-official endpoints', () => {
  const base = {
    mode: 'live',
    network: 'mainnet',
    account: '0x0000000000000000000000000000000000000001',
    signerKey: `0x${'11'.repeat(32)}`,
    apiUrl: 'https://api.rise.trade',
    wsUrl: 'wss://api.rise.trade/ws/',
  };
  assert.throws(() => createRsExchange({ ...base, network: 'testnet' }), /只支持 mainnet/);
  assert.throws(() => createRsExchange({ ...base, apiUrl: 'https://proxy.invalid' }), /RISEX_API_URL/);
  assert.throws(() => createRsExchange({ ...base, wsUrl: 'wss://proxy.invalid/ws/' }), /RISEX_WS_URL/);
});

test('RISEx paper remains available without live credentials', () => {
  assert.equal(createRsExchange({ mode: 'paper', startBalance: 1000 }).mode, 'paper');
});

test('live exchange initialization failure aborts startup', async () => {
  const cause = new Error('authentication failed');
  const exchange = { init: async () => { throw cause; } };
  const errors = [];

  await assert.rejects(
    initializeExchange(exchange, 'Extended', { mode: 'live' }, { log() {}, error: (line) => errors.push(line) }),
    (error) => error.cause === cause && /Extended 实盘初始化失败/.test(error.message),
  );
  assert.equal(errors.some((line) => line.includes('authentication failed')), true);
});

test('paper exchange initialization failure is reported but does not abort startup', async () => {
  const errors = [];
  const result = await initializeExchange(
    { init: async () => { throw new Error('market feed unavailable'); } },
    'Decibel',
    { mode: 'paper' },
    { log() {}, error: (line) => errors.push(line) },
  );

  assert.equal(result, false);
  assert.equal(errors.some((line) => line.includes('market feed unavailable')), true);
});

test('running snapshot is remapped by displayName before resume', async () => {
  const snapshot = { running: true, config: { marketId: 99, displayName: 'BTC-USD' } };
  const exchange = { getMarkets: async () => [{ marketId: 7, displayName: 'BTC-USD' }] };

  const mapped = await remapSnapshotMarket(exchange, snapshot);

  assert.equal(mapped.config.marketId, 7);
  assert.equal(snapshot.config.marketId, 99);
});

test('resume receives remapped id and propagates reconciliation failure', async () => {
  let received;
  const bot = { resume: async (snapshot) => { received = snapshot; throw new Error('reconcile failed'); } };
  const exchange = { dataSource: 'real', getMarkets: async () => [{ marketId: 7, displayName: 'BTC-USD' }] };

  await assert.rejects(
    resumeRunningSnapshot(bot, exchange, { running: true, config: { marketId: 99, displayName: 'BTC-USD' } }),
    /reconcile failed/,
  );
  assert.equal(received.config.marketId, 7);
});

test('startup passes the persisted snapshot to adapters that enforce ownership', () => {
  let received;
  const exchange = { setRecoverySnapshot: (snapshot) => { received = snapshot; } };
  const snapshot = { running: true, active: [['o1', {}]] };
  prepareExchangeRecovery(exchange, snapshot);
  assert.equal(received, snapshot);
  assert.doesNotThrow(() => prepareExchangeRecovery({}, snapshot));
});
