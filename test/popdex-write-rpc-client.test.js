import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexWriteRpcClient } from '../src/exchange/px/write-rpc-client.js';

const AGENT = '0x2222222222222222222222222222222222222222';
const ORDER_PRECOMPILE = '0x0000000000000000000000000000000000001000';
const RAW_TRANSACTION = `0x${'01'.repeat(120)}`;
const TX_HASH = `0x${'ab'.repeat(32)}`;

function rpcResponse(request, result, status = 200) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result,
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('write RPC verifies chain and simulates without broadcasting', async () => {
  const requests = [];
  const client = new PopdexWriteRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return rpcResponse(request, request.method === 'eth_chainId' ? '0x888' : '0x');
    },
  });

  assert.equal(await client.verifyChain(), 2184n);
  assert.equal(await client.simulate({
    from: AGENT,
    to: ORDER_PRECOMPILE,
    data: '0x1234',
    value: '0x0',
  }), '0x');
  assert.deepEqual(requests.map((request) => request.method), ['eth_chainId', 'eth_call']);
  assert.deepEqual(requests[1].params, [[{
    from: AGENT,
    to: ORDER_PRECOMPILE,
    data: '0x1234',
    value: '0x0',
  }][0], 'latest']);
});

test('write RPC broadcasts one exact serialized transaction and preserves txHash', async () => {
  let captured;
  const client = new PopdexWriteRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      captured = request;
      return rpcResponse(request, TX_HASH);
    },
  });
  assert.equal(await client.broadcast(RAW_TRANSACTION), TX_HASH);
  assert.equal(captured.method, 'eth_sendRawTransaction');
  assert.deepEqual(captured.params, [RAW_TRANSACTION]);
});

test('write RPC accepts only the official HTTPS endpoint and exact write inputs', async () => {
  assert.throws(
    () => new PopdexWriteRpcClient({ rpcUrl: 'https://rpc.example/' }),
    /RPC.*官方/,
  );
  assert.throws(
    () => new PopdexWriteRpcClient({ rpcUrl: 'http://app.popdex.xyz/api/v1/web3/rpc' }),
    /RPC.*官方/,
  );
  const client = new PopdexWriteRpcClient({ fetchImpl: async () => { throw new Error('unexpected'); } });
  await assert.rejects(client.broadcast('0x1'), /serializedTransaction.*偶数/);
  await assert.rejects(client.broadcast('not-hex'), /serializedTransaction.*十六进制/);
  await assert.rejects(client.getReceipt('0x12'), /txHash.*32 字节/);
});

test('write RPC exposes JSON-RPC error data without leaking a raw transaction', async () => {
  const client = new PopdexWriteRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: 'rejected', data: { reason: 'bad nonce' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await assert.rejects(client.broadcast(RAW_TRANSACTION), (error) => {
    assert.match(error.message, /eth_sendRawTransaction.*-32000.*rejected.*bad nonce/);
    assert.doesNotMatch(error.message, new RegExp(RAW_TRANSACTION.slice(2), 'i'));
    return true;
  });
});

test('waitForReceipt returns only an explicit successful receipt', async () => {
  let attempts = 0;
  let now = 1000;
  const client = new PopdexWriteRpcClient({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      attempts += 1;
      return rpcResponse(request, attempts === 1 ? null : { transactionHash: TX_HASH, status: '0x1' });
    },
  });
  const receipt = await client.waitForReceipt(TX_HASH, { timeoutMs: 5000, pollMs: 1000 });
  assert.equal(receipt.transactionHash, TX_HASH);
  assert.equal(attempts, 2);
});

test('waitForReceipt reports explicit failure details and timeout without rebroadcast', async () => {
  const methods = [];
  const failed = new PopdexWriteRpcClient({
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      methods.push(request.method);
      return rpcResponse(
        request,
        request.method === 'eth_getTransactionReceipt'
          ? { transactionHash: TX_HASH, status: '0x0' }
          : { reason: 'order rejected' },
      );
    },
  });
  await assert.rejects(failed.waitForReceipt(TX_HASH), /回执失败.*order rejected/);
  assert.deepEqual(methods, ['eth_getTransactionReceipt', 'core_getTransactionFailure']);

  let now = 0;
  const timedOut = new PopdexWriteRpcClient({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async (_input, options) => {
      const request = JSON.parse(options.body);
      methods.push(request.method);
      return rpcResponse(request, null);
    },
  });
  await assert.rejects(
    timedOut.waitForReceipt(TX_HASH, { timeoutMs: 2000, pollMs: 1000 }),
    new RegExp(`超时.*${TX_HASH}`),
  );
  assert.ok(!methods.includes('eth_sendRawTransaction'));
});
