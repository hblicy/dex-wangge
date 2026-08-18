import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POPDEX_ORDER_EVENT_INTERFACE,
  parseOrderCancelReceipt,
  parseOrderCreateReceipt,
} from '../src/exchange/px/receipt-events.js';

const PRECOMPILE = '0x0000000000000000000000000000000000001000';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const CLIENT_ORDER_ID = `0x${'12'.repeat(32)}`;
const TX_HASH = `0x${'34'.repeat(32)}`;
const ORDER_ID = '234237619377012736';

function eventLog(name, args, address = PRECOMPILE) {
  const encoded = POPDEX_ORDER_EVENT_INTERFACE.encodeEventLog(
    POPDEX_ORDER_EVENT_INTERFACE.getEvent(name),
    args,
  );
  return { address, data: encoded.data, topics: encoded.topics };
}

function receipt(logs) {
  return { transactionHash: TX_HASH, status: '0x1', logs };
}

function createLog(overrides = {}) {
  const values = {
    account: ACCOUNT,
    symbol: 20000,
    orderId: ORDER_ID,
    clientOid: CLIENT_ORDER_ID,
    price: '60000000000000000000000',
    qty: '200000000000000',
    borrowAmount: '0',
    status: 2,
    succeeded: true,
    code: 0,
    ...overrides,
  };
  return eventLog('OrderCreate', [
    values.account,
    values.symbol,
    values.orderId,
    values.clientOid,
    values.price,
    values.qty,
    values.borrowAmount,
    values.status,
    values.succeeded,
    values.code,
  ]);
}

function cancelLog(overrides = {}) {
  const values = {
    account: ACCOUNT,
    orderId: ORDER_ID,
    clientOid: CLIENT_ORDER_ID,
    succeeded: true,
    code: 0,
    ...overrides,
  };
  return eventLog('OrderCancel', [
    values.account,
    values.orderId,
    values.clientOid,
    values.succeeded,
    values.code,
  ]);
}

test('OrderCreate receipt yields the exact authoritative order identity', () => {
  const result = parseOrderCreateReceipt(receipt([createLog()]), {
    account: ACCOUNT,
    symbolId: '20000',
    clientOrderId: CLIENT_ORDER_ID,
    priceWad: '60000000000000000000000',
    qtyWad: '200000000000000',
  });

  assert.deepEqual(result, {
    orderId: ORDER_ID,
    clientOrderId: CLIENT_ORDER_ID,
    symbolId: '20000',
    priceWad: '60000000000000000000000',
    qtyWad: '200000000000000',
    status: '2',
  });
});

test('OrderCreate receipt rejects missing, duplicate, failed and conflicting events', () => {
  const expected = {
    account: ACCOUNT,
    symbolId: '20000',
    clientOrderId: CLIENT_ORDER_ID,
    priceWad: '60000000000000000000000',
    qtyWad: '200000000000000',
  };
  assert.throws(() => parseOrderCreateReceipt(receipt([]), expected), /OrderCreate.*恰好 1 条/);
  assert.throws(
    () => parseOrderCreateReceipt(receipt([createLog(), createLog()]), expected),
    /OrderCreate.*恰好 1 条/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([createLog({ succeeded: false, code: 13004 })]), expected),
    /succeeded=false.*code=13004/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([createLog({ price: '1' })]), expected),
    /priceWad.*不匹配/,
  );
});

test('OrderCreate market receipt accepts only an explicitly requested positive execution price', () => {
  const expected = {
    account: ACCOUNT,
    symbolId: '20000',
    clientOrderId: CLIENT_ORDER_ID,
    priceWad: '0',
    qtyWad: '200000000000000',
    priceRule: 'positive-execution',
  };
  const result = parseOrderCreateReceipt(receipt([
    createLog({ price: '62358000000000000000000' }),
  ]), expected);
  assert.equal(result.priceWad, '62358000000000000000000');

  assert.throws(
    () => parseOrderCreateReceipt(receipt([createLog({ price: '0' })]), expected),
    /priceWad.*正整数/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([createLog({ price: '-1' })]), expected),
    /priceWad.*非负整数字符串/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([
      createLog({ price: '62358000000000000000000' }),
    ]), { ...expected, priceRule: undefined }),
    /priceWad.*不匹配/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([
      createLog({ price: '62358000000000000000000' }),
    ]), { ...expected, priceWad: '1' }),
    /positive-execution.*priceWad=0/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([
      createLog({ price: '62358000000000000000000' }),
    ]), { ...expected, priceRule: 'unknown' }),
    /priceRule.*无效/,
  );
});

test('OrderCancel receipt confirms the exact order and client ID', () => {
  const result = parseOrderCancelReceipt(receipt([cancelLog()]), {
    account: ACCOUNT,
    orderId: ORDER_ID,
    clientOrderId: CLIENT_ORDER_ID,
  });
  assert.deepEqual(result, { orderId: ORDER_ID, clientOrderId: CLIENT_ORDER_ID });
});

test('OrderCancel receipt rejects another order and unsuccessful cancellation', () => {
  const expected = {
    account: ACCOUNT,
    orderId: ORDER_ID,
    clientOrderId: CLIENT_ORDER_ID,
  };
  assert.throws(
    () => parseOrderCancelReceipt(receipt([cancelLog({ orderId: '9' })]), expected),
    /orderId.*不匹配/,
  );
  assert.throws(
    () => parseOrderCancelReceipt(receipt([cancelLog({ succeeded: false, code: 1 })]), expected),
    /succeeded=false.*code=1/,
  );
});
