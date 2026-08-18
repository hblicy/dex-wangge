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

function liveJournal(flow) {
  let record = null;
  return {
    get record() { return record; },
    create(value) {
      assert.equal(record, null);
      record = { ...value, stage: 'PREPARED', lastError: null };
      flow.push('journal:create');
      return record;
    },
    load() { return record; },
    advance(expected, next, fields = {}) {
      assert.equal(record.stage, expected);
      record = { ...record, ...fields, stage: next, lastError: null };
      flow.push(`journal:${next}`);
      return record;
    },
    recordError(expected, error) {
      assert.equal(record.stage, expected);
      record = { ...record, lastError: String(error?.message ?? error) };
      flow.push(`journal:error:${expected}`);
      return record;
    },
    clearCompleted() {
      assert.equal(record.stage, 'COMPLETED');
      flow.push('journal:clear');
      record = null;
    },
  };
}

function liveDependencies({
  kind = 'full',
  initialLeverage = '1',
  residualAfterClose = false,
  entryFailure = null,
} = {}) {
  const flow = [];
  const deps = dependencies({ leverage: initialLeverage });
  const journal = liveJournal(flow);
  let phase = 'initial';
  let entryCalls = 0;
  let cancelCalls = 0;
  let closeCalls = 0;
  let leverageCalls = 0;
  const order = () => {
    const cancelled = phase === 'cancelled';
    const filledQty = kind === 'full' ? '0.0002' : kind === 'partial' ? '0.0001' : '0';
    const remainingQty = kind === 'full' || cancelled ? '0'
      : kind === 'partial' ? '0.0001' : '0.0002';
    const cancelledQty = cancelled
      ? (kind === 'partial' ? '0.0001' : '0.0002')
      : '0';
    return {
      walletId: MAIN_ACCOUNT,
      orderId: '9',
      clientOid: 'dw-bb-0102030405060708090a0b0c',
      clientOrderId: `0x${'00'.repeat(32)}`,
      symbolId: '20000',
      symbol: 'BTCUSDT',
      side: 'Buy',
      status: kind === 'full' ? 'FullyFilled'
        : cancelled ? (kind === 'partial' ? 'PartiallyFilledCancelled' : 'Cancelled')
          : kind === 'partial' ? 'PartiallyFilled' : 'NewAccept',
      price: '63189',
      qty: '0.0002',
      filledQty,
      remainingQty,
      cancelledQty,
      reduceOnly: false,
    };
  };
  const longPosition = () => ({
    walletId: MAIN_ACCOUNT,
    positionId: '7',
    symbolId: '20000',
    side: '1',
    holdSizeWad: kind === 'full' ? '200000000000000' : '100000000000000',
    avgOpenPriceWad: '63000000000000000000000',
    closeSizeWad: '0',
    lockedSizeWad: '0',
    realizedPnlWad: '0',
    createdTime: '1',
    updatedTime: '2',
  });
  deps.journal = journal;
  deps.accountClient.findUniqueOrderByClientId = async () => {
    if (phase === 'initial') {
      const error = new Error('not found');
      error.code = 'POPDEX_ORDER_NOT_FOUND';
      throw error;
    }
    return order();
  };
  deps.accountClient.getAllFills = async () => {
    if (phase === 'initial' || kind === 'zero') return [];
    return [{
      fillId: '1',
      orderId: '9',
      symbol: 'BTCUSDT',
      side: 'Buy',
      execPrice: '63000',
      execQty: kind === 'full' ? '0.0002' : '0.0001',
    }];
  };
  deps.accountClient.getAllOpenOrders = async () => {
    if (phase === 'active' && kind !== 'full') return [order()];
    return [];
  };
  deps.readRpc.getAllOpenPositions = async () => {
    if (phase === 'initial' || kind === 'zero') return [];
    if (phase === 'closed' && !residualAfterClose) return [];
    return [longPosition()];
  };
  deps.trading = {
    async setBtcLeverageOne(_plan, targetJournal) {
      leverageCalls += 1;
      flow.push('trading:leverage');
      targetJournal.advance('PREPARED', 'LEVERAGE_BROADCAST', {
        leverageTxHash: `0x${'11'.repeat(32)}`,
      });
      targetJournal.advance('LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED');
      return { leverage: '1', changed: true };
    },
    async placeFillCloseEntry(_plan, targetJournal) {
      entryCalls += 1;
      flow.push('trading:entry');
      targetJournal.advance('LEVERAGE_CONFIRMED', 'ENTRY_BROADCAST', {
        entryTxHash: `0x${'22'.repeat(32)}`,
      });
      if (entryFailure) throw new Error(entryFailure);
      targetJournal.advance('ENTRY_BROADCAST', 'ENTRY_SETTLING', { orderId: '9' });
      phase = 'active';
      return { orderId: '9' };
    },
    async cancelFillCloseRemainder(_plan, _order, targetJournal) {
      cancelCalls += 1;
      flow.push('trading:cancel');
      targetJournal.advance('ENTRY_SETTLING', 'REMAINDER_CANCEL_BROADCAST', {
        cancelTxHash: `0x${'33'.repeat(32)}`,
      });
      phase = 'cancelled';
      return { orderId: '9' };
    },
    async closeFillCloseLong(_plan, targetJournal) {
      closeCalls += 1;
      flow.push('trading:close');
      targetJournal.advance('POSITION_CONFIRMED', 'CLOSE_BROADCAST', {
        closeTxHash: `0x${'44'.repeat(32)}`,
      });
      phase = 'closed';
      return { status: '0x1' };
    },
  };
  let clock = NOW;
  Object.assign(deps, {
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    pollTimeoutMs: 10,
    pollMs: 1,
  });
  return {
    deps,
    flow,
    journal,
    get counts() {
      return { leverageCalls, entryCalls, cancelCalls, closeCalls };
    },
  };
}

