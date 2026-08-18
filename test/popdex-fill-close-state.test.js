import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUnits } from 'ethers';
import { prepareFillClosePlan } from '../src/exchange/px/fill-close-codec.js';
import {
  assertCompletedFlat,
  assertConfirmedLong,
  assertEntrySettled,
  assertInitialFlat,
  classifyEntry,
  exactBtcLeverage,
} from '../src/exchange/px/fill-close-state.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const ORDER_ID = '234237619377012736';

const plan = prepareFillClosePlan({
  mainAccount: ACCOUNT,
  ask: '63000',
  randomBytesImpl: () => Uint8Array.from({ length: 16 }, (_unused, index) => index + 1),
});
const CLIENT_OID = 'dw-bb-0102030405060708090a0b0c';

function order(overrides = {}) {
  return {
    walletId: ACCOUNT,
    orderId: ORDER_ID,
    clientOid: CLIENT_OID,
    symbolId: '20000',
    symbol: 'BTCUSDT',
    side: 'Buy',
    status: 'PartiallyFilled',
    price: '63189',
    qty: '0.0002',
    filledQty: '0.0001',
    remainingQty: '0.0001',
    cancelledQty: '0',
    reduceOnly: false,
    ...overrides,
  };
}

function fill(overrides = {}) {
  return {
    fillId: '1',
    orderId: ORDER_ID,
    symbol: 'BTCUSDT',
    side: 'Buy',
    execPrice: '63000',
    execQty: '0.0001',
    ...overrides,
  };
}

function position(overrides = {}) {
  return {
    walletId: ACCOUNT,
    positionId: '77',
    symbolId: '20000',
    side: '1',
    holdSizeWad: parseUnits('0.0001', 18).toString(),
    avgOpenPriceWad: parseUnits('63000', 18).toString(),
    closeSizeWad: '0',
    lockedSizeWad: '0',
    realizedPnlWad: '0',
    createdTime: '1',
    updatedTime: '2',
    ...overrides,
  };
}

test('initial state rejects any BTC order or nonzero position', () => {
  assert.throws(() => assertInitialFlat({
    openOrders: [{ symbol: 'BTCUSDT', orderId: '9' }],
    positions: [],
  }), /活动订单/);
  assert.throws(() => assertInitialFlat({
    openOrders: [],
    positions: [position({ holdSizeWad: '1' })],
  }), /持仓/);
  assert.doesNotThrow(() => assertInitialFlat({
    openOrders: [{ symbol: 'ETHUSDT', orderId: '9' }],
    positions: [position({ symbolId: '20001' })],
  }));
});

test('BTC leverage requires OneWay mode and one exact bounded entry', () => {
  assert.equal(exactBtcLeverage({
    positionMode: '0',
    symbolLeverages: [{ symbolId: '20000', leverage: '1' }],
  }), '1');
  assert.throws(() => exactBtcLeverage({
    positionMode: '1',
    symbolLeverages: [{ symbolId: '20000', leverage: '1' }],
  }), /OneWay.*0/);
  assert.throws(() => exactBtcLeverage({
    positionMode: '0',
    symbolLeverages: [],
  }), /必须唯一/);
  assert.throws(() => exactBtcLeverage({
    positionMode: '0',
    symbolLeverages: [{ symbolId: '20000', leverage: '0' }],
  }), /1-255/);
});

test('entry classification distinguishes full partial active-zero and cancelled-zero fills', () => {
  assert.deepEqual(classifyEntry(plan, {
    orderId: ORDER_ID,
    order: order(),
    fills: [fill()],
    openOrders: [order()],
    cancelConfirmed: false,
  }), {
    kind: 'partial-fill',
    filledQtyWad: parseUnits('0.0001', 18).toString(),
    remainingQtyWad: parseUnits('0.0001', 18).toString(),
    orderId: ORDER_ID,
  });

  assert.deepEqual(classifyEntry(plan, {
    orderId: ORDER_ID,
    order: order({
      status: 'FullyFilled',
      filledQty: '0.0002',
      remainingQty: '0',
    }),
    fills: [fill({ fillId: '2', execQty: '0.0002' })],
    openOrders: [],
  }).kind, 'full-fill');

  assert.equal(classifyEntry(plan, {
    orderId: ORDER_ID,
    order: order({ status: 'NewAccept', filledQty: '0', remainingQty: '0.0002' }),
    fills: [],
    openOrders: [order({ status: 'NewAccept', filledQty: '0', remainingQty: '0.0002' })],
  }).kind, 'zero-fill-active');

  assert.deepEqual(classifyEntry(plan, {
    orderId: ORDER_ID,
    order: order({
      status: 'Cancelled',
      filledQty: '0',
      remainingQty: '0',
      cancelledQty: '0.0002',
    }),
    fills: [],
    openOrders: [],
    cancelConfirmed: true,
  }), {
    kind: 'zero-fill',
    orderId: ORDER_ID,
    filledQtyWad: '0',
    remainingQtyWad: '0',
  });
});

