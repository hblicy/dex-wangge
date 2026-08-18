import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, Transaction, Wallet, ZeroAddress } from 'ethers';
import {
  POPDEX_USER_CONFIG_INTERFACE,
  prepareFillClosePlan,
} from '../src/exchange/px/fill-close-codec.js';
import { POPDEX_ORDER_INTERFACE } from '../src/exchange/px/order-codec.js';
import { POPDEX_ORDER_EVENT_INTERFACE } from '../src/exchange/px/receipt-events.js';
import { PopdexTradingClient } from '../src/exchange/px/trading-client.js';

const MAIN_ACCOUNT = '0x1111111111111111111111111111111111111111';
const AGENT_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const AGENT = new Wallet(AGENT_PRIVATE_KEY).address;
const ORDER_PRECOMPILE = '0x0000000000000000000000000000000000001000';
const USER_CONFIG_PRECOMPILE = '0x0000000000000000000000000000000000001009';
const NOW = 1787032800000;
const ORDER_ID = '234237619377012736';
const CLOSE_ORDER_ID = '234237619377012737';

const plan = prepareFillClosePlan({
  mainAccount: MAIN_ACCOUNT,
  ask: '63000',
  randomBytesImpl: () => Uint8Array.from({ length: 16 }, (_unused, index) => index + 1),
});

const livePosition = {
  walletId: MAIN_ACCOUNT,
  positionId: '7',
  symbolId: '20000',
  side: '1',
  holdSizeWad: '200000000000000',
};

function agentInfo() {
  return {
    exists: true,
    expiresAt: String(NOW + 60000),
    isExpired: false,
    delegator: MAIN_ACCOUNT,
    name: `0x${'00'.repeat(32)}`,
    isGlobal: false,
  };
}

function config(leverage) {
  return {
    status: '0',
    vipLevel: '0',
    positionMode: '0',
    bizPermissionCode: '0',
    symbolLeverages: leverage === null
      ? []
      : [{ symbolId: '20000', leverage }],
    tokenLeverages: [],
  };
}

function eventLog(iface, name, args, address) {
  const encoded = iface.encodeEventLog(iface.getEvent(name), args);
  return { address, data: encoded.data, topics: encoded.topics };
}

function fakeJournal(stage = 'PREPARED') {
  return {
    stage,
    advances: [],
    errors: [],
    advance(expected, next, fields = {}) {
      assert.equal(this.stage, expected);
      this.stage = next;
      this.advances.push({ expected, next, fields });
      return { stage: next, ...fields };
    },
    recordError(expected, error) {
      assert.equal(this.stage, expected);
      this.errors.push(String(error?.message ?? error));
    },
  };
}

