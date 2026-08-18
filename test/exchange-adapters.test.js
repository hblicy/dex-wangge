import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtendedExchange,
  externalOrderId,
  generateOrderNonce,
} from '../src/exchange/ex/extended.js';
import {
  DecibelExchange,
  confirmedDecibelFillSize,
} from '../src/exchange/de/decibel.js';

test('Extended nonce is always in the documented inclusive range', () => {
  for (let i = 0; i < 10_000; i++) {
    const nonce = generateOrderNonce();
    assert.ok(Number.isInteger(nonce));
    assert.ok(nonce >= 1 && nonce <= 2 ** 31);
  }
});

test('Extended uses full-precision externalId and rejects numeric fallback', () => {
  assert.equal(
    externalOrderId({ id: 1784963886257016800, externalId: '1784963886257016832' }),
    '1784963886257016832',
  );
  assert.equal(externalOrderId({ id: 1784963886257016800 }), null);
});

test('Extended keeps tracking when individual cancellation fails', async () => {
  const id = '1784963886257016832';
  const exchange = new ExtendedExchange({
    apiKey: 'x', vault: '1', privateKey: '1', apiUrl: 'https://invalid.local',
  });
  exchange._tracked.set(id, { marketId: 1 });
  exchange._req = async () => { throw new Error('cancel rejected'); };

  await assert.rejects(exchange.cancelOrder(1, id), /cancel rejected/);

  assert.equal(exchange._tracked.has(id), true);
});

test('Extended mass cancellation only clears tracking after confirmed success', async () => {
  const exchange = new ExtendedExchange({
    apiKey: 'x', vault: '1', privateKey: '1', apiUrl: 'https://invalid.local',
  });
  exchange.on('error', () => {});
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD' });
  exchange._tracked.set('order-1', { marketId: 1 });
  exchange._req = async () => { throw new Error('mass cancel rejected'); };

  assert.equal(await exchange.cancelAll(1), false);
  assert.equal(exchange._tracked.has('order-1'), true);

  exchange._req = async () => ({ status: 'OK' });
  assert.equal(await exchange.cancelAll(1), true);
  assert.equal(exchange._tracked.has('order-1'), false);
});

test('Extended keeps a partially filled live order tracked', async () => {
  const exchange = new ExtendedExchange({
    apiKey: 'x', vault: '1', privateKey: '1', apiUrl: 'https://invalid.local',
  });
  const id = 'order-1';
  const tracked = {
    marketId: 1,
    externalId: id,
    side: 'buy',
    price: 100,
    sizeBase: 1,
    levelIndex: 1,
  };
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD' });
  exchange._tracked.set(id, tracked);
  exchange._get = async () => [{
    externalId: id,
    status: 'PARTIALLY_FILLED',
    filledQty: '0.25',
    remainingQty: '0.75',
  }];
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));

  await exchange._resolveGone(id, tracked);

  assert.equal(exchange._tracked.has(id), true);
  assert.equal(fills.length, 0);
});

test('Decibel partial fill returns only executed quantity', () => {
  assert.equal(
    confirmedDecibelFillSize({ orig_size: '1', remaining_size: '0.75', status: 'CANCELLED' }, 1),
    0.25,
  );
  assert.equal(
    confirmedDecibelFillSize({ orig_size: '1', remaining_size: '0', status: 'FILLED' }, 1),
    1,
  );
  assert.equal(
    confirmedDecibelFillSize({ orig_size: '1', remaining_size: '1', status: 'CANCELLED' }, 1),
    null,
  );
});

test('Decibel keeps a partially filled live order tracked', async () => {
  const exchange = new DecibelExchange({ apiKey: 'x', privateKey: '1' });
  const id = 'order-1';
  const tracked = {
    marketId: 1,
    side: 'buy',
    price: 100,
    sizeBase: 1,
    levelIndex: 1,
  };
  exchange.subaccount = '0x1';
  exchange._tracked.set(id, tracked);
  exchange.read = {
    userOrderHistory: {
      getByAddr: async () => [{
        order_id: id,
        status: 'PARTIALLY_FILLED',
        orig_size: '1',
        remaining_size: '0.75',
      }],
    },
  };
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));

  await exchange._resolveGone(id, tracked);

  assert.equal(exchange._tracked.has(id), true);
  assert.equal(fills.length, 0);
});

test('Decibel cancelAll reports failure and retains failed order tracking', async () => {
  const exchange = new DecibelExchange({ apiKey: 'x', privateKey: '1' });
  exchange.on('error', () => {});
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD', addr: '0xbtc' });
  exchange._tracked.set('order-1', { marketId: 1 });
  exchange._openOrders = async () => [{
    order_id: 'order-1', market: 'BTC-USD', is_tpsl: false,
  }];
  exchange.write = {
    cancelOrder: async () => { throw new Error('cancel rejected'); },
  };

  assert.equal(await exchange.cancelAll(1), false);
  assert.equal(exchange._tracked.has('order-1'), true);
});

test('Decibel keeps accepted cancellations tracked until explicitly forgotten', async () => {
  const exchange = new DecibelExchange({ apiKey: 'x', privateKey: '1' });
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD', addr: '0xbtc' });
  exchange._tracked.set('order-1', { marketId: 1 });
  exchange.write = { cancelOrder: async () => ({ hash: '0x1' }) };

  assert.equal(await exchange.cancelOrder(1, 'order-1'), true);
  assert.equal(exchange._tracked.has('order-1'), true);
  exchange.forgetOrder('order-1');
  assert.equal(exchange._tracked.has('order-1'), false);
});

test('Decibel cancelAll ignores tracked orders missing from one valid snapshot', async () => {
  const exchange = new DecibelExchange({ apiKey: 'x', privateKey: '1' });
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD', addr: '0xbtc' });
  exchange._tracked.set('order-1', { marketId: 1 });
  exchange._tracked.set('order-2', { marketId: 1 });
  exchange._openOrders = async () => [{ order_id: 'order-1', market: 'BTC-USD', is_tpsl: false }];
  const cancelled = [];
  exchange.write = { cancelOrder: async ({ orderId }) => { cancelled.push(orderId); } };

  assert.equal(await exchange.cancelAll(1), true);
  assert.deepEqual(cancelled, ['order-1']);
  assert.deepEqual([...exchange._tracked.keys()], ['order-1', 'order-2']);
});

test('Decibel cancelAll rejects a malformed open-order snapshot', async () => {
  const exchange = new DecibelExchange({ apiKey: 'x', privateKey: '1' });
  exchange.on('error', () => {});
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD', addr: '0xbtc' });
  exchange._openOrders = async () => null;
  let writes = 0;
  exchange.write = { cancelOrder: async () => { writes++; } };

  assert.equal(await exchange.cancelAll(1), false);
  assert.equal(writes, 0);
});