test('entry classification proves partial fill after cancellation from complete fill history', () => {
  const result = classifyEntry(plan, {
    orderId: ORDER_ID,
    order: order({
      status: 'PartiallyFilledCancelled',
      remainingQty: '0',
      cancelledQty: '0.0001',
    }),
    fills: [fill(), fill({ fillId: '90', orderId: '90', execQty: '5' })],
    openOrders: [],
    cancelConfirmed: true,
  });
  assert.deepEqual(result, {
    kind: 'partial-fill',
    orderId: ORDER_ID,
    filledQtyWad: parseUnits('0.0001', 18).toString(),
    remainingQtyWad: '0',
  });
});

test('entry classification exposes settling and bounded polling fails explicitly', () => {
  const result = classifyEntry(plan, {
    orderId: ORDER_ID,
    order: order({ filledQty: '0.0002', remainingQty: '0' }),
    fills: [fill()],
    openOrders: [],
  });
  assert.deepEqual(result, {
    kind: 'settling',
    orderId: ORDER_ID,
    orderFilledQtyWad: parseUnits('0.0002', 18).toString(),
    fillSumQtyWad: parseUnits('0.0001', 18).toString(),
    remainingQtyWad: '0',
  });
  assert.throws(() => assertEntrySettled(result), /仍未一致/);
});

test('entry classification rejects duplicate or conflicting exact-order facts', () => {
  const base = { orderId: ORDER_ID, order: order(), openOrders: [order()] };
  assert.throws(() => classifyEntry(plan, {
    ...base,
    fills: [fill(), fill()],
  }), /fillId.*重复/);
  assert.throws(() => classifyEntry(plan, {
    ...base,
    fills: [fill({ side: 'Sell' })],
  }), /成交身份不匹配/);
  assert.throws(() => classifyEntry(plan, {
    ...base,
    fills: [fill()],
    openOrders: [order({ orderId: '8' })],
  }), /不属于本探针/);
  assert.throws(() => classifyEntry(plan, {
    ...base,
    fills: [fill()],
    order: order({ walletId: OTHER }),
  }), /订单身份不匹配/);
});

test('confirmed long must uniquely equal this order fill and have no active order', () => {
  assert.equal(assertConfirmedLong(plan, {
    positions: [position()],
    openOrders: [],
  }, parseUnits('0.0001', 18).toString()).positionId, '77');
  assert.throws(() => assertConfirmedLong(plan, {
    positions: [position({ side: '2' })],
    openOrders: [],
  }, parseUnits('0.0001', 18).toString()), /Long=1/);
  assert.throws(() => assertConfirmedLong(plan, {
    positions: [position({ holdSizeWad: '2' })],
    openOrders: [],
  }, '1'), /持仓量.*不一致/);
  assert.throws(() => assertConfirmedLong(plan, {
    positions: [position()],
    openOrders: [order()],
  }, parseUnits('0.0001', 18).toString()), /活动订单/);
});

test('completed flat rejects both residual long and reverse short', () => {
  assert.equal(assertCompletedFlat({ positions: [], openOrders: [] }), true);
  assert.throws(() => assertCompletedFlat({
    positions: [position()],
    openOrders: [],
  }), /持仓/);
  assert.throws(() => assertCompletedFlat({
    positions: [position({ side: '2' })],
    openOrders: [],
  }), /持仓/);
});