function dependencies({
  initialLeverage = '20',
  readbackLeverage = '1',
  leverageEvent = {},
  simulation = '0x',
  receiptStatus = '0x1',
  orderEventOverrides = [{}],
  openOrders = [],
  positions = [livePosition],
  agentInfoOverrides = {},
} = {}) {
  const serialized = [];
  let configReads = 0;
  const readRpc = {
    async verifyChain() { return 2184n; },
    async getAgentInfo() { return { ...agentInfo(), ...agentInfoOverrides }; },
    async getAccountConfig() {
      configReads += 1;
      return config(configReads === 1 ? initialLeverage : readbackLeverage);
    },
    async getAllOpenPositions() { return positions; },
  };
  const accountClient = {
    async getAllOpenOrders() { return openOrders; },
  };
  const writeRpc = {
    async verifyChain() { return 2184n; },
    async simulate() { return simulation; },
    async broadcast(raw) { serialized.push(raw); return keccak256(raw); },
    async waitForReceipt(hash) {
      const tx = Transaction.from(serialized.at(-1));
      const base = { transactionHash: hash, status: receiptStatus, logs: [] };
      if (tx.to.toLowerCase() === USER_CONFIG_PRECOMPILE.toLowerCase()) {
        const parsed = POPDEX_USER_CONFIG_INTERFACE.parseTransaction({ data: tx.data });
        return {
          ...base,
          logs: [eventLog(POPDEX_USER_CONFIG_INTERFACE, 'LeverageUpdated', [
            parsed.args.account,
            leverageEvent.category ?? 2,
            parsed.args.request.symbolId,
            parsed.args.request.tokenAddress,
            parsed.args.request.newLeverage,
            leverageEvent.succeeded ?? true,
            leverageEvent.code ?? 0,
          ], USER_CONFIG_PRECOMPILE)],
        };
      }
      const parsed = POPDEX_ORDER_INTERFACE.parseTransaction({ data: tx.data });
      if (parsed.name === 'placeOrder') {
        return {
          ...base,
          logs: orderEventOverrides.map((overrides) => eventLog(
            POPDEX_ORDER_EVENT_INTERFACE,
            'OrderCreate',
            [
              overrides.account ?? parsed.args.account,
              overrides.symbolId ?? parsed.args.symbolId,
              overrides.orderId ?? (parsed.args.price === 0n ? CLOSE_ORDER_ID : ORDER_ID),
              overrides.clientOrderId ?? parsed.args.clientOrderId,
              overrides.price ?? (parsed.args.price === 0n
                ? 62358000000000000000000n
                : parsed.args.price),
              overrides.qty ?? parsed.args.qty,
              0,
              2,
              true,
              0,
            ],
            ORDER_PRECOMPILE,
          )),
        };
      }
      if (parsed.name === 'cancelOrder') {
        return {
          ...base,
          logs: [eventLog(POPDEX_ORDER_EVENT_INTERFACE, 'OrderCancel', [
            parsed.args.account,
            parsed.args.orderId,
            parsed.args.clientOrderId,
            true,
            0,
          ], ORDER_PRECOMPILE)],
        };
      }
      throw new Error(`unexpected order method ${parsed.name}`);
    },
  };
  return {
    readRpc,
    accountClient,
    writeRpc,
    serialized,
    get configReads() { return configReads; },
  };
}

function client(deps) {
  return new PopdexTradingClient({
    mainAccount: MAIN_ACCOUNT,
    agentPrivateKey: AGENT_PRIVATE_KEY,
    readRpc: deps.readRpc,
    accountClient: deps.accountClient,
    writeRpc: deps.writeRpc,
    now: () => NOW,
    sleep: async () => {},
  });
}

test('stage5 leverage writes once to UserConfig and confirms event plus readback', async () => {
  const deps = dependencies();
  const journal = fakeJournal();
  const result = await client(deps).setBtcLeverageOne(plan, journal);
  assert.equal(result.leverage, '1');
  assert.equal(deps.serialized.length, 1);
  const tx = Transaction.from(deps.serialized[0]);
  assert.equal(tx.from, AGENT);
  assert.equal(tx.to, USER_CONFIG_PRECOMPILE);
  const parsed = POPDEX_USER_CONFIG_INTERFACE.parseTransaction({ data: tx.data });
  assert.deepEqual(Array.from(parsed.args.request, String), ['1', '20000', ZeroAddress, '2']);
  assert.deepEqual(journal.advances.map((entry) => entry.next), [
    'LEVERAGE_BROADCAST',
    'LEVERAGE_CONFIRMED',
  ]);
  assert.equal(deps.configReads, 2);
});

test('stage5 leverage writes fixed 1x when BTC has no explicit leverage record', async () => {
  const deps = dependencies({ initialLeverage: null });
  const journal = fakeJournal();
  const result = await client(deps).setBtcLeverageOne(plan, journal);
  assert.equal(result.leverage, '1');
  assert.equal(result.changed, true);
  assert.equal(deps.serialized.length, 1);
  assert.equal(deps.configReads, 2);
});

test('stage5 leverage skips writing only after exact 1x readback', async () => {
  const deps = dependencies({ initialLeverage: '1' });
  const journal = fakeJournal();
  assert.deepEqual(await client(deps).setBtcLeverageOne(plan, journal), {
    leverage: '1',
    changed: false,
  });
  assert.equal(deps.serialized.length, 0);
  assert.deepEqual(journal.advances.map((entry) => entry.next), ['LEVERAGE_CONFIRMED']);
});

