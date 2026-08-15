import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';
import {
  OrderType,
  Side,
  StpMode,
  TimeInForce,
} from 'risex-client';
import { RisexMainnetClient } from '../src/exchange/rs/mainnet-client.js';

const PERMIT_PARAMS = Object.freeze({
  account: '0x0000000000000000000000000000000000000001',
  signer: '0x0000000000000000000000000000000000000002',
  nonce_anchor: 1,
  nonce_bitmap_index: 2,
  deadline: 3,
  signature: 'signature',
});

function makeClient() {
  const calls = [];
  const permitHashes = [];
  const client = Object.create(RisexMainnetClient.prototype);
  client.info = {
    http: {
      async post(path, body) {
        calls.push({ path, body });
        return { success: true, order_id: 'o1' };
      },
    },
  };
  client.createPermit = async (hash) => {
    permitHashes.push(hash);
    return PERMIT_PARAMS;
  };
  return { client, calls, permitHashes };
}

test('RISEx mainnet leverage permit matches the official V1 action hash', async () => {
  const { client, permitHashes } = makeClient();
  await client.updateLeverage(1, 25n);

  const actionTypeHash = keccak256(toUtf8Bytes('RISE_PERPS_UPDATE_LEVERAGE_V1'));
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint16', 'uint8'],
    [actionTypeHash, 1, 25n],
  );
  assert.equal(permitHashes[0], keccak256(encoded));
});

test('RISEx mainnet permit signs the next official nonce anchor', async () => {
  let signedMessage;
  const client = Object.create(RisexMainnetClient.prototype);
  client.initialized = true;
  client.account = PERMIT_PARAMS.account;
  client.target = '0x0000000000000000000000000000000000000003';
  client.domain = {
    name: 'RISEx',
    version: '1',
    chainId: 4153n,
    verifyingContract: '0x0000000000000000000000000000000000000004',
  };
  client.isErc1271 = false;
  client.signerWallet = {
    address: PERMIT_PARAMS.signer,
    async signTypedData(_domain, _types, message) {
      signedMessage = message;
      return `0x${'11'.repeat(64)}1b`;
    },
  };
  client.getNonceState = async () => ({ nonce_anchor: '8', current_bitmap_index: 7 });

  const permit = await client.createPermit(`0x${'22'.repeat(32)}`);
  assert.equal(signedMessage.nonceAnchor, 9);
  assert.equal(signedMessage.nonceBitmap, 7);
  assert.equal(permit.nonce_anchor, 9);
  assert.equal(permit.nonce_bitmap_index, 7);
});

test('RISEx mainnet signed writes use endpoint-specific permit fields', async () => {
  const { client, calls } = makeClient();
  await client.updateLeverage(1, 25n);
  await client.placeOrder({
    market_id: 1,
    side: Side.Long,
    order_type: OrderType.Limit,
    price_ticks: 600_000,
    size_steps: 10,
    time_in_force: TimeInForce.GoodTillCancelled,
    post_only: false,
    reduce_only: false,
    stp_mode: StpMode.ExpireTaker,
    ttl_units: 0,
    client_order_id: '1',
  });
  await client.cancelOrder({ market_id: 1, order_id: 'o1', resting_order_id: '101' });
  await client.cancelAllOrders(1);

  assert.deepEqual(calls.map((call) => call.path), [
    '/v1/account/leverage',
    '/v1/orders/place',
    '/v1/orders/cancel',
    '/v1/orders/cancel-all',
  ]);
  assert.equal(calls[0].body.permit_params, PERMIT_PARAMS);
  assert.equal(Object.hasOwn(calls[0].body, 'permit'), false);
  for (const { body } of calls.slice(1)) {
    assert.equal(body.permit, PERMIT_PARAMS);
    assert.equal(Object.hasOwn(body, 'permit_params'), false);
  }
  assert.equal(calls[0].body.leverage, '25');
});

test('RISEx mainnet fetches one order by the exact string ID', async () => {
  const { client, calls } = makeClient();
  const id = '0x1234567890abcdef1234567890abcdef1234567890abcdef';
  client.info.http.get = async (path) => {
    calls.push({ path });
    return { order: { id, market_id: '1' } };
  };

  assert.deepEqual(await client.getOrderById(id, 1), { id, market_id: '1' });
  assert.equal(
    calls.at(-1).path,
    `/v1/orders/by-id/${encodeURIComponent(id)}?market_id=1`,
  );
});

test('RISEx mainnet single-order lookup treats only HTTP 404 as not found', async () => {
  const { client } = makeClient();
  client.info.http.get = async () => {
    throw Object.assign(new Error('not found'), { status: 404 });
  };
  assert.equal(await client.getOrderById('0xmissing', 1), null);

  client.info.http.get = async () => {
    throw Object.assign(new Error('server failed'), { status: 500 });
  };
  await assert.rejects(client.getOrderById('0xfailed', 1), /server failed/);
});
