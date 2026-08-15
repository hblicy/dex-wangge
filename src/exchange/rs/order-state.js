import { compareRisexCursor } from './normalize.js';

const STATUSES = new Set(['OPEN', 'PARTIAL', 'FILLED', 'CANCELLED']);

function assertId(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`RISEx ${field} 必须是非空字符串。`);
}

function assertNumber(value, field, { positive = false, nonnegative = false } = {}) {
  if (!Number.isFinite(value)) throw new Error(`RISEx ${field} 必须是有限数字。`);
  if (positive && !(value > 0)) throw new Error(`RISEx ${field} 必须大于零。`);
  if (nonnegative && value < 0) throw new Error(`RISEx ${field} 不能为负数。`);
}

function assertCursor(value, field) {
  if (!value || typeof value !== 'object') throw new Error(`RISEx ${field} 缺少 cursor。`);
  for (const key of ['block', 'log', 'timestamp']) {
    if (typeof value[key] !== 'bigint' || value[key] < 0n) {
      throw new Error(`RISEx ${field} cursor.${key} 必须是非负 bigint。`);
    }
  }
}

function orderFingerprint(update) {
  return [
    update.orderId, update.marketId, update.side, update.sizeBase, update.price,
    update.filledSize, update.avgPrice, update.status,
  ].join('|');
}

function fillFingerprint(update) {
  return [
    update.fillId, update.orderId, update.marketId, update.side,
    update.sizeBase, update.price, update.fee,
    update.cursor.block, update.cursor.log, update.cursor.timestamp,
  ].join('|');
}

function cloneRecord(record) {
  return {
    orderId: record.orderId,
    marketId: record.marketId,
    side: record.side,
    sizeBase: record.sizeBase,
    price: record.price,
    status: record.status,
    reportedFilled: record.reportedFilled,
    fillSum: record.fillSum,
    fillAveragePrice: record.fillSum > 0 ? record.fillValue / record.fillSum : 0,
    terminalEmitted: record.terminalEmitted,
    meta: { ...record.meta },
  };
}

export class RisexOrderState {
  constructor() {
    this._orders = new Map();
    this._pendingOrders = new Map();
    this._pendingFills = new Map();
    this._fillFingerprints = new Map();
    this._fillCursorFingerprints = new Map();
  }

  track(meta) {
    this._validateMeta(meta);
    const id = meta.orderId;
    let record = this._orders.get(id);
    if (record) {
      this._assertIdentity(record, meta);
      record.meta = { ...record.meta, ...meta };
      return null;
    }
    record = {
      orderId: id,
      marketId: meta.marketId,
      side: meta.side,
      sizeBase: meta.sizeBase,
      price: meta.price,
      meta: { ...meta },
      tolerance: meta.sizeTolerance ?? 1e-12,
      status: 'PENDING',
      reportedFilled: 0,
      fillSum: 0,
      fillValue: 0,
      lastOrderCursor: null,
      lastOrderFingerprint: null,
      terminalEmitted: false,
    };
    this._orders.set(id, record);

    for (const pending of this._pendingFills.get(id) || []) this._applyKnownFill(record, pending);
    this._pendingFills.delete(id);

    let result = null;
    const orders = [...(this._pendingOrders.get(id) || [])]
      .sort((left, right) => compareRisexCursor(left.cursor, right.cursor));
    this._pendingOrders.delete(id);
    for (const pending of orders) result = this._applyKnownOrder(record, pending) ?? result;
    return result;
  }

  adopt(meta) {
    return this.track(meta);
  }

  seedOpen(order, meta = null) {
    const tracked = this.track(meta || {
      orderId: order.orderId,
      marketId: order.marketId,
      side: order.side,
      sizeBase: order.sizeBase,
      price: order.price,
    });
    return this.applyOrder(order) ?? tracked;
  }

  applyOrder(update) {
    this._validateOrder(update);
    const record = this._orders.get(update.orderId);
    if (!record) {
      const pending = this._pendingOrders.get(update.orderId) || [];
      pending.push(update);
      this._pendingOrders.set(update.orderId, pending);
      return { pending: true };
    }
    return this._applyKnownOrder(record, update);
  }

