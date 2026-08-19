import { createHash } from 'node:crypto';
import { decodeBytes32String, parseUnits } from 'ethers';
import { strictDecimalString, strictIntegerString } from './normalize.js';

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const REST_TERMINAL_STATES = new Map([
  ['FullyFilled', 'FILLED'],
  ['PartiallyFilledCancelled', 'CANCELLED'],
  ['Cancelled', 'CANCELLED'],
  ['Rejected', 'REJECTED'],
  ['Expired', 'EXPIRED'],
]);

function integer(value, field) {
  return BigInt(strictIntegerString(value, field));
}

function decimalWad(value, field) {
  const normalized = strictDecimalString(value, field);
  if ((normalized.split('.')[1] ?? '').length > 18) {
    throw new Error(`PopDEX ${field} 最多支持 18 位小数。`);
  }
  return parseUnits(normalized, 18);
}

function bytes32(value, field) {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw new Error(`PopDEX ${field} 必须是 bytes32 十六进制字符串。`);
  }
  return value.toLowerCase();
}

function ownedSide(value) {
  if (value !== 'buy' && value !== 'sell') {
    throw new Error('PopDEX owned.side 必须是 buy 或 sell。');
  }
  return value;
}

function officialSide(value, field) {
  if (value === '0' || value === 0 || value === 'Buy') return 'buy';
  if (value === '1' || value === 1 || value === 'Sell') return 'sell';
  throw new Error(`PopDEX ${field} 无效。`);
}

function exactBoolean(value, field) {
  if (typeof value !== 'boolean') throw new Error(`PopDEX ${field} 必须是布尔值。`);
  return value;
}

function normalizeOwned(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PopDEX owned order 必须是对象。');
  }
  const orderId = strictIntegerString(value.orderId, 'owned.orderId');
  const clientOrderId = bytes32(value.clientOrderId, 'owned.clientOrderId');
  if (!Number.isSafeInteger(value.marketId) || value.marketId <= 0) {
    throw new Error('PopDEX owned.marketId 必须是正安全整数。');
  }
  const qtyWad = integer(value.qtyWad, 'owned.qtyWad');
  const priceWad = integer(value.priceWad, 'owned.priceWad');
  if (qtyWad <= 0n || priceWad <= 0n) {
    throw new Error('PopDEX owned priceWad 和 qtyWad 必须大于 0。');
  }
  return {
    orderId,
    clientOrderId,
    clientOid: decodeBytes32String(clientOrderId),
    marketId: value.marketId,
    side: ownedSide(value.side),
    priceWad,
    qtyWad,
    reduceOnly: exactBoolean(value.reduceOnly, 'owned.reduceOnly'),
  };
}

function quantity(value, wadField, decimalField, label) {
  if (value[wadField] !== undefined) return integer(value[wadField], `${label}.${wadField}`);
  return decimalWad(value[decimalField], `${label}.${decimalField}`);
}

