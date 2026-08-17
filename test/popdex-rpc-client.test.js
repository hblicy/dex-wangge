import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, parseUnits, ZeroAddress } from 'ethers';
import {
  agentNameBytes32,
  POPDEX_ACCOUNT_INTERFACE,
} from '../src/exchange/px/agent.js';
import { PopdexRpcClient } from '../src/exchange/px/rpc-client.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';
const ORDER_PRECOMPILE = '0x0000000000000000000000000000000000001000';
const ACCOUNT_PRECOMPILE = '0x0000000000000000000000000000000000001008';
const OPEN_POSITIONS_ABI = [
  'function getOpenPositionsByAccount(address account,uint32 offset,uint32 limit) view returns ((tuple(address walletId,uint128 positionId,uint16 symbolId,uint8 side,uint256 holdSize,uint256 avgOpenPrice,uint256 closeSize,uint256 lockedSize,int256 realizedPnl,uint64 createdTime,uint64 updatedTime)[] positions,bool hasMore) page)',
];
const ORDER_PAGE_ABI = [
  'function getActiveOrdersByAccount(address account,uint32 offset,uint32 limit) view returns ((tuple(address walletId,uint8 category,uint8 source,uint128 orderId,bytes32 clientOrderId,uint16 symbolId,uint8 side,bool isReduceOnly,uint8 orderType,uint8 timeInForce,uint8 stpMode,address stpKey,uint8 status,uint256 price,tuple(uint256 qty,uint256 filledQty,uint256 remainingQty,uint256 cancelledQty,uint256 quoteQty,uint256 filledQuoteQty,uint256 remainingQuoteQty,uint256 cancelledQuoteQty) quantities,uint256 averagePrice,uint64 nonce,uint64 createdAt,uint64 updatedAt,uint256 makerFeeRate,uint256 takerFeeRate)[] orders,bool hasMore) page)',
  'function getCompletedOrdersByAccount(address account,uint32 offset,uint32 limit) view returns ((tuple(address walletId,uint8 category,uint8 source,uint128 orderId,bytes32 clientOrderId,uint16 symbolId,uint8 side,bool isReduceOnly,uint8 orderType,uint8 timeInForce,uint8 stpMode,address stpKey,uint8 status,uint256 price,tuple(uint256 qty,uint256 filledQty,uint256 remainingQty,uint256 cancelledQty,uint256 quoteQty,uint256 filledQuoteQty,uint256 remainingQuoteQty,uint256 cancelledQuoteQty) quantities,uint256 averagePrice,uint64 nonce,uint64 createdAt,uint64 updatedAt,uint256 makerFeeRate,uint256 takerFeeRate)[] orders,bool hasMore) page)',
];

function chainOrder(overrides = {}) {
  const qty = parseUnits('0.0002', 18);
  return {
    walletId: ACCOUNT,
    category: 2,
    source: 0,
    orderId: 90071992547409931234n,
    clientOrderId: `0x${'12'.repeat(32)}`,
    symbolId: 20000,
    side: 0,
    isReduceOnly: false,
    orderType: 0,
    timeInForce: 1,
    stpMode: 0,
    stpKey: ZeroAddress,
    status: 1,
    price: parseUnits('60000', 18),
    quantities: {
      qty,
      filledQty: 0n,
      remainingQty: qty,
      cancelledQty: 0n,
      quoteQty: 0n,
      filledQuoteQty: 0n,
      remainingQuoteQty: 0n,
      cancelledQuoteQty: 0n,
    },
    averagePrice: 0n,
    nonce: 1786946400000n,
    createdAt: 1786946400000n,
    updatedAt: 1786946400000n,
    makerFeeRate: 0n,
    takerFeeRate: 0n,
    ...overrides,
  };
}

function rpcResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcFetch(chainId) {
  return async (_input, options) => {
    assert.equal(options.method, 'POST');
    const request = JSON.parse(options.body);
    assert.equal(request.method, 'eth_chainId');
    return rpcResponse({ jsonrpc: '2.0', id: request.id, result: chainId });
  };
}

test('RPC client requires chainId 2184', async () => {
  const client = new PopdexRpcClient({ fetchImpl: rpcFetch('0x888') });
  assert.equal(await client.verifyChain(), 2184n);
});

test('RPC client rejects another chain before any protocol call', async () => {
  const client = new PopdexRpcClient({ fetchImpl: rpcFetch('0x1') });
  await assert.rejects(client.verifyChain(), /2184/);
});

test('RPC client preserves JSON-RPC error code data and nested network cause', async () => {
  const failingRpcFetch = async (_input, options) => {
    const request = JSON.parse(options.body);
    return rpcResponse({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32602, message: 'invalid params', data: { field: 'hash' } },
    });
  };
  const client = new PopdexRpcClient({ fetchImpl: failingRpcFetch });
  await assert.rejects(
    client.call('eth_getTransactionByHash', ['0x' + '11'.repeat(32)]),
    /-32602.*invalid params.*hash/,
  );

  const networkClient = new PopdexRpcClient({
    fetchImpl: async () => {
      throw new TypeError('fetch failed', { cause: new Error('connection reset') });
    },
  });
  await assert.rejects(networkClient.verifyChain(), /fetch failed.*connection reset/);
});

