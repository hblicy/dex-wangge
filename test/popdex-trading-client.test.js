import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, Transaction, Wallet } from 'ethers';
import {
  POPDEX_ORDER_INTERFACE,
  prepareProbeOrder,
} from '../src/exchange/px/order-codec.js';
import { PopdexTradingClient } from '../src/exchange/px/trading-client.js';

const MAIN_ACCOUNT = '0x1111111111111111111111111111111111111111';
const AGENT_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const AGENT = new Wallet(AGENT_PRIVATE_KEY).address;
const NOW = 1786946400000;

function plan() {
  return prepareProbeOrder({
    mainAccount: MAIN_ACCOUNT,
    symbol: 'BTCUSDT',
    side: 'buy',
    price: '60000',
    qty: '0.0002',
    bid: '62900',
    ask: '62901',
    randomBytesImpl: () => Uint8Array.from({ length: 16 }, (_, index) => index + 1),
    nowMs: NOW,
  });
}

function openOrder(orderPlan = plan(), overrides = {}) {
  return {
    walletId: MAIN_ACCOUNT,
    orderId: '90071992547409931234',
    clientOrderId: orderPlan.clientOrderId,
    symbolId: orderPlan.symbolId,
    side: '0',
    isReduceOnly: false,
    priceWad: orderPlan.priceWad,
    qtyWad: orderPlan.qtyWad,
    filledQtyWad: '0',
    remainingQtyWad: orderPlan.qtyWad,
    cancelledQtyWad: '0',
    ...overrides,
  };
}

function terminalOrder(orderPlan = plan(), overrides = {}) {
  return openOrder(orderPlan, {
    status: '4',
    remainingQtyWad: '0',
    cancelledQtyWad: orderPlan.qtyWad,
    ...overrides,
  });
}

function activeAgent(overrides = {}) {
  return {
    exists: true,
    expiresAt: String(NOW + 60000),
    isExpired: false,
    delegator: MAIN_ACCOUNT,
    name: `0x${'00'.repeat(32)}`,
    isGlobal: false,
    ...overrides,
  };
}

