import fs from 'node:fs';
import { strictAddress, strictIntegerString } from './normalize.js';

const STAGES = new Set([
  'PREPARED',
  'LEVERAGE_BROADCAST',
  'LEVERAGE_CONFIRMED',
  'ENTRY_BROADCAST',
  'ENTRY_SETTLING',
  'REMAINDER_CANCEL_BROADCAST',
  'POSITION_CONFIRMED',
  'CLOSE_BROADCAST',
  'CLOSE_SETTLING',
  'COMPLETED',
]);
const NEXT = Object.freeze({
  PREPARED: new Set(['LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED', 'COMPLETED']),
  LEVERAGE_BROADCAST: new Set(['LEVERAGE_CONFIRMED', 'COMPLETED']),
  LEVERAGE_CONFIRMED: new Set(['ENTRY_BROADCAST', 'COMPLETED']),
  ENTRY_BROADCAST: new Set(['ENTRY_SETTLING', 'COMPLETED']),
  ENTRY_SETTLING: new Set(['REMAINDER_CANCEL_BROADCAST', 'POSITION_CONFIRMED', 'COMPLETED']),
  REMAINDER_CANCEL_BROADCAST: new Set(['POSITION_CONFIRMED', 'COMPLETED']),
  POSITION_CONFIRMED: new Set(['CLOSE_BROADCAST']),
  CLOSE_BROADCAST: new Set(['CLOSE_SETTLING', 'COMPLETED']),
  CLOSE_SETTLING: new Set(['COMPLETED']),
});
const OUTCOMES = new Set([
  'completed-flat',
  'completed-flat-manual',
  'zero-fill-cleared',
  'safe-no-exposure',
]);
const RECORD_KEYS = Object.freeze([
  'version',
  'stage',
  'mainAccount',
  'agentAddress',
  'symbol',
  'symbolId',
  'positionMode',
  'leverage',
  'priceWad',
  'qtyWad',
  'clientOrderId',
  'closeKind',
  'closeClientOrderId',
  'orderId',
  'closeOrderId',
  'positionId',
  'leverageTxHash',
  'entryTxHash',
  'cancelTxHash',
  'closeTxHash',
  'filledQtyWad',
  'remainingQtyWad',
  'positionQtyWad',
  'closeQtyWad',
  'outcome',
  'lastError',
  'updatedAt',
]);
const CREATE_KEYS = new Set([
  'mainAccount',
  'agentAddress',
  'symbol',
  'symbolId',
  'positionMode',
  'leverage',
  'priceWad',
  'qtyWad',
  'clientOrderId',
  'closeClientOrderId',
]);
const ADVANCE_KEYS = new Set([
  'orderId',
  'closeKind',
  'closeOrderId',
  'positionId',
  'leverageTxHash',
  'entryTxHash',
  'cancelTxHash',
  'closeTxHash',
  'filledQtyWad',
  'remainingQtyWad',
  'positionQtyWad',
  'closeQtyWad',
  'outcome',
  'lastError',
]);
const UINT128_MAX = (1n << 128n) - 1n;

