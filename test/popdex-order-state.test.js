import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBytes32String, encodeBytes32String, parseUnits } from 'ethers';
import {
  buildFillEventId,
  reconcileOwnedOrder,
} from '../src/exchange/px/order-state.js';

const CLIENT_ORDER_ID = encodeBytes32String('dw-bb-111111111111111111111111').toLowerCase();
const PRICE_WAD = parseUnits('63000', 18).toString();

function ownedOrder(overrides = {}) {
  return {
    orderId: '123',
    clientOrderId: CLIENT_ORDER_ID,
    marketId: 20000,
    side: 'buy',
    priceWad: PRICE_WAD,
    qtyWad: '200',
    reduceOnly: false,
    ...overrides,
  };
}

function officialOrder(overrides = {}) {
  return {
    orderId: '123',
    clientOrderId: CLIENT_ORDER_ID,
    symbolId: '20000',
    side: '0',
    isReduceOnly: false,
    priceWad: PRICE_WAD,
    qtyWad: '200',
    filledQtyWad: '0',
    remainingQtyWad: '200',
    cancelledQtyWad: '0',
    ...overrides,
  };
}

function restTerminal(overrides = {}) {
  return {
    orderId: '123',
    clientOid: decodeBytes32String(CLIENT_ORDER_ID),
    symbolId: '20000',
    symbol: 'BTCUSDT',
    side: 'Buy',
    reduceOnly: false,
    status: 'FullyFilled',
    price: '63000',
    qty: '0.0000000000000002',
    filledQty: '0.0000000000000002',
    remainingQty: '0',
    cancelledQty: '0',
    ...overrides,
  };
}

function fill(fillId, qtyWad, price = '63000', overrides = {}) {
  return {
    fillId,
    orderId: '123',
    symbol: 'BTCUSDT',
    side: 'Buy',
    execPrice: price,
    execQty: `0.${String(qtyWad).padStart(18, '0')}`,
    ...overrides,
  };
}

test('partial fills stay active and duplicate fill IDs fail', () => {
  const active = officialOrder({ filledQtyWad: '100', remainingQtyWad: '100' });
  const partial = reconcileOwnedOrder(ownedOrder(), {
    active,
    fills: [fill('1', '100')],
  });
  assert.equal(partial.state, 'PARTIAL');
  assert.deepEqual(partial.fillIds, ['1']);

  assert.throws(() => reconcileOwnedOrder(ownedOrder(), {
    active,
    fills: [fill('1', '50'), fill('1', '50')],
  }), /fillId 1 重复/);
});

test('full fill produces one stable pending event from exact fills', () => {
  const facts = {
    completed: officialOrder({
      filledQtyWad: '200', remainingQtyWad: '0', cancelledQtyWad: '0',
    }),
    fills: [fill('8', '80', '63000'), fill('9', '120', '63100')],
  };
  const result = reconcileOwnedOrder(ownedOrder(), facts);
  const replay = reconcileOwnedOrder(ownedOrder(), facts);
  assert.equal(result.state, 'FILLED');
  assert.equal(result.event.filledQtyWad, '200');
  assert.equal(result.event.priceWad, '63060000000000000000000');
  assert.equal(result.event.suppressRequote, false);
  assert.equal(result.event.fillEventId, replay.event.fillEventId);
  assert.equal(result.event.fillEventId, buildFillEventId({
    orderId: '123',
    clientOrderId: CLIENT_ORDER_ID,
    terminalState: 'FILLED',
    fillIds: ['8', '9'],
    filledQtyWad: '200',
  }));
});

test('partial fill then cancel emits actual quantity and bulk cancel suppresses requote', () => {
  const result = reconcileOwnedOrder(ownedOrder(), {
    completed: officialOrder({
      filledQtyWad: '80', remainingQtyWad: '0', cancelledQtyWad: '120',
    }),
    fills: [fill('8', '80')],
    suppressRequote: true,
  });
  assert.equal(result.state, 'CANCELLED');
  assert.equal(result.event.filledQtyWad, '80');
  assert.equal(result.event.suppressRequote, true);
});

test('verified REST terminal names preserve rejected and expired states', () => {
  assert.equal(reconcileOwnedOrder(ownedOrder(), {
    completed: restTerminal({
      status: 'Rejected', filledQty: '0', remainingQty: '0', cancelledQty: '0.0000000000000002',
    }),
  }).state, 'REJECTED');
  assert.equal(reconcileOwnedOrder(ownedOrder(), {
    completed: restTerminal({
      status: 'Expired', filledQty: '0', remainingQty: '0', cancelledQty: '0.0000000000000002',
    }),
  }).state, 'EXPIRED');
});

test('order and fill identity conflicts fail closed', () => {
  for (const [field, value] of [
    ['orderId', '124'],
    ['clientOrderId', encodeBytes32String('dw-bb-222222222222222222222222').toLowerCase()],
    ['side', '1'],
    ['priceWad', parseUnits('63001', 18).toString()],
    ['qtyWad', '201'],
    ['isReduceOnly', true],
  ]) {
    assert.throws(
      () => reconcileOwnedOrder(ownedOrder(), { active: officialOrder({ [field]: value }) }),
      /身份不匹配/,
      field,
    );
  }
  assert.throws(() => reconcileOwnedOrder(ownedOrder(), {
    active: officialOrder({ filledQtyWad: '1', remainingQtyWad: '199' }),
    fills: [fill('1', '1', '63000', { side: 'Sell' })],
  }), /成交身份不匹配/);
});

test('incomplete propagation settles without guessing a terminal state', () => {
  const mismatch = reconcileOwnedOrder(ownedOrder(), {
    completed: officialOrder({ filledQtyWad: '200', remainingQtyWad: '0' }),
    fills: [fill('1', '100')],
  });
  assert.equal(mismatch.state, 'SETTLING');
  assert.equal(mismatch.event, null);

  assert.equal(reconcileOwnedOrder(ownedOrder()).state, 'UNKNOWN_TERMINAL');
  assert.equal(reconcileOwnedOrder(ownedOrder(), { fills: [fill('1', '100')] }).state, 'SETTLING');
});

test('fills cannot exceed the owned order quantity', () => {
  assert.throws(() => reconcileOwnedOrder(ownedOrder(), {
    fills: [fill('1', '201')],
  }), /成交量超过委托量/);
});

test('cancel proof must identify the exact owned order and fill quantity', () => {
  assert.throws(
    () => reconcileOwnedOrder(ownedOrder(), { cancelProof: false }),
    /cancelProof.*对象/,
  );
  assert.throws(() => reconcileOwnedOrder(ownedOrder(), {
    cancelProof: { orderId: '999', clientOrderId: CLIENT_ORDER_ID, filledQtyWad: '0' },
  }), /撤单证明身份不匹配/);
  assert.throws(() => reconcileOwnedOrder(ownedOrder(), {
    fills: [fill('1', '80')],
    cancelProof: { orderId: '123', clientOrderId: CLIENT_ORDER_ID, filledQtyWad: '0' },
  }), /撤单证明成交量不匹配/);

  const result = reconcileOwnedOrder(ownedOrder(), {
    fills: [fill('1', '80')],
    cancelProof: { orderId: '123', clientOrderId: CLIENT_ORDER_ID, filledQtyWad: '80' },
  });
  assert.equal(result.state, 'CANCELLED');
  assert.equal(result.event.filledQtyWad, '80');
});
