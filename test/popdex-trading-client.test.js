import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBytes32String, keccak256, Transaction, Wallet } from 'ethers';
import {
  POPDEX_ORDER_INTERFACE,
  prepareProbeOrder,
} from '../src/exchange/px/order-codec.js';
import { PopdexTradingClient } from '../src/exchange/px/trading-client.js';
import { POPDEX_ORDER_EVENT_INTERFACE } from '../src/exchange/px/receipt-events.js';

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

function restOrder(orderPlan = plan(), overrides = {}) {
  return {
    walletId: MAIN_ACCOUNT,
    orderId: '90071992547409931234',
    clientOid: decodeBytes32String(orderPlan.clientOrderId),
    symbolId: orderPlan.symbolId,
    symbol: orderPlan.symbol,
    side: 'Buy',
    status: 'NewAccept',
    price: orderPlan.price,
    qty: orderPlan.qty,
    filledQty: '0',
    remainingQty: orderPlan.qty,
    cancelledQty: '0',
    reduceOnly: false,
    ...overrides,
  };
}

function createReceipt(orderPlan = plan(), txHash = `0x${'34'.repeat(32)}`) {
  const event = POPDEX_ORDER_EVENT_INTERFACE.encodeEventLog(
    POPDEX_ORDER_EVENT_INTERFACE.getEvent('OrderCreate'),
    [
      MAIN_ACCOUNT,
      orderPlan.symbolId,
      '90071992547409931234',
      orderPlan.clientOrderId,
      orderPlan.priceWad,
      orderPlan.qtyWad,
      '0',
      2,
      true,
      0,
    ],
  );
  return {
    transactionHash: txHash,
    status: '0x1',
    logs: [{
      address: '0x0000000000000000000000000000000000001000',
      data: event.data,
      topics: event.topics,
    }],
  };
}

function receiptFromTransaction(hash, raw) {
  const transaction = Transaction.from(raw);
  const parsed = POPDEX_ORDER_INTERFACE.parseTransaction({ data: transaction.data });
  if (parsed.name === 'placeOrder') {
    const event = POPDEX_ORDER_EVENT_INTERFACE.encodeEventLog(
      POPDEX_ORDER_EVENT_INTERFACE.getEvent('OrderCreate'),
      [
        parsed.args.account,
        parsed.args.symbolId,
        '90071992547409931234',
        parsed.args.clientOrderId,
        parsed.args.price,
        parsed.args.qty,
        0,
        2,
        true,
        0,
      ],
    );
    return {
      transactionHash: hash,
      status: '0x1',
      logs: [{ address: transaction.to, data: event.data, topics: event.topics }],
    };
  }
  if (parsed.name === 'cancelOrder') {
    const event = POPDEX_ORDER_EVENT_INTERFACE.encodeEventLog(
      POPDEX_ORDER_EVENT_INTERFACE.getEvent('OrderCancel'),
      [
        parsed.args.account,
        parsed.args.orderId,
        parsed.args.clientOrderId,
        true,
        0,
      ],
    );
    return {
      transactionHash: hash,
      status: '0x1',
      logs: [{ address: transaction.to, data: event.data, topics: event.topics }],
    };
  }
  throw new Error(`unexpected transaction ${parsed.name}`);
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

function dependencies({
  agentInfo = activeAgent(),
  findOrder,
  findRestOrder,
  getFills,
  getPositions,
  simulate,
  broadcast,
  waitReceipt,
} = {}) {
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
      async getOpenPositions(account, offset, limit) {
        calls.push(`read:positions:${offset}:${limit}`);
        if (getPositions) return getPositions(account, offset, limit);
        return { positions: [], hasMore: false };
      },
    },
    accountClient: {
      async findUniqueOrderByClientId(account, symbol, clientOrderId) {
        calls.push('rest:order');
        if (findRestOrder) return findRestOrder(account, symbol, clientOrderId);
        return restOrder();
      },
      async getFills(account, symbol, cursor) {
        calls.push(`rest:fills:${cursor ?? 'first'}`);
        if (getFills) return getFills(account, symbol, cursor);
        return [];
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
        if (waitReceipt) return waitReceipt(hash, serialized.at(-1));
        return receiptFromTransaction(hash, serialized.at(-1));
      },
    },
  };
}

