import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, Transaction, Wallet, ZeroAddress } from 'ethers';
import {
  POPDEX_REVERSE_INTERFACE,
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

const plan = prepareFillClosePlan({
  mainAccount: MAIN_ACCOUNT,
  ask: '63000',
  randomBytesImpl: () => Uint8Array.from({ length: 16 }, (_unused, index) => index + 1),
});

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
} = {}) {
  const serialized = [];
  let configReads = 0;
  const readRpc = {
    async verifyChain() { return 2184n; },
    async getAgentInfo() { return agentInfo(); },
    async getAccountConfig() {
      configReads += 1;
      return config(configReads === 1 ? initialLeverage : readbackLeverage);
    },
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
      let parsed;
      try {
        parsed = POPDEX_ORDER_INTERFACE.parseTransaction({ data: tx.data });
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        parsed = POPDEX_REVERSE_INTERFACE.parseTransaction({ data: tx.data });
      }
      if (parsed.name === 'placeOrder') {
        return {
          ...base,
          logs: [eventLog(POPDEX_ORDER_EVENT_INTERFACE, 'OrderCreate', [
            parsed.args.account,
            parsed.args.symbolId,
            ORDER_ID,
            parsed.args.clientOrderId,
            parsed.args.price,
            parsed.args.qty,
            0,
            2,
            true,
            0,
          ], ORDER_PRECOMPILE)],
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
      assert.equal(parsed.name, 'placeReverseOrder');
      return base;
    },
  };
  return { readRpc, writeRpc, serialized, get configReads() { return configReads; } };
}

function client(deps) {
  return new PopdexTradingClient({
    mainAccount: MAIN_ACCOUNT,
    agentPrivateKey: AGENT_PRIVATE_KEY,
    readRpc: deps.readRpc,
    accountClient: {},
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

test('stage5 remainder cancellation and long close each broadcast exactly once', async () => {
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
  await client(closeDeps).closeFillCloseLong(plan, closeJournal);
  assert.equal(closeDeps.serialized.length, 1);
  const tx = Transaction.from(closeDeps.serialized[0]);
  const parsed = POPDEX_REVERSE_INTERFACE.parseTransaction({ data: tx.data });
  assert.deepEqual(Array.from(parsed.args, String), [MAIN_ACCOUNT, '20000', '1']);
  assert.equal(closeJournal.stage, 'CLOSE_BROADCAST');
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
  const falseSimulation = POPDEX_REVERSE_INTERFACE.encodeFunctionResult(
    'placeReverseOrder',
    [false],
  );
  const simulationDeps = dependencies({ simulation: falseSimulation });
  const simulationJournal = fakeJournal('POSITION_CONFIRMED');
  await assert.rejects(
    client(simulationDeps).closeFillCloseLong(plan, simulationJournal),
    /未返回 true/,
  );
  assert.equal(simulationDeps.serialized.length, 0);
  assert.equal(simulationJournal.stage, 'POSITION_CONFIRMED');

  const receiptDeps = dependencies({ receiptStatus: '0x0' });
  const receiptJournal = fakeJournal('POSITION_CONFIRMED');
  await assert.rejects(client(receiptDeps).closeFillCloseLong(plan, receiptJournal), /status=0x1/);
  assert.equal(receiptJournal.stage, 'CLOSE_BROADCAST');
  assert.equal(receiptJournal.errors.length, 1);
});
