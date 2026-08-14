import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createExchange as createRsExchange } from '../src/exchange/rs/index.js';
import { initializeExchange } from '../src/startup.js';
import { remapSnapshotMarket, resumeRunningSnapshot } from '../src/recovery.js';

test('RISEx live is rejected before signer key reaches unofficial SDK', () => {
  assert.throws(
    () => createRsExchange({ mode: 'live', account: '0x1', signerKey: 'secret' }),
    /RISEx 实盘已禁用/,
  );
});

test('RISEx paper remains available', () => {
  assert.equal(createRsExchange({ mode: 'paper', startBalance: 1000 }).mode, 'paper');
});

test('direct RISEx live adapter initialization is also blocked before SDK loading', () => {
  const source = fs.readFileSync(new URL('../src/exchange/rs/risex.js', import.meta.url), 'utf8');
  assert.match(source, /async init\(\) \{\s*throw new Error\('RISEx 实盘已禁用/);
  assert.match(source, /async reconnect\(\) \{\s*throw new Error\('RISEx 实盘已禁用/);
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
