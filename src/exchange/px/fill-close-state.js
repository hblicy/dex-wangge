import { decodeBytes32String, parseUnits } from 'ethers';
import {
  strictAddress,
  strictDecimalString,
  strictIntegerString,
} from './normalize.js';

const WAD_DECIMALS = 18;
const BTC_SYMBOL = 'BTCUSDT';
const BTC_SYMBOL_ID = '20000';
const LONG_POSITION_SIDE = '1';
const ALLOWED_ORDER_STATUSES = new Set([
  'PendingNew',
  'NewAccept',
  'PendingCancel',
  'PartiallyFilled',
  'FullyFilled',
  'PartiallyFilledCancelled',
  'Cancelled',
]);

function decimalWad(value, field) {
  const normalized = strictDecimalString(value, field);
  if ((normalized.split('.')[1] ?? '').length > WAD_DECIMALS) {
    throw new Error(`PopDEX ${field} 最多支持 18 位小数。`);
  }
  return parseUnits(normalized, WAD_DECIMALS);
}

function integerWad(value, field) {
  return BigInt(strictIntegerString(value, field));
}

function isBtc(value) {
  return value?.symbol === BTC_SYMBOL || String(value?.symbolId) === BTC_SYMBOL_ID;
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

export function assertInitialFlat({ openOrders, positions } = {}) {
  if (!Array.isArray(openOrders) || !Array.isArray(positions)) {
    throw new Error('PopDEX 初始快照格式无效。');
  }
  const btcOrders = openOrders.filter(isBtc);
  const btcPositions = positions.filter((item) => isBtc(item)
    && integerWad(item.holdSizeWad, 'position.holdSizeWad') > 0n);
  if (btcOrders.length !== 0) {
    throw new Error(`PopDEX BTCUSDT 仍有 ${btcOrders.length} 个活动订单。`);
  }
  if (btcPositions.length !== 0) {
    throw new Error(`PopDEX BTCUSDT 仍有 ${btcPositions.length} 个持仓。`);
  }
  return true;
}

export function exactBtcLeverage(config) {
  if (!config || config.positionMode !== '0' || !Array.isArray(config.symbolLeverages)) {
    throw new Error('PopDEX 账户必须是 OneWay positionMode=0。');
  }
  const matches = config.symbolLeverages.filter((item) => item?.symbolId === BTC_SYMBOL_ID);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`PopDEX BTCUSDT 杠杆记录重复，实际 ${matches.length}。`);
  }
  const leverage = integerWad(matches[0].leverage, 'BTC leverage');
  if (leverage < 1n || leverage > 255n) {
    throw new Error('PopDEX BTCUSDT leverage 必须是 1-255。');
  }
  return leverage.toString();
}

function assertOrderIdentity(candidate, plan, orderId, expectedClientOid) {
  const account = strictAddress(candidate.walletId, 'order.walletId');
  const expectedAccount = strictAddress(plan.mainAccount, 'plan.mainAccount');
  const valid = sameAddress(account, expectedAccount)
    && String(candidate.orderId) === orderId
    && String(candidate.symbolId) === BTC_SYMBOL_ID
    && candidate.symbol === BTC_SYMBOL
    && candidate.side === 'Buy'
    && candidate.clientOid === expectedClientOid
    && ALLOWED_ORDER_STATUSES.has(candidate.status)
    && candidate.reduceOnly === false
    && decimalWad(candidate.price, 'order.price') === integerWad(plan.priceWad, 'plan.priceWad')
    && decimalWad(candidate.qty, 'order.qty') === integerWad(plan.qtyWad, 'plan.qtyWad');
  if (!valid) throw new Error('PopDEX 入场订单身份不匹配。');
}

