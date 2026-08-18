import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeBytes32String } from 'ethers';
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
            clientOid: 'dw-bb-111111111111111111111111',
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
        },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

function accountClientFromPages(pages) {
  return new PopdexAccountClient({
    fetchImpl: async (input) => {
      const url = new URL(input);
      const key = `${url.pathname.endsWith('/trade/fills') ? 'fills' : 'orders'}:${String(url.searchParams.get('cursor'))}`;
      const page = pages.get(key);
      if (!page) throw new Error(`unexpected page ${key}`);
      return jsonResponse({
        code: '200',
        msg: 'success',
        data: page.data,
        cursor: page.cursor,
      });
    },
  });
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
  assert.equal(order.clientOid, 'dw-bb-111111111111111111111111');
  assert.equal(orders.cursor, '90071992547409935555');
  const [fill] = await client.getFills(ACCOUNT, 'BTCUSDT');
  assert.equal(fill.fillId, '90071992547409939999');
  assert.equal(fill.orderId, '90071992547409931234');
});

test('REST order lookup matches the bytes32 client ID through the official clientOid string', async () => {
  const client = new PopdexAccountClient({ fetchImpl: makeAccountFetch() });
  const clientOrderId = encodeBytes32String('dw-bb-111111111111111111111111');
  const order = await client.findUniqueOrderByClientId(ACCOUNT, 'BTCUSDT', clientOrderId);
  assert.equal(order.orderId, '90071992547409931234');
  assert.equal(order.clientOid, 'dw-bb-111111111111111111111111');
});

test('overview is read without assuming it contains positions', async () => {
  const client = new PopdexAccountClient({ fetchImpl: makeAccountFetch() });
  const overview = await client.getOverview(ACCOUNT);
  assert.equal(overview.balances[0].balance, '1000');
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

test('account client collects all fills and rejects a repeated cursor', async () => {
  const fill = (fillId) => ({
    fillId,
    orderId: '9',
    symbol: 'BTCUSDT',
    side: 'Buy',
    execPrice: '63000',
    execQty: '0.0001',
  });
  const client = accountClientFromPages(new Map([
    ['fills:null', { data: [fill('1')], cursor: '7' }],
    ['fills:7', { data: [fill('2')], cursor: '' }],
  ]));
  const rows = await client.getAllFills(ACCOUNT, 'BTCUSDT');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.pageInfo, { pages: 2, cursors: ['7'], rows: 2 });
  assert.equal(Object.keys(rows).includes('pageInfo'), false);

  const repeated = accountClientFromPages(new Map([
    ['fills:null', { data: [], cursor: '7' }],
    ['fills:7', { data: [], cursor: '7' }],
  ]));
  await assert.rejects(repeated.getAllFills(ACCOUNT, 'BTCUSDT'), /cursor.*重复/);
});

test('account client collects all open orders with bounded strict pagination', async () => {
  const order = (orderId) => ({
    orderId,
    clientOid: `dw-bb-${orderId.padStart(24, '0')}`,
    symbol: 'BTCUSDT',
    side: 'Buy',
    status: 'OPEN',
    price: '60000',
    qty: '0.0002',
    filledQty: '0',
  });
  const client = accountClientFromPages(new Map([
    ['orders:null', { data: { orders: [order('1')] }, cursor: '7' }],
    ['orders:7', { data: { orders: [order('2')] }, cursor: '' }],
  ]));
  const rows = await client.getAllOpenOrders(ACCOUNT, 'BTCUSDT');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.pageInfo, { pages: 2, cursors: ['7'], rows: 2 });
  assert.equal(Object.keys(rows).includes('pageInfo'), false);

  const history = await client.getAllOrderHistory(ACCOUNT, 'BTCUSDT');
  assert.equal(history.length, 2);
  assert.deepEqual(history.pageInfo, { pages: 2, cursors: ['7'], rows: 2 });

  const repeated = accountClientFromPages(new Map([
    ['orders:null', { data: { orders: [] }, cursor: '7' }],
    ['orders:7', { data: { orders: [] }, cursor: '7' }],
  ]));
  await assert.rejects(repeated.getAllOpenOrders(ACCOUNT, 'BTCUSDT'), /cursor.*重复/);

  const endlessPages = new Map();
  endlessPages.set('orders:null', { data: { orders: [] }, cursor: '1' });
  for (let page = 1; page <= 10; page += 1) {
    endlessPages.set(`orders:${page}`, {
      data: { orders: [] },
      cursor: String(page + 1),
    });
  }
  await assert.rejects(
    accountClientFromPages(endlessPages).getAllOpenOrders(ACCOUNT, 'BTCUSDT'),
    /分页超过.*10/,
  );

  const malformed = accountClientFromPages(new Map([
    ['orders:null', { data: { orders: null }, cursor: '' }],
  ]));
  await assert.rejects(malformed.getAllOpenOrders(ACCOUNT, 'BTCUSDT'), /orders.*数组/);
});
