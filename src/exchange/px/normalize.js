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
