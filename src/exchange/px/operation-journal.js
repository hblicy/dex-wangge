import fs from 'node:fs';
import { strictAddress, strictDecimalString, strictIntegerString } from './normalize.js';

const KINDS = new Set(['leverage', 'place', 'cancel', 'close']);
const STAGES = new Set(['PREPARED', 'BROADCAST', 'CONFIRMED']);
const NEXT = Object.freeze({ PREPARED: 'BROADCAST', BROADCAST: 'CONFIRMED' });
const RECORD_KEYS = Object.freeze([
  'version',
  'kind',
  'stage',
  'mainAccount',
  'agentAddress',
  'symbol',
  'symbolId',
  'side',
  'price',
  'qty',
  'leverage',
  'clientOrderId',
  'closeClientOrderId',
  'orderId',
  'closeOrderId',
  'positionId',
  'txHash',
  'outcome',
  'lastError',
  'updatedAt',
]);
const CREATE_KEYS = new Set([
  'kind',
  'mainAccount',
  'agentAddress',
  'symbol',
  'symbolId',
  'side',
  'price',
  'qty',
  'leverage',
  'clientOrderId',
  'closeClientOrderId',
  'orderId',
  'positionId',
]);
const ADVANCE_KEYS = new Set(['txHash', 'orderId', 'closeOrderId']);
const UINT128_MAX = (1n << 128n) - 1n;

