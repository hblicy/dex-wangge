import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeBytes32String,
  encodeBytes32String,
  parseUnits,
  ZeroAddress,
} from 'ethers';
import {
  encodeCancelOrder,
  encodeOrderParams,
  POPDEX_ORDER_INTERFACE,
  prepareProbeOrder,
} from '../src/exchange/px/order-codec.js';

const MAIN_ACCOUNT = '0x1111111111111111111111111111111111111111';
const FIXED_ENTROPY = () => Uint8Array.from({ length: 16 }, (_, index) => index + 1);

function validOrder(overrides = {}) {
  return {
    mainAccount: MAIN_ACCOUNT,
    symbol: 'BTCUSDT',
    side: 'buy',
    price: '60000',
    qty: '0.0002',
    bid: '62900',
    ask: '62901',
    randomBytesImpl: FIXED_ENTROPY,
    nowMs: 1786946400000,
    ...overrides,
  };
}

test('prepareProbeOrder encodes the fixed BTC buy ABI vector without floating point', () => {
  const plan = prepareProbeOrder(validOrder());

  assert.equal(plan.mainAccount, MAIN_ACCOUNT);
  assert.equal(plan.symbolId, '20000');
  assert.equal(plan.priceWad, parseUnits('60000', 18).toString());
  assert.equal(plan.qtyWad, parseUnits('0.0002', 18).toString());
  assert.match(plan.clientOrderId, /^0x[0-9a-f]{64}$/);
  assert.equal(
    plan.orderParams,
    '0x0200000100000000000000000000000000000000000000000000000000000000',
  );

  const decoded = POPDEX_ORDER_INTERFACE.decodeFunctionData('placeOrder', plan.data);
  assert.equal(decoded.account, MAIN_ACCOUNT);
  assert.equal(decoded.clientOrderId, plan.clientOrderId);
  assert.equal(decoded.symbolId, 20000n);
  assert.equal(decoded.orderParams, plan.orderParams);
  assert.equal(decoded.price, parseUnits('60000', 18));
  assert.equal(decoded.qty, parseUnits('0.0002', 18));
  assert.equal(decoded.slippage, 0n);
  assert.equal(decoded.builder, ZeroAddress);
  assert.equal(decoded.builderFeeRate, 0n);
});

test('orderParams supports only exact buy and sell limit GTC vectors', () => {
  assert.equal(
    encodeOrderParams('buy'),
    '0x0200000100000000000000000000000000000000000000000000000000000000',
  );
  assert.equal(
    encodeOrderParams('sell'),
    '0x0200010100000000000000000000000000000000000000000000000000000000',
  );
  assert.throws(() => encodeOrderParams('BUY'), /side.*buy.*sell/i);
});

test('prepareProbeOrder accepts the exact ETH whitelist identity and sell protection', () => {
  const plan = prepareProbeOrder(validOrder({
    symbol: 'ETHUSDT',
    side: 'sell',
    price: '2000.1',
    qty: '0.006',
    bid: '1878.8',
    ask: '1878.9',
  }));
  assert.equal(plan.symbolId, '20001');
  assert.equal(plan.priceWad, parseUnits('2000.1', 18).toString());
  assert.equal(plan.qtyWad, parseUnits('0.006', 18).toString());
});

test('prepareProbeOrder generates a different bytes32 client ID for different entropy', () => {
  const first = prepareProbeOrder(validOrder());
  const second = prepareProbeOrder(validOrder({
    randomBytesImpl: () => Uint8Array.from({ length: 16 }, (_, index) => index + 2),
  }));
  assert.notEqual(first.clientOrderId, second.clientOrderId);
});

test('prepareProbeOrder emits the canonical printable UTF-8 client ID required by mainnet', () => {
  const plan = prepareProbeOrder(validOrder());
  const label = decodeBytes32String(plan.clientOrderId);

  assert.equal(label, 'dw-bb-AQIDBAUGBwgJCgsMDQ4PEA');
  assert.match(label, /^dw-bb-[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.byteLength(label, 'utf8') <= 31, true);
  assert.equal(encodeBytes32String(label), plan.clientOrderId);
});

for (const [name, overrides, expected] of [
  ['non-whitelisted market', { symbol: 'SOLUSDT' }, /白名单/],
  ['unknown side', { side: 'long' }, /side.*buy.*sell/i],
  ['price below tick', { price: '60000.1' }, /tickSize/],
  ['quantity below lot', { qty: '0.00021' }, /lotSize/],
  ['quantity below minimum', { qty: '0' }, /minQty/],
  ['notional below minimum', { price: '100', qty: '0.0001', bid: '101', ask: '102' }, /minNotional/],
  ['marketable buy', { price: '62900' }, /best bid/],
  ['marketable sell', { side: 'sell', price: '62901' }, /best ask/],
  ['scientific price', { price: '6e4' }, /十进制字符串/],
  ['negative quantity', { qty: '-0.001' }, /十进制字符串/],
  ['too many decimals', { qty: '0.0002000000000000001' }, /18 位小数/],
]) {
  test(`prepareProbeOrder rejects ${name}`, () => {
    assert.throws(() => prepareProbeOrder(validOrder(overrides)), expected);
  });
}

test('prepareProbeOrder rejects malformed time and entropy sources', () => {
  assert.throws(() => prepareProbeOrder(validOrder({ nowMs: 1.5 })), /nowMs.*安全整数/);
  assert.throws(
    () => prepareProbeOrder(validOrder({ randomBytesImpl: () => new Uint8Array(15) })),
    /entropy.*16 字节/,
  );
});

test('encodeCancelOrder accepts exact uint128 and bytes32 values', () => {
  const orderId = '90071992547409931234';
  const clientOrderId = `0x${'12'.repeat(32)}`;
  const data = encodeCancelOrder({ mainAccount: MAIN_ACCOUNT, orderId, clientOrderId });
  const decoded = POPDEX_ORDER_INTERFACE.decodeFunctionData('cancelOrder', data);
  assert.equal(decoded.account, MAIN_ACCOUNT);
  assert.equal(decoded.orderId, BigInt(orderId));
  assert.equal(decoded.clientOrderId, clientOrderId);
});

test('encodeCancelOrder rejects zero, uint128 overflow and malformed bytes32', () => {
  assert.throws(
    () => encodeCancelOrder({ mainAccount: MAIN_ACCOUNT, orderId: '0', clientOrderId: `0x${'12'.repeat(32)}` }),
    /orderId.*正整数/,
  );
  assert.throws(
    () => encodeCancelOrder({ mainAccount: MAIN_ACCOUNT, orderId: (1n << 128n).toString(), clientOrderId: `0x${'12'.repeat(32)}` }),
    /uint128/,
  );
  assert.throws(
    () => encodeCancelOrder({ mainAccount: MAIN_ACCOUNT, orderId: '1', clientOrderId: '0x12' }),
    /clientOrderId.*bytes32/,
  );
});
