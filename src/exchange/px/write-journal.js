import fs from 'node:fs';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import { strictDecimalString, strictIntegerString } from './normalize.js';

const STAGES = Object.freeze([
  'PREPARED',
  'BROADCAST',
  'OPEN_CONFIRMED',
  'CANCEL_BROADCAST',
  'CANCEL_CONFIRMED',
]);
const NEXT_STAGE = Object.freeze({
  PREPARED: 'BROADCAST',
  BROADCAST: 'OPEN_CONFIRMED',
  OPEN_CONFIRMED: 'CANCEL_BROADCAST',
  CANCEL_BROADCAST: 'CANCEL_CONFIRMED',
});
const RECORD_KEYS = Object.freeze([
  'version',
  'stage',
  'symbol',
  'side',
  'price',
  'qty',
  'clientOrderId',
  'orderId',
  'placeTxHash',
  'cancelTxHash',
  'lastError',
  'updatedAt',
]);
const CREATE_KEYS = new Set(['symbol', 'side', 'price', 'qty', 'clientOrderId']);
const ADVANCE_KEYS = new Set(['orderId', 'placeTxHash', 'cancelTxHash', 'lastError']);
const UINT128_MAX = (1n << 128n) - 1n;

function exactHex32(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`PopDEX journal ${field} 必须是 32 字节十六进制字符串。`);
  }
  return value.toLowerCase();
}

function exactOrderId(value) {
  const normalized = strictIntegerString(value, 'journal.orderId');
  const orderId = BigInt(normalized);
  if (orderId <= 0n || orderId > UINT128_MAX) {
    throw new Error('PopDEX journal orderId 必须是 uint128 正整数字符串。');
  }
  return normalized;
}

function exactUpdatedAt(value) {
  if (typeof value !== 'string') {
    throw new Error('PopDEX journal updatedAt 必须是 ISO 时间字符串。');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error('PopDEX journal updatedAt 必须是规范 ISO 时间字符串。');
  }
  return value;
}

