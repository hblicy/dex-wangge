import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseUnits } from 'ethers';
import { GridBot } from '../../bot.js';
import { loadEnv, ROOT } from '../../config.js';
import { strictAddress, strictIntegerString } from './normalize.js';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import { PopdexPublicClient } from './public-client.js';
import { PopdexAccountClient } from './account-client.js';
import { PopdexRpcClient } from './rpc-client.js';
import { PopdexOwnershipStore } from './ownership-store.js';
import { createLiveExchange } from './index.js';

const FILES = Object.freeze({
  state: path.join(ROOT, '.popdex-grid-probe.json'),
  ownership: path.join(ROOT, '.popdex-grid-probe-ownership.json'),
  operation: path.join(ROOT, '.popdex-grid-probe-operation.json'),
  lock: path.join(ROOT, '.popdex-grid-probe.lock'),
});
const VALUE_FLAGS = Object.freeze([
  '--lower', '--upper', '--size-base', '--mode', '--grids', '--leverage',
]);
const MANUAL_CANCEL_FLAG = '--confirm-manual-cancel-order';
const MANUAL_FLAT_FLAG = '--confirm-manual-flat-order';

function exactNumber(value, field, { integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isSafeInteger(number))) {
    throw new Error(`PopDEX grid-probe ${field} 必须是正${integer ? '安全整数' : '有限数'}。`);
  }
  return number;
}

export function parseGridProbeArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('PopDEX grid-probe argv 必须是数组。');
  const values = new Map(VALUE_FLAGS.map((flag) => [flag, null]));
  const seen = new Set();
  let confirmMainnetGrid = false;
  let resume = false;
  let manualCancelOrderId = null;
  let manualFlatOrderId = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (VALUE_FLAGS.includes(arg)) {
      if (seen.has(arg)) throw new Error(`PopDEX grid-probe 重复参数 ${arg}。`);
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(`PopDEX grid-probe 参数 ${arg} 缺少值。`);
      }
      seen.add(arg);
      values.set(arg, value);
      index += 1;
      continue;
    }
    if (arg === MANUAL_CANCEL_FLAG) {
      if (seen.has(arg)) throw new Error(`PopDEX grid-probe 重复参数 ${arg}。`);
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(`PopDEX grid-probe 参数 ${arg} 缺少订单号。`);
      }
      manualCancelOrderId = strictIntegerString(value, 'grid-probe 人工撤单 orderId');
      if (BigInt(manualCancelOrderId) <= 0n) {
        throw new Error('PopDEX grid-probe 人工撤单 orderId 必须大于 0。');
      }
      seen.add(arg);
      index += 1;
      continue;
    }
    if (arg === MANUAL_FLAT_FLAG) {
      if (seen.has(arg)) throw new Error(`PopDEX grid-probe 重复参数 ${arg}。`);
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(`PopDEX grid-probe 参数 ${arg} 缺少订单号。`);
      }
      manualFlatOrderId = strictIntegerString(value, 'grid-probe 人工平仓 orderId');
      if (BigInt(manualFlatOrderId) <= 0n) {
        throw new Error('PopDEX grid-probe 人工平仓 orderId 必须大于 0。');
      }
      seen.add(arg);
      index += 1;
      continue;
    }
    if (arg === '--confirm-mainnet-grid' || arg === '--resume') {
      if (seen.has(arg)) throw new Error(`PopDEX grid-probe 重复参数 ${arg}。`);
      seen.add(arg);
      if (arg === '--confirm-mainnet-grid') confirmMainnetGrid = true;
      else resume = true;
      continue;
    }
    throw new Error(`PopDEX grid-probe 不支持参数 ${String(arg)}。`);
  }
  if (resume && (confirmMainnetGrid || VALUE_FLAGS.some((flag) => values.get(flag) !== null))) {
    throw new Error('PopDEX grid-probe --resume 与新网格参数及 --confirm-mainnet-grid 互斥。');
  }
  if (manualCancelOrderId !== null
      && (manualFlatOrderId !== null || resume || confirmMainnetGrid
        || VALUE_FLAGS.some((flag) => values.get(flag) !== null))) {
    throw new Error(`PopDEX grid-probe ${MANUAL_CANCEL_FLAG} 与其它运行参数互斥。`);
  }
  if (manualFlatOrderId !== null
      && (manualCancelOrderId !== null || resume || confirmMainnetGrid
        || VALUE_FLAGS.some((flag) => values.get(flag) !== null))) {
    throw new Error(`PopDEX grid-probe ${MANUAL_FLAT_FLAG} 与其它运行参数互斥。`);
  }
  return {
    lower: values.get('--lower') === null ? null : exactNumber(values.get('--lower'), '--lower'),
    upper: values.get('--upper') === null ? null : exactNumber(values.get('--upper'), '--upper'),
    sizeBase: values.get('--size-base') === null
      ? 0.0002 : exactNumber(values.get('--size-base'), '--size-base'),
    mode: values.get('--mode') ?? 'long',
    grids: values.get('--grids') === null
      ? 3 : exactNumber(values.get('--grids'), '--grids', { integer: true }),
    leverage: values.get('--leverage') === null
      ? 1 : exactNumber(values.get('--leverage'), '--leverage', { integer: true }),
    confirmMainnetGrid,
    resume,
    manualCancelOrderId,
    manualFlatOrderId,
  };
}

