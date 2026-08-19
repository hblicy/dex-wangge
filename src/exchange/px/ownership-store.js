import fs from 'node:fs';
import { strictAddress, strictIntegerString } from './normalize.js';

const ROOT_KEYS = new Set(['version', 'mainAccount', 'symbol', 'symbolId', 'orders', 'updatedAt']);
const ORDER_KEYS = new Set([
  'orderId', 'clientOrderId', 'marketId', 'levelIndex', 'side', 'priceWad', 'qtyWad',
  'opening', 'reduceOnly', 'parentFillEventId', 'state', 'filledQtyWad', 'fillIds',
  'terminalEvent',
]);
const EVENT_KEYS = new Set([
  'fillEventId', 'stage', 'terminalState', 'filledQtyWad', 'priceWad', 'fillIds',
  'suppressRequote', 'replacementOrderId',
]);
const RESULT_KEYS = new Set([
  'state', 'event', 'filledQtyWad', 'fillIds', 'officialFilledQtyWad', 'fillSumQtyWad',
]);
const STATES = new Set([
  'OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'SETTLING',
  'UNKNOWN_TERMINAL',
]);
const TERMINAL_STATES = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);
const EVENT_STAGES = new Set(['EVENT_PENDING', 'REPLACEMENT_CONFIRMED', 'EVENT_COMPLETED']);
const EVENT_ID = /^px-fill-[0-9a-f]{64}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function rejectUnknown(value, allowed, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PopDEX ownership ${context} 必须是对象。`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`PopDEX ownership ${context} 包含未知字段 ${key}。`);
  }
}

function requireKeys(value, keys, context) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`PopDEX ownership ${context} 缺少字段 ${key}。`);
  }
}

function bytes32(value, field) {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw new Error(`PopDEX ownership ${field} 必须是 bytes32 十六进制字符串。`);
  }
  return value.toLowerCase();
}

function positiveInteger(value, field) {
  const normalized = strictIntegerString(value, `ownership ${field}`);
  if (BigInt(normalized) <= 0n) throw new Error(`PopDEX ownership ${field} 必须大于 0。`);
  return normalized;
}

function wad(value, field, { positive = false } = {}) {
  const normalized = strictIntegerString(value, `ownership ${field}`);
  if (positive && BigInt(normalized) <= 0n) {
    throw new Error(`PopDEX ownership ${field} 必须大于 0。`);
  }
  return normalized;
}

function timestamp(value) {
  if (typeof value !== 'string') throw new Error('PopDEX ownership updatedAt 必须是 ISO 时间字符串。');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error('PopDEX ownership updatedAt 必须是规范 ISO 时间字符串。');
  }
  return value;
}

function fillEventId(value, field = 'fillEventId') {
  if (typeof value !== 'string' || !EVENT_ID.test(value)) {
    throw new Error(`PopDEX ownership ${field} 必须是规范事件 ID。`);
  }
  return value;
}

function fillIds(value, field) {
  if (!Array.isArray(value)) throw new Error(`PopDEX ownership ${field} 必须是数组。`);
  const normalized = value.map((item) => strictIntegerString(item, `ownership ${field}`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`PopDEX ownership ${field} 存在重复 fillId。`);
  }
  return normalized;
}

function validateEvent(value, order) {
  rejectUnknown(value, EVENT_KEYS, 'terminalEvent');
  requireKeys(value, EVENT_KEYS, 'terminalEvent');
  const event = value;
  event.fillEventId = fillEventId(event.fillEventId);
  if (!EVENT_STAGES.has(event.stage)) throw new Error(`PopDEX ownership event stage 无效：${String(event.stage)}。`);
  if (!TERMINAL_STATES.has(event.terminalState)) {
    throw new Error(`PopDEX ownership event terminalState 无效：${String(event.terminalState)}。`);
  }
  event.filledQtyWad = wad(event.filledQtyWad, 'event.filledQtyWad', { positive: true });
  event.priceWad = wad(event.priceWad, 'event.priceWad', { positive: true });
  event.fillIds = fillIds(event.fillIds, 'event.fillIds');
  if (typeof event.suppressRequote !== 'boolean') {
    throw new Error('PopDEX ownership event suppressRequote 必须是布尔值。');
  }
  if (event.replacementOrderId !== null) {
    event.replacementOrderId = positiveInteger(event.replacementOrderId, 'event.replacementOrderId');
  }
  if (event.filledQtyWad !== order.filledQtyWad || event.fillIds.join(',') !== order.fillIds.join(',')) {
    throw new Error('PopDEX ownership event 成交事实与订单不匹配。');
  }
  if (event.stage === 'EVENT_PENDING' && event.replacementOrderId !== null) {
    throw new Error('PopDEX ownership EVENT_PENDING 不允许 replacementOrderId。');
  }
  if (event.suppressRequote && event.replacementOrderId !== null) {
    throw new Error('PopDEX ownership suppression 事件不允许 replacementOrderId。');
  }
  if (!event.suppressRequote
      && ['REPLACEMENT_CONFIRMED', 'EVENT_COMPLETED'].includes(event.stage)
      && event.replacementOrderId === null) {
    throw new Error(`PopDEX ownership ${event.stage} 缺少 replacementOrderId。`);
  }
  if (event.suppressRequote && event.stage === 'REPLACEMENT_CONFIRMED') {
    throw new Error('PopDEX ownership suppression 事件不能进入 REPLACEMENT_CONFIRMED。');
  }
  return event;
}

function validateOrder(value) {
  rejectUnknown(value, ORDER_KEYS, 'order');
  requireKeys(value, ORDER_KEYS, 'order');
  const order = value;
  order.orderId = positiveInteger(order.orderId, 'order.orderId');
  order.clientOrderId = bytes32(order.clientOrderId, 'order.clientOrderId');
  if (order.marketId !== 20000) throw new Error('PopDEX ownership marketId 固定为 20000。');
  if (!Number.isSafeInteger(order.levelIndex) || order.levelIndex < 0) {
    throw new Error('PopDEX ownership levelIndex 必须是非负安全整数。');
  }
  if (order.side !== 'buy' && order.side !== 'sell') {
    throw new Error('PopDEX ownership side 必须是 buy 或 sell。');
  }
  order.priceWad = wad(order.priceWad, 'order.priceWad', { positive: true });
  order.qtyWad = wad(order.qtyWad, 'order.qtyWad', { positive: true });
  if (typeof order.opening !== 'boolean' || typeof order.reduceOnly !== 'boolean') {
    throw new Error('PopDEX ownership opening 和 reduceOnly 必须是布尔值。');
  }
  if (order.opening === order.reduceOnly) {
    throw new Error('PopDEX ownership opening 与 reduceOnly 必须互斥。');
  }
  if (order.parentFillEventId !== null) fillEventId(order.parentFillEventId, 'parentFillEventId');
  if (!STATES.has(order.state)) throw new Error(`PopDEX ownership state 无效：${String(order.state)}。`);
  order.filledQtyWad = wad(order.filledQtyWad, 'order.filledQtyWad');
  if (BigInt(order.filledQtyWad) > BigInt(order.qtyWad)) {
    throw new Error('PopDEX ownership filledQtyWad 超过 qtyWad。');
  }
  order.fillIds = fillIds(order.fillIds, 'order.fillIds');
  if (order.terminalEvent !== null) order.terminalEvent = validateEvent(order.terminalEvent, order);
  if (order.terminalEvent !== null && !TERMINAL_STATES.has(order.state)) {
    throw new Error('PopDEX ownership 非终态订单不能包含 terminalEvent。');
  }
  return order;
}

function validateRoot(value, expectedAccount) {
  rejectUnknown(value, ROOT_KEYS, 'root');
  requireKeys(value, ROOT_KEYS, 'root');
  if (value.version !== 1) throw new Error('PopDEX ownership version 必须是 1。');
  value.mainAccount = strictAddress(value.mainAccount, 'ownership mainAccount');
  if (value.mainAccount.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error('PopDEX ownership mainAccount 与配置不匹配。');
  }
  if (value.symbol !== 'BTCUSDT' || value.symbolId !== '20000') {
    throw new Error('PopDEX ownership 只允许 BTCUSDT symbolId=20000。');
  }
  if (!Array.isArray(value.orders)) throw new Error('PopDEX ownership orders 必须是数组。');
  value.orders = value.orders.map(validateOrder);
  timestamp(value.updatedAt);
  const orderIds = new Set();
  const clientOrderIds = new Set();
  const eventIds = new Set();
  for (const order of value.orders) {
    if (orderIds.has(order.orderId)) throw new Error(`PopDEX ownership orderId ${order.orderId} 重复。`);
    if (clientOrderIds.has(order.clientOrderId)) throw new Error(`PopDEX ownership clientOrderId ${order.clientOrderId} 重复。`);
    orderIds.add(order.orderId);
    clientOrderIds.add(order.clientOrderId);
    if (order.terminalEvent) {
      if (eventIds.has(order.terminalEvent.fillEventId)) {
        throw new Error(`PopDEX ownership fillEventId ${order.terminalEvent.fillEventId} 重复。`);
      }
      eventIds.add(order.terminalEvent.fillEventId);
    }
  }
  return value;
}

function eventFromResult(event, order) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('PopDEX ownership result.event 必须是对象。');
  }
  return {
    fillEventId: event.fillEventId,
    stage: 'EVENT_PENDING',
    terminalState: event.terminalState,
    filledQtyWad: event.filledQtyWad,
    priceWad: event.priceWad,
    fillIds: event.fillIds,
    suppressRequote: event.suppressRequote,
    replacementOrderId: null,
  };
}

function sameTerminalFacts(current, next) {
  return current.fillEventId === next.fillEventId
    && current.terminalState === next.terminalState
    && current.filledQtyWad === next.filledQtyWad
    && current.priceWad === next.priceWad
    && current.fillIds.join(',') === next.fillIds.join(',')
    && current.suppressRequote === next.suppressRequote;
}

export class PopdexOwnershipStore {
  constructor({ file, mainAccount, fsImpl = fs, platform = process.platform, now = () => Date.now() }) {
    if (typeof file !== 'string' || file.length === 0) throw new Error('PopDEX ownership file 必须是非空字符串。');
    if (!fsImpl || typeof fsImpl !== 'object') throw new Error('PopDEX ownership fsImpl 必须是对象。');
    if (typeof now !== 'function') throw new Error('PopDEX ownership now 必须是函数。');
    this.file = file;
    this.mainAccount = strictAddress(mainAccount, 'ownership mainAccount');
    this.fs = fsImpl;
    this.platform = platform;
    this.now = now;
  }

  #timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('PopDEX ownership now() 必须返回非负安全整数。');
    }
    return new Date(value).toISOString();
  }

  #empty() {
    return {
      version: 1,
      mainAccount: this.mainAccount,
      symbol: 'BTCUSDT',
      symbolId: '20000',
      orders: [],
      updatedAt: this.#timestamp(),
    };
  }

  #persist(value) {
    const validated = validateRoot(structuredClone(value), this.mainAccount);
    const tempFile = `${this.file}.tmp`;
    try {
      this.fs.writeFileSync(tempFile, JSON.stringify(validated, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      if (this.platform !== 'win32') this.fs.chmodSync(tempFile, 0o600);
      this.fs.renameSync(tempFile, this.file);
    } catch (cause) {
      throw new Error(`PopDEX ownership 写入失败 (${this.file})：${cause?.message || cause}`, { cause });
    }
    return structuredClone(validated);
  }

  #change(mutator) {
    const next = structuredClone(this.load());
    mutator(next);
    next.updatedAt = this.#timestamp();
    return this.#persist(next);
  }

  load() {
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (cause) {
      if (cause?.code === 'ENOENT') return this.#empty();
      throw new Error(`PopDEX ownership 读取失败 (${this.file})：${cause?.message || cause}`, { cause });
    }
    if (this.platform !== 'win32') {
      let mode;
      try {
        mode = this.fs.statSync(this.file).mode & 0o777;
      } catch (cause) {
        throw new Error(`PopDEX ownership 权限读取失败 (${this.file})：${cause?.message || cause}`, { cause });
      }
      if (mode !== 0o600) {
        throw new Error(`PopDEX ownership 权限必须是 0600，实际 ${mode.toString(8).padStart(4, '0')}。`);
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(`PopDEX ownership JSON 解析失败 (${this.file})：${cause?.message || cause}`, { cause });
    }
    return structuredClone(validateRoot(parsed, this.mainAccount));
  }

  listOrders() {
    return this.load().orders;
  }

  upsertOrder(value) {
    const order = validateOrder(structuredClone(value));
    return this.#change((root) => {
      const byOrderId = root.orders.findIndex((item) => item.orderId === order.orderId);
      const byClientId = root.orders.findIndex((item) => item.clientOrderId === order.clientOrderId);
      if (byOrderId >= 0 && byClientId >= 0 && byOrderId === byClientId) {
        if (JSON.stringify(root.orders[byOrderId]) !== JSON.stringify(order)) {
          throw new Error(`PopDEX ownership 已有订单 ${order.orderId}，拒绝覆盖持久化事实。`);
        }
        return;
      }
      if (byOrderId >= 0) throw new Error(`PopDEX ownership orderId ${order.orderId} 身份冲突。`);
      if (byClientId >= 0) throw new Error(`PopDEX ownership clientOrderId ${order.clientOrderId} 重复。`);
      root.orders.push(order);
    });
  }

  applyResult(orderIdValue, result) {
    const orderId = positiveInteger(orderIdValue, 'result.orderId');
    rejectUnknown(result, RESULT_KEYS, 'result');
    if (!STATES.has(result.state)) throw new Error(`PopDEX ownership result state 无效：${String(result.state)}。`);
    return this.#change((root) => {
      const order = root.orders.find((item) => item.orderId === orderId);
      if (!order) throw new Error(`PopDEX ownership orderId ${orderId} 不存在。`);
      order.state = result.state;
      const resultFilled = result.filledQtyWad ?? result.event?.filledQtyWad ?? order.filledQtyWad;
      order.filledQtyWad = wad(resultFilled, 'result.filledQtyWad');
      if (result.fillIds !== undefined) {
        order.fillIds = fillIds(result.fillIds, 'result.fillIds');
      }
      if (result.event !== null && result.event !== undefined) {
        const nextEvent = eventFromResult(result.event, order);
        order.fillIds = fillIds(result.event.fillIds, 'result.event.fillIds');
        if (order.terminalEvent !== null
            && order.terminalEvent.fillEventId !== nextEvent.fillEventId) {
          throw new Error('PopDEX ownership 终态事件身份冲突。');
        }
        if (order.terminalEvent !== null && !sameTerminalFacts(order.terminalEvent, nextEvent)) {
          throw new Error('PopDEX ownership 终态事件事实冲突。');
        }
        if (order.terminalEvent === null) order.terminalEvent = nextEvent;
      }
    });
  }

  pendingEvents() {
    return this.load().orders
      .filter((order) => order.terminalEvent && order.terminalEvent.stage !== 'EVENT_COMPLETED')
      .map((order) => ({
        ...structuredClone(order.terminalEvent),
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        marketId: order.marketId,
        levelIndex: order.levelIndex,
        side: order.side,
        opening: order.opening,
        reduceOnly: order.reduceOnly,
        parentFillEventId: order.parentFillEventId,
      }));
  }

  #findEvent(root, eventId) {
    const id = fillEventId(eventId);
    const order = root.orders.find((item) => item.terminalEvent?.fillEventId === id);
    if (!order) throw new Error(`PopDEX ownership 事件 ${id} 不存在。`);
    return order.terminalEvent;
  }

  markReplacementConfirmed(eventId, replacementOrderIdValue) {
    const replacementOrderId = positiveInteger(replacementOrderIdValue, 'replacementOrderId');
    return this.#change((root) => {
      const event = this.#findEvent(root, eventId);
      if (event.stage === 'EVENT_COMPLETED') throw new Error(`PopDEX ownership 事件 ${eventId} 已完成。`);
      if (event.suppressRequote) throw new Error('PopDEX ownership suppression 事件不能确认补单。');
      if (event.stage === 'REPLACEMENT_CONFIRMED') {
        if (event.replacementOrderId !== replacementOrderId) {
          throw new Error('PopDEX ownership 补单身份不匹配。');
        }
        return;
      }
      event.stage = 'REPLACEMENT_CONFIRMED';
      event.replacementOrderId = replacementOrderId;
    });
  }

  completeSuppressedEvent(eventId) {
    return this.#change((root) => {
      const event = this.#findEvent(root, eventId);
      if (event.stage === 'EVENT_COMPLETED') throw new Error(`PopDEX ownership 事件 ${eventId} 已完成。`);
      if (!event.suppressRequote) throw new Error('PopDEX ownership 事件不是 suppression。');
      if (event.stage !== 'EVENT_PENDING') throw new Error('PopDEX ownership suppression 事件阶段无效。');
      event.stage = 'EVENT_COMPLETED';
    });
  }

  completeEvent(eventId) {
    return this.#change((root) => {
      const event = this.#findEvent(root, eventId);
      if (event.stage === 'EVENT_COMPLETED') throw new Error(`PopDEX ownership 事件 ${eventId} 已完成。`);
      if (event.suppressRequote) throw new Error('PopDEX ownership suppression 事件必须使用专用完成路径。');
      if (event.stage !== 'REPLACEMENT_CONFIRMED') {
        throw new Error('PopDEX ownership 事件尚未确认补单。');
      }
      event.stage = 'EVENT_COMPLETED';
    });
  }

  removeSettled(orderIdValue) {
    const orderId = positiveInteger(orderIdValue, 'remove.orderId');
    return this.#change((root) => {
      const index = root.orders.findIndex((item) => item.orderId === orderId);
      if (index < 0) throw new Error(`PopDEX ownership orderId ${orderId} 不存在。`);
      const order = root.orders[index];
      if (!TERMINAL_STATES.has(order.state)) throw new Error(`PopDEX ownership orderId ${orderId} 尚未结算。`);
      if (order.terminalEvent && order.terminalEvent.stage !== 'EVENT_COMPLETED') {
        throw new Error(`PopDEX ownership orderId ${orderId} 事件尚未完成。`);
      }
      root.orders.splice(index, 1);
    });
  }
}