function rejectUnknownKeys(value, allowed, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PopDEX operation journal ${context} 必须是对象。`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`PopDEX operation journal ${context} 包含未知字段 ${key}。`);
    }
  }
}

function hex32(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`PopDEX operation journal ${field} 必须是 32 字节十六进制字符串。`);
  }
  return value.toLowerCase();
}

function positiveUint128(value, field) {
  const normalized = strictIntegerString(value, `operation journal ${field}`);
  const exact = BigInt(normalized);
  if (exact <= 0n || exact > UINT128_MAX) {
    throw new Error(`PopDEX operation journal ${field} 必须是 uint128 正整数字符串。`);
  }
  return normalized;
}

function positiveDecimal(value, field) {
  const normalized = strictDecimalString(value, `operation journal ${field}`);
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > 18) {
    throw new Error(`PopDEX operation journal ${field} 最多支持 18 位小数。`);
  }
  const scaled = BigInt(whole) * (10n ** 18n) + BigInt(fraction.padEnd(18, '0') || '0');
  if (scaled <= 0n) {
    throw new Error(`PopDEX operation journal ${field} 必须大于 0。`);
  }
  return normalized;
}

function timestamp(value) {
  if (typeof value !== 'string') {
    throw new Error('PopDEX operation journal updatedAt 必须是 ISO 时间字符串。');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error('PopDEX operation journal updatedAt 必须是规范 ISO 时间字符串。');
  }
  return value;
}

function sanitizedError(value) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function assertNull(value, field, kind) {
  if (value !== null) {
    throw new Error(`PopDEX operation journal ${kind} 不允许字段 ${field}。`);
  }
}

function validateKind(record) {
  if (record.kind === 'leverage') {
    if (record.leverage !== '1') {
      throw new Error('PopDEX operation journal leverage 只允许 1。');
    }
    for (const field of [
      'side', 'price', 'qty', 'clientOrderId', 'closeClientOrderId',
      'orderId', 'closeOrderId', 'positionId',
    ]) assertNull(record[field], field, record.kind);
    return;
  }

  assertNull(record.leverage, 'leverage', record.kind);
  if (record.kind === 'place') {
    if (record.side !== 'buy' && record.side !== 'sell') {
      throw new Error('PopDEX operation journal place side 必须是 buy 或 sell。');
    }
    record.price = positiveDecimal(record.price, 'price');
    record.qty = positiveDecimal(record.qty, 'qty');
    record.clientOrderId = hex32(record.clientOrderId, 'clientOrderId');
    for (const field of ['closeClientOrderId', 'closeOrderId', 'positionId']) {
      assertNull(record[field], field, record.kind);
    }
    if (record.orderId !== null) record.orderId = positiveUint128(record.orderId, 'orderId');
    if (record.stage === 'CONFIRMED' && record.outcome === null && record.orderId === null) {
      throw new Error('PopDEX operation journal CONFIRMED place 缺少 orderId。');
    }
    return;
  }

  assertNull(record.side, 'side', record.kind);
  assertNull(record.price, 'price', record.kind);
  if (record.kind === 'cancel') {
    assertNull(record.qty, 'qty', record.kind);
    record.orderId = positiveUint128(record.orderId, 'orderId');
    record.clientOrderId = hex32(record.clientOrderId, 'clientOrderId');
    for (const field of ['closeClientOrderId', 'closeOrderId', 'positionId']) {
      assertNull(record[field], field, record.kind);
    }
    return;
  }

  assertNull(record.clientOrderId, 'clientOrderId', record.kind);
  assertNull(record.orderId, 'orderId', record.kind);
  record.positionId = positiveUint128(record.positionId, 'positionId');
  record.qty = positiveDecimal(record.qty, 'qty');
  record.closeClientOrderId = hex32(record.closeClientOrderId, 'closeClientOrderId');
  if (record.closeOrderId !== null) {
    record.closeOrderId = positiveUint128(record.closeOrderId, 'closeOrderId');
  }
  if (record.stage === 'CONFIRMED' && record.outcome === null && record.closeOrderId === null) {
    throw new Error('PopDEX operation journal CONFIRMED close 缺少 closeOrderId。');
  }
}

function validateRecord(value) {
  rejectUnknownKeys(value, new Set(RECORD_KEYS), 'record');
  for (const key of RECORD_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`PopDEX operation journal record 缺少字段 ${key}。`);
    }
  }
  if (value.version !== 1) throw new Error('PopDEX operation journal version 必须是 1。');
  if (!KINDS.has(value.kind)) {
    throw new Error(`PopDEX operation journal kind 无效：${String(value.kind)}。`);
  }
  if (!STAGES.has(value.stage)) {
    throw new Error(`PopDEX operation journal stage 无效：${String(value.stage)}。`);
  }
  value.mainAccount = strictAddress(value.mainAccount, 'operation journal mainAccount');
  value.agentAddress = strictAddress(value.agentAddress, 'operation journal agentAddress');
  if (value.mainAccount.toLowerCase() === value.agentAddress.toLowerCase()) {
    throw new Error('PopDEX operation journal Agent 不能与主账户相同。');
  }
  if (value.symbol !== 'BTCUSDT' || value.symbolId !== '20000') {
    throw new Error('PopDEX operation journal 实盘写操作只允许 BTCUSDT symbolId=20000。');
  }
  if (value.txHash !== null) value.txHash = hex32(value.txHash, 'txHash');
  if (value.outcome !== null && value.outcome !== 'safe-no-broadcast') {
    throw new Error(`PopDEX operation journal outcome 无效：${String(value.outcome)}。`);
  }
  if (value.lastError !== null
      && (typeof value.lastError !== 'string'
        || value.lastError.length > 500
        || /[\r\n]/.test(value.lastError))) {
    throw new Error('PopDEX operation journal lastError 必须是最多 500 字符的单行字符串。');
  }
  timestamp(value.updatedAt);

  if (value.stage === 'PREPARED' && (value.txHash !== null || value.outcome !== null)) {
    throw new Error('PopDEX operation journal PREPARED 不允许广播或完成事实。');
  }
  if (value.stage === 'BROADCAST' && (value.txHash === null || value.outcome !== null)) {
    throw new Error('PopDEX operation journal BROADCAST 必须包含 txHash 且不能包含 outcome。');
  }
  if (value.stage === 'CONFIRMED') {
    const broadcastConfirmed = value.txHash !== null && value.outcome === null;
    const noBroadcastConfirmed = value.txHash === null && value.outcome === 'safe-no-broadcast';
    if (!broadcastConfirmed && !noBroadcastConfirmed) {
      throw new Error('PopDEX operation journal CONFIRMED 广播事实与 no-broadcast 事实冲突。');
    }
  }
  validateKind(value);
  return value;
}

export class PopdexOperationJournal {
  constructor({ file, fsImpl = fs, platform = process.platform, now = () => Date.now() }) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('PopDEX operation journal file 必须是非空字符串。');
    }
    if (!fsImpl || typeof fsImpl !== 'object') {
      throw new Error('PopDEX operation journal fsImpl 必须是对象。');
    }
    if (typeof now !== 'function') {
      throw new Error('PopDEX operation journal now 必须是函数。');
    }
    this.file = file;
    this.fs = fsImpl;
    this.platform = platform;
    this.now = now;
  }

  #timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('PopDEX operation journal now() 必须返回非负安全整数。');
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
      throw new Error(
        `PopDEX operation journal 写入失败 (${this.file})：${cause?.message || cause}`,
        { cause },
      );
    }
    return validated;
  }

  load() {
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (cause) {
      if (cause?.code === 'ENOENT') return null;
      throw new Error(
        `PopDEX operation journal 读取失败 (${this.file})：${cause?.message || cause}`,
        { cause },
      );
    }
    if (this.platform !== 'win32') {
      let mode;
      try {
        mode = this.fs.statSync(this.file).mode & 0o777;
      } catch (cause) {
        throw new Error(
          `PopDEX operation journal 权限读取失败 (${this.file})：${cause?.message || cause}`,
          { cause },
        );
      }
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `PopDEX operation journal 权限必须是 0600，实际 ${mode.toString(8).padStart(4, '0')}。`,
        );
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `PopDEX operation journal JSON 解析失败 (${this.file})：${cause?.message || cause}`,
        { cause },
      );
    }
    return validateRecord(parsed);
  }

  create(facts) {
    rejectUnknownKeys(facts, CREATE_KEYS, 'create facts');
    if (this.load() !== null) {
      throw new Error(`PopDEX 已有未完成操作 ${this.file}，拒绝覆盖。`);
    }
    return this.#persist({
      version: 1,
      kind: facts.kind,
      stage: 'PREPARED',
      mainAccount: facts.mainAccount,
      agentAddress: facts.agentAddress,
      symbol: facts.symbol,
      symbolId: facts.symbolId,
      side: facts.side ?? null,
      price: facts.price ?? null,
      qty: facts.qty ?? null,
      leverage: facts.leverage ?? null,
      clientOrderId: facts.clientOrderId ?? null,
      closeClientOrderId: facts.closeClientOrderId ?? null,
      orderId: facts.orderId ?? null,
      closeOrderId: null,
      positionId: facts.positionId ?? null,
      txHash: null,
      outcome: null,
      lastError: null,
      updatedAt: this.#timestamp(),
    });
  }

  advance(expectedStage, nextStage, fields = {}) {
    rejectUnknownKeys(fields, ADVANCE_KEYS, 'advance fields');
    const current = this.load();
    if (current === null) {
      throw new Error('PopDEX operation journal 不存在，无法推进阶段。');
    }
    if (current.stage !== expectedStage) {
      throw new Error(
        `PopDEX operation journal 当前阶段 ${current.stage}，不是 ${expectedStage}。`,
      );
    }
    if (NEXT[expectedStage] !== nextStage) {
      throw new Error(
        `PopDEX operation journal 阶段转换 ${expectedStage} -> ${nextStage} 不允许。`,
      );
    }
    return this.#persist({
      ...current,
      ...fields,
      stage: nextStage,
      lastError: null,
      updatedAt: this.#timestamp(),
    });
  }

  recordError(expectedStage, error) {
    const current = this.load();
    if (current === null) {
      throw new Error('PopDEX operation journal 不存在，无法记录错误。');
    }
    if (current.stage !== expectedStage) {
      throw new Error(
        `PopDEX operation journal 当前阶段 ${current.stage}，不是 ${expectedStage}。`,
      );
    }
    return this.#persist({
      ...current,
      lastError: sanitizedError(error),
      updatedAt: this.#timestamp(),
    });
  }

  completePreparedWithoutBroadcast(outcome) {
    const current = this.load();
    if (current === null || current.stage !== 'PREPARED') {
      throw new Error('PopDEX operation journal 只有 PREPARED 才能无广播完成。');
    }
    if (outcome !== 'safe-no-broadcast') {
      throw new Error('PopDEX operation journal 无广播完成 outcome 必须是 safe-no-broadcast。');
    }
    if (current.kind === 'place') {
      throw new Error('PopDEX operation journal place 不能无广播完成。');
    }
    return this.#persist({
      ...current,
      stage: 'CONFIRMED',
      txHash: null,
      outcome,
      lastError: null,
      updatedAt: this.#timestamp(),
    });
  }

  clearConfirmed() {
    const current = this.load();
    if (current === null || current.stage !== 'CONFIRMED') {
      throw new Error('PopDEX operation journal 只有 CONFIRMED 才能清理。');
    }
    try {
      this.fs.unlinkSync(this.file);
    } catch (cause) {
      throw new Error(
        `PopDEX operation journal 清理失败 (${this.file})：${cause?.message || cause}`,
        { cause },
      );
    }
  }
}
