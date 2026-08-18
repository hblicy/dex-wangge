import { getAddress, isAddress, ZeroAddress } from 'ethers';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';

const INTEGER_STRING = /^(?:0|[1-9]\d*)$/;
const DECIMAL_STRING = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function strictAddress(value, field) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`PopDEX ${field} 必须是有效 EVM 地址字符串。`);
  }
  const normalized = getAddress(value);
  if (normalized === ZeroAddress) {
    throw new Error(`PopDEX ${field} 不能是零地址。`);
  }
  return normalized;
}

export function strictIntegerString(value, field) {
  if (typeof value !== 'string') {
    throw new Error(`PopDEX ${field} 必须是非负整数字符串。`);
  }
  if (!INTEGER_STRING.test(value)) {
    throw new Error(`PopDEX ${field} 必须是非负整数字符串。`);
  }
  return value;
}

export function strictDecimalString(value, field) {
  if (typeof value !== 'string' || !DECIMAL_STRING.test(value)) {
    throw new Error(`PopDEX ${field} 必须是非负十进制字符串。`);
  }
  return value;
}

function boundedNumber(value, field) {
  const parsed = Number(strictDecimalString(value, field));
  if (!Number.isFinite(parsed)) {
    throw new Error(`PopDEX ${field} 超出可显示数值范围。`);
  }
  return parsed;
}

export function normalizeMarket(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PopDEX market 必须是对象。');
  }
  if (typeof value.symbol !== 'string' || !(value.symbol in POPDEX_EXPECTED_MARKETS)) {
    throw new Error(`PopDEX market ${String(value.symbol)} 不在白名单。`);
  }

  const expected = POPDEX_EXPECTED_MARKETS[value.symbol];
  if (value.category !== 'Futures') {
    throw new Error(`PopDEX ${value.symbol} category 必须是 Futures。`);
  }
  if (value.status !== 'Trading') {
    throw new Error(`PopDEX ${value.symbol} status 必须是 Trading。`);
  }

  for (const field of ['symbolId', 'tickSize', 'lotSize', 'minQty', 'minNotional']) {
    const parser = field === 'symbolId' ? strictIntegerString : strictDecimalString;
    const actual = parser(value[field], `${value.symbol} ${field}`);
    if (actual !== expected[field]) {
      throw new Error(
        `PopDEX ${value.symbol} ${field} 与主网身份不符：expected=${expected[field]} actual=${actual}`,
      );
    }
  }

  const marketId = Number(expected.symbolId);
  if (!Number.isSafeInteger(marketId)) {
    throw new Error(`PopDEX ${value.symbol} symbolId 不是安全整数。`);
  }
  const defaultLeverage = Number(strictIntegerString(value.defaultLeverage, `${value.symbol} defaultLeverage`));
  if (!Number.isSafeInteger(defaultLeverage) || defaultLeverage <= 0) {
    throw new Error(`PopDEX ${value.symbol} defaultLeverage 必须是正安全整数。`);
  }

  return {
    marketId,
    name: value.symbol,
    displayName: value.symbol,
    symbol: value.symbol.slice(0, -4),
    stepPrice: boundedNumber(expected.tickSize, `${value.symbol} tickSize`),
    stepSize: boundedNumber(expected.lotSize, `${value.symbol} lotSize`),
    minOrderSize: boundedNumber(expected.minQty, `${value.symbol} minQty`),
    minNotional: boundedNumber(expected.minNotional, `${value.symbol} minNotional`),
    defaultLeverage,
  };
}

function strictNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`PopDEX ${field} 必须是非空字符串。`);
  }
  return value;
}

function strictTargetSymbol(value, field) {
  const symbol = strictNonEmptyString(value, field);
  if (!(symbol in POPDEX_EXPECTED_MARKETS)) {
    throw new Error(`PopDEX ${field} ${symbol} 不在白名单。`);
  }
  return symbol;
}

function strictOptionalDecimal(value, field) {
  return value === undefined || value === null
    ? value
    : strictDecimalString(value, field);
}

export function normalizeOrder(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PopDEX order 必须是对象。');
  }
  const orderId = strictIntegerString(value.orderId, 'order.orderId');
  if (value.clientOid !== undefined && value.clientOrderId !== undefined
      && value.clientOid !== value.clientOrderId) {
    throw new Error('PopDEX order.clientOid 与 order.clientOrderId 冲突。');
  }
  const rawClientOid = value.clientOid ?? value.clientOrderId;
  const clientOid = rawClientOid === undefined || rawClientOid === null
    ? rawClientOid
    : strictNonEmptyString(rawClientOid, 'order.clientOid');
  return {
    ...value,
    orderId,
    clientOid,
    symbol: strictTargetSymbol(value.symbol, 'order.symbol'),
    side: strictNonEmptyString(value.side, 'order.side'),
    status: strictNonEmptyString(value.status, 'order.status'),
    price: strictOptionalDecimal(value.price, 'order.price'),
    qty: strictOptionalDecimal(value.qty, 'order.qty'),
    filledQty: strictOptionalDecimal(value.filledQty, 'order.filledQty'),
  };
}

export function normalizeFill(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PopDEX fill 必须是对象。');
  }
  const fillIds = [value.fillId, value.tradeId, value.execId]
    .filter((item) => item !== undefined)
    .map((item) => strictIntegerString(item, 'fill ID'));
  if (new Set(fillIds).size > 1) {
    throw new Error('PopDEX fill ID 字段冲突。');
  }
  return {
    ...value,
    fillId: strictIntegerString(fillIds[0], 'fill.fillId'),
    orderId: strictIntegerString(value.orderId, 'fill.orderId'),
    symbol: strictTargetSymbol(value.symbol, 'fill.symbol'),
    side: strictNonEmptyString(value.side, 'fill.side'),
    execPrice: strictOptionalDecimal(value.execPrice, 'fill.execPrice'),
    execQty: strictOptionalDecimal(value.execQty, 'fill.execQty'),
  };
}
