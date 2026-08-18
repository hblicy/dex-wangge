import { randomBytes } from 'node:crypto';
import {
  encodeBytes32String,
  formatUnits,
  getAddress,
  hexlify,
  Interface,
  isAddress,
  parseUnits,
  ZeroAddress,
} from 'ethers';
import { POPDEX_EXPECTED_MARKETS, POPDEX_USER_CONFIG_PRECOMPILE } from './constants.js';
import { encodeOrderParams, POPDEX_ORDER_INTERFACE } from './order-codec.js';
import {
  strictAddress,
  strictDecimalString,
  strictIntegerString,
} from './normalize.js';

const WAD_DECIMALS = 18;
const WAD = 10n ** 18n;
const BTC_SYMBOL = 'BTCUSDT';
const BTC_SYMBOL_ID = '20000';
const FUTURES_CATEGORY = '2';
const ONE_WAY_POSITION_MODE = '0';
const LONG_POSITION_SIDE = '1';
const TARGET_LEVERAGE = '1';
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const CLOSE_SLIPPAGE_WAD = 30_000_000_000_000_000n;

export const POPDEX_USER_CONFIG_INTERFACE = new Interface([
  'function getAccountConfig(address account) view returns ((uint8 status,uint8 vipLevel,uint8 positionMode,uint64 bizPermissionCode,tuple(uint16 symbolId,uint8 leverage)[] symbolLeverages,tuple(address tokenAddress,uint8 leverage)[] tokenLeverages) config)',
  'function updateLeverage(address account,(uint8 newLeverage,uint16 symbolId,address tokenAddress,uint8 category) request) returns (bool success)',
  'event LeverageUpdated(address indexed account,uint8 category,uint16 symbolId,address tokenAddress,uint8 newLeverage,bool succeeded,uint32 code)',
]);

export const POPDEX_REDUCE_ONLY_MARKET_PARAMS =
  '0x0201010000000100000000000000000000000000000000000000000000000000';

function exactBytes32(value, field) {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw new Error(`PopDEX ${field} 必须是精确 bytes32 十六进制字符串。`);
  }
  return value.toLowerCase();
}

export function encodeReduceOnlyMarketClose({
  mainAccount,
  closeClientOrderId,
  closeQtyWad,
}) {
  const account = strictAddress(mainAccount, 'close.mainAccount');
  const clientOrderId = exactBytes32(closeClientOrderId, 'closeClientOrderId');
  const qty = BigInt(strictIntegerString(closeQtyWad, 'closeQtyWad'));
  if (qty <= 0n) throw new Error('PopDEX closeQtyWad 必须大于 0。');
  return POPDEX_ORDER_INTERFACE.encodeFunctionData('placeOrder', [
    account,
    clientOrderId,
    20000,
    POPDEX_REDUCE_ONLY_MARKET_PARAMS,
    0n,
    qty,
    CLOSE_SLIPPAGE_WAD,
    ZeroAddress,
    0n,
  ]);
}

function decimalToWad(value, field) {
  const normalized = strictDecimalString(value, field);
  if ((normalized.split('.')[1] ?? '').length > WAD_DECIMALS) {
    throw new Error(`PopDEX ${field} 最多支持 18 位小数。`);
  }
  return parseUnits(normalized, WAD_DECIMALS);
}

function wadToDecimal(value) {
  const text = formatUnits(value, WAD_DECIMALS);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

function fixedInput(value, expected, field) {
  if (value !== undefined && value !== expected) {
    throw new Error(`PopDEX Stage 5 ${field} 固定为 ${expected}。`);
  }
}

function exactEntropy(randomBytesImpl) {
  if (typeof randomBytesImpl !== 'function') {
    throw new Error('PopDEX randomBytesImpl 必须是函数。');
  }
  const entropy = randomBytesImpl(16);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) {
    throw new Error('PopDEX entropy 必须是 16 字节 Uint8Array。');
  }
  return entropy;
}

function exactEntropyBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16) {
    throw new Error('PopDEX entropy 必须是 16 字节 Uint8Array。');
  }
  return value;
}