function round(value) {
  return Math.round(value * 1e8) / 1e8;
}

export function buildBtcLongThreeGridPlan({ mark, lower, upper, sizeBase }) {
  const current = exactNumber(mark, 'mark');
  const qty = exactNumber(sizeBase, 'sizeBase');
  const lo = exactNumber(lower, 'lower');
  const hi = exactNumber(upper, 'upper');
  if (!(lo < current && current < hi)) {
    throw new Error('PopDEX grid-probe 上下界必须严格包住当前价。');
  }
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
    throw new Error('PopDEX grid-probe BTCUSDT 上下界必须按 tick=1 对齐。');
  }
  const spacing = (hi - lo) / 3;
  if (!Number.isInteger(spacing) || spacing <= 0) {
    throw new Error('PopDEX grid-probe 三格间距必须按 tick=1 对齐。');
  }
  if (Math.round(qty * 10000) !== qty * 10000) {
    throw new Error('PopDEX grid-probe sizeBase 必须按 lot=0.0001 对齐。');
  }
  const levels = [lo, lo + spacing, lo + spacing * 2, hi].map(round);
  const below = levels.map((price, levelIndex) => ({ price, levelIndex }))
    .filter((level) => level.price < current);
  if (below.length !== 1) {
    throw new Error('PopDEX grid-probe 验收区间必须使当前价下方恰好只有 1 个初始买单。');
  }
  if (current - below[0].price < spacing * 0.25) {
    throw new Error('PopDEX grid-probe 初始买单距离当前价过近，会被安全带跳过。');
  }
  for (const price of levels) {
    const notional = price * qty;
    if (notional < 10 || notional > 15) {
      throw new Error(`PopDEX grid-probe 每单名义金额必须在 10-15 USDT，${price} 档实际 ${round(notional)}。`);
    }
  }
  return {
    marketId: 20000,
    symbol: 'BTCUSDT',
    mode: 'long',
    leverage: 1,
    gridCount: 3,
    lower: lo,
    upper: hi,
    spacing,
    sizeBase: qty,
    levels,
    seed: { ...below[0], side: 'buy', opening: true, reduceOnly: false },
  };
}

function exactMarket(markets) {
  if (!Array.isArray(markets)) throw new Error('PopDEX grid-probe markets 必须是数组。');
  const matches = markets.filter((market) => market?.name === 'BTCUSDT');
  const expected = POPDEX_EXPECTED_MARKETS.BTCUSDT;
  if (matches.length !== 1) throw new Error(`PopDEX BTCUSDT 市场数量必须为 1，实际 ${matches.length}。`);
  const market = matches[0];
  if (String(market.marketId) !== expected.symbolId
      || Number(market.stepPrice) !== Number(expected.tickSize)
      || Number(market.stepSize) !== Number(expected.lotSize)
      || Number(market.minNotional) !== Number(expected.minNotional)) {
    throw new Error('PopDEX BTCUSDT 主网市场身份或精度不匹配。');
  }
  return market;
}