function sanitizedError(value) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function rejectUnknownKeys(value, allowed, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PopDEX journal ${context} 必须是对象。`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`PopDEX journal ${context} 包含未知字段 ${key}。`);
    }
  }
}

function validateRecord(value) {
  rejectUnknownKeys(value, new Set(RECORD_KEYS), 'record');
  for (const key of RECORD_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`PopDEX journal record 缺少字段 ${key}。`);
    }
  }
  if (value.version !== 1) throw new Error('PopDEX journal version 必须是 1。');
  if (!STAGES.includes(value.stage)) throw new Error(`PopDEX journal stage 无效：${String(value.stage)}。`);
  if (typeof value.symbol !== 'string' || !(value.symbol in POPDEX_EXPECTED_MARKETS)) {
    throw new Error(`PopDEX journal symbol ${String(value.symbol)} 不在白名单。`);
  }
  if (value.side !== 'buy' && value.side !== 'sell') {
    throw new Error('PopDEX journal side 必须是 buy 或 sell。');
  }
  strictDecimalString(value.price, 'journal.price');
  strictDecimalString(value.qty, 'journal.qty');
  value.clientOrderId = exactHex32(value.clientOrderId, 'clientOrderId');
  if (value.orderId !== null) value.orderId = exactOrderId(value.orderId);
  if (value.placeTxHash !== null) value.placeTxHash = exactHex32(value.placeTxHash, 'placeTxHash');
  if (value.cancelTxHash !== null) value.cancelTxHash = exactHex32(value.cancelTxHash, 'cancelTxHash');
  if (value.lastError !== null) {
    if (typeof value.lastError !== 'string' || value.lastError.length > 500 || /[\r\n]/.test(value.lastError)) {
      throw new Error('PopDEX journal lastError 必须是最多 500 字符的单行字符串。');
    }
  }
  exactUpdatedAt(value.updatedAt);
  if (STAGES.indexOf(value.stage) >= STAGES.indexOf('BROADCAST') && value.placeTxHash === null) {
    throw new Error(`PopDEX journal ${value.stage} 缺少 placeTxHash。`);
  }
  if (STAGES.indexOf(value.stage) >= STAGES.indexOf('OPEN_CONFIRMED') && value.orderId === null) {
    throw new Error(`PopDEX journal ${value.stage} 缺少 orderId。`);
  }
  if (STAGES.indexOf(value.stage) >= STAGES.indexOf('CANCEL_BROADCAST') && value.cancelTxHash === null) {
    throw new Error(`PopDEX journal ${value.stage} 缺少 cancelTxHash。`);
  }
  return value;
}

export class PopdexWriteJournal {
  constructor({ file, fsImpl = fs, platform = process.platform, now = () => Date.now() }) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('PopDEX journal file 必须是非空字符串。');
    }
    if (!fsImpl || typeof fsImpl !== 'object') {
      throw new Error('PopDEX journal fsImpl 必须是对象。');
    }
    if (typeof now !== 'function') {
      throw new Error('PopDEX journal now 必须是函数。');
    }
    this.file = file;
    this.fs = fsImpl;
    this.platform = platform;
    this.now = now;
  }

  #timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('PopDEX journal now() 必须返回非负安全整数。');
    }
    return new Date(value).toISOString();
  }

  #persist(record) {
    const validated = validateRecord(structuredClone(record));
    const tempFile = `${this.file}.tmp`;
    try {
      this.fs.writeFileSync(tempFile, JSON.stringify(validated, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      this.fs.renameSync(tempFile, this.file);
      if (this.platform !== 'win32') this.fs.chmodSync(this.file, 0o600);
    } catch (cause) {
      throw new Error(`PopDEX journal 写入失败 (${this.file})：${cause?.message || cause}`, { cause });
    }
    return validated;
  }

  load() {
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (cause) {
      if (cause?.code === 'ENOENT') return null;
      throw new Error(`PopDEX journal 读取失败 (${this.file})：${cause?.message || cause}`, { cause });
    }
    if (this.platform !== 'win32') {
      let mode;
      try {
        mode = this.fs.statSync(this.file).mode & 0o777;
      } catch (cause) {
        throw new Error(`PopDEX journal 权限读取失败 (${this.file})：${cause?.message || cause}`, { cause });
      }
      if ((mode & 0o077) !== 0) {
        throw new Error(`PopDEX journal 权限必须是 0600，实际 ${mode.toString(8).padStart(4, '0')}。`);
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(`PopDEX journal JSON 解析失败 (${this.file})：${cause?.message || cause}`, { cause });
    }
    return validateRecord(parsed);
  }

  create(orderPlan) {
    rejectUnknownKeys(orderPlan, CREATE_KEYS, 'orderPlan');
    const record = validateRecord({
      version: 1,
      stage: 'PREPARED',
      symbol: orderPlan.symbol,
      side: orderPlan.side,
      price: orderPlan.price,
      qty: orderPlan.qty,
      clientOrderId: orderPlan.clientOrderId,
      orderId: null,
      placeTxHash: null,
      cancelTxHash: null,
      lastError: null,
      updatedAt: this.#timestamp(),
    });
    if (this.load() !== null) {
      throw new Error(`PopDEX 已有恢复记录 ${this.file}，拒绝覆盖。`);
    }
    return this.#persist(record);
  }

  advance(expectedStage, nextStage, fields = {}) {
    rejectUnknownKeys(fields, ADVANCE_KEYS, 'advance fields');
    const current = this.load();
    if (current === null) throw new Error('PopDEX journal 不存在，无法推进阶段。');
    if (current.stage !== expectedStage) {
      throw new Error(`PopDEX journal 当前阶段 ${current.stage}，不是 ${expectedStage}。`);
    }
    if (NEXT_STAGE[expectedStage] !== nextStage) {
      throw new Error(`PopDEX journal 阶段转换 ${expectedStage} -> ${nextStage} 不允许。`);
    }
    const next = {
      ...current,
      ...fields,
      stage: nextStage,
      lastError: fields.lastError === undefined ? null : sanitizedError(fields.lastError),
      updatedAt: this.#timestamp(),
    };
    return this.#persist(next);
  }

  recordError(expectedStage, error) {
    const current = this.load();
    if (current === null) throw new Error('PopDEX journal 不存在，无法记录错误。');
    if (current.stage !== expectedStage) {
      throw new Error(`PopDEX journal 当前阶段 ${current.stage}，不是 ${expectedStage}。`);
    }
    return this.#persist({
      ...current,
      lastError: sanitizedError(error),
      updatedAt: this.#timestamp(),
    });
  }

  clearCompleted() {
    const current = this.load();
    if (current === null || current.stage !== 'CANCEL_CONFIRMED') {
      throw new Error('PopDEX journal 只有 CANCEL_CONFIRMED 才能清理。');
    }
    try {
      this.fs.unlinkSync(this.file);
    } catch (cause) {
      throw new Error(`PopDEX journal 清理失败 (${this.file})：${cause?.message || cause}`, { cause });
    }
  }
}
