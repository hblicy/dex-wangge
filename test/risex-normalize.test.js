import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareRisexCursor,
  normalizeRestFill,
  normalizeRestOpenOrder,
  normalizeRestOrderHistory,
  normalizeRestPosition,
  normalizeRisexMarkets,
  parseFillEnvelope,
  parseOrderEnvelope,
  wadToNumber,
} from '../src/exchange/rs/normalize.js';

const btc = {
  market_id: '1', display_name: 'BTC-USD', base_asset_symbol: 'BTC',
  last_price: '60000', mark_price: '60001', visible: true,
  config: { step_size: '0.0001', step_price: '0.1', min_order_size: '0.001', max_leverage: '50' },
};
const eth = {
  market_id: '2', display_name: 'ETH-USD', base_asset_symbol: 'ETH',
  last_price: '3000', mark_price: '3001', visible: true,
  config: { step_size: '0.001', step_price: '0.01', min_order_size: '0.01', max_leverage: '50' },
};
const WAD = 10n ** 18n;
const wad = (value) => (BigInt(value) * WAD).toString();

const rawOrder = {
  id: '0x00000000000125b1000000000124ded20000000000000125', market_id: '1', side: 'BUY',
  size: '0.004447', price: '61000',
  filled_size: '0', avg_price: '0',
  status: 'ORDER_STATUS_OPEN', sender: '0xAbC', block_number: '12', log_index: '3',
};

function orderEnvelope(order = rawOrder) {
  return { channel: 'orders', type: 'update', timestamp: '99', data: [order] };
}

test('wadToNumber parses signed 18-decimal integer strings only', () => {
  assert.equal(wadToNumber('61788900000000000000000', 'price'), 61788.9);
  assert.equal(wadToNumber('2600000000000000', 'size'), 0.0026);
  assert.equal(wadToNumber('-1000000000000000000', 'pnl'), -1);
  assert.throws(() => wadToNumber('0.0026', 'size'), /WAD 整数字符串/);
  assert.throws(() => wadToNumber(Number.MAX_SAFE_INTEGER, 'size'), /WAD 整数字符串/);
});

test('market normalization exposes exactly BTC-PERP and ETH-PERP', () => {
  const markets = normalizeRisexMarkets([
    btc, eth,
    { market_id: '3', display_name: 'SOL-USD', base_asset_symbol: 'SOL', last_price: '100', config: { step_size: '0.1', step_price: '0.01', min_order_size: '1', max_leverage: '20' } },
  ]);
  assert.deepEqual(markets.map((m) => m.displayName), ['BTC-PERP', 'ETH-PERP']);
  assert.deepEqual(markets.map((m) => m.marketId), [1, 2]);
  assert.equal(markets[0].lastPrice, 60001);
});

test('market normalization accepts the current official USDC pair schema', () => {
  const markets = normalizeRisexMarkets([
    {
      ...btc,
      display_name: 'BTC/USDC',
      base_asset_symbol: 'BTC/USDC',
      visible: undefined,
      config: { ...btc.config, name: 'BTC/USDC', unlocked: true },
    },
    {
      ...eth,
      display_name: 'ETH/USDC',
      base_asset_symbol: 'ETH/USDC',
      visible: undefined,
      config: { ...eth.config, name: 'ETH/USDC', unlocked: true },
    },
  ]);

  assert.deepEqual(markets.map((market) => market.displayName), ['BTC-PERP', 'ETH-PERP']);
  assert.throws(() => normalizeRisexMarkets([
    {
      ...btc,
      display_name: 'BTC/USDC',
      base_asset_symbol: 'BTC/USDC',
      visible: undefined,
      config: { ...btc.config, name: 'BTC/USDC', unlocked: false },
    },
    eth,
  ]), /BTC-PERP.*不可用/);
});

test('market normalization rejects missing, duplicate, unsafe or invalid targets', () => {
  assert.throws(() => normalizeRisexMarkets([btc]), /缺少 ETH-PERP/);
  assert.throws(() => normalizeRisexMarkets([btc, { ...btc, market_id: '9' }, eth]), /BTC-PERP.*重复/);
  assert.throws(() => normalizeRisexMarkets([{ ...btc, market_id: '9007199254740992' }, eth]), /market_id/);
  assert.throws(() => normalizeRisexMarkets([btc, { ...eth, config: { ...eth.config, step_size: '0' } }]), /step_size/);
  assert.throws(() => normalizeRisexMarkets([{ ...btc, visible: false }, eth]), /BTC-PERP.*不可用/);
});

test('orders parser accepts current mainnet decimal values and preserves cursor', () => {
  const [order] = parseOrderEnvelope(orderEnvelope());
  assert.equal(order.orderId, rawOrder.id);
  assert.equal(order.status, 'OPEN');
  assert.equal(order.sizeBase, 0.004447);
  assert.equal(order.price, 61000);
  assert.equal(order.filledSize, 0);
  assert.equal(order.avgPrice, 0);
  assert.equal(order.sender, '0xabc');
  assert.deepEqual(order.cursor, { block: 12n, log: 3n, timestamp: 99n });
});

test('fills parser accepts the official decimal object format', () => {
  const [fill] = parseFillEnvelope({
    channel: 'fills', type: 'update', block_number: 13, log_index: 4,
    timestamp: '101', data: {
      id: '318622-318647', order_id: '90071992547409931234', market_id: '1',
      side: 'BUY', price: '59950.25', size: '0.125', fee: '0.5', time: '100',
    },
  });
  assert.deepEqual(fill, {
    fillId: '318622-318647', orderId: '90071992547409931234', marketId: 1,
    side: 'buy', price: 59950.25, sizeBase: 0.125, fee: 0.5,
    cursor: { block: 13n, log: 4n, timestamp: 101n },
  });
});