async function defaultPreflight(env, deps) {
  (deps.loadEnv ?? loadEnv)();
  const mainAccount = strictAddress(env.POPDEX_MAIN_ACCOUNT, 'POPDEX_MAIN_ACCOUNT');
  const publicClient = deps.publicClient ?? new PopdexPublicClient();
  const accountClient = deps.accountClient ?? new PopdexAccountClient();
  const readRpc = deps.readRpc ?? new PopdexRpcClient();
  const markets = await publicClient.getMarkets();
  const market = exactMarket(markets);
  const [ticker, openOrders, fills, chainActiveOrders, positions, overview] = await Promise.all([
    publicClient.getTicker('BTCUSDT'),
    accountClient.getAllOpenOrders(mainAccount, 'BTCUSDT'),
    accountClient.getAllFills(mainAccount, 'BTCUSDT'),
    readRpc.getAllActiveOrders(mainAccount),
    readRpc.getAllOpenPositions(mainAccount),
    accountClient.getOverview(mainAccount),
  ]);
  const mark = Number(ticker?.mark);
  exactNumber(mark, 'mark');
  if (!Array.isArray(openOrders) || !Array.isArray(fills)
      || !Array.isArray(chainActiveOrders) || !Array.isArray(positions)) {
    throw new Error('PopDEX grid-probe 官方订单、成交或持仓快照不是数组。');
  }
  const btcPositions = positions.filter((position) => (
    String(position?.symbolId ?? position?.marketId) === '20000'
  ));
  const btcChainActiveOrders = chainActiveOrders.filter((order) => (
    String(order?.symbolId ?? order?.marketId) === '20000'
  ));
  return {
    mainAccount,
    mark,
    market,
    openOrders,
    fills,
    chainActiveOrders: btcChainActiveOrders,
    positions: btcPositions,
    availableMargin: exactNumber(overview?.availableMargin, 'availableMargin'),
  };
}

function readJson(file, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`PopDEX grid-probe 读取 ${file} 失败：${error?.message || error}`, { cause: error });
  }
}

function writeJson(file, value, fsImpl) {
  const temp = `${file}.tmp`;
  try {
    fsImpl.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fsImpl.chmodSync(temp, 0o600);
    fsImpl.renameSync(temp, file);
  } catch (error) {
    throw new Error(`PopDEX grid-probe 写入 ${file} 失败：${error?.message || error}`, { cause: error });
  }
}

function defaultInspectProbeFacts(files, fsImpl) {
  const state = readJson(files.state, fsImpl);
  const ownership = readJson(files.ownership, fsImpl);
  const operation = readJson(files.operation, fsImpl);
  return {
    state: state?.snapshot?.running === true,
    ownership: Array.isArray(ownership?.orders) && ownership.orders.length > 0,
    operation: operation !== null,
  };
}

