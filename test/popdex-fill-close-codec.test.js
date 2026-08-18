import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeBytes32String,
  Interface,
  keccak256,
  ZeroAddress,
} from 'ethers';
import {
  encodeOrderParams,
  POPDEX_ORDER_INTERFACE,
} from '../src/exchange/px/order-codec.js';
import {
  POPDEX_REDUCE_ONLY_MARKET_PARAMS,
  POPDEX_USER_CONFIG_INTERFACE,
  createBtcCloseClientOrderId,
  encodeBtcLeverageOne,
  encodeReduceOnlyMarketClose,
  parseLeverageUpdatedReceipt,
  prepareFillClosePlan,
  verifyStage5Simulation,
} from '../src/exchange/px/fill-close-codec.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const USER_CONFIG_PRECOMPILE = '0x0000000000000000000000000000000000001009';
const MAINNET_ACCOUNT = '0xdA1efA6fc801D6788Cc785405610462f99CCb3e8';
const MAINNET_CLOSE_CLIENT_ID =
  '0x7765622d31373837303334333039323331000000000000000000000000000000';
const MAINNET_CLOSE_CALLDATA =
  '0x0f05a9d9'
  + '000000000000000000000000da1efa6fc801d6788cc785405610462f99ccb3e8'
  + '7765622d31373837303334333039323331000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000004e20'
  + '0201010000000100000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000b5e620f48000'
  + '000000000000000000000000000000000000000000000000006a94d74f430000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000';

function deterministicBytes() {
  return Uint8Array.from({ length: 16 }, (_unused, index) => index + 1);
}

function plan() {
  return prepareFillClosePlan({
    mainAccount: ACCOUNT,
    ask: '63000',
    randomBytesImpl: deterministicBytes,
  });
}

test('production BTC leverage and close identity helpers preserve validated vectors', () => {
  assert.equal(
    keccak256(encodeBtcLeverageOne(MAINNET_ACCOUNT)),
    '0x75a358124ff6d9dac768951aa74a4cf82bd2862958e195aeed7e7b6c559b6e6c',
  );
  assert.equal(
    createBtcCloseClientOrderId(deterministicBytes()),
    plan().closeClientOrderId,
  );
  assert.equal(
    decodeBytes32String(createBtcCloseClientOrderId(deterministicBytes())),
    'dw-bc-0102030405060708090a0b0c',
  );
});

test('fill-close plan is fixed to BTCUSDT 1x minimum long with 0.3 percent cap', () => {
  const prepared = plan();
  assert.equal(prepared.symbol, 'BTCUSDT');
  assert.equal(prepared.symbolId, '20000');
  assert.equal(prepared.side, 'buy');
  assert.equal(prepared.leverage, '1');
  assert.equal(prepared.positionMode, '0');
  assert.equal(prepared.positionSide, '1');
  assert.equal(prepared.category, '2');
  assert.equal(prepared.price, '63189');
  assert.equal(prepared.qty, '0.0002');
  assert.equal(decodeBytes32String(prepared.clientOrderId), 'dw-bb-0102030405060708090a0b0c');
  assert.equal(
    decodeBytes32String(prepared.closeClientOrderId),
    'dw-bc-0102030405060708090a0b0c',
  );
  assert.notEqual(prepared.clientOrderId, prepared.closeClientOrderId);

  const leverage = POPDEX_USER_CONFIG_INTERFACE.decodeFunctionData(
    'updateLeverage',
    prepared.leverageData,
  );
  assert.equal(leverage.account, ACCOUNT);
  assert.deepEqual(Array.from(leverage.request, String), [
    '1',
    '20000',
    ZeroAddress,
    '2',
  ]);

  const entry = POPDEX_ORDER_INTERFACE.decodeFunctionData('placeOrder', prepared.entryData);
  assert.equal(entry.account, ACCOUNT);
  assert.equal(entry.symbolId.toString(), '20000');
  assert.equal(entry.price.toString(), prepared.priceWad);
  assert.equal(entry.qty.toString(), prepared.qtyWad);
  assert.equal(entry.clientOrderId, prepared.clientOrderId);
  assert.equal(entry.orderParams, encodeOrderParams({ side: 'buy' }));
  assert.equal(entry.slippage, 0n);
  assert.equal(entry.builder, ZeroAddress);
  assert.equal(entry.builderFeeRate, 0n);

  const close = POPDEX_ORDER_INTERFACE.decodeFunctionData(
    'placeOrder',
    prepared.closePreviewData,
  );
  assert.equal(close.clientOrderId, prepared.closeClientOrderId);
  assert.equal(close.orderParams, POPDEX_REDUCE_ONLY_MARKET_PARAMS);
  assert.equal(close.price, 0n);
  assert.equal(close.qty.toString(), prepared.qtyWad);
  assert.equal(close.slippage, 30000000000000000n);
  assert.equal(close.builder, ZeroAddress);
  assert.equal(close.builderFeeRate, 0n);
});

