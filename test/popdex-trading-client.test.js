import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBytes32String, keccak256, Transaction, Wallet } from 'ethers';
import {
  POPDEX_ORDER_INTERFACE,
  prepareLimitOrder,
  prepareProbeOrder,
} from '../src/exchange/px/order-codec.js';
import {
  POPDEX_USER_CONFIG_INTERFACE,
  createBtcCloseClientOrderId,
} from '../src/exchange/px/fill-close-codec.js';
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

function adapterPlan() {
  return prepareLimitOrder({
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

function genericJournal(initialStage = 'PREPARED') {
  return {
    stage: initialStage,
    advances: [],
    errors: [],
    advance(expected, next, fields = {}) {
      if (this.stage !== expected) {
        throw new Error(`PopDEX operation journal 当前阶段 ${this.stage}，不是 ${expected}。`);
      }
      this.stage = next;
      this.advances.push({ expected, next, fields });
      return { stage: next, ...fields };
    },
    completePreparedWithoutBroadcast(outcome) {
      assert.equal(this.stage, 'PREPARED');
      assert.equal(outcome, 'safe-no-broadcast');
      this.stage = 'CONFIRMED';
      this.advances.push({ expected: 'PREPARED', next: 'CONFIRMED', fields: { outcome } });
      return { stage: this.stage, outcome, txHash: null };
    },
    recordError(expected, error) {
      if (this.stage !== expected) {
        throw new Error(`PopDEX operation journal 当前阶段 ${this.stage}，不是 ${expected}。`);
      }
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
  getAllPositions,
  getAllOpenOrders,
  getAllFills,
  getAccountConfig,
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
      async getAllOpenPositions(account) {
        calls.push('read:all-positions');
        if (getAllPositions) return getAllPositions(account);
        return [];
      },
      async getAccountConfig(account) {
        calls.push('read:account-config');
        if (getAccountConfig) return getAccountConfig(account);
        return { positionMode: '0', symbolLeverages: [{ symbolId: '20000', leverage: '1' }] };
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
      async getAllOpenOrders(account, symbol) {
        calls.push('rest:all-open');
        if (getAllOpenOrders) return getAllOpenOrders(account, symbol);
        return [];
      },
      async getAllFills(account, symbol) {
        calls.push('rest:all-fills');
        if (getAllFills) return getAllFills(account, symbol);
        return [];
      },
    },
    writeRpc: {
      async verifyChain() { calls.push('write:chain'); return 2184n; },
      async simulate(transaction) {
        calls.push('write:simulate');
        if (simulate) return simulate(transaction);
        try {
          POPDEX_ORDER_INTERFACE.parseTransaction({ data: transaction.data });
        } catch {
          POPDEX_USER_CONFIG_INTERFACE.parseTransaction({ data: transaction.data });
        }
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

function leverageReceipt(hash) {
  const event = POPDEX_USER_CONFIG_INTERFACE.encodeEventLog(
    POPDEX_USER_CONFIG_INTERFACE.getEvent('LeverageUpdated'),
    [MAIN_ACCOUNT, 2, 20000, '0x0000000000000000000000000000000000000000', 1, true, 0],
  );
  return {
    transactionHash: hash,
    status: '0x1',
    logs: [{
      address: '0x0000000000000000000000000000000000001009',
      data: event.data,
      topics: event.topics,
    }],
  };
}

function closeReceipt(hash, closeClientOrderId) {
  const event = POPDEX_ORDER_EVENT_INTERFACE.encodeEventLog(
    POPDEX_ORDER_EVENT_INTERFACE.getEvent('OrderCreate'),
    [
      MAIN_ACCOUNT,
      '20000',
      '90071992547409931235',
      closeClientOrderId,
      '62901000000000000000000',
      '200000000000000',
      '0',
      2,
      true,
      0,
    ],
  );
  return {
    transactionHash: hash,
    status: '0x1',
    logs: [{
      address: '0x0000000000000000000000000000000000001000',
      data: event.data,
      topics: event.topics,
    }],
  };
}

test('placeAdapterOrder uses generic stages and confirms exact REST identity', async () => {
  const orderPlan = adapterPlan();
  const deps = dependencies({ findRestOrder: async () => restOrder(orderPlan) });
  const journal = genericJournal();
  const result = await createClient(deps).placeAdapterOrder(orderPlan, journal);

  assert.equal(result.orderId, '90071992547409931234');
  assert.deepEqual(journal.advances.map((entry) => entry.next), ['BROADCAST', 'CONFIRMED']);
  assert.equal(journal.advances[0].fields.txHash, keccak256(deps.serialized[0]));
});

test('setAdapterBtcLeverageOne skips an already exact setting without broadcasting', async () => {
  const deps = dependencies();
  const journal = genericJournal();
  const result = await createClient(deps).setAdapterBtcLeverageOne(journal);

  assert.deepEqual(result, { leverage: '1', changed: false });
  assert.equal(journal.stage, 'CONFIRMED');
  assert.equal(deps.serialized.length, 0);
});

test('setAdapterBtcLeverageOne broadcasts once and confirms exact receipt plus readback', async () => {
  let reads = 0;
  const deps = dependencies({
    getAccountConfig: async () => {
      reads += 1;
      return {
        positionMode: '0',
        symbolLeverages: reads === 1 ? [] : [{ symbolId: '20000', leverage: '1' }],
      };
    },
    waitReceipt: async (hash) => leverageReceipt(hash),
  });
  const journal = genericJournal();
  const result = await createClient(deps).setAdapterBtcLeverageOne(journal);

  assert.equal(result.changed, true);
  assert.equal(journal.stage, 'CONFIRMED');
  assert.equal(deps.serialized.length, 1);
});

test('cancelAdapterOrder uses generic stages and exact terminal confirmation', async () => {
  const orderPlan = adapterPlan();
  const deps = dependencies({
    findRestOrder: async () => restOrder(orderPlan, {
      status: 'Cancelled', remainingQty: '0', cancelledQty: orderPlan.qty,
    }),
  });
  const journal = genericJournal();
  const result = await createClient(deps).cancelAdapterOrder(openOrder(orderPlan), journal);

  assert.equal(result.cancelledQtyWad, orderPlan.qtyWad);
  assert.deepEqual(journal.advances.map((entry) => entry.next), ['BROADCAST', 'CONFIRMED']);
});

test('closeAdapterBtcLong confirms positive execution receipt fill and flat official position', async () => {
  const closeClientOrderId = createBtcCloseClientOrderId(
    Uint8Array.from({ length: 16 }, (_, index) => index + 1),
  );
  let positionReads = 0;
  const deps = dependencies({
    getAllPositions: async () => {
      positionReads += 1;
      if (positionReads === 1) {
        return [{
          walletId: MAIN_ACCOUNT,
          symbol: 'BTCUSDT',
          symbolId: '20000',
          positionId: '7',
          side: '1',
          holdSizeWad: '200000000000000',
        }];
      }
      return [];
    },
    getAllFills: async () => [{
      fillId: '8',
      orderId: '90071992547409931235',
      symbol: 'BTCUSDT',
      side: 'Sell',
      execQty: '0.0002',
      execPrice: '62901',
    }],
    waitReceipt: async (hash) => closeReceipt(hash, closeClientOrderId),
  });
  const journal = genericJournal();
  const result = await createClient(deps).closeAdapterBtcLong({
    positionId: '7',
    qtyWad: '200000000000000',
    closeClientOrderId,
  }, journal);

  assert.equal(result.closeOrderId, '90071992547409931235');
  assert.equal(result.positionQtyWad, '0');
  assert.equal(journal.stage, 'CONFIRMED');
});

test('closeAdapterBtcLong keeps BROADCAST when official fill and position facts never settle', async () => {
  const closeClientOrderId = createBtcCloseClientOrderId(
    Uint8Array.from({ length: 16 }, (_, index) => index + 1),
  );
  const livePosition = {
    walletId: MAIN_ACCOUNT,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    positionId: '7',
    side: '1',
    holdSizeWad: '200000000000000',
  };
  const deps = dependencies({
    getAllPositions: async () => [livePosition],
    getAllFills: async () => [],
    waitReceipt: async (hash) => closeReceipt(hash, closeClientOrderId),
  });
  const journal = genericJournal();

  await assert.rejects(createClient(deps).closeAdapterBtcLong({
    positionId: '7',
    qtyWad: '200000000000000',
    closeClientOrderId,
  }, journal), /close CONFIRMED 超时.*remaining=200000000000000/);

  assert.equal(journal.stage, 'BROADCAST');
  assert.equal(journal.errors.length, 1);
  assert.equal(deps.serialized.length, 1);
});

test('adapter uncertain confirmation retains BROADCAST and never broadcasts twice', async () => {
  const orderPlan = adapterPlan();
  let attempts = 0;
  const deps = dependencies({
    findRestOrder: async () => restOrder(orderPlan, { price: '1' }),
    broadcast: async (raw) => { attempts += 1; return keccak256(raw); },
  });
  const journal = genericJournal();
  const client = createClient(deps);
  await assert.rejects(client.placeAdapterOrder(orderPlan, journal), /priceWad.*不匹配/);
  assert.equal(journal.stage, 'BROADCAST');
  assert.equal(attempts, 1);
  await assert.rejects(client.placeAdapterOrder(orderPlan, journal), /PREPARED|当前阶段/);
  assert.equal(attempts, 1);
});

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
