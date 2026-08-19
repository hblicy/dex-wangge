import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeBytes32String, parseUnits } from 'ethers';
import { PopdexOwnershipStore } from '../src/exchange/px/ownership-store.js';

const FILE = 'ownership.json';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const CLIENT_ID = encodeBytes32String('dw-bb-111111111111111111111111').toLowerCase();
const EVENT_ID = `px-fill-${'12'.repeat(32)}`;

function memoryFs(initial = null, mode = 0o600, failures = {}) {
  const files = new Map(initial === null ? [] : [[FILE, typeof initial === 'string' ? initial : JSON.stringify(initial)]]);
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
      calls.push(['unlink', file]);
      files.delete(file);
    },
  };
}

function createStore(fsImpl = memoryFs(), overrides = {}) {
  return new PopdexOwnershipStore({
    file: FILE,
    mainAccount: ACCOUNT,
    fsImpl,
    platform: 'linux',
    now: () => 1786946400000,
    ...overrides,
  });
}

function ownedOrder(overrides = {}) {
  return {
    orderId: '123',
    clientOrderId: CLIENT_ID,
    marketId: 20000,
    levelIndex: 0,
    side: 'buy',
    priceWad: parseUnits('60000', 18).toString(),
    qtyWad: parseUnits('0.0002', 18).toString(),
    opening: true,
    reduceOnly: false,
    parentFillEventId: null,
    state: 'OPEN',
    filledQtyWad: '0',
    fillIds: [],
    terminalEvent: null,
    ...overrides,
  };
}

function terminalResult(overrides = {}) {
  return {
    state: 'FILLED',
    filledQtyWad: parseUnits('0.0002', 18).toString(),
    event: {
      fillEventId: EVENT_ID,
      terminalState: 'FILLED',
      filledQtyWad: parseUnits('0.0002', 18).toString(),
      priceWad: parseUnits('60100', 18).toString(),
      fillIds: ['9'],
      suppressRequote: false,
    },
    ...overrides,
  };
}

test('ownership store persists exact order and pending event atomically', () => {
  const fsImpl = memoryFs();
  const store = createStore(fsImpl);
  store.upsertOrder(ownedOrder());
  store.applyResult('123', terminalResult());

  const loaded = store.load();
  assert.equal(loaded.mainAccount, ACCOUNT);
  assert.equal(loaded.orders[0].terminalEvent.stage, 'EVENT_PENDING');
  assert.equal(loaded.orders[0].terminalEvent.fillEventId, EVENT_ID);
  assert.deepEqual(fsImpl.calls.filter(([kind]) => kind === 'write').at(-1), [
    'write', `${FILE}.tmp`, { encoding: 'utf8', mode: 0o600 },
  ]);
  assert.deepEqual(fsImpl.calls.filter(([kind]) => kind === 'rename').at(-1), [
    'rename', `${FILE}.tmp`, FILE,
  ]);
});

test('event transitions are monotonic and completed events cannot replay', () => {
  const store = createStore();
  store.upsertOrder(ownedOrder());
  store.applyResult('123', terminalResult());
  assert.deepEqual(store.pendingEvents().map((event) => event.fillEventId), [EVENT_ID]);

  store.markReplacementConfirmed(EVENT_ID, '456');
  assert.equal(store.pendingEvents()[0].stage, 'REPLACEMENT_CONFIRMED');
  store.completeEvent(EVENT_ID);
  assert.deepEqual(store.pendingEvents(), []);
  assert.throws(() => store.markReplacementConfirmed(EVENT_ID, '789'), /已完成/);
  assert.throws(() => store.completeEvent(EVENT_ID), /已完成/);
});