export function classifyEntry(plan, {
  orderId,
  order = null,
  fills,
  openOrders,
  cancelConfirmed = false,
} = {}) {
  if (!plan || typeof plan !== 'object'
      || !Array.isArray(fills)
      || !Array.isArray(openOrders)
      || typeof cancelConfirmed !== 'boolean') {
    throw new Error('PopDEX 入场快照格式无效。');
  }
  const exactOrderId = strictIntegerString(orderId, 'entry.orderId');
  const expectedClientOid = decodeBytes32String(plan.clientOrderId);
  const btcOpen = openOrders.filter(isBtc);
  if (btcOpen.some((item) => String(item.orderId) !== exactOrderId
      || item.clientOid !== expectedClientOid)) {
    throw new Error('PopDEX 出现不属于本探针的 BTCUSDT 活动订单。');
  }
  if (btcOpen.length > 1) throw new Error('PopDEX 入场活动订单重复。');
  const candidate = order ?? btcOpen[0] ?? null;
  if (candidate) assertOrderIdentity(candidate, plan, exactOrderId, expectedClientOid);
  if (btcOpen.length === 1) {
    assertOrderIdentity(btcOpen[0], plan, exactOrderId, expectedClientOid);
  }

  const seen = new Set();
  let fillWad = 0n;
  for (const item of fills) {
    if (String(item?.orderId) !== exactOrderId) continue;
    const fillId = strictIntegerString(item.fillId, 'fill.fillId');
    if (seen.has(fillId)) throw new Error(`PopDEX fillId ${fillId} 重复。`);
    seen.add(fillId);
    if (item.symbol !== BTC_SYMBOL || item.side !== 'Buy') {
      throw new Error('PopDEX 成交身份不匹配。');
    }
    const execQtyWad = decimalWad(item.execQty, 'fill.execQty');
    if (execQtyWad <= 0n) throw new Error('PopDEX fill.execQty 必须大于 0。');
    fillWad += execQtyWad;
  }

  const qty = integerWad(plan.qtyWad, 'plan.qtyWad');
  if (fillWad > qty) throw new Error('PopDEX 本单成交量超过委托量。');
  if (candidate) {
    const filled = decimalWad(candidate.filledQty, 'order.filledQty');
    const remaining = decimalWad(candidate.remainingQty, 'order.remainingQty');
    const cancelled = decimalWad(candidate.cancelledQty, 'order.cancelledQty');
    if (qty !== filled + remaining + cancelled) {
      throw new Error('PopDEX 入场订单数量恒等式不成立。');
    }
    if (filled !== fillWad) {
      return {
        kind: 'settling',
        orderId: exactOrderId,
        orderFilledQtyWad: filled.toString(),
        fillSumQtyWad: fillWad.toString(),
        remainingQtyWad: remaining.toString(),
      };
    }
  }

  if (cancelConfirmed && btcOpen.length === 0) {
    return {
      kind: fillWad > 0n ? 'partial-fill' : 'zero-fill',
      orderId: exactOrderId,
      filledQtyWad: fillWad.toString(),
      remainingQtyWad: '0',
    };
  }
  if (fillWad === qty) {
    return {
      kind: 'full-fill',
      orderId: exactOrderId,
      filledQtyWad: fillWad.toString(),
      remainingQtyWad: '0',
    };
  }
  if (btcOpen.length === 1) {
    const remaining = decimalWad(btcOpen[0].remainingQty, 'active.remainingQty');
    return {
      kind: fillWad > 0n ? 'partial-fill' : 'zero-fill-active',
      orderId: exactOrderId,
      filledQtyWad: fillWad.toString(),
      remainingQtyWad: remaining.toString(),
    };
  }
  if (candidate && decimalWad(candidate.remainingQty, 'order.remainingQty') === 0n) {
    return {
      kind: fillWad > 0n ? 'partial-fill' : 'zero-fill',
      orderId: exactOrderId,
      filledQtyWad: fillWad.toString(),
      remainingQtyWad: '0',
    };
  }
  return {
    kind: 'settling',
    orderId: exactOrderId,
    fillSumQtyWad: fillWad.toString(),
  };
}

export function assertEntrySettled(result) {
  if (!result || typeof result !== 'object' || typeof result.kind !== 'string') {
    throw new Error('PopDEX 入场分类结果无效。');
  }
  if (result.kind === 'settling') {
    throw new Error(
      `PopDEX 订单与成交事实仍未一致：orderId=${String(result.orderId)}。`,
    );
  }
  return result;
}

export function assertConfirmedLong(plan, { positions, openOrders } = {}, filledQtyWad) {
  if (!plan || typeof plan !== 'object'
      || !Array.isArray(positions)
      || !Array.isArray(openOrders)) {
    throw new Error('PopDEX 持仓确认快照格式无效。');
  }
  if (openOrders.some(isBtc)) {
    throw new Error('PopDEX 确认持仓前仍有 BTCUSDT 活动订单。');
  }
  const nonzero = positions.filter((item) => isBtc(item)
    && integerWad(item.holdSizeWad, 'position.holdSizeWad') > 0n);
  if (nonzero.length !== 1 || nonzero[0].side !== LONG_POSITION_SIDE) {
    throw new Error('PopDEX 必须只有一个 BTCUSDT Long=1 持仓。');
  }
  const candidate = nonzero[0];
  const wallet = strictAddress(candidate.walletId, 'position.walletId');
  if (!sameAddress(wallet, strictAddress(plan.mainAccount, 'plan.mainAccount'))) {
    throw new Error('PopDEX BTCUSDT 持仓账户与本探针不匹配。');
  }
  if (integerWad(candidate.holdSizeWad, 'position.holdSizeWad')
      !== integerWad(filledQtyWad, 'filledQtyWad')) {
    throw new Error('PopDEX BTCUSDT 持仓量与本单成交量不一致。');
  }
  return candidate;
}