test('RPC client rejects transaction broadcasts before fetch', async () => {
  let calls = 0;
  const client = new PopdexRpcClient({ fetchImpl: async () => { calls += 1; } });
  await assert.rejects(client.call('eth_sendRawTransaction', ['0x00']), /只读.*eth_sendRawTransaction/);
  await assert.rejects(client.call('eth_sendTransaction', [{}]), /只读.*eth_sendTransaction/);
  assert.equal(calls, 0);
});

test('transaction and receipt helpers preserve exact hashes and null results', async () => {
  const hash = '0x' + '22'.repeat(32);
  const methods = [];
  const client = new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      methods.push(request.method);
      return rpcResponse({ jsonrpc: '2.0', id: request.id, result: null });
    },
  });
  assert.equal(await client.getTransaction(hash), null);
  assert.equal(await client.getReceipt(hash), null);
  assert.equal(await client.getTransactionFailure(hash), null);
  assert.deepEqual(methods, [
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
    'core_getTransactionFailure',
  ]);
});

test('RPC client reads official open-position precompile without losing uint values', async () => {
  const iface = new Interface(OPEN_POSITIONS_ABI);
  const client = new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'eth_call');
      assert.equal(request.params[0].to, ORDER_PRECOMPILE);
      assert.deepEqual(
        iface.decodeFunctionData('getOpenPositionsByAccount', request.params[0].data)
          .map(String),
        [ACCOUNT, '0', '100'],
      );
      return rpcResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: iface.encodeFunctionResult('getOpenPositionsByAccount', [[[
          [
            ACCOUNT,
            90071992547409931234n,
            20000,
            0,
            200000000000000n,
            62978000000000000000000n,
            0,
            0,
            -125000000000000000n,
            1786800000,
            1786800001,
          ],
        ], false]]),
      });
    },
  });

  assert.deepEqual(await client.getOpenPositions(ACCOUNT), {
    positions: [{
      walletId: ACCOUNT,
      positionId: '90071992547409931234',
      symbolId: '20000',
      side: '0',
      holdSizeWad: '200000000000000',
      avgOpenPriceWad: '62978000000000000000000',
      closeSizeWad: '0',
      lockedSizeWad: '0',
      realizedPnlWad: '-125000000000000000',
      createdTime: '1786800000',
      updatedTime: '1786800001',
    }],
    hasMore: false,
  });
});

test('RPC client reads official active orders without losing uint values', async () => {
  const iface = new Interface(ORDER_PAGE_ABI);
  const order = chainOrder();
  const client = new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'eth_call');
      assert.equal(request.params[0].to, ORDER_PRECOMPILE);
      assert.deepEqual(
        iface.decodeFunctionData('getActiveOrdersByAccount', request.params[0].data).map(String),
        [ACCOUNT, '0', '100'],
      );
      return rpcResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: iface.encodeFunctionResult('getActiveOrdersByAccount', [{
          orders: [order],
          hasMore: false,
        }]),
      });
    },
  });

  assert.deepEqual(await client.getActiveOrders(ACCOUNT), {
    orders: [{
      walletId: ACCOUNT,
      category: '2',
      source: '0',
      orderId: '90071992547409931234',
      clientOrderId: `0x${'12'.repeat(32)}`,
      symbolId: '20000',
      side: '0',
      isReduceOnly: false,
      orderType: '0',
      timeInForce: '1',
      stpMode: '0',
      stpKey: ZeroAddress,
      status: '1',
      priceWad: parseUnits('60000', 18).toString(),
      qtyWad: parseUnits('0.0002', 18).toString(),
      filledQtyWad: '0',
      remainingQtyWad: parseUnits('0.0002', 18).toString(),
      cancelledQtyWad: '0',
      quoteQtyWad: '0',
      filledQuoteQtyWad: '0',
      remainingQuoteQtyWad: '0',
      cancelledQuoteQtyWad: '0',
      averagePriceWad: '0',
      nonce: '1786946400000',
      createdAt: '1786946400000',
      updatedAt: '1786946400000',
      makerFeeRateWad: '0',
      takerFeeRateWad: '0',
    }],
    hasMore: false,
  });
});

test('RPC client finds one completed order by clientOrderId across bounded pages', async () => {
  const iface = new Interface(ORDER_PAGE_ABI);
  const wanted = `0x${'34'.repeat(32)}`;
  const offsets = [];
  const client = new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      const decoded = iface.decodeFunctionData(
        'getCompletedOrdersByAccount',
        request.params[0].data,
      );
      offsets.push(Number(decoded.offset));
      const secondPage = decoded.offset === 100n;
      return rpcResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: iface.encodeFunctionResult('getCompletedOrdersByAccount', [{
          orders: secondPage
            ? [chainOrder({ clientOrderId: wanted, status: 4 })]
            : [chainOrder({ clientOrderId: `0x${'56'.repeat(32)}` })],
          hasMore: !secondPage,
        }]),
      });
    },
  });

  const result = await client.findUniqueOrderByClientId(ACCOUNT, wanted, {
    completed: true,
    maxPages: 2,
  });
  assert.equal(result.clientOrderId, wanted);
  assert.equal(result.status, '4');
  assert.deepEqual(offsets, [0, 100]);
});

