import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexAccountClient } from '../src/exchange/px/account-client.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeAccountFetch(seen = []) {
  return async (input, options = {}) => {
    const url = new URL(input);
    const headers = new Headers(options.headers);
    seen.push(headers);
    if (url.origin === 'https://api.popdex.xyz' && url.pathname.endsWith('/orders')) {
      assert.equal(url.searchParams.get('limit'), '100');
      assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
      return jsonResponse({
        code: '200',
        msg: 'success',
        cursor: '90071992547409935555',
        data: {
          orders: [{
            orderId: '90071992547409931234',
            clientOrderId: '0x' + '11'.repeat(32),
            symbol: 'BTCUSDT',
            side: 'Buy',
            status: 'OPEN',
            price: '62978',
            qty: '0.0002',
            filledQty: '0',
          }],
        },
      });
    }
    if (url.origin === 'https://api.popdex.xyz' && url.pathname.endsWith('/trade/fills')) {
      assert.equal(url.searchParams.get('limit'), '100');
      assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
      return jsonResponse({
        code: '200',
        msg: 'success',
        data: {
          fills: [{
            fillId: '90071992547409939999',
            orderId: '90071992547409931234',
            symbol: 'BTCUSDT',
            side: 'Buy',
            execPrice: '62978',
            execQty: '0.0002',
          }],
        },
      });
    }
    if (url.origin === 'https://app.popdex.xyz' && url.pathname.endsWith('/overview')) {
      assert.equal(url.search, '');
      return jsonResponse({
        code: '200',
        msg: 'success',
        data: {
          balances: [{ asset: 'USDT', balance: '1000' }],
          positions: [{
            symbol: 'BTCUSDT',
            positionSide: 'LONG',
            holdQty: '0.0002',
            avgOpenPrice: '62000',
            unrealizedPnl: '-0.1956',
          }],
        },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test('account reads do not require or send a copied website bearer token', async () => {
  const seen = [];
  const client = new PopdexAccountClient({ fetchImpl: makeAccountFetch(seen) });
  await client.getOpenOrders(ACCOUNT, 'BTCUSDT');
  assert.equal(
    seen.some((headers) => headers.has('authorization') || headers.has('dy-token')),
    false,
  );
});

test('order and fill IDs remain exact strings', async () => {
  const client = new PopdexAccountClient({ fetchImpl: makeAccountFetch() });
  const orders = await client.getOpenOrders(ACCOUNT, 'BTCUSDT');
  const [order] = orders;
  assert.equal(order.orderId, '90071992547409931234');
  assert.equal(orders.cursor, '90071992547409935555');
  const [fill] = await client.getFills(ACCOUNT, 'BTCUSDT');
  assert.equal(fill.fillId, '90071992547409939999');
  assert.equal(fill.orderId, '90071992547409931234');
});

test('overview and positions are read from the official web endpoint', async () => {
  const client = new PopdexAccountClient({ fetchImpl: makeAccountFetch() });
  const overview = await client.getOverview(ACCOUNT);
  assert.equal(overview.balances[0].balance, '1000');
  assert.deepEqual(await client.getPositions(ACCOUNT), [{
    symbol: 'BTCUSDT',
    positionSide: 'LONG',
    holdQty: '0.0002',
    avgOpenPrice: '62000',
    unrealizedPnl: '-0.1956',
  }]);
});

test('account response errors and malformed arrays fail instead of becoming empty state', async () => {
  const malformedAccountFetch = async () => jsonResponse({
    code: '200',
    msg: 'success',
    data: { orders: null },
  });
  const client = new PopdexAccountClient({ fetchImpl: malformedAccountFetch });
  await assert.rejects(client.getOpenOrders(ACCOUNT, 'BTCUSDT'), /orders.*数组/);
});

test('missing account is an explicit error rather than empty state', async () => {
  const missingAccountFetch = async () => jsonResponse({
    code: '11100',
    msg: 'Account does not exist',
    data: null,
  });
  const client = new PopdexAccountClient({ fetchImpl: missingAccountFetch });
  await assert.rejects(client.getOverview(ACCOUNT), /11100.*Account does not exist/);
});