test('stage5 leverage keeps recovery state on event or readback conflict', async () => {
  for (const options of [
    { leverageEvent: { category: 0 } },
    { readbackLeverage: '2' },
  ]) {
    const deps = dependencies(options);
    const journal = fakeJournal();
    await assert.rejects(client(deps).setBtcLeverageOne(plan, journal), /category|回读/);
    assert.equal(deps.serialized.length, 1);
    assert.equal(journal.stage, 'LEVERAGE_BROADCAST');
    assert.equal(journal.errors.length, 1);
  }
});

test('stage5 entry broadcasts once and persists authoritative orderId', async () => {
  const deps = dependencies();
  const journal = fakeJournal('LEVERAGE_CONFIRMED');
  const result = await client(deps).placeFillCloseEntry(plan, journal);
  assert.equal(result.orderId, ORDER_ID);
  assert.equal(deps.serialized.length, 1);
  assert.equal(Transaction.from(deps.serialized[0]).to, ORDER_PRECOMPILE);
  assert.deepEqual(journal.advances.map((entry) => entry.next), [
    'ENTRY_BROADCAST',
    'ENTRY_SETTLING',
  ]);
  assert.equal(journal.advances[1].fields.orderId, ORDER_ID);
});

test('stage5 remainder cancellation and reduce-only market close each broadcast exactly once', async () => {
  const cancelDeps = dependencies();
  const cancelJournal = fakeJournal('ENTRY_SETTLING');
  const order = { orderId: ORDER_ID, clientOrderId: plan.clientOrderId };
  assert.equal(
    (await client(cancelDeps).cancelFillCloseRemainder(plan, order, cancelJournal)).orderId,
    ORDER_ID,
  );
  assert.equal(cancelDeps.serialized.length, 1);
  assert.equal(cancelJournal.stage, 'REMAINDER_CANCEL_BROADCAST');

  const closeDeps = dependencies();
  const closeJournal = fakeJournal('POSITION_CONFIRMED');
  const closed = await client(closeDeps).closeFillCloseLong(plan, {
    closeClientOrderId: plan.closeClientOrderId,
    closeQtyWad: '200000000000000',
    positionQtyWad: '200000000000000',
    positionId: '7',
  }, closeJournal);
  assert.equal(closed.orderId, CLOSE_ORDER_ID);
  assert.equal(closeDeps.serialized.length, 1);
  const tx = Transaction.from(closeDeps.serialized[0]);
  const parsed = POPDEX_ORDER_INTERFACE.parseTransaction({ data: tx.data });
  assert.equal(parsed.name, 'placeOrder');
  assert.equal(parsed.args.account, MAIN_ACCOUNT);
  assert.equal(parsed.args.symbolId.toString(), '20000');
  assert.equal(parsed.args.clientOrderId, plan.closeClientOrderId);
  assert.equal(
    parsed.args.orderParams,
    '0x0201010000000100000000000000000000000000000000000000000000000000',
  );
  assert.equal(parsed.args.price, 0n);
  assert.equal(parsed.args.qty, 200000000000000n);
  assert.equal(parsed.args.slippage, 30000000000000000n);
  assert.equal(closeJournal.stage, 'CLOSE_SETTLING');
});

test('stage5 remainder cancellation rejects an order outside the exact entry plan', async () => {
  const deps = dependencies();
  const journal = fakeJournal('ENTRY_SETTLING');
  await assert.rejects(client(deps).cancelFillCloseRemainder(plan, {
    orderId: ORDER_ID,
    clientOrderId: `0x${'99'.repeat(32)}`,
  }, journal), /clientOrderId.*计划.*不匹配/);
  assert.equal(deps.serialized.length, 0);
  assert.equal(journal.stage, 'ENTRY_SETTLING');
});

