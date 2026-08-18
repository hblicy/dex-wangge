import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildBtcLongThreeGridPlan,
  parseGridProbeArgs,
  runGridProbe,
} from '../src/exchange/px/grid-probe.js';

function fakePreflight(overrides = {}) {
  return async () => ({
    mainAccount: '0x1111111111111111111111111111111111111111',
    mark: 63000.5,
    market: {
      marketId: 20000,
      name: 'BTCUSDT',
      displayName: 'BTCUSDT',
      symbol: 'BTC',
      stepPrice: 1,
      stepSize: 0.0001,
      minOrderSize: 0.0001,
      minNotional: 10,
    },
    openOrders: [],
    positions: [],
    availableMargin: 799,
    ...overrides,
  });
}

class FakeStrictAdapter extends EventEmitter {
  constructor() {
    super();
    this.strictOrderRecovery = true;
    this.requiresDurableFillAck = true;
    this.state = 'READY';
    this.equity = 799;
    this.orders = new Map();
    this.pending = new Map();
    this.sequence = 0;
    this.placeCalls = 0;
    this.cancelCalls = 0;
    this.closeCalls = 0;
    this.reconcileFailure = null;
    this.position = null;
    this.released = new Set();
  }

  async init() { return this; }
  start() {}
  stop() {}
  async getMarkets() { return [(await fakePreflight()()).market]; }
  async getPrice() { return 63000.5; }
  async setLeverage(_marketId, leverage) { assert.equal(leverage, 1); return true; }
  async placeLimitOrder(input) {
    this.placeCalls++;
    const orderId = String(++this.sequence);
    const order = {
      orderId,
      clientOrderId: `0x${this.sequence.toString(16).padStart(64, '0')}`,
      marketId: input.marketId,
      side: input.side,
      price: input.price,
      sizeBase: input.sizeBase,
      reduceOnly: input.reduceOnly,
      levelIndex: input.levelIndex,
      opening: input.opening,
      parentFillEventId: input.parentFillEventId,
    };
    this.orders.set(orderId, order);
    return structuredClone(order);
  }
  async cancelAll() { this.cancelCalls++; this.orders.clear(); return true; }
  async closePosition() { this.closeCalls++; this.position = null; return true; }
  getPosition() { return this.position === null ? null : structuredClone(this.position); }
  getOpenOrders() { return [...this.orders.values()].map((order) => structuredClone(order)); }
  pendingFillEvents() { return [...this.pending.values()].map((event) => structuredClone(event)); }
  async recoverOwnedOrders() { return this.reconcileOwnedOrders(); }
  async reconcileOwnedOrders() {
    if (this.reconcileFailure) {
      this.state = 'RECONCILING';
      throw this.reconcileFailure;
    }
    this.state = 'READY';
    return {
      status: 'READY',
      activeOrders: this.getOpenOrders(),
      pendingEvents: this.pendingFillEvents(),
      positions: this.position === null ? [] : [structuredClone(this.position)],
      diagnostics: {},
    };
  }
  releaseRecoveredEvents() {
    for (const event of this.pending.values()) {
      if (this.released.has(event.fillEventId)) continue;
      this.released.add(event.fillEventId);
      this.emit('fill', structuredClone(event));
    }
  }
  acknowledgeFillEvent(fillEventId, replacementOrderId) {
    const event = this.pending.get(fillEventId);
    if (!event) throw new Error('missing event');
    if (!event.suppressRequote) {
      const replacement = this.orders.get(String(replacementOrderId));
      if (replacement?.parentFillEventId !== fillEventId) throw new Error('replacement mismatch');
    }
    this.pending.delete(fillEventId);
  }
  haltFromBot(error) { this.state = 'HALTED'; this.haltReason = error.message; }
  async reconnect() { this.reconcileFailure = null; return this.reconcileOwnedOrders(); }
  getHealth() { return { state: this.state, status: this.state === 'READY' ? 'ok' : 'error' }; }
  terminalFill(orderId, { offline = false } = {}) {
    const order = this.orders.get(String(orderId));
    this.orders.delete(String(orderId));
    const fillEventId = `px-fill-${String(orderId).padStart(64, 'a').slice(-64)}`;
    this.pending.set(fillEventId, {
      fillEventId,
      stage: 'EVENT_PENDING',
      terminalState: 'FILLED',
      filledQtyWad: '200000000000000',
      priceWad: String(BigInt(Math.round(order.price)) * 10n ** 18n),
      fillIds: [String(orderId)],
      suppressRequote: false,
      replacementOrderId: null,
      ...structuredClone(order),
      price: order.price,
      sizeBase: order.sizeBase,
    });
    this.position = { sizeBase: order.sizeBase, entryPrice: order.price };
    if (!offline) this.releaseRecoveredEvents();
    return fillEventId;
  }
}

