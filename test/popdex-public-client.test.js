import assert from 'node:assert/strict';
import test from 'node:test';
import { PopdexPublicClient } from '../src/exchange/px/public-client.js';

const MARKETS = [
  {
    symbolId: '20001', symbol: 'ETHUSDT', category: 'Futures', status: 'Trading',
    tickSize: '0.1', lotSize: '0.001', minQty: '0.001', minNotional: '10',
    defaultLeverage: '20',
  },
  {
    symbolId: '20000', symbol: 'BTCUSDT', category: 'Futures', status: 'Trading',
    tickSize: '1', lotSize: '0.0001', minQty: '0.0001', minNotional: '10',
    defaultLeverage: '20',
  },
];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fakePublicFetch(input) {
  const url = new URL(input);
  if (url.pathname === '/api/v1/config/symbols') {
    assert.equal(url.searchParams.get('category'), 'Futures');
    return jsonResponse({ code: '200', msg: 'success', data: MARKETS });
  }
  if (url.pathname === '/api/v1/public/market/tickers') {
    assert.equal(url.searchParams.get('category'), 'Futures');
    assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
    return jsonResponse({
      code: '200',
      msg: 'success',
      data: [{
        symbol: 'BTCUSDT', bid1Price: '62978', ask1Price: '62980', lastPrice: '62979',
        indexPrice: '63009', markPrice: '62981',
      }],
    });
  }
  if (url.pathname === '/api/v1/public/market/candles') {
    assert.equal(url.searchParams.get('category'), 'Futures');
    assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
    assert.equal(url.searchParams.get('interval'), '1H');
    assert.equal(url.searchParams.get('type'), 'Market');
    assert.equal(url.searchParams.get('limit'), '2');
    return jsonResponse({
      code: '200',
      msg: 'success',
      data: [
        { time: '1786800000000', open: '62900', high: '63000', low: '62800', close: '62950' },
        { time: '1786803600000', open: '62950', high: '63100', low: '62920', close: '63050' },
      ],
    });
  }
  throw new Error(`unexpected URL ${url}`);
}

test('public client returns exactly BTCUSDT and ETHUSDT in stable order', async () => {
  const client = new PopdexPublicClient({ fetchImpl: fakePublicFetch });
  const markets = await client.getMarkets();
  assert.deepEqual(markets.map((market) => market.marketId), [20000, 20001]);
});

test('public client rejects a successful HTTP response with changed BTC precision', async () => {
  const changedPrecisionFetch = async () => jsonResponse({
    code: '200',
    msg: 'success',
    data: MARKETS.map((market) => (
      market.symbol === 'BTCUSDT' ? { ...market, tickSize: '0.5' } : market
    )),
  });
  const client = new PopdexPublicClient({ fetchImpl: changedPrecisionFetch });
  await assert.rejects(client.getMarkets(), /BTCUSDT.*tickSize/);
});

test('ticker requires positive bid ask last index and mark prices', async () => {
  const client = new PopdexPublicClient({ fetchImpl: fakePublicFetch });
  assert.deepEqual(await client.getTicker('BTCUSDT'), {
    bid: 62978,
    ask: 62980,
    last: 62979,
    index: 63009,
    mark: 62981,
  });
});

test('candles preserve millisecond timestamps and require complete positive OHLC data', async () => {
  const client = new PopdexPublicClient({ fetchImpl: fakePublicFetch });
  assert.deepEqual(await client.getCandles('BTCUSDT', '1H', 2), [
    { time: '1786800000000', open: 62900, high: 63000, low: 62800, close: 62950 },
    { time: '1786803600000', open: 62950, high: 63100, low: 62920, close: 63050 },
  ]);
});