test('RPC client rejects missing, duplicate and inconsistent on-chain orders', async () => {
  const iface = new Interface(ORDER_PAGE_ABI);
  const wanted = `0x${'78'.repeat(32)}`;
  const clientFor = (orders) => new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      return rpcResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: iface.encodeFunctionResult('getActiveOrdersByAccount', [{ orders, hasMore: false }]),
      });
    },
  });

  await assert.rejects(
    clientFor([]).findUniqueOrderByClientId(ACCOUNT, wanted),
    /clientOrderId.*未找到/,
  );
  await assert.rejects(
    clientFor([
      chainOrder({ clientOrderId: wanted }),
      chainOrder({ orderId: 90071992547409931235n, clientOrderId: wanted }),
    ]).findUniqueOrderByClientId(ACCOUNT, wanted),
    /clientOrderId.*重复/,
  );
  const qty = parseUnits('0.0002', 18);
  await assert.rejects(
    clientFor([chainOrder({
      clientOrderId: wanted,
      quantities: {
        ...chainOrder().quantities,
        filledQty: qty,
        remainingQty: qty,
      },
    })]).getActiveOrders(ACCOUNT),
    /qty.*filledQty.*remainingQty.*cancelledQty/,
  );
  await assert.rejects(
    clientFor([chainOrder({ walletId: AGENT, clientOrderId: wanted })]).getActiveOrders(ACCOUNT),
    /walletId.*account.*不匹配/,
  );
  await assert.rejects(
    clientFor([chainOrder({ symbolId: 20002, clientOrderId: wanted })]).getActiveOrders(ACCOUNT),
    /symbolId.*白名单/,
  );
});

test('RPC client stops order pagination at maxPages', async () => {
  const iface = new Interface(ORDER_PAGE_ABI);
  const client = new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      return rpcResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: iface.encodeFunctionResult('getActiveOrdersByAccount', [{
          orders: [],
          hasMore: true,
        }]),
      });
    },
  });
  await assert.rejects(
    client.findUniqueOrderByClientId(ACCOUNT, `0x${'90'.repeat(32)}`, { maxPages: 1 }),
    /分页超过.*1/,
  );
});

test('RPC client reads exact official Agent authorization fields', async () => {
  const name = agentNameBytes32('vps.example');
  const client = new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'eth_call');
      assert.equal(request.params[0].to, ACCOUNT_PRECOMPILE);
      const decoded = POPDEX_ACCOUNT_INTERFACE.decodeFunctionData(
        'getAgentInfo',
        request.params[0].data,
      );
      assert.equal(decoded.agent, AGENT);
      return rpcResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: POPDEX_ACCOUNT_INTERFACE.encodeFunctionResult('getAgentInfo', [
          true,
          1789531200123n,
          false,
          ACCOUNT,
          name,
          false,
        ]),
      });
    },
  });

  assert.deepEqual(await client.getAgentInfo(AGENT), {
    exists: true,
    expiresAt: '1789531200123',
    isExpired: false,
    delegator: ACCOUNT,
    name,
    isGlobal: false,
  });
});

test('RPC client reads Agent lists without losing uint64 values', async () => {
  const name = agentNameBytes32('vps.example');
  const client = new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'eth_call');
      const decoded = POPDEX_ACCOUNT_INTERFACE.decodeFunctionData(
        'getAgents',
        request.params[0].data,
      );
      assert.equal(decoded.delegator, ACCOUNT);
      return rpcResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: POPDEX_ACCOUNT_INTERFACE.encodeFunctionResult('getAgents', [
          [AGENT],
          [1789531200123n],
          [false],
          [name],
          [false],
        ]),
      });
    },
  });

  assert.deepEqual(await client.getAgents(ACCOUNT), [{
    agent: AGENT,
    expiresAt: '1789531200123',
    isExpired: false,
    name,
    isGlobal: false,
  }]);
});

test('RPC client rejects inconsistent or malformed Agent results', async () => {
  const name = agentNameBytes32('vps.example');
  const uneven = new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      return rpcResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: POPDEX_ACCOUNT_INTERFACE.encodeFunctionResult('getAgents', [
          [AGENT],
          [],
          [false],
          [name],
          [false],
        ]),
      });
    },
  });
  await assert.rejects(uneven.getAgents(ACCOUNT), /数组长度不一致/);

  const malformed = new PopdexRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      return rpcResponse({ jsonrpc: '2.0', id: request.id, result: '0x1234' });
    },
  });
  await assert.rejects(malformed.getAgentInfo(AGENT), /getAgentInfo.*解码失败/);
});
