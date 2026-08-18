import { createHash } from 'node:crypto';
import {
  encodeBytes32String,
  hexlify,
  Interface,
  parseUnits,
  ZeroAddress,
} from 'ethers';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import { strictAddress, strictDecimalString, strictIntegerString } from './normalize.js';

const WAD_DECIMALS = 18;
const WAD = 10n ** 18n;
const UINT128_MAX = (1n << 128n) - 1n;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export const POPDEX_ORDER_INTERFACE = new Interface([
  'function placeOrder(address account,bytes32 clientOrderId,uint16 symbolId,bytes32 orderParams,uint256 price,uint256 qty,uint256 slippage,address builder,uint256 builderFeeRate)',
  'function cancelOrder(address account,uint128 orderId,bytes32 clientOrderId)',
]);

function decimalToWad(value, field) {
  const normalized = strictDecimalString(value, field);
  const fraction = normalized.split('.')[1] ?? '';
  if (fraction.length > WAD_DECIMALS) {
    throw new Error(`PopDEX ${field} 最多支持 18 位小数。`);
  }
  return parseUnits(normalized, WAD_DECIMALS);
}

function exactSide(value) {
  if (value !== 'buy' && value !== 'sell') {
    throw new Error('PopDEX side 必须是 buy 或 sell。');
  }
  return value;
}

function exactClientOrderId(value) {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw new Error('PopDEX clientOrderId 必须是精确 bytes32 十六进制字符串。');
  }
  return value.toLowerCase();
}

export function createGridClientOrderId({ symbol, side, intentId }) {
  const marketCode = symbol === 'BTCUSDT' ? 'b' : symbol === 'ETHUSDT' ? 'e' : null;
  const normalizedSide = exactSide(side);
  if (marketCode === null) {
    throw new Error(`PopDEX market ${String(symbol)} 不在白名单。`);
  }
  if (typeof intentId !== 'string' || intentId.length === 0) {
    throw new Error('PopDEX intentId 不能为空。');
  }
  const sideCode = normalizedSide === 'buy' ? 'b' : 's';
  const digest = createHash('sha256').update(intentId, 'utf8').digest('hex').slice(0, 24);
  return encodeBytes32String(`dw-${marketCode}${sideCode}-${digest}`).toLowerCase();
}

export function encodeOrderParams({ side, reduceOnly = false, positionSide = '0' }) {
  if (typeof reduceOnly !== 'boolean') {
    throw new Error('PopDEX reduceOnly 必须是布尔值。');
  }
  if (positionSide !== '0') {
    throw new Error('PopDEX 网格订单只允许 OneWay/Net positionSide=0。');
  }
  const normalizedSide = exactSide(side);
  const bytes = new Uint8Array(32);
  bytes[0] = 2;
  bytes[1] = 0;
  bytes[2] = normalizedSide === 'buy' ? 0 : 1;
  bytes[3] = 1;
  bytes[6] = reduceOnly ? 1 : 0;
  bytes[7] = 0;
  return hexlify(bytes);
}