function unlinkExisting(file, fsImpl) {
  try {
    fsImpl.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function acquireLock({ file, mainAccount, fsImpl, now, processKill }) {
  const existing = readJson(file, fsImpl);
  if (existing !== null) {
    const pid = Number(existing.pid);
    let alive = Number.isSafeInteger(pid) && pid > 0;
    if (alive) {
      try { processKill(pid, 0); }
      catch (error) {
        if (error?.code === 'ESRCH') alive = false;
        else if (error?.code !== 'EPERM') throw error;
      }
    }
    if (alive) throw new Error(`PopDEX grid-probe 已有活动实例 PID=${pid}。`);
    unlinkExisting(file, fsImpl);
  }
  const startedAt = new Date(now()).toISOString();
  const record = { pid: process.pid, mainAccount, startedAt };
  try {
    fsImpl.writeFileSync(file, JSON.stringify(record, null, 2), {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    if (process.platform !== 'win32') fsImpl.chmodSync(file, 0o600);
  } catch (error) {
    throw new Error(`PopDEX grid-probe 获取进程锁失败：${error?.message || error}`, { cause: error });
  }
  return () => unlinkExisting(file, fsImpl);
}

function defaultBounds(mark) {
  const spacing = Math.max(1, Math.ceil(mark * 0.001));
  let lower = Math.floor(mark - spacing / 2);
  if (lower >= mark) lower = Math.floor(mark) - 1;
  return { lower, upper: lower + spacing * 3 };
}

function validateFixedMode(args) {
  if (args.mode !== 'long') throw new Error('PopDEX Stage 7 只允许做多模式。');
  if (args.grids !== 3) throw new Error('PopDEX Stage 7 网格数量固定为 3。');
  if (args.leverage !== 1) throw new Error('PopDEX Stage 7 杠杆固定为 1x。');
  if ((args.lower === null) !== (args.upper === null)) {
    throw new Error('PopDEX grid-probe --lower 与 --upper 必须同时提供。');
  }
}

function removeCompletedFiles(files, fsImpl) {
  for (const file of [files.state, files.ownership, files.operation]) unlinkExisting(file, fsImpl);
}

function archiveRecoveryFiles(files, fsImpl, now, { suffix, label }) {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error('PopDEX grid-probe now() 必须返回非负安全整数。');
  }
  const timestampSuffix = new Date(milliseconds).toISOString().replace(/[:.]/g, '-');
  const entries = [files.state, files.ownership, files.operation]
    .filter((file) => fsImpl.existsSync(file))
    .map((file) => ({ file, archived: `${file}.${suffix}-${timestampSuffix}.bak` }));
  for (const { archived } of entries) {
    if (fsImpl.existsSync(archived)) {
      throw new Error(`PopDEX grid-probe 恢复备份已存在：${archived}。`);
    }
  }
  const moved = [];
  try {
    for (const entry of entries) {
      fsImpl.renameSync(entry.file, entry.archived);
      moved.push(entry);
    }
  } catch (cause) {
    for (const entry of moved.reverse()) {
      fsImpl.renameSync(entry.archived, entry.file);
    }
    throw new Error(`PopDEX grid-probe 归档${label}事实失败：${cause?.message || cause}`, { cause });
  }
  return entries.map((entry) => entry.archived);
}

function validateRunningManualCancelActive(activeEntry, owned, orderId) {
  if (!Array.isArray(activeEntry) || activeEntry.length !== 2) {
    throw new Error('PopDEX grid-probe 运行中人工撤单 active 条目格式无效。');
  }
  const [activeOrderId, metadata] = activeEntry;
  const priceWad = parseUnits(String(metadata?.price), 18).toString();
  const qtyWad = parseUnits(String(metadata?.sizeBase), 18).toString();
  if (String(activeOrderId) !== orderId
      || metadata?.clientOrderId?.toLowerCase() !== owned.clientOrderId
      || metadata?.levelIndex !== owned.levelIndex
      || metadata?.side !== owned.side
      || priceWad !== owned.priceWad
      || qtyWad !== owned.qtyWad
      || metadata?.opening !== owned.opening
      || metadata?.reduceOnly !== owned.reduceOnly
      || metadata?.recovery !== false
      || metadata?.parentFillEventId !== owned.parentFillEventId) {
    throw new Error('PopDEX grid-probe 运行中人工撤单活动订单身份与 ownership 不匹配。');
  }
}

function validateManualCancelState({ files, fsImpl, preflight, orderId }) {
  const record = readJson(files.state, fsImpl);
  if (record?.version !== 1
      || record.mainAccount?.toLowerCase() !== preflight.mainAccount.toLowerCase()) {
    throw new Error('PopDEX grid-probe 人工撤单恢复的状态文件版本或账户不匹配。');
  }
  if (readJson(files.operation, fsImpl) !== null) {
    throw new Error('PopDEX grid-probe 仍有未完成写操作，拒绝人工撤单恢复。');
  }
  const ownershipStore = new PopdexOwnershipStore({
    file: files.ownership,
    mainAccount: preflight.mainAccount,
    fsImpl,
  });
  const orders = ownershipStore.listOrders();
  if (orders.length !== 1 || orders[0].orderId !== orderId) {
    throw new Error('PopDEX grid-probe 人工确认的订单号与本地事实不一致。');
  }
  const owned = orders[0];
  const active = record.snapshot?.active;
  const processed = record.snapshot?.processedFillEventIds;
  let recoveryShape;
  if (record.snapshot?.running === false
      && Array.isArray(active) && active.length === 0
      && Array.isArray(processed) && processed.length === 0
      && owned.state === 'UNKNOWN_TERMINAL') {
    recoveryShape = 'stopped-unknown-terminal';
  } else if (record.snapshot?.running === true
      && Array.isArray(active) && active.length === 1
      && Array.isArray(processed) && processed.length === 0
      && ['OPEN', 'UNKNOWN_TERMINAL'].includes(owned.state)) {
    recoveryShape = 'aborted-running-zero-fill-open';
    validateRunningManualCancelActive(active[0], owned, orderId);
  } else {
    throw new Error('PopDEX grid-probe 人工撤单恢复状态形态不受支持。');
  }
  if (owned.filledQtyWad !== '0'
      || owned.fillIds.length !== 0
      || owned.terminalEvent !== null
      || owned.cancelProof !== null) {
    throw new Error('PopDEX grid-probe 本地订单不是可人工确认的零成交状态。');
  }
  if (preflight.openOrders.length !== 0 || preflight.chainActiveOrders.length !== 0) {
    throw new Error('PopDEX BTCUSDT 仍有活动挂单，拒绝人工撤单恢复。');
  }
  if (preflight.positions.length !== 0) {
    throw new Error('PopDEX BTCUSDT 仍有持仓，拒绝人工撤单恢复。');
  }
  if (preflight.fills.some((fill) => String(fill?.orderId) === orderId)) {
    throw new Error(`PopDEX orderId=${orderId} 存在成交事实，拒绝人工撤单恢复。`);
  }
  return { owned, recoveryShape };
}

function recoverManualCancel({ args, preflight, deps, files, fsImpl }) {
  const now = deps.now ?? (() => Date.now());
  const releaseLock = acquireLock({
    file: files.lock,
    mainAccount: preflight.mainAccount,
    fsImpl,
    now,
    processKill: deps.processKill ?? process.kill.bind(process),
  });
  try {
    const validated = validateManualCancelState({
      files,
      fsImpl,
      preflight,
      orderId: args.manualCancelOrderId,
    });
    const archivedFiles = archiveRecoveryFiles(files, fsImpl, now, {
      suffix: 'manual-cancel',
      label: '人工撤单',
    });
    return {
      mode: 'manual-cancel-recovered',
      orderId: args.manualCancelOrderId,
      recoveryShape: validated.recoveryShape,
      archivedFiles,
      writes: 0,
    };
  } finally {
    releaseLock();
  }
}

function validateManualFlatState({ files, fsImpl, preflight, orderId }) {
  const record = readJson(files.state, fsImpl);
  if (record?.version !== 1
      || record.mainAccount?.toLowerCase() !== preflight.mainAccount.toLowerCase()) {
    throw new Error('PopDEX grid-probe 人工平仓恢复的状态文件版本或账户不匹配。');
  }
  if (!Array.isArray(record.snapshot?.active)
      || record.snapshot.active.length !== 0
      || !Array.isArray(record.snapshot?.processedFillEventIds)) {
    throw new Error('PopDEX grid-probe 人工平仓恢复只允许 running、0 active、0 已处理成交事件的快照。');
  }
  const processed = record.snapshot.processedFillEventIds;
  let recoveryShape;
  if (record.snapshot.running === true && processed.length === 0) {
    recoveryShape = 'pending-manual-flat';
  } else if (record.snapshot.running === false && processed.length === 1) {
    recoveryShape = 'stopped-completed-flat';
  } else {
    throw new Error('PopDEX grid-probe 人工平仓恢复只允许 running、0 active、0 已处理成交事件的快照。');
  }
  if (readJson(files.operation, fsImpl) !== null) {
    throw new Error('PopDEX grid-probe 仍有未完成写操作，拒绝人工平仓恢复。');
  }

  const ownershipStore = new PopdexOwnershipStore({
    file: files.ownership,
    mainAccount: preflight.mainAccount,
    fsImpl,
  });
  const orders = ownershipStore.listOrders();
  if (orders.length !== 1 || orders[0].orderId !== orderId) {
    throw new Error('PopDEX grid-probe 人工确认的订单号与本地事实不一致。');
  }
  const owned = orders[0];
  if (owned.side !== 'buy' || owned.opening !== true || owned.reduceOnly !== false
      || owned.parentFillEventId !== null || owned.state !== 'FILLED'
      || BigInt(owned.filledQtyWad) <= 0n || owned.filledQtyWad !== owned.qtyWad) {
    throw new Error('PopDEX grid-probe 本地订单不是唯一完整开仓成交。');
  }
  const event = owned.terminalEvent;
  if (recoveryShape === 'pending-manual-flat') {
    if (event?.stage !== 'EVENT_PENDING' || event.terminalState !== 'FILLED'
        || event.suppressRequote !== false || event.replacementOrderId !== null) {
      throw new Error('PopDEX grid-probe 本地订单不是未补单的待补单成交事件。');
    }
  } else {
    if (event?.stage !== 'EVENT_COMPLETED' || event.terminalState !== 'FILLED'
        || event.suppressRequote !== true || event.replacementOrderId !== null) {
      throw new Error('PopDEX grid-probe 本地订单不是已停止的 suppression 完成事件。');
    }
    if (processed[0] !== event.fillEventId) {
      throw new Error('PopDEX grid-probe 已处理成交事件与本地终态事件不匹配。');
    }
  }
  if (preflight.openOrders.length !== 0 || preflight.chainActiveOrders.length !== 0) {
    throw new Error('PopDEX BTCUSDT 仍有活动挂单，拒绝人工平仓恢复。');
  }
  if (preflight.positions.length !== 0) {
    throw new Error('PopDEX BTCUSDT 仍有持仓，拒绝人工平仓恢复。');
  }

  const official = preflight.fills.filter((fill) => String(fill?.orderId) === orderId);
  if (official.length === 0) {
    throw new Error(`PopDEX orderId=${orderId} 官方成交事实不匹配。`);
  }
  const officialFillIds = official
    .map((fill) => strictIntegerString(fill?.fillId, 'grid-probe 人工平仓 fill ID'))
    .sort();
  const ownedFillIds = [...owned.fillIds].sort();
  if (officialFillIds.join(',') !== ownedFillIds.join(',')) {
    throw new Error(`PopDEX orderId=${orderId} 官方 fill ID 与本地事实不匹配。`);
  }
  const officialQtyWad = official.reduce(
    (total, fill) => total + parseUnits(String(fill?.execQty), 18),
    0n,
  ).toString();
  if (officialQtyWad !== owned.filledQtyWad) {
    throw new Error(`PopDEX orderId=${orderId} 官方成交数量与本地事实不匹配。`);
  }
  return { owned, recoveryShape };
}

function recoverManualFlat({ args, preflight, deps, files, fsImpl }) {
  const now = deps.now ?? (() => Date.now());
  const releaseLock = acquireLock({
    file: files.lock,
    mainAccount: preflight.mainAccount,
    fsImpl,
    now,
    processKill: deps.processKill ?? process.kill.bind(process),
  });
  try {
    const validated = validateManualFlatState({
      files,
      fsImpl,
      preflight,
      orderId: args.manualFlatOrderId,
    });
    const archivedFiles = archiveRecoveryFiles(files, fsImpl, now, {
      suffix: 'manual-flat',
      label: '人工平仓',
    });
    return {
      mode: 'manual-flat-recovered',
      orderId: args.manualFlatOrderId,
      recoveryShape: validated.recoveryShape,
      archivedFiles,
      writes: 0,
    };
  } finally {
    releaseLock();
  }
}

async function createSession({ args, preflight, plan, env, deps, files, fsImpl }) {
  const now = deps.now ?? (() => Date.now());
  const releaseLock = acquireLock({
    file: files.lock,
    mainAccount: preflight.mainAccount,
    fsImpl,
    now,
    processKill: deps.processKill ?? process.kill.bind(process),
  });
  let exchange;
  let bot;
  try {
    const agentPrivateKey = env.POPDEX_AGENT_PRIVATE_KEY || '';
    if (!agentPrivateKey) throw new Error('PopDEX grid-probe 缺少 POPDEX_AGENT_PRIVATE_KEY。');
    exchange = (deps.createLiveExchange ?? createLiveExchange)({
      mainAccount: preflight.mainAccount,
      agentPrivateKey,
      journalFile: files.operation,
      ownershipFile: files.ownership,
    }, deps.exchangeDeps ?? {});
    await exchange.init();
    const persistSnapshot = (snapshot) => writeJson(files.state, {
      version: 1,
      mainAccount: preflight.mainAccount,
      snapshot,
      updatedAt: new Date(now()).toISOString(),
    }, fsImpl);
    bot = new GridBot(exchange, {
      onChange: persistSnapshot,
      onAlert: (message) => (deps.output ?? console.log)(message),
    });
    if (args.resume) {
      const record = readJson(files.state, fsImpl);
      if (record?.version !== 1 || record.mainAccount?.toLowerCase() !== preflight.mainAccount.toLowerCase()
          || record.snapshot?.running !== true) {
        throw new Error('PopDEX grid-probe 没有可恢复的运行快照。');
      }
      await bot.resume(record.snapshot);
    } else {
      await bot.start({
        marketId: 20000,
        mode: 'long',
        lower: plan.lower,
        upper: plan.upper,
        gridCount: 3,
        sizeBase: plan.sizeBase,
        leverage: 1,
        outOfRangeAction: 'close',
      });
    }
  } catch (error) {
    exchange?.stop?.();
    releaseLock();
    throw error;
  }

  let closed = false;
  const output = deps.output ?? console.log;
  const closeAfterControlFailure = (command, error) => {
    if (closed) return error;
    const cleanupErrors = [];
    try {
      exchange.stop();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      releaseLock();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    closed = true;
    if (cleanupErrors.length === 0) {
      output(
        `[PopDEX ${command}] 失败后已关闭交易所刷新并释放进程锁；恢复事实已保留。`,
      );
      return error;
    }
    return new AggregateError(
      [error, ...cleanupErrors],
      `PopDEX 控制命令 ${command} 失败，且会话资源清理失败。`,
    );
  };
  const session = {
    exchange,
    bot,
    async executeCommand(command) {
      if (closed) throw new Error('PopDEX grid-probe 会话已结束。');
      if (command === 'status') {
        const status = {
          health: exchange.getHealth(),
          bot: bot.getState(),
          openOrders: exchange.getOpenOrders(20000),
          position: exchange.getPosition(20000),
          pendingEvents: exchange.pendingFillEvents(),
        };
        output(JSON.stringify(status, null, 2));
        return status;
      }
      if (command === 'reconnect') {
        await exchange.reconnect();
        await bot.reconcileOpenOrders();
        return { state: exchange.getHealth().state };
      }
      if (command === 'stop') {
        const stopStartedAt = now();
        let stopStage = '撤单与持仓处理';
        const elapsed = () => Math.max(0, now() - stopStartedAt);
        output(
          `[PopDEX stop] 开始：活动挂单=${exchange.getOpenOrders(20000).length}，`
          + `持仓=${exchange.getPosition(20000) === null ? '无' : '有'}。`,
        );
        try {
          output('[PopDEX stop] 正在撤销挂单并确认终态/平仓。');
          await bot.stop({ closePosition: exchange.getPosition(20000) !== null });
          output('[PopDEX stop] 撤单与持仓处理完成。');

          stopStage = '最终对账';
          output('[PopDEX stop] 正在执行最终订单/仓位对账。');
          const reconciled = await exchange.reconcileOwnedOrders({
            marketId: 20000,
            reason: 'probe-stop-final',
            suppressRequote: true,
          });
          if (reconciled.status !== 'READY') {
            throw new Error(`PopDEX grid-probe stop 后订单终态仍为 ${String(reconciled.status)}。`);
          }
          const pending = exchange.pendingFillEvents();
          const position = exchange.getPosition(20000);
          output(
            `[PopDEX stop] 最终对账完成：活动挂单=${reconciled.activeOrders.length}，`
            + `pending=${pending.length}，持仓=${position === null ? '无' : '有'}。`,
          );
          if (reconciled.activeOrders.length !== 0 || pending.length !== 0 || position !== null) {
            throw new Error('PopDEX grid-probe stop 后未确认 0 挂单、0 pending event、0 持仓。');
          }

          stopStage = '本地清理';
          output('[PopDEX stop] 正在清理本地恢复文件。');
          exchange.stop();
          removeCompletedFiles(files, fsImpl);
          releaseLock();
          closed = true;
          output(`[PopDEX stop] 已安全停止：本地恢复文件已清理，耗时=${elapsed()}ms。`);
          return { status: 'stopped-flat' };
        } catch (error) {
          output(`[PopDEX stop] 失败：阶段=${stopStage}，耗时=${elapsed()}ms。`);
          throw error;
        }
      }
      throw new Error(`PopDEX grid-probe 不支持控制命令 ${String(command)}。`);
    },
    signalExit(signal) {
      if (closed) return;
      writeJson(files.state, {
        version: 1,
        mainAccount: preflight.mainAccount,
        snapshot: bot.snapshot(),
        interruptedBy: signal,
        updatedAt: new Date(now()).toISOString(),
      }, fsImpl);
      bot._rollbackResume();
      exchange.stop();
      releaseLock();
      closed = true;
      output(`PopDEX grid-probe 收到 ${signal}，未发送撤单或平仓；必须使用 --resume。`);
    },
  };
  let activeCommand = null;
  const executeCommandUnlocked = session.executeCommand.bind(session);
  session.executeCommand = async (command) => {
    if (activeCommand !== null) {
      throw new Error(`PopDEX 控制命令 ${activeCommand} 正在执行，请等待完成。`);
    }
    activeCommand = command;
    try {
      return await executeCommandUnlocked(command);
    } catch (error) {
      throw closeAfterControlFailure(command, error);
    } finally {
      activeCommand = null;
    }
  };
  return session;
}

export async function runGridProbe({
  argv = process.argv.slice(2),
  env = process.env,
  deps = {},
} = {}) {
  const args = parseGridProbeArgs(argv);
  validateFixedMode(args);
  const preflight = await (deps.preflight ?? ((inputEnv) => defaultPreflight(inputEnv, deps)))(env);
  const bounds = args.lower === null ? defaultBounds(preflight.mark) : {
    lower: args.lower,
    upper: args.upper,
  };
  const plan = buildBtcLongThreeGridPlan({
    mark: preflight.mark,
    lower: bounds.lower,
    upper: bounds.upper,
    sizeBase: args.sizeBase,
  });
  if (preflight.availableMargin < plan.seed.price * plan.sizeBase) {
    throw new Error('PopDEX grid-probe 可用保证金不足以覆盖 1x 验收订单。');
  }
  const files = deps.files ?? FILES;
  const fsImpl = deps.fsImpl ?? fs;
  if (args.manualCancelOrderId !== null) {
    return recoverManualCancel({ args, preflight, deps, files, fsImpl });
  }
  if (args.manualFlatOrderId !== null) {
    return recoverManualFlat({ args, preflight, deps, files, fsImpl });
  }
  const facts = (deps.inspectProbeFacts ?? defaultInspectProbeFacts)(files, fsImpl);
  if (!args.resume && (args.confirmMainnetGrid || facts.state || facts.ownership || facts.operation)) {
    if (facts.state || facts.ownership || facts.operation) {
      throw new Error('PopDEX grid-probe 已有未完成事实，只能使用 --resume。');
    }
  }
  if (!args.resume && args.confirmMainnetGrid) {
    if (preflight.openOrders.length > 0 || preflight.chainActiveOrders.length > 0) {
      throw new Error('PopDEX BTCUSDT 存在外部挂单，拒绝启动。');
    }
    if (preflight.positions.length > 0) throw new Error('PopDEX BTCUSDT 存在外部持仓，拒绝启动。');
  }
  if (!args.confirmMainnetGrid && !args.resume) {
    return { mode: 'dry-run', writes: 0, plan, preflight, facts };
  }
  const session = await createSession({ args, preflight, plan, env, deps, files, fsImpl });
  if (deps.interactive === false) return { mode: 'live', plan, session };

  (deps.output ?? console.log)('PopDEX 三格验收已运行。控制命令：status / reconnect / stop');
  const stdin = deps.stdin ?? process.stdin;
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off('data', onData);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    const finishSignal = (signal) => {
      try { session.signalExit(signal); cleanup(); resolve({ mode: 'interrupted', signal }); }
      catch (error) { cleanup(); reject(error); }
    };
    const onSigint = () => finishSignal('SIGINT');
    const onSigterm = () => finishSignal('SIGTERM');
    const onData = (chunk) => {
      const commands = String(chunk).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      for (const command of commands) {
        session.executeCommand(command).then((result) => {
          if (command === 'stop') { cleanup(); resolve({ mode: 'stopped', result }); }
        }).catch((error) => { cleanup(); reject(error); });
      }
    };
    stdin.on('data', onData);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

export function printManualFlatRecoveryResult(result, output = console.log) {
  output(`PopDEX 人工平仓恢复完成：orderId=${result.orderId}，链上写入=0。`);
  output(`恢复形态：${result.recoveryShape}。`);
  for (const file of result.archivedFiles) output(`已归档：${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGridProbe().then((result) => {
    if (result?.mode === 'dry-run') {
      console.log('PopDEX grid-probe 只读预检通过');
      console.log(`BTCUSDT mark=${result.preflight.mark} lower=${result.plan.lower} upper=${result.plan.upper}`);
      console.log(`grids=3 leverage=1x size=${result.plan.sizeBase} seed=${result.plan.seed.price}`);
      console.log('writes=0；加入 --confirm-mainnet-grid 才会启动主网三格验收。');
    } else if (result?.mode === 'manual-cancel-recovered') {
      console.log(`PopDEX 人工撤单恢复完成：orderId=${result.orderId}，链上写入=0。`);
      console.log(`恢复形态：${result.recoveryShape}。`);
      for (const file of result.archivedFiles) console.log(`已归档：${file}`);
    } else if (result?.mode === 'manual-flat-recovered') {
      printManualFlatRecoveryResult(result);
    }
  }).catch((error) => {
    console.error(`PopDEX grid-probe 失败：${error?.message || error}`);
    process.exitCode = 1;
  });
}