test('reduce-only market close exactly matches the successful Mainnet calldata', () => {
  assert.equal(
    encodeReduceOnlyMarketClose({
      mainAccount: MAINNET_ACCOUNT,
      closeClientOrderId: MAINNET_CLOSE_CLIENT_ID,
      closeQtyWad: '200000000000000',
    }),
    MAINNET_CLOSE_CALLDATA,
  );
  assert.equal(
    POPDEX_REDUCE_ONLY_MARKET_PARAMS,
    '0x0201010000000100000000000000000000000000000000000000000000000000',
  );
});

test('fill-close plan rejects overrides and invalid orderbook facts', () => {
  const base = { mainAccount: ACCOUNT, ask: '63000', randomBytesImpl: deterministicBytes };
  for (const override of [
    { symbol: 'ETHUSDT' },
    { side: 'sell' },
    { leverage: '2' },
    { positionMode: '1' },
    { positionSide: '2' },
  ]) {
    assert.throws(() => prepareFillClosePlan({ ...base, ...override }), /固定|只允许/);
  }
  for (const ask of ['0', '-1', 'NaN', '1.1234567890123456789']) {
    assert.throws(() => prepareFillClosePlan({ ...base, ask }), /ask|小数/);
  }
});

test('stage5 simulation accepts only empty or ABI true results', () => {
  assert.equal(
    verifyStage5Simulation('0x', POPDEX_ORDER_INTERFACE, 'placeOrder'),
    'empty',
  );
  const trueResult = POPDEX_USER_CONFIG_INTERFACE.encodeFunctionResult('updateLeverage', [true]);
  assert.equal(
    verifyStage5Simulation(trueResult, POPDEX_USER_CONFIG_INTERFACE, 'updateLeverage'),
    'bool-true',
  );
  const falseResult = POPDEX_USER_CONFIG_INTERFACE.encodeFunctionResult('updateLeverage', [false]);
  assert.throws(
    () => verifyStage5Simulation(falseResult, POPDEX_USER_CONFIG_INTERFACE, 'updateLeverage'),
    /未返回 true/,
  );
  assert.throws(
    () => verifyStage5Simulation('0x12', POPDEX_ORDER_INTERFACE, 'placeOrder'),
    /模拟结果无效/,
  );
});

function leverageLog(overrides = {}) {
  const values = {
    account: ACCOUNT,
    category: 2,
    symbolId: 20000,
    tokenAddress: ZeroAddress,
    newLeverage: 1,
    succeeded: true,
    code: 0,
    ...overrides,
  };
  const event = POPDEX_USER_CONFIG_INTERFACE.getEvent('LeverageUpdated');
  const encoded = POPDEX_USER_CONFIG_INTERFACE.encodeEventLog(event, [
    values.account,
    values.category,
    values.symbolId,
    values.tokenAddress,
    values.newLeverage,
    values.succeeded,
    values.code,
  ]);
  return {
    address: values.address ?? USER_CONFIG_PRECOMPILE,
    data: encoded.data,
    topics: encoded.topics,
  };
}

function receipt(logs, status = '0x1') {
  return { status, transactionHash: `0x${'12'.repeat(32)}`, logs };
}

test('LeverageUpdated receipt proves the exact BTC futures 1x request', () => {
  assert.deepEqual(parseLeverageUpdatedReceipt(receipt([leverageLog()]), plan()), {
    account: ACCOUNT,
    category: '2',
    symbolId: '20000',
    tokenAddress: ZeroAddress,
    leverage: '1',
  });
});

test('LeverageUpdated receipt rejects missing duplicate failed and conflicting facts', () => {
  const expected = plan();
  const cases = [
    [receipt([]), /恰好 1 条/],
    [receipt([leverageLog(), leverageLog()]), /恰好 1 条/],
    [receipt([leverageLog({ address: OTHER })]), /恰好 1 条/],
    [receipt([leverageLog({ account: OTHER })]), /account.*不匹配/],
    [receipt([leverageLog({ category: 0 })]), /category.*不匹配/],
    [receipt([leverageLog({ symbolId: 20001 })]), /symbolId.*不匹配/],
    [receipt([leverageLog({ tokenAddress: OTHER })]), /tokenAddress.*不匹配/],
    [receipt([leverageLog({ newLeverage: 2 })]), /leverage.*不匹配/],
    [receipt([leverageLog({ succeeded: false })]), /succeeded=false/],
    [receipt([leverageLog({ code: 9 })]), /code=9/],
    [receipt([leverageLog()], '0x0'), /status=0x1/],
  ];
  for (const [candidate, error] of cases) {
    assert.throws(() => parseLeverageUpdatedReceipt(candidate, expected), error);
  }
});

test('simulation verifier rejects an invalid interface contract', () => {
  assert.throws(
    () => verifyStage5Simulation('0x', new Interface([]), 'missing'),
    /functionName|接口|函数/,
  );
});
