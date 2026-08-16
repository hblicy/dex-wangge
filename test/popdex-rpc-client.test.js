import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexRpcClient } from '../src/exchange/px/rpc-client.js';

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
