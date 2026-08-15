import test from 'node:test';
import assert from 'node:assert/strict';
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
  const client = Object.create(RisexMainnetClient.prototype);
  client.info = {
    http: {
      async post(path, body) {
        calls.push({ path, body });
        return { success: true, order_id: 'o1' };
      },
    },
  };
  client.createPermit = async () => PERMIT_PARAMS;
  return { client, calls };
}

test('RISEx mainnet signed writes send permit_params required by the live API', async () => {
  const { client, calls } = makeClient();
  await client.updateLeverage(1, 3_000_000_000_000_000_000n);
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
  for (const { body } of calls) {
    assert.equal(body.permit_params, PERMIT_PARAMS);
    assert.equal(Object.hasOwn(body, 'permit'), false);
  }
  assert.equal(calls[0].body.leverage, '3000000000000000000');
});
