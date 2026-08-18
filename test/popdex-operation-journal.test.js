import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexOperationJournal } from '../src/exchange/px/operation-journal.js';

const MAIN = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';
const CLIENT_ID = `0x${'12'.repeat(32)}`;
const CLOSE_CLIENT_ID = `0x${'34'.repeat(32)}`;
const TX_HASH = `0x${'56'.repeat(32)}`;

function memoryFs(initialText = null, mode = 0o600, failures = {}) {
  const files = new Map(initialText === null ? [] : [['operation.json', initialText]]);
  const calls = [];
  return {
    calls,
    files,
    readFileSync(file) {
      if (failures.read) throw failures.read;
      if (!files.has(file)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    writeFileSync(file, text, options) {
      if (failures.write) throw failures.write;
      calls.push(['write', file, options]);
      files.set(file, text);
    },
    renameSync(from, to) {
      if (failures.rename) throw failures.rename;
      calls.push(['rename', from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
    chmodSync(file, exactMode) { calls.push(['chmod', file, exactMode]); },
    statSync() {
      if (failures.stat) throw failures.stat;
      return { mode };
    },
    unlinkSync(file) {
      if (failures.unlink) throw failures.unlink;
      calls.push(['unlink', file]);
      files.delete(file);
    },
  };
}

function createJournal(fsImpl = memoryFs(), overrides = {}) {
  return new PopdexOperationJournal({
    file: 'operation.json',
    fsImpl,
    platform: 'linux',
    now: () => 1786946400000,
    ...overrides,
  });
}

function baseFacts(overrides = {}) {
  return {
    mainAccount: MAIN,
    agentAddress: AGENT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    ...overrides,
  };
}

function placeFacts(overrides = {}) {
  return baseFacts({
    kind: 'place',
    side: 'buy',
    price: '60000',
    qty: '0.0002',
    clientOrderId: CLIENT_ID,
    ...overrides,
  });
}

test('operation journal atomically persists one strict place lifecycle', () => {
  const fsImpl = memoryFs();
  const journal = createJournal(fsImpl);
  const prepared = journal.create(placeFacts());
  assert.equal(prepared.stage, 'PREPARED');
  assert.equal(prepared.updatedAt, '2026-08-17T06:00:00.000Z');
  journal.advance('PREPARED', 'BROADCAST', { txHash: TX_HASH });
  journal.advance('BROADCAST', 'CONFIRMED', { orderId: '90071992547409931234' });

  assert.equal(journal.load().stage, 'CONFIRMED');
  assert.deepEqual(fsImpl.calls.filter(([kind]) => kind === 'rename'), [
    ['rename', 'operation.json.tmp', 'operation.json'],
    ['rename', 'operation.json.tmp', 'operation.json'],
    ['rename', 'operation.json.tmp', 'operation.json'],
  ]);
  assert.deepEqual(fsImpl.calls.filter(([kind]) => kind === 'write'), [
    ['write', 'operation.json.tmp', { encoding: 'utf8', mode: 0o600 }],
    ['write', 'operation.json.tmp', { encoding: 'utf8', mode: 0o600 }],
    ['write', 'operation.json.tmp', { encoding: 'utf8', mode: 0o600 }],
  ]);
  assert.doesNotMatch(fsImpl.files.get('operation.json'), /private|secret|signature|serialized/i);
});

test('operation journal validates leverage cancel and close facts', () => {
  const leverage = createJournal();
  leverage.create(baseFacts({ kind: 'leverage', leverage: '1' }));
  leverage.advance('PREPARED', 'BROADCAST', { txHash: TX_HASH });
  assert.equal(leverage.advance('BROADCAST', 'CONFIRMED').stage, 'CONFIRMED');

  const cancel = createJournal();
  cancel.create(baseFacts({ kind: 'cancel', orderId: '9', clientOrderId: CLIENT_ID }));
  cancel.advance('PREPARED', 'BROADCAST', { txHash: TX_HASH });
  assert.equal(cancel.advance('BROADCAST', 'CONFIRMED').orderId, '9');

  const close = createJournal();
  close.create(baseFacts({
    kind: 'close',
    positionId: '10',
    qty: '0.0002',
    closeClientOrderId: CLOSE_CLIENT_ID,
  }));
  close.advance('PREPARED', 'BROADCAST', { txHash: TX_HASH });
  assert.equal(
    close.advance('BROADCAST', 'CONFIRMED', { closeOrderId: '11' }).closeOrderId,
    '11',
  );
});

test('operation journal rejects overwrite and clears only CONFIRMED', () => {
  const fsImpl = memoryFs();
  const journal = createJournal(fsImpl);
  journal.create(placeFacts());
  assert.throws(() => journal.create(placeFacts()), /已有未完成操作/);
  assert.throws(() => journal.clearConfirmed(), /只有 CONFIRMED/);
  journal.advance('PREPARED', 'BROADCAST', { txHash: TX_HASH });
  assert.throws(() => journal.clearConfirmed(), /只有 CONFIRMED/);
  journal.advance('BROADCAST', 'CONFIRMED', { orderId: '1' });
  journal.clearConfirmed();
  assert.equal(journal.load(), null);
  assert.deepEqual(fsImpl.calls.at(-1), ['unlink', 'operation.json']);
});

test('operation journal enforces exact transitions and required stage facts', () => {
  const journal = createJournal();
  journal.create(placeFacts());
  assert.throws(() => journal.advance('PREPARED', 'CONFIRMED', { orderId: '1' }), /转换/);
  assert.throws(() => journal.advance('PREPARED', 'BROADCAST'), /txHash/);
  journal.advance('PREPARED', 'BROADCAST', { txHash: TX_HASH });
  assert.throws(() => journal.advance('PREPARED', 'BROADCAST', { txHash: TX_HASH }), /当前阶段/);
  assert.throws(() => journal.advance('BROADCAST', 'CONFIRMED'), /orderId/);
});

test('operation journal completes only a PREPARED no-broadcast operation', () => {
  const journal = createJournal();
  journal.create(baseFacts({ kind: 'leverage', leverage: '1' }));
  const completed = journal.completePreparedWithoutBroadcast('safe-no-broadcast');
  assert.equal(completed.stage, 'CONFIRMED');
  assert.equal(completed.txHash, null);
  assert.equal(completed.outcome, 'safe-no-broadcast');

  const broadcast = createJournal();
  broadcast.create(placeFacts());
  broadcast.advance('PREPARED', 'BROADCAST', { txHash: TX_HASH });
  assert.throws(
    () => broadcast.completePreparedWithoutBroadcast('safe-no-broadcast'),
    /只有 PREPARED/,
  );

  const place = createJournal();
  place.create(placeFacts());
  assert.throws(
    () => place.completePreparedWithoutBroadcast('safe-no-broadcast'),
    /place.*不能无广播完成/,
  );
});

test('operation journal rejects unknown fields unsafe IDs malformed bytes32 and invalid kind facts', () => {
  assert.throws(() => createJournal().create(placeFacts({ agentPrivateKey: 'secret' })), /未知字段/);
  assert.throws(() => createJournal().create(placeFacts({ clientOrderId: '0x12' })), /clientOrderId/);
  assert.throws(() => createJournal().create(baseFacts({
    kind: 'cancel', orderId: '340282366920938463463374607431768211456', clientOrderId: CLIENT_ID,
  })), /uint128/);
  assert.throws(() => createJournal().create(baseFacts({
    kind: 'close', positionId: '0', qty: '0.0002', closeClientOrderId: CLOSE_CLIENT_ID,
  })), /positionId/);
  assert.throws(() => createJournal().create(baseFacts({
    kind: 'close', positionId: '1', qty: '0', closeClientOrderId: CLOSE_CLIENT_ID,
  })), /qty/);
  assert.throws(() => createJournal().create(placeFacts({
    qty: '0.0002000000000000001',
  })), /18 位小数/);
  assert.throws(() => createJournal().create(baseFacts({ kind: 'leverage', leverage: '2' })), /leverage/);
  assert.throws(() => createJournal().create(placeFacts({ symbol: 'ETHUSDT', symbolId: '20001' })), /只允许 BTCUSDT/);
});

test('operation journal records a bounded single-line error without changing stage', () => {
  const journal = createJournal();
  journal.create(placeFacts());
  const record = journal.recordError('PREPARED', `RPC failed\n${'x'.repeat(800)}`);
  assert.equal(record.stage, 'PREPARED');
  assert.ok(record.lastError.length <= 500);
  assert.doesNotMatch(record.lastError, /[\r\n]/);
  assert.throws(() => journal.recordError('BROADCAST', 'wrong'), /当前阶段/);
});

test('operation journal never hides read permission JSON or schema failures', () => {
  assert.throws(() => createJournal(memoryFs('{broken')).load(), /JSON.*解析失败/);
  assert.throws(() => createJournal(memoryFs('{}', 0o644)).load(), /权限.*0600/);
  assert.throws(
    () => createJournal(memoryFs('{}', 0o600), { platform: 'win32' }).load(),
    /record.*缺少字段|version/,
  );
  const denied = new Error('denied');
  denied.code = 'EACCES';
  assert.throws(() => createJournal(memoryFs(null, 0o600, { read: denied })).load(), /读取失败.*denied/);
});

test('operation journal surfaces write rename and unlink failures', () => {
  assert.throws(
    () => createJournal(memoryFs(null, 0o600, { write: new Error('disk full') })).create(placeFacts()),
    /写入失败.*disk full/,
  );
  assert.throws(
    () => createJournal(memoryFs(null, 0o600, { rename: new Error('rename denied') })).create(placeFacts()),
    /写入失败.*rename denied/,
  );

  const fsImpl = memoryFs();
  const journal = createJournal(fsImpl);
  journal.create(baseFacts({ kind: 'leverage', leverage: '1' }));
  journal.completePreparedWithoutBroadcast('safe-no-broadcast');
  fsImpl.unlinkSync = () => { throw new Error('unlink denied'); };
  assert.throws(() => journal.clearConfirmed(), /清理失败.*unlink denied/);
});