function fakeJournal(initialStage = 'PREPARED') {
  return {
    stage: initialStage,
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

function dependencies({ agentInfo = activeAgent(), findOrder, simulate, broadcast } = {}) {
  const calls = [];
  const serialized = [];
  return {
    calls,
    serialized,
    readRpc: {
      async verifyChain() { calls.push('read:chain'); return 2184n; },
      async getAgentInfo(agent) { calls.push(`read:agent:${agent}`); return agentInfo; },
      async findUniqueOrderByClientId(account, clientOrderId, options) {
        calls.push(`read:order:${options?.completed === true ? 'completed' : 'active'}`);
        return findOrder(account, clientOrderId, options);
      },
    },
    writeRpc: {
      async verifyChain() { calls.push('write:chain'); return 2184n; },
      async simulate(transaction) {
        calls.push('write:simulate');
        if (simulate) return simulate(transaction);
        POPDEX_ORDER_INTERFACE.parseTransaction({ data: transaction.data });
        return '0x';
      },
      async broadcast(raw) {
        calls.push('write:broadcast');
        serialized.push(raw);
        return broadcast ? broadcast(raw) : keccak256(raw);
      },
      async waitForReceipt(hash) {
        calls.push(`write:receipt:${hash}`);
        return { transactionHash: hash, status: '0x1' };
      },
    },
  };
}

function createClient(deps, overrides = {}) {
  return new PopdexTradingClient({
    mainAccount: MAIN_ACCOUNT,
    agentPrivateKey: AGENT_PRIVATE_KEY,
    readRpc: deps.readRpc,
    writeRpc: deps.writeRpc,
    now: () => NOW,
    sleep: async () => {},
    orderTimeoutMs: 5000,
    orderPollMs: 100,
    ...overrides,
  });
}

test('placeAndConfirm signs one exact Agent legacy transaction and confirms the official order', async () => {
  const orderPlan = plan();
  let activeReads = 0;
  const deps = dependencies({
    findOrder: async (_account, _clientOrderId, options) => {
      if (options?.completed === true) {
        const error = new Error('not completed');
        error.code = 'POPDEX_ORDER_NOT_FOUND';
        throw error;
      }
      activeReads += 1;
      if (activeReads === 1) {
        const error = new Error('not found yet');
        error.code = 'POPDEX_ORDER_NOT_FOUND';
        throw error;
      }
      return openOrder(orderPlan);
    },
  });
  const journal = fakeJournal();
  const result = await createClient(deps).placeAndConfirm(orderPlan, journal);

  assert.equal(result.orderId, '90071992547409931234');
  assert.equal(result.clientOrderId, orderPlan.clientOrderId);
  assert.equal(deps.serialized.length, 1);
  const transaction = Transaction.from(deps.serialized[0]);
  assert.equal(transaction.from, AGENT);
  assert.equal(transaction.to, '0x0000000000000000000000000000000000001000');
  assert.equal(transaction.chainId, 2184n);
  assert.equal(transaction.type, 0);
  assert.equal(transaction.nonce, NOW);
  assert.equal(transaction.gasLimit, 1000000n);
  assert.equal(transaction.gasPrice, 0n);
  assert.equal(transaction.data, orderPlan.data);
  assert.deepEqual(journal.advances.map((entry) => entry.next), [
    'BROADCAST', 'OPEN_CONFIRMED',
  ]);
  assert.equal(journal.advances[0].fields.placeTxHash, keccak256(deps.serialized[0]));
  assert.equal(activeReads, 2);
});

test('placeAndConfirm accepts the empty eth_call result returned by the Mainnet Order precompile', async () => {
  const orderPlan = plan();
  const deps = dependencies({
    simulate: async () => '0x',
    findOrder: async (_account, _clientOrderId, options) => {
      if (options?.completed === true) {
        const error = new Error('not completed');
        error.code = 'POPDEX_ORDER_NOT_FOUND';
        throw error;
      }
      return openOrder(orderPlan);
    },
  });
  const journal = fakeJournal();

  const result = await createClient(deps).placeAndConfirm(orderPlan, journal);

  assert.equal(result.orderId, '90071992547409931234');
  assert.equal(deps.serialized.length, 1);
  assert.equal(journal.stage, 'OPEN_CONFIRMED');
});

test('cancelAndConfirm uses the next monotonic nonce and confirms zero-fill terminal state', async () => {
  const orderPlan = plan();
  const open = openOrder(orderPlan);
  const deps = dependencies({
    findOrder: async (_account, _clientOrderId, options) => {
      if (options?.completed === true) return terminalOrder(orderPlan);
      const error = new Error('active order gone');
      error.code = 'POPDEX_ORDER_NOT_FOUND';
      throw error;
    },
  });
  const journal = fakeJournal('OPEN_CONFIRMED');
  const client = createClient(deps);
  client.lastNonce = NOW;
  const result = await client.cancelAndConfirm(open, journal);

  assert.equal(result.filledQtyWad, '0');
  assert.equal(result.remainingQtyWad, '0');
  assert.equal(result.cancelledQtyWad, orderPlan.qtyWad);
  const transaction = Transaction.from(deps.serialized[0]);
  assert.equal(transaction.nonce, NOW + 1);
  assert.deepEqual(journal.advances.map((entry) => entry.next), [
    'CANCEL_BROADCAST', 'CANCEL_CONFIRMED',
  ]);
});

test('preflight rejects missing, expired, global and conflicting Agent authorization', async () => {
  for (const [name, agentInfo, expected] of [
    ['missing', activeAgent({ exists: false, delegator: null }), /Agent.*不存在/],
    ['expired flag', activeAgent({ isExpired: true }), /Agent.*过期/],
    ['expired time', activeAgent({ expiresAt: String(NOW) }), /Agent.*过期/],
    ['global', activeAgent({ isGlobal: true }), /global/i],
    ['delegator', activeAgent({ delegator: AGENT }), /delegator.*主账户.*不匹配/],
  ]) {
    const deps = dependencies({ agentInfo, findOrder: async () => openOrder() });
    await assert.rejects(createClient(deps).preflight(), expected, name);
    assert.ok(!deps.calls.includes('write:simulate'));
    assert.ok(!deps.calls.includes('write:broadcast'));
  }
});

test('simulation failure happens before signing, journal advancement and broadcast', async () => {
  const deps = dependencies({
    findOrder: async () => openOrder(),
    simulate: async () => { throw new Error('simulation rejected'); },
  });
  const journal = fakeJournal();
  await assert.rejects(createClient(deps).placeAndConfirm(plan(), journal), /simulation rejected/);
  assert.equal(deps.serialized.length, 0);
  assert.equal(journal.stage, 'PREPARED');
  assert.deepEqual(journal.advances, []);
});

test('uncertain broadcast records deterministic txHash and never retries', async () => {
  let attempts = 0;
  const deps = dependencies({
    findOrder: async () => openOrder(),
    broadcast: async () => { attempts += 1; throw new Error('connection reset'); },
  });
  const journal = fakeJournal();
  await assert.rejects(createClient(deps).placeAndConfirm(plan(), journal), /connection reset/);
  assert.equal(attempts, 1);
  assert.equal(journal.stage, 'BROADCAST');
  assert.equal(journal.errors.length, 1);
  assert.equal(journal.advances[0].fields.placeTxHash, keccak256(deps.serialized[0]));
});

test('place confirmation rejects an official order with conflicting immutable fields', async () => {
  const orderPlan = plan();
  const deps = dependencies({
    findOrder: async () => openOrder(orderPlan, { priceWad: '1' }),
  });
  const journal = fakeJournal();
  await assert.rejects(
    createClient(deps).placeAndConfirm(orderPlan, journal),
    /OPEN_CONFIRMED.*priceWad.*不匹配/,
  );
  assert.equal(journal.stage, 'BROADCAST');
  assert.equal(journal.errors.length, 1);
});

test('place confirmation immediately stops when the order already completed with a fill', async () => {
  const orderPlan = plan();
  const deps = dependencies({
    findOrder: async (_account, _clientOrderId, options) => {
      if (options?.completed !== true) {
        const error = new Error('not active');
        error.code = 'POPDEX_ORDER_NOT_FOUND';
        throw error;
      }
      return terminalOrder(orderPlan, {
        filledQtyWad: orderPlan.qtyWad,
        cancelledQtyWad: '0',
      });
    },
  });
  const journal = fakeJournal();
  await assert.rejects(
    createClient(deps).placeAndConfirm(orderPlan, journal),
    /OPEN_CONFIRMED.*发生成交.*人工处理仓位/,
  );
  assert.ok(deps.calls.includes('read:order:completed'));
  assert.equal(journal.stage, 'BROADCAST');
});

test('cancel rejects an open order owned by another account before simulation', async () => {
  const deps = dependencies({ findOrder: async () => terminalOrder() });
  const journal = fakeJournal('OPEN_CONFIRMED');
  await assert.rejects(
    createClient(deps).cancelAndConfirm(openOrder(plan(), { walletId: AGENT }), journal),
    /openOrder.*walletId.*主账户.*不匹配/,
  );
  assert.ok(!deps.calls.includes('write:simulate'));
  assert.equal(journal.stage, 'OPEN_CONFIRMED');
});

test('cancel confirmation stops on any fill and keeps recovery state', async () => {
  const orderPlan = plan();
  const deps = dependencies({
    findOrder: async (_account, _clientOrderId, options) => {
      if (options?.completed !== true) {
        const error = new Error('gone');
        error.code = 'POPDEX_ORDER_NOT_FOUND';
        throw error;
      }
      return terminalOrder(orderPlan, {
        filledQtyWad: '100000000000000',
        cancelledQtyWad: '100000000000000',
      });
    },
  });
  const journal = fakeJournal('OPEN_CONFIRMED');
  await assert.rejects(
    createClient(deps).cancelAndConfirm(openOrder(orderPlan), journal),
    /CANCEL_CONFIRMED.*发生成交.*人工处理仓位/,
  );
  assert.equal(journal.stage, 'CANCEL_BROADCAST');
  assert.equal(journal.errors.length, 1);
});
