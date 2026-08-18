import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexFillCloseJournal } from '../src/exchange/px/fill-close-journal.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';
const CLIENT_ORDER_ID = `0x${'12'.repeat(32)}`;
const HASH = (byte) => `0x${byte.repeat(64)}`;

function initial(overrides = {}) {
  return {
    mainAccount: ACCOUNT,
    agentAddress: AGENT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    positionMode: '0',
    leverage: '1',
    priceWad: '63189000000000000000000',
    qtyWad: '200000000000000',
    clientOrderId: CLIENT_ORDER_ID,
    ...overrides,
  };
}

function memoryFs(initialText = null, mode = 0o600) {
  const files = new Map(initialText === null ? [] : [['probe.json', initialText]]);
  const calls = [];
  return {
    files,
    calls,
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

function journal(fsImpl = memoryFs()) {
  return new PopdexFillCloseJournal({
    file: 'probe.json',
    fsImpl,
    platform: 'linux',
    now: () => 1787032800000,
  });
}

test('fill-close journal atomically persists only the strict PREPARED schema', () => {
  const fsImpl = memoryFs();
  const target = journal(fsImpl);
  const record = target.create(initial());
  assert.equal(record.stage, 'PREPARED');
  assert.equal(record.updatedAt, '2026-08-18T06:00:00.000Z');
  assert.deepEqual(fsImpl.calls, [
    ['write', 'probe.json.tmp', { encoding: 'utf8', mode: 0o600 }],
    ['rename', 'probe.json.tmp', 'probe.json'],
    ['chmod', 'probe.json', 0o600],
  ]);
  assert.doesNotMatch(fsImpl.files.get('probe.json'), /private|secret|signature|serialized/i);
  assert.throws(() => target.create(initial()), /已有.*恢复记录/);
});

test('fill-close journal supports the full-fill close path with required evidence', () => {
  const target = journal();
  target.create(initial());
  target.advance('PREPARED', 'LEVERAGE_CONFIRMED');
  target.advance('LEVERAGE_CONFIRMED', 'ENTRY_BROADCAST', { entryTxHash: HASH('2') });
  target.advance('ENTRY_BROADCAST', 'ENTRY_SETTLING', { orderId: '9' });
  target.advance('ENTRY_SETTLING', 'POSITION_CONFIRMED', {
    filledQtyWad: '200000000000000',
    remainingQtyWad: '0',
    positionId: '7',
    positionQtyWad: '200000000000000',
  });
  target.advance('POSITION_CONFIRMED', 'CLOSE_BROADCAST', { closeTxHash: HASH('4') });
  const completed = target.advance('CLOSE_BROADCAST', 'COMPLETED', {
    outcome: 'completed-flat',
    positionQtyWad: '0',
  });
  assert.equal(completed.outcome, 'completed-flat');
  target.clearCompleted();
  assert.equal(target.load(), null);
});

test('fill-close journal supports leverage and zero-fill cancellation branches', () => {
  const target = journal();
  target.create(initial());
  target.advance('PREPARED', 'LEVERAGE_BROADCAST', { leverageTxHash: HASH('1') });
  target.advance('LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED');
  target.advance('LEVERAGE_CONFIRMED', 'ENTRY_BROADCAST', { entryTxHash: HASH('2') });
  target.advance('ENTRY_BROADCAST', 'ENTRY_SETTLING', { orderId: '9' });
  target.advance('ENTRY_SETTLING', 'REMAINDER_CANCEL_BROADCAST', {
    cancelTxHash: HASH('3'),
  });
  assert.equal(target.advance('REMAINDER_CANCEL_BROADCAST', 'COMPLETED', {
    outcome: 'zero-fill-cleared',
    filledQtyWad: '0',
    remainingQtyWad: '0',
  }).stage, 'COMPLETED');
});

test('safe-no-exposure is limited to pre-entry or an exact failed entry receipt', () => {
  for (const stage of ['PREPARED', 'LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED']) {
    const target = journal();
    target.create(initial());
    if (stage === 'LEVERAGE_BROADCAST') {
      target.advance('PREPARED', stage, { leverageTxHash: HASH('1') });
    }
    if (stage === 'LEVERAGE_CONFIRMED') target.advance('PREPARED', stage);
    assert.equal(target.advance(stage, 'COMPLETED', {
      outcome: 'safe-no-exposure',
    }).outcome, 'safe-no-exposure');
  }

  const broadcast = journal();
  broadcast.create(initial());
  broadcast.advance('PREPARED', 'LEVERAGE_CONFIRMED');
  broadcast.advance('LEVERAGE_CONFIRMED', 'ENTRY_BROADCAST', { entryTxHash: HASH('2') });
  assert.throws(() => broadcast.advance('ENTRY_BROADCAST', 'COMPLETED', {
    outcome: 'safe-no-exposure',
  }), /精确失败回执/);
  assert.equal(broadcast.completeFailedEntry(HASH('2')).outcome, 'safe-no-exposure');
});

test('fill-close journal rejects illegal transitions and missing stage facts', () => {
  const target = journal();
  target.create(initial());
  assert.throws(() => target.advance('PREPARED', 'ENTRY_BROADCAST', {
    entryTxHash: HASH('2'),
  }), /转换.*不允许/);
  assert.throws(() => target.advance('PREPARED', 'LEVERAGE_BROADCAST'), /leverageTxHash/);
  target.advance('PREPARED', 'LEVERAGE_CONFIRMED');
  assert.throws(() => target.advance('LEVERAGE_CONFIRMED', 'ENTRY_BROADCAST'), /entryTxHash/);
  target.advance('LEVERAGE_CONFIRMED', 'ENTRY_BROADCAST', { entryTxHash: HASH('2') });
  assert.throws(() => target.advance('ENTRY_BROADCAST', 'ENTRY_SETTLING'), /orderId/);
  assert.throws(() => target.advance('ENTRY_BROADCAST', 'COMPLETED', {
    outcome: 'unknown',
  }), /outcome/);
});

test('fill-close journal rejects unknown fields secrets corrupt JSON and insecure mode', () => {
  assert.throws(() => journal().create(initial({ agentPrivateKey: '0xsecret' })), /未知字段/);
  const target = journal();
  target.create(initial());
  assert.throws(() => target.advance('PREPARED', 'LEVERAGE_CONFIRMED', {
    privateKey: 'secret',
  }), /未知字段/);

  assert.throws(() => new PopdexFillCloseJournal({
    file: 'probe.json',
    fsImpl: memoryFs('{broken'),
    platform: 'win32',
  }).load(), /JSON.*解析失败/);

  const insecureText = JSON.stringify(target.load());
  assert.throws(() => new PopdexFillCloseJournal({
    file: 'probe.json',
    fsImpl: memoryFs(insecureText, 0o644),
    platform: 'linux',
  }).load(), /权限.*0600/);
});

test('fill-close journal records bounded errors and clears only COMPLETED', () => {
  const target = journal();
  target.create(initial());
  const errored = target.recordError('PREPARED', `failed\n${'x'.repeat(800)}`);
  assert.equal(errored.stage, 'PREPARED');
  assert.ok(errored.lastError.length <= 500);
  assert.doesNotMatch(errored.lastError, /[\r\n]/);
  assert.throws(() => target.clearCompleted(), /COMPLETED/);
});