export function classifyClose(plan, { fills, openOrders, positions } = {}) {
  if (!plan || typeof plan !== 'object'
      || !Array.isArray(fills)
      || !Array.isArray(openOrders)
      || !Array.isArray(positions)) {
    throw new Error('PopDEX 平仓快照格式无效。');
  }
  const closeOrderId = strictIntegerString(plan.closeOrderId, 'close.orderId');
  const closeQty = integerWad(plan.closeQtyWad, 'close.qtyWad');
  const expectedClientOid = decodeBytes32String(plan.closeClientOrderId);
  const expectedAccount = strictAddress(plan.mainAccount, 'close.mainAccount');
  if (closeQty <= 0n) throw new Error('PopDEX 平仓数量必须大于 0。');

  const btcOpen = openOrders.filter(isBtc);
  for (const item of btcOpen) {
    const wallet = strictAddress(item.walletId, 'close order.walletId');
    if (!sameAddress(wallet, expectedAccount)
        || String(item.orderId) !== closeOrderId
        || item.clientOid !== expectedClientOid
        || item.side !== 'Sell'
        || item.reduceOnly !== true) {
      throw new Error('PopDEX 出现不属于本次平仓的 BTCUSDT 活动订单。');
    }
  }
  if (btcOpen.length > 1) throw new Error('PopDEX 平仓活动订单重复。');

  const seen = new Set();
  let fillQty = 0n;
  for (const item of fills) {
    if (String(item?.orderId) !== closeOrderId) continue;
    const fillId = strictIntegerString(item.fillId, 'close fill.fillId');
    if (seen.has(fillId)) throw new Error(`PopDEX close fillId ${fillId} 重复。`);
    seen.add(fillId);
    if (item.symbol !== BTC_SYMBOL || item.side !== 'Sell') {
      throw new Error('PopDEX 平仓成交身份不匹配。');
    }
    const execQty = decimalWad(item.execQty, 'close fill.execQty');
    if (execQty <= 0n) throw new Error('PopDEX close fill.execQty 必须大于 0。');
    fillQty += execQty;
  }
  if (fillQty > closeQty) throw new Error('PopDEX 平仓成交量超过委托量。');

  const nonzero = positions.filter((item) => isBtc(item)
    && integerWad(item.holdSizeWad, 'close position.holdSizeWad') > 0n);
  if (nonzero.length > 1 || nonzero.some((item) => item.side !== LONG_POSITION_SIDE)) {
    throw new Error('PopDEX 平仓后出现冲突的 BTCUSDT 持仓。');
  }
  if (nonzero.length === 1) {
    const wallet = strictAddress(nonzero[0].walletId, 'close position.walletId');
    if (!sameAddress(wallet, expectedAccount)) {
      throw new Error('PopDEX 平仓剩余仓位账户不匹配。');
    }
  }
  const remaining = nonzero.length === 0
    ? 0n
    : integerWad(nonzero[0].holdSizeWad, 'close position.holdSizeWad');

  if (fillQty === closeQty && remaining === 0n && btcOpen.length === 0) {
    return {
      kind: 'completed-flat',
      closeOrderId,
      filledQtyWad: fillQty.toString(),
      remainingPositionQtyWad: '0',
    };
  }
  if (fillQty > 0n && fillQty + remaining === closeQty && btcOpen.length === 0) {
    return {
      kind: 'partial-unresolved',
      closeOrderId,
      filledQtyWad: fillQty.toString(),
      remainingPositionQtyWad: remaining.toString(),
    };
  }
  return {
    kind: 'settling',
    closeOrderId,
    filledQtyWad: fillQty.toString(),
    remainingPositionQtyWad: remaining.toString(),
  };
}

export function assertCompletedFlat({ positions, openOrders } = {}) {
  assertInitialFlat({ positions, openOrders });
  return true;
}
