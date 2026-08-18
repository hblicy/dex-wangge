import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet } from 'ethers';
import {
  main,
  parseArgs,
  runProbe,
} from '../src/exchange/px/fill-close-probe.js';
import { POPDEX_USER_CONFIG_PRECOMPILE } from '../src/exchange/px/constants.js';
import { POPDEX_USER_CONFIG_INTERFACE } from '../src/exchange/px/fill-close-codec.js';

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
          symbolLeverages: leverage === null
            ? []
            : [{ symbolId: '20000', leverage }],
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
  assert.match(result.calldataHashes.closePreview, /^0x[0-9a-f]{64}$/);
  assert.notEqual(result.clientOrderId, result.closeClientOrderId);
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

test('fill-close dry-run treats a missing BTC leverage record as unconfigured', async () => {
  const deps = dependencies({ leverage: null });
  const result = await runProbe({ mode: 'dry-run' }, deps);
  assert.equal(result.status, 'dry-run-ready');
  assert.equal(result.currentLeverage, 'unset');
  assert.equal(result.targetLeverage, '1');
  assert.equal(deps.broadcasts, 0);
  assert.equal(deps.calls.filter((call) => call.startsWith('write:simulate:')).length, 3);
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
    const fills = [{
      fillId: '1',
      orderId: '9',
      symbol: 'BTCUSDT',
      side: 'Buy',
      execPrice: '63000',
      execQty: kind === 'full' ? '0.0002' : '0.0001',
    }];
    if (phase === 'closed') {
      fills.push({
        fillId: '2',
        orderId: '10',
        symbol: 'BTCUSDT',
        side: 'Sell',
        execPrice: '63000',
        execQty: kind === 'full' ? '0.0002' : '0.0001',
      });
    }
    return fills;
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
    async closeFillCloseLong(_plan, positionFacts, targetJournal) {
      closeCalls += 1;
      flow.push('trading:close');
      assert.equal(positionFacts.closeClientOrderId, _plan.closeClientOrderId);
      assert.equal(positionFacts.closeQtyWad, positionFacts.positionQtyWad);
      assert.equal(positionFacts.positionId, '7');
      targetJournal.advance('POSITION_CONFIRMED', 'CLOSE_BROADCAST', {
        closeKind: 'reduce-only-market',
        closeTxHash: `0x${'44'.repeat(32)}`,
        closeQtyWad: positionFacts.closeQtyWad,
      });
      targetJournal.advance('CLOSE_BROADCAST', 'CLOSE_SETTLING', {
        closeOrderId: '10',
      });
      phase = 'closed';
      return { orderId: '10' };
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
  assert.equal(result.closeOrderId, '10');
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
    'journal:CLOSE_SETTLING',
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
  assert.equal(residual.journal.load().stage, 'CLOSE_SETTLING');
});

function recoveryRecord(stage, overrides = {}) {
  const afterPosition = ['POSITION_CONFIRMED', 'CLOSE_BROADCAST', 'CLOSE_SETTLING']
    .includes(stage);
  return {
    version: 2,
    stage,
    mainAccount: MAIN_ACCOUNT,
    agentAddress: AGENT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    positionMode: '0',
    leverage: '1',
    priceWad: '63189000000000000000000',
    qtyWad: '200000000000000',
    clientOrderId: '0x64772d62622d3031303230333034303530363037303830393061306230630000',
    closeKind: ['CLOSE_BROADCAST', 'CLOSE_SETTLING'].includes(stage)
      ? 'reduce-only-market' : null,
    closeClientOrderId:
      '0x64772d62632d3031303230333034303530363037303830393061306230630000',
    closeOrderId: stage === 'CLOSE_SETTLING' ? '10' : null,
    orderId: ['PREPARED', 'LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED', 'ENTRY_BROADCAST']
      .includes(stage) ? null : '9',
    positionId: afterPosition ? '7' : null,
    leverageTxHash: stage === 'LEVERAGE_BROADCAST' ? `0x${'11'.repeat(32)}` : null,
    entryTxHash: ['ENTRY_BROADCAST', 'ENTRY_SETTLING', 'REMAINDER_CANCEL_BROADCAST', 'POSITION_CONFIRMED', 'CLOSE_BROADCAST', 'CLOSE_SETTLING']
      .includes(stage) ? `0x${'22'.repeat(32)}` : null,
    cancelTxHash: stage === 'REMAINDER_CANCEL_BROADCAST' ? `0x${'33'.repeat(32)}` : null,
    closeTxHash: ['CLOSE_BROADCAST', 'CLOSE_SETTLING'].includes(stage)
      ? `0x${'44'.repeat(32)}` : null,
    filledQtyWad: afterPosition
      ? '100000000000000' : null,
    remainingQtyWad: afterPosition ? '0' : null,
    positionQtyWad: afterPosition
      ? '100000000000000' : null,
    closeQtyWad: ['CLOSE_BROADCAST', 'CLOSE_SETTLING'].includes(stage)
      ? '100000000000000' : null,
    outcome: null,
    lastError: null,
    ...overrides,
  };
}

function recoveryJournal(initial, flow) {
  let record = structuredClone(initial);
  return {
    load() { return record; },
    advance(expected, next, fields = {}) {
      assert.equal(record.stage, expected);
      record = { ...record, ...fields, stage: next };
      flow.push(`journal:${next}`);
      return record;
    },
    completeFailedEntry(hash) {
      assert.equal(record.stage, 'ENTRY_BROADCAST');
      assert.equal(record.entryTxHash, hash);
      record = { ...record, stage: 'COMPLETED', outcome: 'safe-no-exposure' };
      flow.push('journal:COMPLETED');
      return record;
    },
    recordError(expected, error) {
      assert.equal(record.stage, expected);
      record = { ...record, lastError: String(error?.message ?? error) };
      return record;
    },
    clearCompleted() {
      assert.equal(record.stage, 'COMPLETED');
      record = null;
      flow.push('journal:clear');
    },
  };
}

function recoveryOrder({ filled = '0', remaining = '0.0002', cancelled = '0' } = {}) {
  return {
    walletId: MAIN_ACCOUNT,
    orderId: '9',
    clientOid: 'dw-bb-0102030405060708090a0b0c',
    symbolId: '20000',
    symbol: 'BTCUSDT',
    side: 'Buy',
    status: remaining === '0' ? (filled === '0' ? 'Cancelled' : 'PartiallyFilledCancelled') : 'NewAccept',
    price: '63189',
    qty: '0.0002',
    filledQty: filled,
    remainingQty: remaining,
    cancelledQty: cancelled,
    reduceOnly: false,
  };
}

function recoveryCloseFill(execQty) {
  return {
    fillId: '2',
    orderId: '10',
    symbol: 'BTCUSDT',
    side: 'Sell',
    execQty,
  };
}

function recoveryLong(holdSizeWad) {
  return {
    walletId: MAIN_ACCOUNT,
    positionId: '7',
    symbol: 'BTCUSDT',
    symbolId: '20000',
    side: '1',
    holdSizeWad,
  };
}

function recoveryDependencies(stage, {
  receiptStatus = null,
  receiptLogs = [],
  order = null,
  fills = [],
  openOrders = [],
  positions = [],
  accountConfig = {
    positionMode: '0',
    symbolLeverages: [{ symbolId: '20000', leverage: '1' }],
  },
  recordOverrides = {},
} = {}) {
  const flow = [];
  const journal = recoveryJournal(recoveryRecord(stage, recordOverrides), flow);
  let cancelCalls = 0;
  let closeCalls = 0;
  const deps = {
    mainAccount: MAIN_ACCOUNT,
    agentAddress: AGENT,
    journal,
    readRpc: {
      async verifyChain() { flow.push('read:chain'); return 2184n; },
      async getReceipt() {
        return receiptStatus === null ? null : {
          transactionHash: stage === 'CLOSE_BROADCAST' ? `0x${'44'.repeat(32)}`
            : stage === 'REMAINDER_CANCEL_BROADCAST' ? `0x${'33'.repeat(32)}`
              : stage === 'LEVERAGE_BROADCAST' ? `0x${'11'.repeat(32)}`
                : `0x${'22'.repeat(32)}`,
          status: receiptStatus,
          logs: receiptLogs,
        };
      },
      async getAccountConfig() { return accountConfig; },
      async getAllOpenPositions() { return positions; },
    },
    accountClient: {
      async findUniqueOrderByClientId() {
        if (order) return order;
        const error = new Error('not found');
        error.code = 'POPDEX_ORDER_NOT_FOUND';
        throw error;
      },
      async getAllFills() { return fills; },
      async getAllOpenOrders() { return openOrders; },
    },
    trading: {
      async cancelFillCloseRemainder(_plan, _order, targetJournal) {
        cancelCalls += 1;
        targetJournal.advance('ENTRY_SETTLING', 'REMAINDER_CANCEL_BROADCAST', {
          cancelTxHash: `0x${'33'.repeat(32)}`,
        });
      },
      async closeFillCloseLong(_plan, positionFacts, targetJournal) {
        closeCalls += 1;
        assert.equal(positionFacts.closeClientOrderId, _plan.closeClientOrderId);
        assert.equal(positionFacts.closeQtyWad, positionFacts.positionQtyWad);
        targetJournal.advance('POSITION_CONFIRMED', 'CLOSE_BROADCAST', {
          closeKind: 'reduce-only-market',
          closeTxHash: `0x${'44'.repeat(32)}`,
          closeQtyWad: positionFacts.closeQtyWad,
        });
        return { orderId: '10' };
      },
    },
  };
  return {
    deps,
    journal,
    flow,
    get cancelCalls() { return cancelCalls; },
    get closeCalls() { return closeCalls; },
  };
}

test('plain recovery inspects every broadcast stage without invoking a write method', async () => {
  const active = recoveryOrder();
  const long = [{
    walletId: MAIN_ACCOUNT,
    positionId: '7',
    symbolId: '20000',
    side: '1',
    holdSizeWad: '100000000000000',
  }];
  const cases = [
    ['LEVERAGE_BROADCAST', {}],
    ['ENTRY_BROADCAST', {}],
    ['ENTRY_SETTLING', { order: active, openOrders: [active] }],
    ['REMAINDER_CANCEL_BROADCAST', {}],
    ['POSITION_CONFIRMED', { positions: long }],
    ['CLOSE_BROADCAST', { positions: long }],
  ];
  for (const [stage, facts] of cases) {
    const scenario = recoveryDependencies(stage, facts);
    const result = await runProbe({ mode: 'resume' }, scenario.deps);
    assert.ok(result.status);
    assert.equal(scenario.cancelCalls, 0, stage);
    assert.equal(scenario.closeCalls, 0, stage);
  }
});

test('plain recovery safely clears pre-entry and exact failed-entry records only', async () => {
  const prepared = recoveryDependencies('PREPARED');
  assert.equal((await runProbe({ mode: 'resume' }, prepared.deps)).status, 'safe-no-exposure');
  assert.equal(prepared.journal.load(), null);

  const failedEntry = recoveryDependencies('ENTRY_BROADCAST', { receiptStatus: '0x0' });
  assert.equal((await runProbe({ mode: 'resume' }, failedEntry.deps)).status, 'safe-no-exposure');
  assert.equal(failedEntry.journal.load(), null);
});

test('failed close receipt clears the journal only after read-only facts prove manual flat', async () => {
  const flat = recoveryDependencies('CLOSE_BROADCAST', { receiptStatus: '0x0' });
  const result = await runProbe({ mode: 'resume' }, flat.deps);
  assert.equal(result.status, 'completed-flat-manual');
  assert.equal(flat.closeCalls, 0);
  assert.equal(flat.journal.load(), null);

  const long = recoveryDependencies('CLOSE_BROADCAST', {
    receiptStatus: '0x0',
    positions: [{
      walletId: MAIN_ACCOUNT,
      positionId: '7',
      symbolId: '20000',
      side: '1',
      holdSizeWad: '100000000000000',
    }],
  });
  const unresolved = await runProbe({ mode: 'resume' }, long.deps);
  assert.equal(unresolved.status, 'close-receipt-failed');
  assert.equal(long.closeCalls, 0);
  assert.equal(long.journal.load().stage, 'CLOSE_BROADCAST');
});

test('plain recovery settles the exact close without broadcasting again', async () => {
  const pending = recoveryDependencies('CLOSE_BROADCAST', { receiptStatus: null });
  assert.equal((await runProbe({ mode: 'resume' }, pending.deps)).status,
    'close-receipt-pending');
  assert.equal(pending.closeCalls, 0);

  const partial = recoveryDependencies('CLOSE_SETTLING', {
    fills: [recoveryCloseFill('0.00005')],
    positions: [recoveryLong('50000000000000')],
  });
  const partialResult = await runProbe({ mode: 'resume' }, partial.deps);
  assert.equal(partialResult.status, 'partial-close-unresolved');
  assert.equal(partial.closeCalls, 0);
  assert.equal(partial.journal.load().stage, 'CLOSE_SETTLING');

  const complete = recoveryDependencies('CLOSE_SETTLING', {
    fills: [recoveryCloseFill('0.0001')],
    positions: [],
    openOrders: [],
  });
  const completeResult = await runProbe({ mode: 'resume' }, complete.deps);
  assert.equal(completeResult.status, 'completed-flat');
  assert.equal(complete.closeCalls, 0);
  assert.equal(complete.journal.load(), null);
});

test('leverage broadcast recovery waits for its receipt and verifies success before clearing', async () => {
  const pending = recoveryDependencies('LEVERAGE_BROADCAST');
  assert.equal((await runProbe({ mode: 'resume' }, pending.deps)).status, 'leverage-receipt-pending');
  assert.equal(pending.journal.load().stage, 'LEVERAGE_BROADCAST');

  const event = POPDEX_USER_CONFIG_INTERFACE.encodeEventLog(
    POPDEX_USER_CONFIG_INTERFACE.getEvent('LeverageUpdated'),
    [MAIN_ACCOUNT, 2, 20000, '0x0000000000000000000000000000000000000000', 1, true, 0],
  );
  const confirmed = recoveryDependencies('LEVERAGE_BROADCAST', {
    receiptStatus: '0x1',
    receiptLogs: [{ address: POPDEX_USER_CONFIG_PRECOMPILE, ...event }],
  });
  assert.equal((await runProbe({ mode: 'resume' }, confirmed.deps)).status, 'safe-no-exposure');
  assert.equal(confirmed.journal.load(), null);

  const malformed = recoveryDependencies('LEVERAGE_BROADCAST', { receiptStatus: '0x1' });
  await assert.rejects(runProbe({ mode: 'resume' }, malformed.deps), /LeverageUpdated/);
  assert.equal(malformed.journal.load().stage, 'LEVERAGE_BROADCAST');
});

test('recovery cancel requires the exact active entry and refuses an existing cancel hash', async () => {
  const active = recoveryOrder();
  const scenario = recoveryDependencies('ENTRY_SETTLING', {
    order: active,
    openOrders: [active],
  });
  assert.equal((await runProbe({ mode: 'resume-cancel' }, scenario.deps)).status, 'cancel-broadcast');
  assert.equal(scenario.cancelCalls, 1);
  assert.equal(scenario.journal.load().stage, 'REMAINDER_CANCEL_BROADCAST');

  const existing = recoveryDependencies('REMAINDER_CANCEL_BROADCAST', {
    order: active,
    openOrders: [active],
  });
  await assert.rejects(runProbe({ mode: 'resume-cancel' }, existing.deps), /已经广播|普通 --resume/);
  assert.equal(existing.cancelCalls, 0);
});

test('recovery close requires one exact long and refuses an existing close hash', async () => {
  const long = [{
    walletId: MAIN_ACCOUNT,
    positionId: '7',
    symbolId: '20000',
    side: '1',
    holdSizeWad: '100000000000000',
  }];
  const scenario = recoveryDependencies('POSITION_CONFIRMED', { positions: long });
  assert.equal((await runProbe({ mode: 'resume-close' }, scenario.deps)).status, 'close-broadcast');
  assert.equal(scenario.closeCalls, 1);
  assert.equal(scenario.journal.load().stage, 'CLOSE_BROADCAST');

  const existing = recoveryDependencies('CLOSE_BROADCAST', { positions: long });
  await assert.rejects(runProbe({ mode: 'resume-close' }, existing.deps), /已经广播|普通 --resume/);
  assert.equal(existing.closeCalls, 0);
});

test('recovery write modes reject conflicting order and position facts before writing', async () => {
  const wrongOrder = recoveryOrder();
  wrongOrder.clientOid = 'dw-bb-ffffffffffffffffffffffff';
  const cancel = recoveryDependencies('ENTRY_SETTLING', {
    order: wrongOrder,
    openOrders: [wrongOrder],
  });
  await assert.rejects(runProbe({ mode: 'resume-cancel' }, cancel.deps), /订单身份不匹配|不属于本探针/);
  assert.equal(cancel.cancelCalls, 0);

  const close = recoveryDependencies('POSITION_CONFIRMED', {
    positions: [{
      walletId: MAIN_ACCOUNT,
      positionId: '7',
      symbolId: '20000',
      side: '2',
      holdSizeWad: '100000000000000',
    }],
  });
  await assert.rejects(runProbe({ mode: 'resume-close' }, close.deps), /Long=1/);
  assert.equal(close.closeCalls, 0);
});

test('recovery CLI renders no-record without accessing dry-run-only fields', async () => {
  const lines = [];
  const result = await main(['--resume'], {
    journal: { load: () => null },
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  });
  assert.deepEqual(result, { mode: 'resume', status: 'no-record' });
  assert.match(lines.join('\n'), /resume.*no-record/);
  process.exitCode = 0;
});

test('recovery CLI renders exact unresolved close diagnostics', async () => {
  const scenario = recoveryDependencies('CLOSE_SETTLING', {
    fills: [recoveryCloseFill('0.00005')],
    positions: [recoveryLong('50000000000000')],
  });
  const lines = [];
  const result = await main(['--resume'], {
    ...scenario.deps,
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  });
  assert.equal(result.status, 'partial-close-unresolved');
  assert.match(lines.join('\n'), /closeTxHash=0x(?:44){32}/);
  assert.match(lines.join('\n'), /closeOrderId=10/);
  assert.match(lines.join('\n'), /filledQtyWad=50000000000000/);
  assert.match(lines.join('\n'), /remainingPositionQtyWad=50000000000000/);
  process.exitCode = 0;
});