function createClient(deps, overrides = {}) {
  return new PopdexTradingClient({
    mainAccount: MAIN_ACCOUNT,
    agentPrivateKey: AGENT_PRIVATE_KEY,
    readRpc: deps.readRpc,
    accountClient: deps.accountClient,
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
  const deps = dependencies({
    findRestOrder: async () => restOrder(orderPlan),
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
  assert.ok(deps.calls.includes('rest:order'));
});

test('placeAndConfirm accepts the empty eth_call result returned by the Mainnet Order precompile', async () => {
  const orderPlan = plan();
  const deps = dependencies({
    simulate: async () => '0x',
    findRestOrder: async () => restOrder(orderPlan),
  });
  const journal = fakeJournal();

  const result = await createClient(deps).placeAndConfirm(orderPlan, journal);

  assert.equal(result.orderId, '90071992547409931234');
  assert.equal(deps.serialized.length, 1);
  assert.equal(journal.stage, 'OPEN_CONFIRMED');
});

test('placeAndConfirm uses OrderCreate receipt plus official REST when order precompile pages stay empty', async () => {
  const orderPlan = plan();
  const deps = dependencies({
    findOrder: async () => {
      const error = new Error('precompile page is empty');
      error.code = 'POPDEX_ORDER_NOT_FOUND';
      throw error;
    },
    waitReceipt: async (hash) => createReceipt(orderPlan, hash),
  });
  const accountClient = {
    async findUniqueOrderByClientId(account, symbol, clientOrderId) {
      deps.calls.push('rest:order');
      assert.equal(account, MAIN_ACCOUNT);
      assert.equal(symbol, 'BTCUSDT');
      assert.equal(clientOrderId, orderPlan.clientOrderId);
      return restOrder(orderPlan);
    },
  };
  const journal = fakeJournal();

  const result = await createClient(deps, { accountClient }).placeAndConfirm(orderPlan, journal);

  assert.equal(result.orderId, '90071992547409931234');
  assert.ok(deps.calls.includes('rest:order'));
  assert.equal(deps.calls.some((call) => call.startsWith('read:order:')), false);
  assert.equal(journal.stage, 'OPEN_CONFIRMED');
});

test('place confirmation waits through official pending states until NewAccept', async () => {
  const orderPlan = plan();
  let reads = 0;
  const deps = dependencies({
    findRestOrder: async () => {
      reads += 1;
      return restOrder(orderPlan, { status: reads === 1 ? 'PendingNew' : 'NewAccept' });
    },
  });
  const journal = fakeJournal();

  const result = await createClient(deps).placeAndConfirm(orderPlan, journal);

  assert.equal(result.orderId, '90071992547409931234');
  assert.equal(reads, 2);
  assert.equal(journal.stage, 'OPEN_CONFIRMED');
});

test('cancelAndConfirm uses the next monotonic nonce and confirms zero-fill terminal state', async () => {
  const orderPlan = plan();
  const open = openOrder(orderPlan);
  const deps = dependencies({
    findRestOrder: async () => restOrder(orderPlan, {
      status: 'Cancelled',
      remainingQty: '0',
      cancelledQty: orderPlan.qty,
    }),
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

test('cancelAndConfirm uses OrderCancel receipt plus REST terminal state when precompile pages stay empty', async () => {
  const orderPlan = plan();
  const deps = dependencies({
    findOrder: async () => {
      const error = new Error('precompile page is empty');
      error.code = 'POPDEX_ORDER_NOT_FOUND';
      throw error;
    },
    findRestOrder: async () => restOrder(orderPlan, {
      status: 'Cancelled',
      remainingQty: '0',
      cancelledQty: orderPlan.qty,
    }),
  });
  const journal = fakeJournal('OPEN_CONFIRMED');

  const result = await createClient(deps).cancelAndConfirm(openOrder(orderPlan), journal);

  assert.equal(result.cancelledQtyWad, orderPlan.qtyWad);
  assert.ok(deps.calls.includes('rest:order'));
  assert.equal(deps.calls.some((call) => call.startsWith('read:order:')), false);
  assert.equal(journal.stage, 'CANCEL_CONFIRMED');
});

test('cancelAndConfirm accepts exact OrderCancel when REST removes the order and no fill or position exists', async () => {
  const orderPlan = plan();
  const deps = dependencies({
    findRestOrder: async () => {
      const error = new Error('order removed from open list');
      error.code = 'POPDEX_ORDER_NOT_FOUND';
      throw error;
    },
    getFills: async () => [],
    getPositions: async () => ({ positions: [], hasMore: false }),
  });
  const journal = fakeJournal('OPEN_CONFIRMED');

  const result = await createClient(deps).cancelAndConfirm(openOrder(orderPlan), journal);

  assert.equal(result.filledQtyWad, '0');
  assert.equal(result.remainingQtyWad, '0');
  assert.equal(result.cancelledQtyWad, orderPlan.qtyWad);
  assert.ok(deps.calls.includes('rest:fills:first'));
  assert.ok(deps.calls.includes('read:positions:0:100'));
  assert.equal(journal.stage, 'CANCEL_CONFIRMED');
});

test('cancelAndConfirm keeps recovery state when the removed REST order has an exact fill', async () => {
  const orderPlan = plan();
  const open = openOrder(orderPlan);
  const deps = dependencies({
    findRestOrder: async () => {
      const error = new Error('order removed from open list');
      error.code = 'POPDEX_ORDER_NOT_FOUND';
      throw error;
    },
    getFills: async () => [{ orderId: open.orderId, execQty: '0.0001' }],
  });
  const journal = fakeJournal('OPEN_CONFIRMED');

  await assert.rejects(
    createClient(deps).cancelAndConfirm(open, journal),
    /CANCEL_CONFIRMED.*发生成交 100000000000000.*人工处理仓位/,
  );

  assert.equal(journal.stage, 'CANCEL_BROADCAST');
  assert.equal(journal.errors.length, 1);
  assert.ok(!deps.calls.includes('read:positions:0:100'));
});

test('cancelAndConfirm keeps recovery state when the removed REST order market still has a position', async () => {
  const orderPlan = plan();
  const open = openOrder(orderPlan);
  const deps = dependencies({
    findRestOrder: async () => {
      const error = new Error('order removed from open list');
      error.code = 'POPDEX_ORDER_NOT_FOUND';
      throw error;
    },
    getFills: async () => [],
    getPositions: async () => ({
      positions: [{
        walletId: MAIN_ACCOUNT,
        symbolId: orderPlan.symbolId,
        holdSizeWad: '100000000000000',
      }],
      hasMore: false,
    }),
  });
  const journal = fakeJournal('OPEN_CONFIRMED');

  await assert.rejects(
    createClient(deps).cancelAndConfirm(open, journal),
    /CANCEL_CONFIRMED market BTCUSDT 仍有持仓 100000000000000.*人工处理/,
  );

  assert.equal(journal.stage, 'CANCEL_BROADCAST');
  assert.equal(journal.errors.length, 1);
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
    findRestOrder: async () => restOrder(orderPlan, { price: '1' }),
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
    findRestOrder: async () => restOrder(orderPlan, {
      status: 'FullyFilled',
      filledQty: orderPlan.qty,
      remainingQty: '0',
    }),
  });
  const journal = fakeJournal();
  await assert.rejects(
    createClient(deps).placeAndConfirm(orderPlan, journal),
    /OPEN_CONFIRMED REST.*filledQtyWad.*不匹配/,
  );
  assert.ok(deps.calls.includes('rest:order'));
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

test('cancel rejects an unknown symbol ID before simulation', async () => {
  const deps = dependencies();
  const journal = fakeJournal('OPEN_CONFIRMED');
  await assert.rejects(
    createClient(deps).cancelAndConfirm(openOrder(plan(), { symbolId: '99999' }), journal),
    /symbolId 99999.*不在白名单/,
  );
  assert.ok(!deps.calls.includes('write:simulate'));
  assert.equal(journal.stage, 'OPEN_CONFIRMED');
});

test('cancel confirmation stops on any fill and keeps recovery state', async () => {
  const orderPlan = plan();
  const deps = dependencies({
    findRestOrder: async () => restOrder(orderPlan, {
      status: 'PartiallyFilledCancelled',
      filledQty: '0.0001',
      remainingQty: '0',
      cancelledQty: '0.0001',
    }),
  });
  const journal = fakeJournal('OPEN_CONFIRMED');
  await assert.rejects(
    createClient(deps).cancelAndConfirm(openOrder(orderPlan), journal),
    /CANCEL_CONFIRMED.*发生成交.*人工处理仓位/,
  );
  assert.equal(journal.stage, 'CANCEL_BROADCAST');
  assert.equal(journal.errors.length, 1);
});