export function prepareLimitOrder({
  mainAccount,
  symbol,
  side,
  price,
  qty,
  bid,
  ask,
  randomBytesImpl,
  nowMs,
  reduceOnly = false,
  positionSide = '0',
  clientOrderId: explicitClientOrderId = null,
  intentId = null,
}) {
  const account = strictAddress(mainAccount, 'mainAccount');
  if (typeof symbol !== 'string' || !(symbol in POPDEX_EXPECTED_MARKETS)) {
    throw new Error(`PopDEX market ${String(symbol)} 不在白名单。`);
  }
  const normalizedSide = exactSide(side);
  if (typeof reduceOnly !== 'boolean') {
    throw new Error('PopDEX reduceOnly 必须是布尔值。');
  }
  if (positionSide !== '0') {
    throw new Error('PopDEX 网格订单只允许 OneWay/Net positionSide=0。');
  }
  if (reduceOnly && (symbol !== 'BTCUSDT' || normalizedSide !== 'sell')) {
    throw new Error('PopDEX reduce-only 限价网格只允许 BTCUSDT sell。');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('PopDEX nowMs 必须是非负安全整数。');
  }
  if (typeof randomBytesImpl !== 'function') {
    throw new Error('PopDEX randomBytesImpl 必须是函数。');
  }
  const entropy = randomBytesImpl(16);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) {
    throw new Error('PopDEX entropy 必须是 16 字节 Uint8Array。');
  }

  const expected = POPDEX_EXPECTED_MARKETS[symbol];
  const priceWad = decimalToWad(price, 'price');
  const qtyWad = decimalToWad(qty, 'qty');
  const bidWad = decimalToWad(bid, 'best bid');
  const askWad = decimalToWad(ask, 'best ask');
  const tickWad = decimalToWad(expected.tickSize, `${symbol} tickSize`);
  const lotWad = decimalToWad(expected.lotSize, `${symbol} lotSize`);
  const minQtyWad = decimalToWad(expected.minQty, `${symbol} minQty`);
  const minNotionalWad = decimalToWad(expected.minNotional, `${symbol} minNotional`);

  if (bidWad <= 0n || askWad <= 0n || bidWad >= askWad) {
    throw new Error('PopDEX orderbook 必须满足 0 < best bid < best ask。');
  }
  if (priceWad <= 0n) {
    throw new Error('PopDEX price 必须大于 0。');
  }
  if (priceWad % tickWad !== 0n) {
    throw new Error(`PopDEX ${symbol} price 未对齐 tickSize ${expected.tickSize}。`);
  }
  if (qtyWad < minQtyWad) {
    throw new Error(`PopDEX ${symbol} qty 低于 minQty ${expected.minQty}。`);
  }
  if (qtyWad % lotWad !== 0n) {
    throw new Error(`PopDEX ${symbol} qty 未对齐 lotSize ${expected.lotSize}。`);
  }
  const notionalWad = (priceWad * qtyWad) / WAD;
  if (notionalWad < minNotionalWad) {
    throw new Error(`PopDEX ${symbol} 名义金额低于 minNotional ${expected.minNotional}。`);
  }
  if (normalizedSide === 'buy' && priceWad >= bidWad) {
    throw new Error('PopDEX buy 探针价格必须严格低于 best bid。');
  }
  if (normalizedSide === 'sell' && priceWad <= askWad) {
    throw new Error('PopDEX sell 探针价格必须严格高于 best ask。');
  }

  const marketCode = symbol === 'BTCUSDT' ? 'b' : 'e';
  const sideCode = normalizedSide === 'buy' ? 'b' : 's';
  const clientOrderLabel = `dw-${marketCode}${sideCode}-${hexlify(entropy.slice(0, 12)).slice(2)}`;
  const clientOrderId = explicitClientOrderId !== null
    ? exactClientOrderId(explicitClientOrderId)
    : intentId !== null
      ? createGridClientOrderId({ symbol, side: normalizedSide, intentId })
      : encodeBytes32String(clientOrderLabel).toLowerCase();
  const orderParams = encodeOrderParams({ side: normalizedSide, reduceOnly, positionSide });
  const data = POPDEX_ORDER_INTERFACE.encodeFunctionData('placeOrder', [
    account,
    clientOrderId,
    BigInt(expected.symbolId),
    orderParams,
    priceWad,
    qtyWad,
    0n,
    ZeroAddress,
    0n,
  ]);

  return Object.freeze({
    mainAccount: account,
    symbol,
    symbolId: expected.symbolId,
    side: normalizedSide,
    price,
    qty,
    bid,
    ask,
    priceWad: priceWad.toString(),
    qtyWad: qtyWad.toString(),
    clientOrderId,
    orderParams,
    reduceOnly,
    positionSide,
    data,
  });
}

export function prepareProbeOrder(input) {
  return prepareLimitOrder(input);
}

export function encodeCancelOrder({ mainAccount, orderId, clientOrderId }) {
  const account = strictAddress(mainAccount, 'mainAccount');
  const normalizedOrderId = strictIntegerString(orderId, 'orderId');
  const numericOrderId = BigInt(normalizedOrderId);
  if (numericOrderId <= 0n) {
    throw new Error('PopDEX orderId 必须是正整数字符串。');
  }
  if (numericOrderId > UINT128_MAX) {
    throw new Error('PopDEX orderId 超出 uint128 范围。');
  }
  return POPDEX_ORDER_INTERFACE.encodeFunctionData('cancelOrder', [
    account,
    numericOrderId,
    exactClientOrderId(clientOrderId),
  ]);
}