test('stage5 simulation or failed close receipt stops without a success claim', async () => {
  const simulationDeps = dependencies({ simulation: '0x12' });
  const simulationJournal = fakeJournal('POSITION_CONFIRMED');
  await assert.rejects(
    client(simulationDeps).closeFillCloseLong(plan, {
      closeClientOrderId: plan.closeClientOrderId,
      closeQtyWad: '200000000000000',
      positionQtyWad: '200000000000000',
      positionId: '7',
    }, simulationJournal),
    /模拟结果无效/,
  );
  assert.equal(simulationDeps.serialized.length, 0);
  assert.equal(simulationJournal.stage, 'POSITION_CONFIRMED');

  const receiptDeps = dependencies({ receiptStatus: '0x0' });
  const receiptJournal = fakeJournal('POSITION_CONFIRMED');
  await assert.rejects(client(receiptDeps).closeFillCloseLong(plan, {
    closeClientOrderId: plan.closeClientOrderId,
    closeQtyWad: '200000000000000',
    positionQtyWad: '200000000000000',
    positionId: '7',
  }, receiptJournal), /status=0x1/);
  assert.equal(receiptJournal.stage, 'CLOSE_BROADCAST');
  assert.equal(receiptJournal.errors.length, 1);
});

test('stage5 close rejects stale position facts before signing', async () => {
  for (const options of [
    { openOrders: [{ symbol: 'BTCUSDT', orderId: '99' }] },
    { positions: [] },
    { positions: [{ ...livePosition, side: '2' }] },
    { positions: [livePosition, { ...livePosition, positionId: '8' }] },
    { positions: [{ ...livePosition, holdSizeWad: '100000000000000' }] },
    { positions: [{ ...livePosition, positionId: '8' }] },
  ]) {
    const deps = dependencies(options);
    await assert.rejects(client(deps).closeFillCloseLong(plan, {
      closeClientOrderId: plan.closeClientOrderId,
      closeQtyWad: '200000000000000',
      positionQtyWad: '200000000000000',
      positionId: '7',
    }, fakeJournal('POSITION_CONFIRMED')), /活动订单|Long=1|持仓量|持仓 ID/);
    assert.equal(deps.serialized.length, 0);
  }
});

test('stage5 close rejects wrong account expired Agent and quantity mismatch before signing', async () => {
  const wrongAccountDeps = dependencies();
  await assert.rejects(client(wrongAccountDeps).closeFillCloseLong({
    ...plan,
    mainAccount: '0x2222222222222222222222222222222222222222',
  }, {
    closeClientOrderId: plan.closeClientOrderId,
    closeQtyWad: '200000000000000',
    positionQtyWad: '200000000000000',
    positionId: '7',
  }, fakeJournal('POSITION_CONFIRMED')), /mainAccount/);
  assert.equal(wrongAccountDeps.serialized.length, 0);

  const expiredAgentDeps = dependencies({ agentInfoOverrides: { isExpired: true } });
  await assert.rejects(client(expiredAgentDeps).closeFillCloseLong(plan, {
    closeClientOrderId: plan.closeClientOrderId,
    closeQtyWad: '200000000000000',
    positionQtyWad: '200000000000000',
    positionId: '7',
  }, fakeJournal('POSITION_CONFIRMED')), /Agent.*过期/);
  assert.equal(expiredAgentDeps.serialized.length, 0);

  const qtyDeps = dependencies();
  await assert.rejects(client(qtyDeps).closeFillCloseLong(plan, {
    closeClientOrderId: plan.closeClientOrderId,
    closeQtyWad: '100000000000000',
    positionQtyWad: '200000000000000',
    positionId: '7',
  }, fakeJournal('POSITION_CONFIRMED')), /数量.*不匹配/);
  assert.equal(qtyDeps.serialized.length, 0);
});

test('stage5 close requires one exact OrderCreate and preserves broadcast state on mismatch', async () => {
  for (const orderEventOverrides of [
    [{}, {}],
    [{ clientOrderId: `0x${'99'.repeat(32)}` }],
    [{ qty: 100000000000000n }],
  ]) {
    const deps = dependencies({ orderEventOverrides });
    const journal = fakeJournal('POSITION_CONFIRMED');
    await assert.rejects(client(deps).closeFillCloseLong(plan, {
      closeClientOrderId: plan.closeClientOrderId,
      closeQtyWad: '200000000000000',
      positionQtyWad: '200000000000000',
      positionId: '7',
    }, journal), /OrderCreate/);
    assert.equal(journal.stage, 'CLOSE_BROADCAST');
    assert.equal(deps.serialized.length, 1);
  }
});
