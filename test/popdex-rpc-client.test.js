import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
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