function temporaryFiles(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popdex-grid-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return Object.fromEntries(['state', 'ownership', 'operation', 'lock']
    .map((name) => [name, path.join(directory, `${name}.json`)]));
}

test('grid probe defaults to read-only preflight', async () => {
  const result = await runGridProbe({
    argv: [],
    deps: {
      preflight: fakePreflight(),
      inspectProbeFacts: () => ({ state: false, ownership: false, operation: false }),
    },
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.writes, 0);
  assert.equal(result.plan.marketId, 20000);
  assert.equal(result.plan.mode, 'long');
  assert.equal(result.plan.gridCount, 3);
  assert.equal(result.plan.leverage, 1);
});

test('mainnet grid is fixed to BTC long three grids one leverage', async () => {
  const deps = { preflight: fakePreflight() };
  await assert.rejects(
    runGridProbe({ argv: ['--mode', 'neutral', '--confirm-mainnet-grid'], deps }),
    /只允许做多/,
  );
  await assert.rejects(
    runGridProbe({ argv: ['--grids', '4', '--confirm-mainnet-grid'], deps }),
    /固定为 3/,
  );
  await assert.rejects(
    runGridProbe({ argv: ['--leverage', '2', '--confirm-mainnet-grid'], deps }),
    /固定为 1x/,
  );
});

test('BTC long three-grid plan enforces tick bounds and 10-15 USDT per order', () => {
  const plan = buildBtcLongThreeGridPlan({
    mark: 63050.5,
    lower: 63000,
    upper: 63300,
    sizeBase: 0.0002,
  });
  assert.deepEqual(plan.levels, [63000, 63100, 63200, 63300]);
  assert.equal(plan.seed.price, 63000);
  assert.equal(plan.seed.side, 'buy');
  assert.equal(plan.seed.opening, true);
  assert.equal(plan.gridCount, 3);
  assert.throws(
    () => buildBtcLongThreeGridPlan({ mark: 63050.5, lower: 62900.5, upper: 63200, sizeBase: 0.0002 }),
    /tick/,
  );
  assert.throws(
    () => buildBtcLongThreeGridPlan({ mark: 63050.5, lower: 63000, upper: 63300, sizeBase: 0.001 }),
    /10-15 USDT/,
  );
});

test('new mainnet grid rejects external BTC orders positions and unfinished probe facts', async () => {
  const base = ['--confirm-mainnet-grid'];
  await assert.rejects(runGridProbe({
    argv: base,
    deps: {
      preflight: fakePreflight({ openOrders: [{ orderId: 'external' }] }),
      inspectProbeFacts: () => ({ state: false, ownership: false, operation: false }),
    },
  }), /外部挂单/);
  await assert.rejects(runGridProbe({
    argv: base,
    deps: {
      preflight: fakePreflight({ positions: [{ sizeBase: 0.0002 }] }),
      inspectProbeFacts: () => ({ state: false, ownership: false, operation: false }),
    },
  }), /外部持仓/);
  await assert.rejects(runGridProbe({
    argv: base,
    deps: {
      preflight: fakePreflight(),
      inspectProbeFacts: () => ({ state: true, ownership: false, operation: false }),
    },
  }), /只能使用 --resume/);
});

test('argument parser keeps resume exclusive from a new mainnet start', () => {
  assert.deepEqual(parseGridProbeArgs([]), {
    lower: null,
    upper: null,
    sizeBase: 0.0002,
    mode: 'long',
    grids: 3,
    leverage: 1,
    confirmMainnetGrid: false,
    resume: false,
  });
  assert.throws(
    () => parseGridProbeArgs(['--resume', '--confirm-mainnet-grid']),
    /互斥/,
  );
  assert.throws(() => parseGridProbeArgs(['--unknown']), /不支持参数/);
});

test('mainnet probe handles one fill, offline resume, reconnect and verified stop', async (t) => {
  const files = temporaryFiles(t);
  const adapter = new FakeStrictAdapter();
  const common = {
    env: { POPDEX_AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}` },
    deps: {
      preflight: fakePreflight(),
      createLiveExchange: () => adapter,
      interactive: false,
      files,
      output() {},
    },
  };
  const started = await runGridProbe({ argv: ['--confirm-mainnet-grid'], ...common });
  assert.equal(adapter.placeCalls, 1);
  assert.equal(adapter.orders.size, 1);
  const seedOrderId = [...adapter.orders.keys()][0];
  adapter.terminalFill(seedOrderId);
  await started.session.bot._fillQueue;
  assert.equal(adapter.placeCalls, 2);
  assert.equal(adapter.pending.size, 0);
  const firstReplacement = [...adapter.orders.values()][0];
  assert.equal(firstReplacement.side, 'sell');
  assert.equal(firstReplacement.reduceOnly, true);

  const cancelsBeforeSignal = adapter.cancelCalls;
  started.session.signalExit('SIGTERM');
  assert.equal(adapter.cancelCalls, cancelsBeforeSignal);
  assert.equal(adapter.closeCalls, 0);
  assert.equal(adapter.listenerCount('fill'), 0);

  const replacementId = firstReplacement.orderId;
  adapter.terminalFill(replacementId, { offline: true });
  adapter.position = null;
  const resumed = await runGridProbe({ argv: ['--resume'], ...common });
  await resumed.session.bot._fillQueue;
  assert.equal(adapter.placeCalls, 3);
  assert.equal(adapter.pending.size, 0);
  await resumed.session.bot.reconcileOpenOrders();
  adapter.releaseRecoveredEvents();
  await resumed.session.bot._fillQueue;
  assert.equal(adapter.placeCalls, 3);

  adapter.reconcileFailure = new Error('fetch failed');
  await assert.rejects(resumed.session.bot.reconcileOpenOrders(), /fetch failed/);
  assert.equal(adapter.state, 'RECONCILING');
  await resumed.session.executeCommand('reconnect');
  assert.equal(adapter.state, 'READY');

  const stopped = await resumed.session.executeCommand('stop');
  assert.deepEqual(stopped, { status: 'stopped-flat' });
  assert.equal(adapter.orders.size, 0);
  assert.equal(adapter.position, null);
  assert.equal(fs.existsSync(files.state), false);
  assert.equal(fs.existsSync(files.lock), false);
});

test('probe lock rejects a live PID and replaces a stale PID only after preflight', async (t) => {
  const files = temporaryFiles(t);
  fs.writeFileSync(files.lock, JSON.stringify({
    pid: process.pid,
    mainAccount: '0x1111111111111111111111111111111111111111',
    startedAt: new Date().toISOString(),
  }));
  await assert.rejects(runGridProbe({
    argv: ['--confirm-mainnet-grid'],
    env: { POPDEX_AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}` },
    deps: {
      preflight: fakePreflight(),
      createLiveExchange: () => new FakeStrictAdapter(),
      interactive: false,
      files,
      output() {},
    },
  }), /已有活动实例/);

  fs.writeFileSync(files.lock, JSON.stringify({
    pid: 999999,
    mainAccount: '0x1111111111111111111111111111111111111111',
    startedAt: new Date().toISOString(),
  }));
  let preflightCalls = 0;
  const adapter = new FakeStrictAdapter();
  const started = await runGridProbe({
    argv: ['--confirm-mainnet-grid'],
    env: { POPDEX_AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}` },
    deps: {
      preflight: async (...args) => { preflightCalls++; return fakePreflight()(...args); },
      processKill() { const error = new Error('missing'); error.code = 'ESRCH'; throw error; },
      createLiveExchange: () => adapter,
      interactive: false,
      files,
      output() {},
    },
  });
  assert.equal(preflightCalls, 1);
  assert.equal(fs.existsSync(files.lock), true);
  await started.session.executeCommand('stop');
});