test('fill-close live orchestration completes a full fill and flat close once', async () => {
  const scenario = liveDependencies({ kind: 'full' });
  const result = await runProbe({ mode: 'fill-close' }, scenario.deps);
  assert.equal(result.status, 'completed-flat');
  assert.deepEqual(scenario.counts, {
    leverageCalls: 0,
    entryCalls: 1,
    cancelCalls: 0,
    closeCalls: 1,
  });
  assert.deepEqual(scenario.flow, [
    'journal:create',
    'journal:LEVERAGE_CONFIRMED',
    'trading:entry',
    'journal:ENTRY_BROADCAST',
    'journal:ENTRY_SETTLING',
    'journal:POSITION_CONFIRMED',
    'trading:close',
    'journal:CLOSE_BROADCAST',
    'journal:COMPLETED',
    'journal:clear',
  ]);
});

test('fill-close live orchestration sets leverage before entry when current is not 1x', async () => {
  const scenario = liveDependencies({ kind: 'full', initialLeverage: '20' });
  assert.equal((await runProbe({ mode: 'fill-close' }, scenario.deps)).status, 'completed-flat');
  assert.equal(scenario.counts.leverageCalls, 1);
  assert.ok(scenario.flow.indexOf('trading:leverage') < scenario.flow.indexOf('trading:entry'));
});

test('fill-close live orchestration cancels partial remainder and safely exits zero fill', async () => {
  const partial = liveDependencies({ kind: 'partial' });
  assert.equal((await runProbe({ mode: 'fill-close' }, partial.deps)).status, 'completed-flat');
  assert.deepEqual(partial.counts, {
    leverageCalls: 0,
    entryCalls: 1,
    cancelCalls: 1,
    closeCalls: 1,
  });

  const zero = liveDependencies({ kind: 'zero' });
  assert.equal((await runProbe({ mode: 'fill-close' }, zero.deps)).status, 'zero-fill-cleared');
  assert.deepEqual(zero.counts, {
    leverageCalls: 0,
    entryCalls: 1,
    cancelCalls: 1,
    closeCalls: 0,
  });
  assert.equal(zero.journal.load(), null);
});

test('fill-close live orchestration retains recovery state and never retries writes', async () => {
  const uncertain = liveDependencies({ kind: 'full', entryFailure: 'connection reset' });
  await assert.rejects(
    runProbe({ mode: 'fill-close' }, uncertain.deps),
    /connection reset/,
  );
  assert.equal(uncertain.counts.entryCalls, 1);
  assert.equal(uncertain.journal.load().stage, 'ENTRY_BROADCAST');

  const residual = liveDependencies({ kind: 'full', residualAfterClose: true });
  await assert.rejects(
    runProbe({ mode: 'fill-close' }, residual.deps),
    /平仓终态确认.*超过/,
  );
  assert.equal(residual.counts.closeCalls, 1);
  assert.equal(residual.journal.load().stage, 'CLOSE_BROADCAST');
});