export function createBtcCloseClientOrderId(entropy) {
  const entropyHex = hexlify(exactEntropyBytes(entropy).slice(0, 12)).slice(2);
  return encodeBytes32String(`dw-bc-${entropyHex}`).toLowerCase();
}

export function encodeBtcLeverageOne(mainAccount) {
  const account = strictAddress(mainAccount, 'mainAccount');
  return POPDEX_USER_CONFIG_INTERFACE.encodeFunctionData('updateLeverage', [
    account,
    [1, 20000, ZeroAddress, 2],
  ]);
}

export function prepareFillClosePlan({
  mainAccount,
  ask,
  randomBytesImpl = randomBytes,
  symbol,
  side,
  leverage,
  positionMode,
  positionSide,
} = {}) {
  fixedInput(symbol, BTC_SYMBOL, 'symbol');
  fixedInput(side, 'buy', 'side');
  fixedInput(leverage, TARGET_LEVERAGE, 'leverage');
  fixedInput(positionMode, ONE_WAY_POSITION_MODE, 'positionMode');
  fixedInput(positionSide, LONG_POSITION_SIDE, 'positionSide');
  const account = strictAddress(mainAccount, 'mainAccount');
  const askWad = decimalToWad(ask, 'ask');
  if (askWad <= 0n) throw new Error('PopDEX ask 必须大于 0。');

  const market = POPDEX_EXPECTED_MARKETS[BTC_SYMBOL];
  const tickWad = decimalToWad(market.tickSize, 'BTCUSDT tickSize');
  const lotWad = decimalToWad(market.lotSize, 'BTCUSDT lotSize');
  const minQtyWad = decimalToWad(market.minQty, 'BTCUSDT minQty');
  const minNotionalWad = decimalToWad(market.minNotional, 'BTCUSDT minNotional');
  const requiredQty = (minNotionalWad * WAD + askWad - 1n) / askWad;
  const unalignedQty = requiredQty > minQtyWad ? requiredQty : minQtyWad;
  const qtyWad = ((unalignedQty + lotWad - 1n) / lotWad) * lotWad;
  const rawCap = (askWad * 1003n + 999n) / 1000n;
  const priceWad = ((rawCap + tickWad - 1n) / tickWad) * tickWad;
  if ((priceWad * qtyWad) / WAD < minNotionalWad) {
    throw new Error('PopDEX Stage 5 计划名义价值低于 BTCUSDT 最低要求。');
  }

  const entropy = exactEntropy(randomBytesImpl);
  const entropyHex = hexlify(entropy.slice(0, 12)).slice(2);
  const clientOrderId = encodeBytes32String(`dw-bb-${entropyHex}`).toLowerCase();
  const closeClientOrderId = createBtcCloseClientOrderId(entropy);
  const orderParams = encodeOrderParams('buy');
  const leverageData = encodeBtcLeverageOne(account);
  const entryData = POPDEX_ORDER_INTERFACE.encodeFunctionData('placeOrder', [
    account,
    clientOrderId,
    20000,
    orderParams,
    priceWad,
    qtyWad,
    0n,
    ZeroAddress,
    0n,
  ]);
  const closePreviewData = encodeReduceOnlyMarketClose({
    mainAccount: account,
    closeClientOrderId,
    closeQtyWad: qtyWad.toString(),
  });

  return Object.freeze({
    mainAccount: account,
    symbol: BTC_SYMBOL,
    symbolId: BTC_SYMBOL_ID,
    side: 'buy',
    leverage: TARGET_LEVERAGE,
    positionMode: ONE_WAY_POSITION_MODE,
    positionSide: LONG_POSITION_SIDE,
    category: FUTURES_CATEGORY,
    ask: wadToDecimal(askWad),
    price: wadToDecimal(priceWad),
    qty: wadToDecimal(qtyWad),
    askWad: askWad.toString(),
    priceWad: priceWad.toString(),
    qtyWad: qtyWad.toString(),
    clientOrderId,
    closeClientOrderId,
    orderParams,
    leverageData,
    entryData,
    closePreviewData,
  });
}