  applyFill(update) {
    this._validateFill(update);
    const fingerprint = fillFingerprint(update);
    const previous = this._fillFingerprints.get(update.fillId);
    if (previous) {
      if (previous !== fingerprint) throw new Error(`RISEx fill ${update.fillId} 重复 ID 的内容冲突。`);
      return null;
    }
    const cursorKey = `${update.cursor.block}:${update.cursor.log}:${update.cursor.timestamp}`;
    const cursorPrevious = this._fillCursorFingerprints.get(cursorKey);
    if (cursorPrevious && cursorPrevious !== fingerprint) {
      throw new Error(`RISEx fill cursor ${cursorKey} 的内容冲突。`);
    }
    this._fillFingerprints.set(update.fillId, fingerprint);
    this._fillCursorFingerprints.set(cursorKey, fingerprint);

    const record = this._orders.get(update.orderId);
    if (!record) {
      const pending = this._pendingFills.get(update.orderId) || [];
      pending.push(update);
      this._pendingFills.set(update.orderId, pending);
      return { pending: true };
    }
    this._applyKnownFill(record, update);
    return null;
  }

  get(orderId) {
    const record = this._orders.get(String(orderId));
    return record ? cloneRecord(record) : null;
  }

  getOpen(marketId) {
    const wanted = Number(marketId);
    return [...this._orders.values()]
      .filter((record) => record.marketId === wanted && !record.terminalEmitted)
      .map(cloneRecord);
  }

  forget(orderId) {
    const id = String(orderId);
    this._orders.delete(id);
    this._pendingOrders.delete(id);
    this._pendingFills.delete(id);
  }

  unknownOrderIds() {
    return [...new Set([...this._pendingOrders.keys(), ...this._pendingFills.keys()])].sort();
  }

  _validateMeta(meta) {
    if (!meta || typeof meta !== 'object') throw new Error('RISEx 订单跟踪元数据缺失。');
    assertId(meta.orderId, '订单 ID');
    if (!Number.isSafeInteger(meta.marketId) || meta.marketId <= 0) throw new Error(`RISEx 订单 ${meta.orderId} marketId 非法。`);
    if (meta.side !== 'buy' && meta.side !== 'sell') throw new Error(`RISEx 订单 ${meta.orderId} side 非法。`);
    assertNumber(meta.sizeBase, `订单 ${meta.orderId} sizeBase`, { positive: true });
    assertNumber(meta.price, `订单 ${meta.orderId} price`, { nonnegative: true });
    if (meta.sizeTolerance != null) assertNumber(meta.sizeTolerance, `订单 ${meta.orderId} sizeTolerance`, { positive: true });
  }

  _validateOrder(update) {
    this._validateMeta(update);
    assertNumber(update.filledSize, `订单 ${update.orderId} filledSize`, { nonnegative: true });
    assertNumber(update.avgPrice, `订单 ${update.orderId} avgPrice`, { nonnegative: true });
    if (!STATUSES.has(update.status)) throw new Error(`RISEx 订单 ${update.orderId} 状态未知：${String(update.status)}`);
    assertCursor(update.cursor, `订单 ${update.orderId}`);
  }

  _validateFill(update) {
    if (!update || typeof update !== 'object') throw new Error('RISEx fill 数据缺失。');
    assertId(update.fillId, 'fill ID');
    assertId(update.orderId, `fill ${update.fillId} order ID`);
    if (!Number.isSafeInteger(update.marketId) || update.marketId <= 0) throw new Error(`RISEx fill ${update.fillId} marketId 非法。`);
    if (update.side !== 'buy' && update.side !== 'sell') throw new Error(`RISEx fill ${update.fillId} side 非法。`);
    assertNumber(update.sizeBase, `fill ${update.fillId} sizeBase`, { positive: true });
    assertNumber(update.price, `fill ${update.fillId} price`, { positive: true });
    assertNumber(update.fee ?? 0, `fill ${update.fillId} fee`);
    assertCursor(update.cursor, `fill ${update.fillId}`);
  }

