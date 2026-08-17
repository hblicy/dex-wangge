import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexWriteJournal } from '../src/exchange/px/write-journal.js';

const CLIENT_ORDER_ID = `0x${'12'.repeat(32)}`;
const PLACE_TX_HASH = `0x${'34'.repeat(32)}`;
const CANCEL_TX_HASH = `0x${'56'.repeat(32)}`;

function orderPlan(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'buy',
    price: '60000',
    qty: '0.0002',
    clientOrderId: CLIENT_ORDER_ID,
    ...overrides,
  };
}

function memoryFs(initialText = null, mode = 0o600) {
  const files = new Map(initialText === null ? [] : [['probe.json', initialText]]);
  const calls = [];
  return {
    calls,
    files,
    existsSync(file) { return files.has(file); },
    readFileSync(file) {
      if (!files.has(file)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    writeFileSync(file, text, options) {
      calls.push(['write', file, options]);
      files.set(file, text);
    },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
    chmodSync(file, exactMode) { calls.push(['chmod', file, exactMode]); },
    statSync() { return { mode }; },
    unlinkSync(file) { calls.push(['unlink', file]); files.delete(file); },
  };
}

test('journal create atomically writes an owner-only PREPARED record', () => {
  const fsImpl = memoryFs();
  const journal = new PopdexWriteJournal({
    file: 'probe.json',
    fsImpl,
    platform: 'linux',
    now: () => 1786946400000,
  });
  const record = journal.create(orderPlan());

  assert.equal(record.stage, 'PREPARED');
  assert.equal(record.clientOrderId, CLIENT_ORDER_ID);
  assert.equal(record.updatedAt, '2026-08-17T06:00:00.000Z');
  assert.deepEqual(fsImpl.calls, [
    ['write', 'probe.json.tmp', { encoding: 'utf8', mode: 0o600 }],
    ['rename', 'probe.json.tmp', 'probe.json'],
    ['chmod', 'probe.json', 0o600],
  ]);
  const persisted = JSON.parse(fsImpl.files.get('probe.json'));
  assert.deepEqual(Object.keys(persisted).sort(), [
    'cancelTxHash', 'clientOrderId', 'lastError', 'orderId', 'placeTxHash',
    'price', 'qty', 'recoveredFromChain', 'side', 'stage', 'symbol', 'updatedAt', 'version',
  ]);
  assert.doesNotMatch(fsImpl.files.get('probe.json'), /private|secret|signature|serialized/i);
});

test('journal advances only through exact one-way stages and required fields', () => {
  const fsImpl = memoryFs();
  let now = 1786946400000;
  const journal = new PopdexWriteJournal({
    file: 'probe.json', fsImpl, platform: 'linux', now: () => now,
  });
  journal.create(orderPlan());
  now += 1;
  assert.equal(
    journal.advance('PREPARED', 'BROADCAST', { placeTxHash: PLACE_TX_HASH }).stage,
    'BROADCAST',
  );
  assert.throws(
    () => journal.advance('BROADCAST', 'CANCEL_BROADCAST', { cancelTxHash: CANCEL_TX_HASH }),
    /阶段转换/,
  );
  assert.throws(() => journal.advance('PREPARED', 'OPEN_CONFIRMED', {}), /当前阶段/);
  assert.throws(() => journal.advance('BROADCAST', 'OPEN_CONFIRMED', {}), /orderId/);
  assert.equal(
    journal.advance('BROADCAST', 'OPEN_CONFIRMED', { orderId: '90071992547409931234' }).stage,
    'OPEN_CONFIRMED',
  );
  assert.throws(
    () => journal.advance('OPEN_CONFIRMED', 'CANCEL_BROADCAST', { cancelTxHash: '0x12' }),
    /cancelTxHash/,
  );
  journal.advance('OPEN_CONFIRMED', 'CANCEL_BROADCAST', { cancelTxHash: CANCEL_TX_HASH });
  journal.advance('CANCEL_BROADCAST', 'CANCEL_CONFIRMED');
  assert.equal(journal.load().stage, 'CANCEL_CONFIRMED');
});

test('journal records a bounded sanitized error without changing stage', () => {
  const fsImpl = memoryFs();
  const journal = new PopdexWriteJournal({ file: 'probe.json', fsImpl, platform: 'linux' });
  journal.create(orderPlan());
  const record = journal.recordError('PREPARED', `RPC failed\n${'x'.repeat(800)}`);
  assert.equal(record.stage, 'PREPARED');
  assert.ok(record.lastError.length <= 500);
  assert.doesNotMatch(record.lastError, /[\r\n]/);
});

test('journal refuses overwrite, unknown fields, secrets and insecure POSIX permissions', () => {
  const fsImpl = memoryFs();
  const journal = new PopdexWriteJournal({ file: 'probe.json', fsImpl, platform: 'linux' });
  journal.create(orderPlan());
  assert.throws(() => journal.create(orderPlan()), /已有.*恢复记录/);
  assert.throws(
    () => journal.create(orderPlan({ agentPrivateKey: '0xsecret' })),
    /未知字段.*agentPrivateKey/,
  );

  const unknown = JSON.parse(fsImpl.files.get('probe.json'));
  unknown.agentPrivateKey = '0xsecret';
  const insecureFs = memoryFs(JSON.stringify(unknown), 0o644);
  const insecure = new PopdexWriteJournal({ file: 'probe.json', fsImpl: insecureFs, platform: 'linux' });
  assert.throws(() => insecure.load(), /权限.*0600/);

  const secureUnknownFs = memoryFs(JSON.stringify(unknown), 0o600);
  const secureUnknown = new PopdexWriteJournal({ file: 'probe.json', fsImpl: secureUnknownFs, platform: 'linux' });
  assert.throws(() => secureUnknown.load(), /未知字段.*agentPrivateKey/);
});

test('journal validates corrupt records and never converts them to empty state', () => {
  assert.throws(
    () => new PopdexWriteJournal({
      file: 'probe.json', fsImpl: memoryFs('{broken'), platform: 'win32',
    }).load(),
    /JSON.*解析失败/,
  );
  const validFs = memoryFs();
  new PopdexWriteJournal({ file: 'probe.json', fsImpl: validFs, platform: 'win32' })
    .create(orderPlan());
  const invalidRecord = JSON.parse(validFs.files.get('probe.json'));
  invalidRecord.stage = 'UNKNOWN';
  const invalid = JSON.stringify(invalidRecord);
  assert.throws(
    () => new PopdexWriteJournal({
      file: 'probe.json', fsImpl: memoryFs(invalid), platform: 'win32',
    }).load(),
    /stage/,
  );
});

test('journal clearCompleted deletes only a confirmed cancellation', () => {
  const fsImpl = memoryFs();
  const journal = new PopdexWriteJournal({ file: 'probe.json', fsImpl, platform: 'linux' });
  journal.create(orderPlan());
  assert.throws(() => journal.clearCompleted(), /CANCEL_CONFIRMED/);
  journal.advance('PREPARED', 'BROADCAST', { placeTxHash: PLACE_TX_HASH });
  journal.advance('BROADCAST', 'OPEN_CONFIRMED', { orderId: '1' });
  journal.advance('OPEN_CONFIRMED', 'CANCEL_BROADCAST', { cancelTxHash: CANCEL_TX_HASH });
  journal.advance('CANCEL_BROADCAST', 'CANCEL_CONFIRMED');
  journal.clearCompleted();
  assert.equal(journal.load(), null);
  assert.deepEqual(fsImpl.calls.at(-1), ['unlink', 'probe.json']);
});

test('journal marks a zero-fill manual cancellation as chain-recovered without a fake txHash', () => {
  const fsImpl = memoryFs();
  const journal = new PopdexWriteJournal({ file: 'probe.json', fsImpl, platform: 'linux' });
  journal.create(orderPlan());
  journal.advance('PREPARED', 'BROADCAST', { placeTxHash: PLACE_TX_HASH });
  const recovered = journal.completeFromChain('90071992547409931234');
  assert.equal(recovered.stage, 'CANCEL_CONFIRMED');
  assert.equal(recovered.orderId, '90071992547409931234');
  assert.equal(recovered.cancelTxHash, null);
  assert.equal(recovered.recoveredFromChain, true);
  journal.clearCompleted();

  const prepared = new PopdexWriteJournal({ file: 'other.json', fsImpl, platform: 'linux' });
  prepared.create(orderPlan({ clientOrderId: `0x${'99'.repeat(32)}` }));
  assert.throws(() => prepared.completeFromChain('1'), /PREPARED.*链上完成/);
});

test('journal clears only PREPARED records that have no broadcast evidence', () => {
  const fsImpl = memoryFs();
  const journal = new PopdexWriteJournal({ file: 'probe.json', fsImpl, platform: 'linux' });
  journal.create(orderPlan());
  journal.clearPrepared();
  assert.equal(journal.load(), null);

  journal.create(orderPlan());
  journal.advance('PREPARED', 'BROADCAST', { placeTxHash: PLACE_TX_HASH });
  assert.throws(() => journal.clearPrepared(), /PREPARED/);
  assert.equal(journal.load().stage, 'BROADCAST');
});

test('journal clears only a BROADCAST placement with the exact reverted transaction hash', () => {
  const fsImpl = memoryFs();
  const journal = new PopdexWriteJournal({ file: 'probe.json', fsImpl, platform: 'linux' });
  journal.create(orderPlan());
  journal.advance('PREPARED', 'BROADCAST', { placeTxHash: PLACE_TX_HASH });

  assert.throws(
    () => journal.clearRevertedPlacement(`0x${'78'.repeat(32)}`),
    /placeTxHash.*不匹配/,
  );
  assert.equal(journal.load().stage, 'BROADCAST');

  journal.clearRevertedPlacement(PLACE_TX_HASH);
  assert.equal(journal.load(), null);
  assert.deepEqual(fsImpl.calls.at(-1), ['unlink', 'probe.json']);
});

test('journal never clears a reverted transaction from a stage other than BROADCAST', () => {
  const fsImpl = memoryFs();
  const journal = new PopdexWriteJournal({ file: 'probe.json', fsImpl, platform: 'linux' });
  journal.create(orderPlan());
  assert.throws(() => journal.clearRevertedPlacement(PLACE_TX_HASH), /BROADCAST/);
  assert.equal(journal.load().stage, 'PREPARED');
});