function normalizeOfficial(value, owned, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PopDEX ${label} 必须是对象。`);
  }
  const orderId = strictIntegerString(String(value.orderId), `${label}.orderId`);
  const clientMatches = value.clientOrderId !== undefined
    ? bytes32(value.clientOrderId, `${label}.clientOrderId`) === owned.clientOrderId
    : value.clientOid === owned.clientOid;
  const symbolId = String(value.symbolId);
  const side = officialSide(value.side, `${label}.side`);
  const reduceOnly = exactBoolean(
    value.isReduceOnly ?? value.reduceOnly,
    `${label}.reduceOnly`,
  );
  const priceWad = quantity(value, 'priceWad', 'price', label);
  const qtyWad = quantity(value, 'qtyWad', 'qty', label);
  const filledQtyWad = quantity(value, 'filledQtyWad', 'filledQty', label);
  const remainingQtyWad = quantity(value, 'remainingQtyWad', 'remainingQty', label);
  const cancelledQtyWad = quantity(value, 'cancelledQtyWad', 'cancelledQty', label);
  if (orderId !== owned.orderId
      || !clientMatches
      || symbolId !== String(owned.marketId)
      || side !== owned.side
      || reduceOnly !== owned.reduceOnly
      || priceWad !== owned.priceWad
      || qtyWad !== owned.qtyWad) {
    throw new Error(`PopDEX ${label} 订单身份不匹配。`);
  }
  if (qtyWad !== filledQtyWad + remainingQtyWad + cancelledQtyWad) {
    throw new Error(`PopDEX ${label} 数量恒等式不成立。`);
  }
  return {
    status: value.status === undefined ? null : String(value.status),
    filledQtyWad,
    remainingQtyWad,
    cancelledQtyWad,
  };
}

function normalizeFills(values, owned) {
  if (!Array.isArray(values)) throw new Error('PopDEX fills 必须是数组。');
  const seen = new Set();
  const fills = [];
  let qtyWad = 0n;
  let quoteProduct = 0n;
  for (const value of values) {
    if (!value || typeof value !== 'object' || String(value.orderId) !== owned.orderId) continue;
    const fillId = strictIntegerString(value.fillId, 'fill.fillId');
    if (seen.has(fillId)) throw new Error(`PopDEX fillId ${fillId} 重复。`);
    seen.add(fillId);
    if (value.symbol !== 'BTCUSDT' || officialSide(value.side, 'fill.side') !== owned.side) {
      throw new Error('PopDEX 成交身份不匹配。');
    }
    const fillQtyWad = value.execQtyWad !== undefined
      ? integer(value.execQtyWad, 'fill.execQtyWad')
      : decimalWad(value.execQty, 'fill.execQty');
    const fillPriceWad = value.execPriceWad !== undefined
      ? integer(value.execPriceWad, 'fill.execPriceWad')
      : decimalWad(value.execPrice, 'fill.execPrice');
    if (fillQtyWad <= 0n || fillPriceWad <= 0n) {
      throw new Error('PopDEX fill.execQty 和 fill.execPrice 必须大于 0。');
    }
    qtyWad += fillQtyWad;
    quoteProduct += fillQtyWad * fillPriceWad;
    fills.push({ fillId, qtyWad: fillQtyWad, priceWad: fillPriceWad });
  }
  if (qtyWad > owned.qtyWad) throw new Error('PopDEX 本单成交量超过委托量。');
  return { fills, qtyWad, quoteProduct };
}

export function buildFillEventId({
  orderId,
  clientOrderId,
  terminalState,
  fillIds,
  filledQtyWad,
}) {
  const canonical = JSON.stringify({
    orderId: strictIntegerString(orderId, 'event.orderId'),
    clientOrderId: bytes32(clientOrderId, 'event.clientOrderId'),
    terminalState,
    fillIds: [...fillIds].map((value) => strictIntegerString(value, 'event.fillId')).sort(),
    filledQtyWad: strictIntegerString(filledQtyWad, 'event.filledQtyWad'),
  });
  return `px-fill-${createHash('sha256').update(canonical).digest('hex')}`;
}

function result(state, event = null, details = {}) {
  return { state, event, ...details };
}

function terminalEvent(owned, terminalState, fills, suppressRequote) {
  if (fills.qtyWad === 0n) return null;
  const fillIds = fills.fills.map((value) => value.fillId).sort();
  const filledQtyWad = fills.qtyWad.toString();
  return {
    fillEventId: buildFillEventId({
      orderId: owned.orderId,
      clientOrderId: owned.clientOrderId,
      terminalState,
      fillIds,
      filledQtyWad,
    }),
    orderId: owned.orderId,
    clientOrderId: owned.clientOrderId,
    terminalState,
    fillIds,
    filledQtyWad,
    priceWad: (fills.quoteProduct / fills.qtyWad).toString(),
    suppressRequote,
  };
}

function validateCancelProof(value, owned, fills) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PopDEX cancelProof 必须是对象。');
  }
  const orderId = strictIntegerString(value.orderId, 'cancelProof.orderId');
  const clientOrderId = bytes32(value.clientOrderId, 'cancelProof.clientOrderId');
  if (orderId !== owned.orderId || clientOrderId !== owned.clientOrderId) {
    throw new Error('PopDEX 撤单证明身份不匹配。');
  }
  const filledQtyWad = integer(value.filledQtyWad, 'cancelProof.filledQtyWad');
  if (filledQtyWad !== fills.qtyWad) {
    throw new Error('PopDEX 撤单证明成交量不匹配。');
  }
}

export function reconcileOwnedOrder(ownedValue, {
  active = null,
  completed = null,
  fills: fillValues = [],
  cancelProof = null,
  suppressRequote = false,
} = {}) {
  if (typeof suppressRequote !== 'boolean') {
    throw new Error('PopDEX suppressRequote 必须是布尔值。');
  }
  if (active !== null && completed !== null) {
    throw new Error('PopDEX 同一订单不能同时是 active 和 completed。');
  }
  const owned = normalizeOwned(ownedValue);
  const fills = normalizeFills(fillValues, owned);
  const exactFillIds = fills.fills.map((value) => value.fillId).sort();

  if (active !== null) {
    const official = normalizeOfficial(active, owned, 'active');
    if (official.filledQtyWad !== fills.qtyWad) {
      return result('SETTLING', null, {
        officialFilledQtyWad: official.filledQtyWad.toString(),
        fillSumQtyWad: fills.qtyWad.toString(),
      });
    }
    if (official.remainingQtyWad === 0n) return result('SETTLING');
    return result(fills.qtyWad === 0n ? 'OPEN' : 'PARTIAL', null, {
      filledQtyWad: fills.qtyWad.toString(),
      fillIds: exactFillIds,
    });
  }

  if (completed !== null) {
    const official = normalizeOfficial(completed, owned, 'completed');
    if (official.filledQtyWad !== fills.qtyWad) {
      return result('SETTLING', null, {
        officialFilledQtyWad: official.filledQtyWad.toString(),
        fillSumQtyWad: fills.qtyWad.toString(),
      });
    }
    let state = REST_TERMINAL_STATES.get(official.status);
    if (state === undefined) {
      if (official.remainingQtyWad !== 0n) return result('SETTLING');
      state = official.filledQtyWad === owned.qtyWad ? 'FILLED' : 'CANCELLED';
    }
    if (state === 'FILLED' && official.filledQtyWad !== owned.qtyWad) {
      return result('SETTLING');
    }
    return result(state, terminalEvent(owned, state, fills, suppressRequote), {
      filledQtyWad: fills.qtyWad.toString(),
    });
  }

  if (cancelProof !== null) {
    validateCancelProof(cancelProof, owned, fills);
    return result('CANCELLED', terminalEvent(owned, 'CANCELLED', fills, suppressRequote), {
      filledQtyWad: fills.qtyWad.toString(),
    });
  }
  if (fills.qtyWad === owned.qtyWad) {
    return result('FILLED', terminalEvent(owned, 'FILLED', fills, suppressRequote), {
      filledQtyWad: fills.qtyWad.toString(),
    });
  }
  if (fills.qtyWad > 0n) return result('SETTLING');
  return result('UNKNOWN_TERMINAL');
}