function rejectUnknownKeys(value, allowed, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PopDEX fill-close journal ${context} 必须是对象。`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`PopDEX fill-close journal ${context} 包含未知字段 ${key}。`);
    }
  }
}

function hex32(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`PopDEX fill-close journal ${field} 必须是 32 字节十六进制字符串。`);
  }
  return value.toLowerCase();
}

function positiveUint128(value, field) {
  const normalized = strictIntegerString(value, `fill-close journal ${field}`);
  const exact = BigInt(normalized);
  if (exact <= 0n || exact > UINT128_MAX) {
    throw new Error(`PopDEX fill-close journal ${field} 必须是 uint128 正整数字符串。`);
  }
  return normalized;
}

function wad(value, field) {
  return strictIntegerString(value, `fill-close journal ${field}`);
}

function timestamp(value) {
  if (typeof value !== 'string') {
    throw new Error('PopDEX fill-close journal updatedAt 必须是 ISO 时间字符串。');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error('PopDEX fill-close journal updatedAt 必须是规范 ISO 时间字符串。');
  }
  return value;
}

function sanitizedError(value) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function normalizeLoadedRecord(value) {
  if (value?.version !== 1) return value;
  if (value.stage !== 'CLOSE_BROADCAST' || value.closeTxHash === null) {
    throw new Error(
      'PopDEX fill-close journal version 1 只允许恢复 CLOSE_BROADCAST 失败平仓记录。',
    );
  }
  return {
    ...value,
    version: 2,
    closeKind: 'legacy-reverse',
    closeClientOrderId: null,
    closeOrderId: null,
    closeQtyWad: null,
  };
}

function validateRecord(value) {
  rejectUnknownKeys(value, new Set(RECORD_KEYS), 'record');
  if (value.version !== 2) throw new Error('PopDEX fill-close journal version 必须是 2。');
  for (const key of RECORD_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`PopDEX fill-close journal record 缺少字段 ${key}。`);
    }
  }
  if (!STAGES.has(value.stage)) {
    throw new Error(`PopDEX fill-close journal stage 无效：${String(value.stage)}。`);
  }
  value.mainAccount = strictAddress(value.mainAccount, 'journal.mainAccount');
  value.agentAddress = strictAddress(value.agentAddress, 'journal.agentAddress');
  if (value.mainAccount.toLowerCase() === value.agentAddress.toLowerCase()) {
    throw new Error('PopDEX fill-close journal Agent 不能与主账户相同。');
  }
  if (value.symbol !== 'BTCUSDT' || value.symbolId !== '20000') {
    throw new Error('PopDEX fill-close journal 只允许 BTCUSDT symbolId=20000。');
  }
  if (value.positionMode !== '0' || value.leverage !== '1') {
    throw new Error('PopDEX fill-close journal 只允许 OneWay=0 和 leverage=1。');
  }
  value.priceWad = wad(value.priceWad, 'priceWad');
  value.qtyWad = wad(value.qtyWad, 'qtyWad');
  if (BigInt(value.priceWad) <= 0n || BigInt(value.qtyWad) <= 0n) {
    throw new Error('PopDEX fill-close journal priceWad 和 qtyWad 必须大于 0。');
  }
  value.clientOrderId = hex32(value.clientOrderId, 'clientOrderId');
  if (value.closeClientOrderId !== null) {
    value.closeClientOrderId = hex32(value.closeClientOrderId, 'closeClientOrderId');
  }
  if (value.orderId !== null) value.orderId = positiveUint128(value.orderId, 'orderId');
  if (value.closeOrderId !== null) {
    value.closeOrderId = positiveUint128(value.closeOrderId, 'closeOrderId');
  }
  if (value.positionId !== null) value.positionId = positiveUint128(value.positionId, 'positionId');
  for (const field of ['leverageTxHash', 'entryTxHash', 'cancelTxHash', 'closeTxHash']) {
    if (value[field] !== null) value[field] = hex32(value[field], field);
  }
  for (const field of ['filledQtyWad', 'remainingQtyWad', 'positionQtyWad']) {
    if (value[field] !== null) value[field] = wad(value[field], field);
  }
  if (value.closeQtyWad !== null) {
    value.closeQtyWad = wad(value.closeQtyWad, 'closeQtyWad');
    if (BigInt(value.closeQtyWad) <= 0n) {
      throw new Error('PopDEX fill-close journal closeQtyWad 必须大于 0。');
    }
  }
  if (value.outcome !== null && !OUTCOMES.has(value.outcome)) {
    throw new Error(`PopDEX fill-close journal outcome 无效：${String(value.outcome)}。`);
  }
  if (value.lastError !== null
      && (typeof value.lastError !== 'string'
        || value.lastError.length > 500
        || /[\r\n]/.test(value.lastError))) {
    throw new Error('PopDEX fill-close journal lastError 必须是最多 500 字符的单行字符串。');
  }
  timestamp(value.updatedAt);

  const isNewClose = value.closeKind === 'reduce-only-market';
  const isLegacyClose = value.closeKind === 'legacy-reverse';
  if (value.closeKind !== null && !isNewClose && !isLegacyClose) {
    throw new Error(`PopDEX fill-close journal closeKind 无效：${String(value.closeKind)}。`);
  }
  if (isLegacyClose) {
    if (!['CLOSE_BROADCAST', 'COMPLETED'].includes(value.stage)
        || value.closeTxHash === null
        || value.closeClientOrderId !== null
        || value.closeOrderId !== null
        || value.closeQtyWad !== null) {
      throw new Error('PopDEX legacy-reverse 只允许保留旧失败平仓恢复事实。');
    }
    if (value.stage === 'COMPLETED'
        && (value.outcome !== 'completed-flat-manual' || value.positionQtyWad !== '0')) {
      throw new Error('PopDEX legacy-reverse 只允许以人工空仓事实完成。');
    }
  }
  if (isNewClose && ['CLOSE_BROADCAST', 'CLOSE_SETTLING', 'COMPLETED'].includes(value.stage)) {
    if (value.closeClientOrderId === null
        || value.closeQtyWad === null
        || value.closeTxHash === null) {
      throw new Error(`PopDEX fill-close journal ${value.stage} 缺少平仓订单事实。`);
    }
    if (value.closeQtyWad !== value.filledQtyWad) {
      throw new Error('PopDEX fill-close journal 平仓量与已确认成交量不一致。');
    }
    if (['CLOSE_BROADCAST', 'CLOSE_SETTLING'].includes(value.stage)
        && value.closeQtyWad !== value.positionQtyWad) {
      throw new Error('PopDEX fill-close journal 平仓量与已确认持仓量不一致。');
    }
  }

  if (value.stage === 'LEVERAGE_BROADCAST' && value.leverageTxHash === null) {
    throw new Error('PopDEX fill-close journal LEVERAGE_BROADCAST 缺少 leverageTxHash。');
  }
  const afterEntry = new Set([
    'ENTRY_BROADCAST',
    'ENTRY_SETTLING',
    'REMAINDER_CANCEL_BROADCAST',
    'POSITION_CONFIRMED',
    'CLOSE_BROADCAST',
    'CLOSE_SETTLING',
  ]);
  if (afterEntry.has(value.stage) && value.entryTxHash === null) {
    throw new Error(`PopDEX fill-close journal ${value.stage} 缺少 entryTxHash。`);
  }
  const afterOrder = new Set([
    'ENTRY_SETTLING',
    'REMAINDER_CANCEL_BROADCAST',
    'POSITION_CONFIRMED',
    'CLOSE_BROADCAST',
    'CLOSE_SETTLING',
  ]);
  if (afterOrder.has(value.stage) && value.orderId === null) {
    throw new Error(`PopDEX fill-close journal ${value.stage} 缺少 orderId。`);
  }
  if (value.stage === 'REMAINDER_CANCEL_BROADCAST' && value.cancelTxHash === null) {
    throw new Error('PopDEX fill-close journal REMAINDER_CANCEL_BROADCAST 缺少 cancelTxHash。');
  }
  if (['POSITION_CONFIRMED', 'CLOSE_BROADCAST', 'CLOSE_SETTLING'].includes(value.stage)) {
    if (value.positionId === null || value.filledQtyWad === null || value.positionQtyWad === null) {
      throw new Error(`PopDEX fill-close journal ${value.stage} 缺少持仓事实。`);
    }
    if (BigInt(value.filledQtyWad) <= 0n || value.filledQtyWad !== value.positionQtyWad) {
      throw new Error(`PopDEX fill-close journal ${value.stage} 成交量与持仓量不一致。`);
    }
  }
  if (['CLOSE_BROADCAST', 'CLOSE_SETTLING'].includes(value.stage)
      && value.closeTxHash === null) {
    throw new Error(`PopDEX fill-close journal ${value.stage} 缺少 closeTxHash。`);
  }
  if (value.stage === 'CLOSE_BROADCAST' && value.closeKind === null) {
    throw new Error('PopDEX fill-close journal CLOSE_BROADCAST 缺少 closeKind。');
  }
  if (value.stage === 'CLOSE_SETTLING') {
    if (!isNewClose || value.closeOrderId === null) {
      throw new Error('PopDEX fill-close journal CLOSE_SETTLING 缺少 closeOrderId。');
    }
  }
  if (value.stage === 'COMPLETED') {
    if (value.outcome === null) {
      throw new Error('PopDEX fill-close journal COMPLETED 缺少合法 outcome。');
    }
    if (value.outcome === 'completed-flat'
        && (!isNewClose || value.closeTxHash === null || value.closeOrderId === null
          || value.positionId === null
          || value.filledQtyWad === null || BigInt(value.filledQtyWad) <= 0n
          || value.positionQtyWad !== '0')) {
      throw new Error('PopDEX fill-close journal completed-flat 缺少平仓完成事实。');
    }
    if (value.outcome === 'completed-flat-manual'
        && (value.closeTxHash === null || value.positionId === null
          || value.filledQtyWad === null || BigInt(value.filledQtyWad) <= 0n
          || value.positionQtyWad !== '0')) {
      throw new Error('PopDEX fill-close journal completed-flat-manual 缺少人工空仓事实。');
    }
    if (value.outcome === 'zero-fill-cleared'
        && (value.entryTxHash === null || value.orderId === null
          || value.filledQtyWad !== '0' || value.remainingQtyWad !== '0')) {
      throw new Error('PopDEX fill-close journal zero-fill-cleared 缺少零成交清理事实。');
    }
  } else if (value.outcome !== null) {
    throw new Error('PopDEX fill-close journal outcome 只允许用于 COMPLETED。');
  }
  return value;
}

export class PopdexFillCloseJournal {
  constructor({ file, fsImpl = fs, platform = process.platform, now = () => Date.now() }) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('PopDEX fill-close journal file 必须是非空字符串。');
    }
    if (!fsImpl || typeof fsImpl !== 'object') {
      throw new Error('PopDEX fill-close journal fsImpl 必须是对象。');
    }
    if (typeof now !== 'function') {
      throw new Error('PopDEX fill-close journal now 必须是函数。');
    }
    this.file = file;
    this.fs = fsImpl;
    this.platform = platform;
    this.now = now;
  }

  #timestamp() {
    const milliseconds = this.now();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error('PopDEX fill-close journal now() 必须返回非负安全整数。');
    }
    return new Date(milliseconds).toISOString();
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
        `PopDEX fill-close journal 写入失败 (${this.file})：${cause?.message || cause}`,
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
        `PopDEX fill-close journal 读取失败 (${this.file})：${cause?.message || cause}`,
        { cause },
      );
    }
    if (this.platform !== 'win32') {
      let mode;
      try {
        mode = this.fs.statSync(this.file).mode & 0o777;
      } catch (cause) {
        throw new Error(
          `PopDEX fill-close journal 权限读取失败 (${this.file})：${cause?.message || cause}`,
          { cause },
        );
      }
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `PopDEX fill-close journal 权限必须是 0600，实际 ${mode.toString(8).padStart(4, '0')}。`,
        );
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `PopDEX fill-close journal JSON 解析失败 (${this.file})：${cause?.message || cause}`,
        { cause },
      );
    }
    return validateRecord(normalizeLoadedRecord(parsed));
  }

  create(initial) {
    rejectUnknownKeys(initial, CREATE_KEYS, 'initial');
    if (this.load() !== null) {
      throw new Error(`PopDEX 已有 fill-close 恢复记录 ${this.file}，拒绝覆盖。`);
    }
    return this.#persist({
      version: 2,
      stage: 'PREPARED',
      ...initial,
      closeKind: null,
      orderId: null,
      closeOrderId: null,
      positionId: null,
      leverageTxHash: null,
      entryTxHash: null,
      cancelTxHash: null,
      closeTxHash: null,
      filledQtyWad: null,
      remainingQtyWad: null,
      positionQtyWad: null,
      closeQtyWad: null,
      outcome: null,
      lastError: null,
      updatedAt: this.#timestamp(),
    });
  }

  advance(expectedStage, nextStage, fields = {}) {
    rejectUnknownKeys(fields, ADVANCE_KEYS, 'advance fields');
    const current = this.load();
    if (current === null) throw new Error('PopDEX fill-close journal 不存在，无法推进阶段。');
    if (current.stage !== expectedStage) {
      throw new Error(
        `PopDEX fill-close journal 当前阶段 ${current.stage}，不是 ${expectedStage}。`,
      );
    }
    if (!NEXT[expectedStage]?.has(nextStage)) {
      throw new Error(
        `PopDEX fill-close journal 阶段转换 ${expectedStage} -> ${nextStage} 不允许。`,
      );
    }
    if (nextStage === 'COMPLETED') {
      if (!OUTCOMES.has(fields.outcome)) {
        throw new Error(`PopDEX fill-close journal outcome 无效：${String(fields.outcome)}。`);
      }
      if (fields.outcome === 'safe-no-exposure'
          && !['PREPARED', 'LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED'].includes(expectedStage)) {
        throw new Error('PopDEX ENTRY_BROADCAST 只有精确失败回执才能标记 safe-no-exposure。');
      }
      if (fields.outcome === 'completed-flat' && expectedStage !== 'CLOSE_SETTLING') {
        throw new Error('PopDEX completed-flat 只允许从 CLOSE_SETTLING 完成。');
      }
      if (fields.outcome === 'completed-flat-manual'
          && expectedStage !== 'CLOSE_BROADCAST') {
        throw new Error('PopDEX completed-flat-manual 只允许从 CLOSE_BROADCAST 完成。');
      }
      if (fields.outcome === 'zero-fill-cleared'
          && !['ENTRY_SETTLING', 'REMAINDER_CANCEL_BROADCAST'].includes(expectedStage)) {
        throw new Error('PopDEX zero-fill-cleared 阶段来源无效。');
      }
    }
    return this.#persist({
      ...current,
      ...fields,
      stage: nextStage,
      lastError: fields.lastError === undefined ? null : sanitizedError(fields.lastError),
      updatedAt: this.#timestamp(),
    });
  }

  completeFailedEntry(entryTxHash) {
    const exactHash = hex32(entryTxHash, 'failed entryTxHash');
    const current = this.load();
    if (current === null || current.stage !== 'ENTRY_BROADCAST') {
      throw new Error('PopDEX fill-close journal 只有 ENTRY_BROADCAST 才能记录失败回执。');
    }
    if (current.entryTxHash !== exactHash) {
      throw new Error(
        `PopDEX fill-close journal entryTxHash 不匹配：expected=${current.entryTxHash} actual=${exactHash}。`,
      );
    }
    return this.#persist({
      ...current,
      stage: 'COMPLETED',
      outcome: 'safe-no-exposure',
      lastError: null,
      updatedAt: this.#timestamp(),
    });
  }

  recordError(expectedStage, error) {
    const current = this.load();
    if (current === null) throw new Error('PopDEX fill-close journal 不存在，无法记录错误。');
    if (current.stage !== expectedStage) {
      throw new Error(
        `PopDEX fill-close journal 当前阶段 ${current.stage}，不是 ${expectedStage}。`,
      );
    }
    return this.#persist({
      ...current,
      lastError: sanitizedError(error),
      updatedAt: this.#timestamp(),
    });
  }

  clearCompleted() {
    const current = this.load();
    if (current === null || current.stage !== 'COMPLETED') {
      throw new Error('PopDEX fill-close journal 只有 COMPLETED 才能清理。');
    }
    try {
      this.fs.unlinkSync(this.file);
    } catch (cause) {
      throw new Error(
        `PopDEX fill-close journal 清理失败 (${this.file})：${cause?.message || cause}`,
        { cause },
      );
    }
  }
}