test('suppressed events complete without replacement and normal events cannot use that path', () => {
  const suppressed = createStore();
  suppressed.upsertOrder(ownedOrder());
  suppressed.applyResult('123', terminalResult({
    event: { ...terminalResult().event, suppressRequote: true },
  }));
  suppressed.completeSuppressedEvent(EVENT_ID);
  assert.deepEqual(suppressed.pendingEvents(), []);

  const normal = createStore();
  normal.upsertOrder(ownedOrder());
  normal.applyResult('123', terminalResult());
  assert.throws(() => normal.completeSuppressedEvent(EVENT_ID), /不是 suppression/);
  assert.throws(() => normal.completeEvent(EVENT_ID), /尚未确认补单/);
});

test('ownership store rejects schema drift duplicate identities and account mismatch', () => {
  const store = createStore();
  assert.throws(() => store.upsertOrder({ ...ownedOrder(), secret: 'x' }), /未知字段 secret/);
  store.upsertOrder(ownedOrder());
  assert.throws(() => store.upsertOrder(ownedOrder({ orderId: '124' })), /clientOrderId.*重复/);
  assert.throws(() => store.upsertOrder(ownedOrder({ clientOrderId: encodeBytes32String('dw-bb-222222222222222222222222') })), /orderId.*冲突/);

  const parsed = store.load();
  parsed.mainAccount = '0x2222222222222222222222222222222222222222';
  assert.throws(() => createStore(memoryFs(parsed)).load(), /mainAccount.*不匹配/);
  parsed.mainAccount = ACCOUNT;
  parsed.unknown = true;
  assert.throws(() => createStore(memoryFs(parsed)).load(), /未知字段 unknown/);
});

test('ownership store fails on malformed JSON and non-0600 POSIX permissions', () => {
  assert.throws(() => createStore(memoryFs('{broken')).load(), /JSON.*解析失败/);
  const valid = createStore().load();
  assert.throws(() => createStore(memoryFs(valid, 0o644)).load(), /权限必须是 0600/);
});

test('write or rename failure preserves the last durable snapshot', () => {
  const seedFs = memoryFs();
  const seed = createStore(seedFs);
  seed.upsertOrder(ownedOrder());
  const original = seedFs.files.get(FILE);

  const writeFs = memoryFs(original, 0o600, { write: new Error('disk full') });
  assert.throws(() => createStore(writeFs).applyResult('123', terminalResult()), /写入失败.*disk full/);
  assert.equal(writeFs.files.get(FILE), original);

  const renameFs = memoryFs(original, 0o600, { rename: new Error('rename denied') });
  assert.throws(() => createStore(renameFs).applyResult('123', terminalResult()), /写入失败.*rename denied/);
  assert.equal(renameFs.files.get(FILE), original);
});

test('settled orders are removable only after their terminal event is complete', () => {
  const store = createStore();
  store.upsertOrder(ownedOrder());
  assert.throws(() => store.removeSettled('123'), /尚未结算/);
  store.applyResult('123', terminalResult());
  assert.throws(() => store.removeSettled('123'), /事件尚未完成/);
  store.markReplacementConfirmed(EVENT_ID, '456');
  store.completeEvent(EVENT_ID);
  store.removeSettled('123');
  assert.deepEqual(store.listOrders(), []);
});

test('existing ownership and terminal event facts cannot be overwritten or reinterpreted', () => {
  const store = createStore();
  store.upsertOrder(ownedOrder());
  store.applyResult('123', terminalResult());

  assert.throws(() => store.upsertOrder(ownedOrder()), /已有订单.*拒绝覆盖/);
  assert.throws(() => store.applyResult('123', terminalResult({
    event: { ...terminalResult().event, suppressRequote: true },
  })), /终态事件事实冲突/);
});

test('partial reconciliation persists exact fill IDs for restart deduplication', () => {
  const store = createStore();
  store.upsertOrder(ownedOrder());
  store.applyResult('123', {
    state: 'PARTIAL',
    event: null,
    filledQtyWad: '80',
    fillIds: ['7'],
  });
  assert.equal(store.listOrders()[0].filledQtyWad, '80');
  assert.deepEqual(store.listOrders()[0].fillIds, ['7']);
});