test('WS parsers reject unknown status, malformed IDs and impossible values', () => {
  assert.throws(() => parseOrderEnvelope(orderEnvelope({ ...rawOrder, status: 'ORDER_STATUS_NONE' })), /ORDER_STATUS_NONE/);
  assert.throws(() => parseOrderEnvelope(orderEnvelope({ ...rawOrder, id: '' })), /订单 ID/);
  assert.throws(() => parseOrderEnvelope(orderEnvelope({ ...rawOrder, size: 0.004447 })), /size.*十进制数字字符串/);
  assert.throws(() => parseOrderEnvelope(orderEnvelope({ ...rawOrder, price: '6.1e4' })), /price.*十进制数字字符串/);
  assert.throws(() => parseOrderEnvelope(orderEnvelope({ ...rawOrder, filled_size: '0.005' })), /超过订单总量/);
  assert.throws(() => parseOrderEnvelope({ ...orderEnvelope(), data: rawOrder }), /data.*数组/);
  assert.throws(() => parseFillEnvelope({
    channel: 'fills', type: 'update', block_number: 1, log_index: 1, timestamp: '1',
    data: { order_id: 'o1', market_id: '1', side: 'BUY', size: '0.1', price: '100' },
  }), /fill ID/);
  assert.throws(() => parseFillEnvelope({
    channel: 'fills', type: 'update', block_number: 1, log_index: 1, timestamp: '1',
    data: { id: 'f1', order_id: 'o1', market_id: '1', side: 'HOLD', size: '0.1', price: '100' },
  }), /side/);
});

test('REST normalizers preserve open-order IDs and explicitly convert ticks and steps', () => {
  const market = { marketId: 1, stepPrice: 0.1, stepSize: 0.001 };
  const open = normalizeRestOpenOrder({
    order_id: '90071992547409931234', resting_order_id: '77', market_id: 1,
    side: 0, price_ticks: 600001, size_steps: 3, reduce_only: false,
  }, market);
  assert.equal(open.orderId, '90071992547409931234');
  assert.equal(open.restingOrderId, '77');
  assert.ok(Math.abs(open.price - 60000.1) < 1e-9);
  assert.ok(Math.abs(open.sizeBase - 0.003) < 1e-12);
  assert.equal(open.side, 'buy');
});

test('REST normalizers parse current RISEx order, fill and position schemas', () => {
  const history = normalizeRestOrderHistory({
    id: '0xorder1', market_id: '1', side: 'BUY', size: '0.004447', price: '61000',
    filled_size: '0.001', avg_price: '60999.5',
    status: 'ORDER_STATUS_CANCELLED', created_at: '20', block_number: '7', log_index: '2',
  });
  assert.deepEqual({
    orderId: history.orderId,
    side: history.side,
    sizeBase: history.sizeBase,
    filledSize: history.filledSize,
    avgPrice: history.avgPrice,
    cursor: history.cursor,
  }, {
    orderId: '0xorder1',
    side: 'buy',
    sizeBase: 0.004447,
    filledSize: 0.001,
    avgPrice: 60999.5,
    cursor: { block: 7n, log: 2n, timestamp: 20n },
  });

  const fill = normalizeRestFill({
    id: 'fill1', order_id: '0xorder1', market_id: '1', side: 'BUY',
    size: '0.25', price: '99', fee: '0.1', time: '21',
    blockchain_data: { block_number: '7', log_index: '3' },
  });
  assert.deepEqual(fill.cursor, { block: 7n, log: 3n, timestamp: 21n });

  const position = normalizeRestPosition({
    market_id: '1', side: 'SELL', size: (WAD / 2n).toString(),
    avg_entry_price: wad(100), unrealized_pnl: wad(2), leverage: wad(3),
  });
  assert.deepEqual(position, {
    marketId: 1, sizeBase: -0.5, entryPrice: 100, unrealizedPnl: 2, leverage: 3,
  });

  assert.equal(normalizeRestPosition({
    market_id: '1', side: 0, size: (WAD / 2n).toString(),
    avg_entry_price: wad(100), unrealized_pnl: wad(2), leverage: wad(3),
  }).sizeBase, 0.5);
});

test('REST normalizers reject missing resting IDs, unknown status and incomplete positions', () => {
  const market = { marketId: 1, stepPrice: 0.1, stepSize: 0.001 };
  assert.throws(() => normalizeRestOpenOrder({
    order_id: 'o1', market_id: 1, side: 0, price_ticks: 1, size_steps: 1,
  }, market), /resting_order_id/);
  assert.throws(() => normalizeRestOrderHistory({
    id: 'o1', market_id: '1', side: 'BUY', size: '1', price: '100',
    filled_size: '0', avg_price: '0', status: 'MYSTERY', created_at: '10',
  }), /MYSTERY/);
  assert.throws(() => normalizeRestPosition({
    market_id: '1', side: 'BUY', size: wad(1), avg_entry_price: '',
  }), /avg_entry_price/);
});

test('cursor comparison uses block then log then timestamp', () => {
  assert.equal(compareRisexCursor({ block: 1n, log: 2n, timestamp: 3n }, { block: 1n, log: 2n, timestamp: 3n }), 0);
  assert.equal(compareRisexCursor({ block: 2n, log: 0n, timestamp: 0n }, { block: 1n, log: 9n, timestamp: 9n }), 1);
  assert.equal(compareRisexCursor({ block: 1n, log: 1n, timestamp: 9n }, { block: 1n, log: 2n, timestamp: 0n }), -1);
});
