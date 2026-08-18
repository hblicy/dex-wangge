import { Interface } from 'ethers';
import { POPDEX_ORDER_PRECOMPILE } from './constants.js';
import { strictAddress, strictIntegerString } from './normalize.js';

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ORDER_CREATE_PRICE_RULES = new Set(['exact', 'positive-execution']);

export const POPDEX_ORDER_EVENT_INTERFACE = new Interface([
  'event OrderCreate(address indexed account,uint16 indexed symbol,uint128 orderId,bytes32 clientOid,int256 price,int256 qty,int256 borrowAmount,uint8 status,bool succeeded,uint32 code)',
  'event OrderCancel(address indexed account,uint128 orderId,bytes32 clientOid,bool succeeded,uint32 code)',
]);

function exactBytes32(value, field) {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw new Error(`PopDEX ${field} 必须是精确 bytes32 十六进制字符串。`);
  }
  return value.toLowerCase();
}

function exactPositiveOrderId(value, field) {
  const orderId = strictIntegerString(value.toString(), field);
  if (BigInt(orderId) <= 0n) throw new Error(`PopDEX ${field} 必须是正整数。`);
  return orderId;
}

function mismatch(eventName, field, expected, actual) {
  throw new Error(
    `PopDEX ${eventName} ${field} 不匹配：expected=${String(expected)} actual=${String(actual)}。`,
  );
}

function exactPriceRule(value) {
  const rule = value ?? 'exact';
  if (!ORDER_CREATE_PRICE_RULES.has(rule)) {
    throw new Error(`PopDEX OrderCreate expected.priceRule 无效：${String(rule)}。`);
  }
  return rule;
}

function exactEvent(receipt, eventName) {
  if (!receipt || typeof receipt !== 'object' || receipt.status !== '0x1') {
    throw new Error(`PopDEX ${eventName} 回执必须是 status=0x1 的对象。`);
  }
  if (!Array.isArray(receipt.logs)) {
    throw new Error(`PopDEX ${eventName} 回执 logs 必须是数组。`);
  }
  const topic = POPDEX_ORDER_EVENT_INTERFACE.getEvent(eventName).topicHash.toLowerCase();
  const matches = [];
  for (const [index, log] of receipt.logs.entries()) {
    if (!log || typeof log !== 'object') continue;
    if (typeof log.address !== 'string'
        || log.address.toLowerCase() !== POPDEX_ORDER_PRECOMPILE.toLowerCase()) continue;
    if (!Array.isArray(log.topics) || typeof log.topics[0] !== 'string'
        || log.topics[0].toLowerCase() !== topic) continue;
    try {
      matches.push(POPDEX_ORDER_EVENT_INTERFACE.parseLog({ data: log.data, topics: log.topics }));
    } catch (cause) {
      throw new Error(`PopDEX ${eventName} 回执 log[${index}] 解码失败：${cause?.message || cause}`, { cause });
    }
  }
  if (matches.length !== 1) {
    throw new Error(`PopDEX ${eventName} 回执必须恰好 1 条目标事件，实际 ${matches.length}。`);
  }
  return matches[0].args;
}

function exactSuccess(eventName, args) {
  const code = args.code.toString();
  if (args.succeeded !== true || code !== '0') {
    throw new Error(`PopDEX ${eventName} 失败：succeeded=${String(args.succeeded)} code=${code}。`);
  }
}

export function parseOrderCreateReceipt(receipt, expected) {
  if (!expected || typeof expected !== 'object') {
    throw new Error('PopDEX OrderCreate expected 必须是对象。');
  }
  const account = strictAddress(expected.account, 'OrderCreate expected.account');
  const symbolId = strictIntegerString(expected.symbolId, 'OrderCreate expected.symbolId');
  const clientOrderId = exactBytes32(expected.clientOrderId, 'OrderCreate expected.clientOrderId');
  const priceWad = strictIntegerString(expected.priceWad, 'OrderCreate expected.priceWad');
  const qtyWad = strictIntegerString(expected.qtyWad, 'OrderCreate expected.qtyWad');
  const priceRule = exactPriceRule(expected.priceRule);
  const args = exactEvent(receipt, 'OrderCreate');
  exactSuccess('OrderCreate', args);

  const actualAccount = strictAddress(args.account, 'OrderCreate account');
  const actualSymbolId = args.symbol.toString();
  const actualClientOrderId = exactBytes32(args.clientOid, 'OrderCreate clientOid');
  const actualPriceWad = args.price.toString();
  const actualQtyWad = args.qty.toString();
  for (const [field, wanted, actual] of [
    ['account', account.toLowerCase(), actualAccount.toLowerCase()],
    ['symbolId', symbolId, actualSymbolId],
    ['clientOrderId', clientOrderId, actualClientOrderId],
    ['qtyWad', qtyWad, actualQtyWad],
  ]) {
    if (wanted !== actual) mismatch('OrderCreate', field, wanted, actual);
  }
  if (priceRule === 'exact') {
    if (priceWad !== actualPriceWad) {
      mismatch('OrderCreate', 'priceWad', priceWad, actualPriceWad);
    }
  } else {
    if (priceWad !== '0') {
      throw new Error('PopDEX OrderCreate positive-execution 只允许提交 priceWad=0。');
    }
    const executionPriceWad = strictIntegerString(actualPriceWad, 'OrderCreate priceWad');
    if (BigInt(executionPriceWad) <= 0n) {
      throw new Error('PopDEX OrderCreate priceWad 必须是正整数。');
    }
  }

  return {
    orderId: exactPositiveOrderId(args.orderId, 'OrderCreate orderId'),
    clientOrderId: actualClientOrderId,
    symbolId: actualSymbolId,
    priceWad: actualPriceWad,
    qtyWad: actualQtyWad,
    status: args.status.toString(),
  };
}

export function parseOrderCancelReceipt(receipt, expected) {
  if (!expected || typeof expected !== 'object') {
    throw new Error('PopDEX OrderCancel expected 必须是对象。');
  }
  const account = strictAddress(expected.account, 'OrderCancel expected.account');
  const orderId = exactPositiveOrderId(expected.orderId, 'OrderCancel expected.orderId');
  const clientOrderId = exactBytes32(expected.clientOrderId, 'OrderCancel expected.clientOrderId');
  const args = exactEvent(receipt, 'OrderCancel');
  exactSuccess('OrderCancel', args);

  const actualAccount = strictAddress(args.account, 'OrderCancel account');
  const actualOrderId = exactPositiveOrderId(args.orderId, 'OrderCancel orderId');
  const actualClientOrderId = exactBytes32(args.clientOid, 'OrderCancel clientOid');
  for (const [field, wanted, actual] of [
    ['account', account.toLowerCase(), actualAccount.toLowerCase()],
    ['orderId', orderId, actualOrderId],
    ['clientOrderId', clientOrderId, actualClientOrderId],
  ]) {
    if (wanted !== actual) mismatch('OrderCancel', field, wanted, actual);
  }
  return { orderId: actualOrderId, clientOrderId: actualClientOrderId };
}