  _assertIdentity(record, value) {
    this._assertMarketSide(record, value);
    if (Math.abs(record.sizeBase - value.sizeBase) > record.tolerance) {
      throw new Error(`RISEx 订单 ${record.orderId} 总量发生变化。`);
    }
  }

  _assertMarketSide(record, value) {
    if (record.marketId !== value.marketId) throw new Error(`RISEx 订单 ${record.orderId} 市场发生变化。`);
    if (record.side !== value.side) throw new Error(`RISEx 订单 ${record.orderId} 方向发生变化。`);
  }

  _applyKnownFill(record, update) {
    this._assertMarketSide(record, update);
    const nextSum = record.fillSum + update.sizeBase;
    if (nextSum > record.sizeBase + record.tolerance) {
      throw new Error(`RISEx 订单 ${record.orderId} fill 累计 ${nextSum} 超过订单总量 ${record.sizeBase}。`);
    }
    if (record.terminalEmitted && nextSum > record.reportedFilled + record.tolerance) {
      throw new Error(`RISEx 订单 ${record.orderId} 终态后 fill 累计超过官方终态数量。`);
    }
    record.fillSum = nextSum;
    record.fillValue += update.sizeBase * update.price;
  }

  _applyKnownOrder(record, update) {
    this._assertIdentity(record, update);
    const fingerprint = orderFingerprint(update);
    if (record.lastOrderCursor) {
      const compared = compareRisexCursor(update.cursor, record.lastOrderCursor);
      if (compared < 0) return null;
      if (compared === 0) {
        if (record.lastOrderFingerprint !== fingerprint) {
          throw new Error(`RISEx 订单 ${record.orderId} 相同 cursor 的内容冲突。`);
        }
        return null;
      }
    }
    if (record.terminalEmitted) {
      const sameTerminal = record.status === update.status
        && Math.abs(record.reportedFilled - update.filledSize) <= record.tolerance;
      if (sameTerminal) return null;
      throw new Error(`RISEx 订单 ${record.orderId} 终态后又发生状态变化。`);
    }
    if (update.filledSize + record.tolerance < record.reportedFilled) {
      throw new Error(`RISEx 订单 ${record.orderId} 累计成交量倒退：${record.reportedFilled} -> ${update.filledSize}。`);
    }
    if (update.filledSize > record.sizeBase + record.tolerance) {
      throw new Error(`RISEx 订单 ${record.orderId} 累计成交量超过订单总量。`);
    }
    if (update.status === 'PARTIAL'
      && (!(update.filledSize > 0) || update.filledSize >= record.sizeBase - record.tolerance)) {
      throw new Error(`RISEx 订单 ${record.orderId} PARTIAL 数量非法。`);
    }
    if (update.status === 'FILLED'
      && Math.abs(update.filledSize - record.sizeBase) > record.tolerance) {
      throw new Error(`RISEx 订单 ${record.orderId} FILLED 数量不等于订单总量。`);
    }
    if ((update.status === 'FILLED' || update.status === 'CANCELLED')
      && record.fillSum > update.filledSize + record.tolerance) {
      throw new Error(`RISEx 订单 ${record.orderId} fill 累计超过官方终态数量。`);
    }

    record.lastOrderCursor = update.cursor;
    record.lastOrderFingerprint = fingerprint;
    record.reportedFilled = update.filledSize;
    record.status = update.status;
    if (update.status !== 'FILLED' && update.status !== 'CANCELLED') return null;

    const exactFillPrice = update.avgPrice > 0
      ? update.avgPrice
      : (Math.abs(record.fillSum - update.filledSize) <= record.tolerance && record.fillSum > 0
        ? record.fillValue / record.fillSum
        : null);
    if (update.filledSize > 0 && !(exactFillPrice > 0)) {
      throw new Error(`RISEx 订单 ${record.orderId} 已终态但缺少可确认的实际成交均价。`);
    }
    record.terminalEmitted = true;
    return {
      terminal: true,
      terminalFill: update.filledSize > 0 ? {
        orderId: record.orderId,
        marketId: record.marketId,
        side: record.side,
        sizeBase: update.filledSize,
        price: exactFillPrice,
        levelIndex: record.meta.levelIndex,
        clientOrderId: record.meta.clientOrderId,
      } : null,
    };
  }
}