export function verifyStage5Simulation(raw, iface, functionName) {
  if (!iface || typeof iface.getFunction !== 'function' || typeof functionName !== 'string') {
    throw new Error('PopDEX Stage 5 模拟接口和 functionName 无效。');
  }
  try {
    if (iface.getFunction(functionName) === null) {
      throw new Error('函数不存在');
    }
  } catch (cause) {
    throw new Error(`PopDEX Stage 5 模拟函数 ${String(functionName)} 不存在。`, { cause });
  }
  if (raw === '0x') return 'empty';
  let decoded;
  try {
    decoded = iface.decodeFunctionResult(functionName, raw);
  } catch (cause) {
    throw new Error(`PopDEX ${functionName} 模拟结果无效。`, { cause });
  }
  if (decoded.length !== 1 || decoded[0] !== true) {
    throw new Error(`PopDEX ${functionName} 模拟未返回 true。`);
  }
  return 'bool-true';
}

function exactAddressAllowZero(value, field) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`PopDEX ${field} 必须是有效 EVM 地址。`);
  }
  return getAddress(value);
}

function mismatch(field, expected, actual) {
  throw new Error(
    `PopDEX LeverageUpdated ${field} 不匹配：expected=${expected} actual=${actual}。`,
  );
}

export function parseLeverageUpdatedReceipt(receipt, expected) {
  if (!receipt || typeof receipt !== 'object' || receipt.status !== '0x1') {
    throw new Error('PopDEX LeverageUpdated 回执必须是 status=0x1 的对象。');
  }
  if (!Array.isArray(receipt.logs)) {
    throw new Error('PopDEX LeverageUpdated 回执 logs 必须是数组。');
  }
  if (!expected || typeof expected !== 'object') {
    throw new Error('PopDEX LeverageUpdated expected 必须是对象。');
  }
  const account = strictAddress(expected.mainAccount, 'LeverageUpdated expected.account');
  const topic = POPDEX_USER_CONFIG_INTERFACE
    .getEvent('LeverageUpdated').topicHash.toLowerCase();
  const matches = [];
  for (const [index, log] of receipt.logs.entries()) {
    if (!log || typeof log !== 'object'
        || typeof log.address !== 'string'
        || log.address.toLowerCase() !== POPDEX_USER_CONFIG_PRECOMPILE.toLowerCase()
        || !Array.isArray(log.topics)
        || typeof log.topics[0] !== 'string'
        || log.topics[0].toLowerCase() !== topic) continue;
    try {
      matches.push(POPDEX_USER_CONFIG_INTERFACE.parseLog({
        data: log.data,
        topics: log.topics,
      }).args);
    } catch (cause) {
      throw new Error(
        `PopDEX LeverageUpdated 回执 log[${index}] 解码失败：${cause?.message || cause}`,
        { cause },
      );
    }
  }
  if (matches.length !== 1) {
    throw new Error(`PopDEX LeverageUpdated 回执必须恰好 1 条目标事件，实际 ${matches.length}。`);
  }
  const args = matches[0];
  const code = args.code.toString();
  if (args.succeeded !== true || code !== '0') {
    throw new Error(
      `PopDEX LeverageUpdated 失败：succeeded=${String(args.succeeded)} code=${code}。`,
    );
  }
  const actual = {
    account: strictAddress(args.account, 'LeverageUpdated account'),
    category: args.category.toString(),
    symbolId: args.symbolId.toString(),
    tokenAddress: exactAddressAllowZero(args.tokenAddress, 'LeverageUpdated tokenAddress'),
    leverage: args.newLeverage.toString(),
  };
  for (const [field, wanted, value] of [
    ['account', account.toLowerCase(), actual.account.toLowerCase()],
    ['category', FUTURES_CATEGORY, actual.category],
    ['symbolId', BTC_SYMBOL_ID, actual.symbolId],
    ['tokenAddress', ZeroAddress.toLowerCase(), actual.tokenAddress.toLowerCase()],
    ['leverage', TARGET_LEVERAGE, actual.leverage],
  ]) {
    if (wanted !== value) mismatch(field, wanted, value);
  }
  return actual;
}
