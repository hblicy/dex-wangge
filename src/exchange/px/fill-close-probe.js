import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatUnits, keccak256, parseUnits } from 'ethers';
import { loadEnv, ROOT } from '../../config.js';
import { PopdexAccountClient } from './account-client.js';
import { deriveAgentAddress } from './agent.js';
import {
  POPDEX_REVERSE_INTERFACE,
  POPDEX_USER_CONFIG_INTERFACE,
  prepareFillClosePlan,
  verifyStage5Simulation,
} from './fill-close-codec.js';
import {
  assertCompletedFlat,
  assertConfirmedLong,
  assertInitialFlat,
  classifyEntry,
  exactBtcLeverage,
} from './fill-close-state.js';
import { PopdexFillCloseJournal } from './fill-close-journal.js';
import {
  POPDEX_EXPECTED_MARKETS,
  POPDEX_ORDER_PRECOMPILE,
  POPDEX_USER_CONFIG_PRECOMPILE,
} from './constants.js';
import { strictAddress, strictDecimalString } from './normalize.js';
import { POPDEX_ORDER_INTERFACE } from './order-codec.js';
import { PopdexPublicClient } from './public-client.js';
import { PopdexRpcClient } from './rpc-client.js';
import { parseOrderCancelReceipt, parseOrderCreateReceipt } from './receipt-events.js';
import { PopdexTradingClient, validateAgentAuthorization } from './trading-client.js';
import { PopdexWriteRpcClient } from './write-rpc-client.js';

const FLAGS = new Set([
  '--confirm-mainnet-fill-close',
  '--resume',
  '--confirm-mainnet-cancel',
  '--confirm-mainnet-close',
]);
const JOURNAL_FILE = path.join(ROOT, '.popdex-fill-close-probe.json');

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('PopDEX fill-close-probe argv 必须是数组。');
  const seen = new Set();
  for (const arg of argv) {
    if (!FLAGS.has(arg)) {
      throw new Error(`PopDEX fill-close-probe 不支持参数 ${String(arg)}。`);
    }
    if (seen.has(arg)) {
      throw new Error(`PopDEX fill-close-probe 重复参数 ${arg}。`);
    }
    seen.add(arg);
  }
  const resume = seen.has('--resume');
  const fillClose = seen.has('--confirm-mainnet-fill-close');
  const cancel = seen.has('--confirm-mainnet-cancel');
  const close = seen.has('--confirm-mainnet-close');
  if (resume && fillClose) {
    throw new Error('PopDEX fill-close-probe --resume 与 --confirm-mainnet-fill-close 互斥。');
  }
  if (!resume && (cancel || close)) {
    throw new Error('PopDEX 恢复写入参数必须与 --resume 同时使用。');
  }
  if (cancel && close) {
    throw new Error('PopDEX --confirm-mainnet-cancel 与 --confirm-mainnet-close 互斥。');
  }
  if (fillClose && argv.length !== 1) {
    throw new Error('PopDEX --confirm-mainnet-fill-close 不能与其他参数组合。');
  }
  if (resume) {
    if (cancel) return { mode: 'resume-cancel' };
    if (close) return { mode: 'resume-close' };
    return { mode: 'resume' };
  }
  return { mode: fillClose ? 'fill-close' : 'dry-run' };
}

function exactEnvironment(deps) {
  if (deps.mainAccount !== undefined || deps.agentAddress !== undefined) {
    return {
      mainAccount: strictAddress(deps.mainAccount, 'mainAccount'),
      agentAddress: strictAddress(deps.agentAddress, 'agentAddress'),
      agentPrivateKey: deps.agentPrivateKey ?? null,
    };
  }
  if (deps.env === undefined) (deps.loadEnv ?? loadEnv)();
  const env = deps.env ?? process.env;
  const mainAccount = strictAddress(env.POPDEX_MAIN_ACCOUNT, 'POPDEX_MAIN_ACCOUNT');
  if (typeof env.POPDEX_AGENT_PRIVATE_KEY !== 'string'
      || env.POPDEX_AGENT_PRIVATE_KEY.length === 0) {
    throw new Error('PopDEX fill-close-probe 缺少 POPDEX_AGENT_PRIVATE_KEY。');
  }
  return {
    mainAccount,
    agentAddress: deriveAgentAddress(env.POPDEX_AGENT_PRIVATE_KEY),
    agentPrivateKey: env.POPDEX_AGENT_PRIVATE_KEY,
  };
}

function assertMarketIdentity(markets) {
  if (!Array.isArray(markets)) throw new Error('PopDEX markets 必须是数组。');
  const matches = markets.filter((market) => market?.name === 'BTCUSDT');
  if (matches.length !== 1) {
    throw new Error(`PopDEX BTCUSDT 主网市场数量必须为 1，实际 ${matches.length}。`);
  }
  const market = matches[0];
  const expected = POPDEX_EXPECTED_MARKETS.BTCUSDT;
  if (String(market.marketId) !== expected.symbolId
      || String(market.stepPrice) !== String(Number(expected.tickSize))
      || String(market.stepSize) !== String(Number(expected.lotSize))
      || String(market.minOrderSize) !== String(Number(expected.minQty))
      || String(market.minNotional) !== String(Number(expected.minNotional))) {
    throw new Error('PopDEX BTCUSDT 主网市场身份或精度不匹配。');
  }
  return market;
}

function availableMargin(overview) {
  if (!overview || typeof overview !== 'object' || Array.isArray(overview)) {
    throw new Error('PopDEX account overview 必须是对象。');
  }
  return strictDecimalString(overview.availableMargin, 'overview.availableMargin');
}

function assertCapacity(margin, plan) {
  const marginWad = parseUnits(margin, 18);
  const notionalWad = (BigInt(plan.priceWad) * BigInt(plan.qtyWad)) / (10n ** 18n);
  if (marginWad < notionalWad) {
    throw new Error(
      `PopDEX availableMargin=${margin} 小于 Stage 5 名义金额 ${formatUnits(notionalWad, 18)}。`,
    );
  }
  return formatUnits(notionalWad, 18);
}

async function prepareReadContext(deps) {
  const { mainAccount, agentAddress, agentPrivateKey } = exactEnvironment(deps);
  const readRpc = deps.readRpc ?? new PopdexRpcClient(deps.readRpcOptions);
  const writeRpc = deps.writeRpc ?? new PopdexWriteRpcClient(deps.writeRpcOptions);
  const publicClient = deps.publicClient ?? new PopdexPublicClient(deps.publicOptions);
  const accountClient = deps.accountClient ?? new PopdexAccountClient(deps.accountOptions);
  await readRpc.verifyChain();
  await writeRpc.verifyChain();
  const now = deps.now ?? (() => Date.now());
  const nowMs = now();
  const authorization = validateAgentAuthorization({
    mainAccount,
    agentAddress,
    info: await readRpc.getAgentInfo(agentAddress),
    nowMs,
  });
  assertMarketIdentity(await publicClient.getMarkets());
  const ticker = await publicClient.getTicker('BTCUSDT');
  const config = await readRpc.getAccountConfig(mainAccount);
  const currentLeverage = exactBtcLeverage(config);
  const openOrders = await accountClient.getAllOpenOrders(mainAccount, 'BTCUSDT');
  const positions = await readRpc.getAllOpenPositions(mainAccount);
  assertInitialFlat({ openOrders, positions });
  const margin = availableMargin(await accountClient.getOverview(mainAccount));
  const plan = prepareFillClosePlan({
    mainAccount,
    ask: String(ticker.ask),
    randomBytesImpl: deps.randomBytesImpl ?? randomBytes,
  });
  const notional = assertCapacity(margin, plan);
  return {
    mainAccount,
    agentAddress,
    agentPrivateKey,
    readRpc,
    writeRpc,
    publicClient,
    accountClient,
    currentLeverage,
    authorization,
    margin,
    notional,
    plan,
  };
}

function safeResult(context, mode, status) {
  const {
    mainAccount,
    agentAddress,
    currentLeverage,
    authorization,
    margin,
    notional,
    plan,
  } = context;
  return {
    mode,
    status,
    symbol: plan.symbol,
    symbolId: plan.symbolId,
    currentLeverage,
    targetLeverage: plan.leverage,
    price: plan.price,
    qty: plan.qty,
    ask: plan.ask,
    availableMargin: margin,
    notional,
    mainAccount,
    agentAddress,
    agentExpiresAt: authorization.expiresAt,
    clientOrderId: plan.clientOrderId,
    calldataHashes: {
      leverage: keccak256(plan.leverageData),
      entry: keccak256(plan.entryData),
      close: keccak256(plan.closeData),
    },
  };
}

async function runDryProbe(deps) {
  const context = await prepareReadContext(deps);
  const { agentAddress, writeRpc, plan } = context;
  const simulations = [
    {
      to: POPDEX_USER_CONFIG_PRECOMPILE,
      data: plan.leverageData,
      iface: POPDEX_USER_CONFIG_INTERFACE,
      name: 'updateLeverage',
    },
    {
      to: POPDEX_ORDER_PRECOMPILE,
      data: plan.entryData,
      iface: POPDEX_ORDER_INTERFACE,
      name: 'placeOrder',
    },
    {
      to: POPDEX_ORDER_PRECOMPILE,
      data: plan.closeData,
      iface: POPDEX_REVERSE_INTERFACE,
      name: 'placeReverseOrder',
    },
  ];
  for (const simulation of simulations) {
    const raw = await writeRpc.simulate({
      from: agentAddress,
      to: simulation.to,
      data: simulation.data,
      value: '0x0',
    });
    verifyStage5Simulation(raw, simulation.iface, simulation.name);
  }
  return safeResult(context, 'dry-run', 'dry-run-ready');
}

async function readFacts({ accountClient, readRpc, mainAccount, plan, orderId, cancelConfirmed }) {
  let order = null;
  try {
    order = await accountClient.findUniqueOrderByClientId(
      mainAccount,
      plan.symbol,
      plan.clientOrderId,
    );
  } catch (error) {
    if (error?.code !== 'POPDEX_ORDER_NOT_FOUND') throw error;
  }
  const [fills, openOrders, positions] = await Promise.all([
    accountClient.getAllFills(mainAccount, plan.symbol),
    accountClient.getAllOpenOrders(mainAccount, plan.symbol),
    readRpc.getAllOpenPositions(mainAccount),
  ]);
  return {
    orderId,
    order,
    fills,
    openOrders,
    positions,
    cancelConfirmed,
  };
}

async function pollUntil({ read, done, now, sleep, timeoutMs, pollMs, label }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(pollMs) || pollMs <= 0) {
    throw new Error('PopDEX 轮询超时和间隔必须是正安全整数。');
  }
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0
      || !Number.isSafeInteger(startedAt + timeoutMs)) {
    throw new Error('PopDEX 轮询时钟必须返回非负安全整数。');
  }
  const deadline = startedAt + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (now() >= deadline) {
      throw new Error(`PopDEX ${label} 超过 ${timeoutMs}ms。`);
    }
    await sleep(pollMs);
  }
}

async function runFillClose(deps) {
  const journal = deps.journal ?? new PopdexFillCloseJournal({
    file: deps.journalFile ?? JOURNAL_FILE,
    fsImpl: deps.fsImpl,
    platform: deps.platform,
    now: deps.now,
  });
  const existing = journal.load();
  if (existing !== null) {
    throw new Error(
      `PopDEX 已有 ${existing.stage} 恢复记录，请先运行 --resume。`,
    );
  }
  const context = await prepareReadContext(deps);
  const {
    mainAccount,
    agentAddress,
    agentPrivateKey,
    readRpc,
    writeRpc,
    accountClient,
    currentLeverage,
    plan,
  } = context;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const timeoutMs = deps.pollTimeoutMs ?? 30000;
  const pollMs = deps.pollMs ?? 1000;
  let trading = deps.trading;
  if (!trading) {
    if (typeof agentPrivateKey !== 'string' || agentPrivateKey.length === 0) {
      throw new Error('PopDEX 实盘成交平仓缺少 POPDEX_AGENT_PRIVATE_KEY。');
    }
    trading = new PopdexTradingClient({
      mainAccount,
      agentPrivateKey,
      readRpc,
      accountClient,
      writeRpc,
      now,
      sleep,
    });
  }
  journal.create({
    mainAccount,
    agentAddress,
    symbol: plan.symbol,
    symbolId: plan.symbolId,
    positionMode: plan.positionMode,
    leverage: plan.leverage,
    priceWad: plan.priceWad,
    qtyWad: plan.qtyWad,
    clientOrderId: plan.clientOrderId,
  });
  try {
    if (currentLeverage === '1') {
      journal.advance('PREPARED', 'LEVERAGE_CONFIRMED');
    } else {
      await trading.setBtcLeverageOne(plan, journal);
    }
    const entryOrder = await trading.placeFillCloseEntry(plan, journal);
    const orderId = entryOrder.orderId;
    const entryFacts = await pollUntil({
      read: () => readFacts({
        accountClient,
        readRpc,
        mainAccount,
        plan,
        orderId,
        cancelConfirmed: false,
      }),
      done: (facts) => classifyEntry(plan, facts).kind !== 'settling',
      now,
      sleep,
      timeoutMs,
      pollMs,
      label: '入场成交确认',
    });
    const entry = classifyEntry(plan, entryFacts);
    if (entry.remainingQtyWad !== '0') {
      await trading.cancelFillCloseRemainder(plan, {
        orderId,
        clientOrderId: plan.clientOrderId,
      }, journal);
    }
    const settledFacts = await pollUntil({
      read: () => readFacts({
        accountClient,
        readRpc,
        mainAccount,
        plan,
        orderId,
        cancelConfirmed: journal.load().stage === 'REMAINDER_CANCEL_BROADCAST',
      }),
      done: (facts) => {
        const state = classifyEntry(plan, facts);
        return state.kind !== 'settling'
          && state.remainingQtyWad === '0'
          && !facts.openOrders.some((item) => String(item.orderId) === String(orderId));
      },
      now,
      sleep,
      timeoutMs,
      pollMs,
      label: '入场终态确认',
    });
    const settled = classifyEntry(plan, settledFacts);
    if (settled.filledQtyWad === '0') {
      const stage = journal.load().stage;
      journal.advance(stage, 'COMPLETED', {
        outcome: 'zero-fill-cleared',
        filledQtyWad: '0',
        remainingQtyWad: '0',
      });
      journal.clearCompleted();
      return {
        ...safeResult(context, 'fill-close', 'zero-fill-cleared'),
        orderId,
      };
    }
    const position = assertConfirmedLong(plan, settledFacts, settled.filledQtyWad);
    journal.advance(journal.load().stage, 'POSITION_CONFIRMED', {
      filledQtyWad: settled.filledQtyWad,
      remainingQtyWad: settled.remainingQtyWad,
      positionId: position.positionId,
      positionQtyWad: position.holdSizeWad,
    });
    await trading.closeFillCloseLong(plan, journal);
    const flat = await pollUntil({
      read: async () => ({
        openOrders: await accountClient.getAllOpenOrders(mainAccount, plan.symbol),
        positions: await readRpc.getAllOpenPositions(mainAccount),
      }),
      done: (facts) => facts.openOrders.length === 0
        && facts.positions.every((item) => String(item.symbolId) !== '20000'
          || BigInt(item.holdSizeWad) === 0n),
      now,
      sleep,
      timeoutMs,
      pollMs,
      label: '平仓终态确认',
    });
    assertCompletedFlat(flat);
    journal.advance('CLOSE_BROADCAST', 'COMPLETED', {
      outcome: 'completed-flat',
      positionQtyWad: '0',
    });
    journal.clearCompleted();
    return {
      ...safeResult(context, 'fill-close', 'completed-flat'),
      orderId,
      filledQtyWad: settled.filledQtyWad,
    };
  } catch (error) {
    const current = journal.load();
    if (current !== null && current.stage !== 'COMPLETED') {
      journal.recordError(current.stage, error);
    }
    throw error;
  }
}

function recoveryPlan(record) {
  return Object.freeze({
    mainAccount: strictAddress(record.mainAccount, 'journal.mainAccount'),
    symbol: record.symbol,
    symbolId: record.symbolId,
    side: 'buy',
    leverage: record.leverage,
    positionMode: record.positionMode,
    positionSide: '1',
    category: '2',
    priceWad: record.priceWad,
    qtyWad: record.qtyWad,
    clientOrderId: record.clientOrderId,
    closeData: POPDEX_REVERSE_INTERFACE.encodeFunctionData('placeReverseOrder', [
      record.mainAccount,
      20000,
      1,
    ]),
  });
}

function exactRecoveryAccount(record, environment) {
  if (record.mainAccount.toLowerCase() !== environment.mainAccount.toLowerCase()
      || record.agentAddress.toLowerCase() !== environment.agentAddress.toLowerCase()) {
    throw new Error('PopDEX 恢复记录账户或 Agent 与当前环境不匹配。');
  }
}

async function optionalRecoveryOrder(accountClient, record) {
  if (record.orderId === null) return null;
  try {
    return await accountClient.findUniqueOrderByClientId(
      record.mainAccount,
      record.symbol,
      record.clientOrderId,
    );
  } catch (error) {
    if (error?.code === 'POPDEX_ORDER_NOT_FOUND') return null;
    throw error;
  }
}

async function recoveryFacts({ accountClient, readRpc, record, cancelConfirmed = false }) {
  const [order, fills, openOrders, positions] = await Promise.all([
    optionalRecoveryOrder(accountClient, record),
    accountClient.getAllFills(record.mainAccount, record.symbol),
    accountClient.getAllOpenOrders(record.mainAccount, record.symbol),
    readRpc.getAllOpenPositions(record.mainAccount),
  ]);
  return {
    orderId: record.orderId,
    order,
    fills,
    openOrders,
    positions,
    cancelConfirmed,
  };
}

async function exactSavedReceipt(readRpc, record, field) {
  const hash = record[field];
  if (hash === null) return null;
  const receipt = await readRpc.getReceipt(hash);
  if (receipt === null) return null;
  if (!receipt || typeof receipt !== 'object') {
    throw new Error(`PopDEX ${field} 回执必须是对象或 null。`);
  }
  if (String(receipt.transactionHash).toLowerCase() !== hash.toLowerCase()) {
    throw new Error(`PopDEX ${field} 回执 transactionHash 不匹配。`);
  }
  if (receipt.status !== '0x0' && receipt.status !== '0x1') {
    throw new Error(`PopDEX ${field} 回执 status 必须是 0x0 或 0x1。`);
  }
  return receipt;
}

async function inspectRecovery({ record, journal, readRpc, accountClient }) {
  const plan = recoveryPlan(record);
  if (['PREPARED', 'LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED'].includes(record.stage)) {
    const facts = await recoveryFacts({ accountClient, readRpc, record });
    assertInitialFlat(facts);
    journal.advance(record.stage, 'COMPLETED', { outcome: 'safe-no-exposure' });
    journal.clearCompleted();
    return { status: 'safe-no-exposure', stage: record.stage, action: null, plan, facts };
  }

  if (record.stage === 'ENTRY_BROADCAST') {
    const receipt = await exactSavedReceipt(readRpc, record, 'entryTxHash');
    if (receipt === null) {
      return { status: 'entry-receipt-pending', stage: record.stage, action: null, plan };
    }
    const facts = await recoveryFacts({ accountClient, readRpc, record });
    if (receipt.status === '0x0') {
      assertInitialFlat(facts);
      journal.completeFailedEntry(record.entryTxHash);
      journal.clearCompleted();
      return { status: 'safe-no-exposure', stage: record.stage, action: null, plan, facts };
    }
    const receiptOrder = parseOrderCreateReceipt(receipt, {
      account: record.mainAccount,
      symbolId: record.symbolId,
      clientOrderId: record.clientOrderId,
      priceWad: record.priceWad,
      qtyWad: record.qtyWad,
    });
    journal.advance('ENTRY_BROADCAST', 'ENTRY_SETTLING', { orderId: receiptOrder.orderId });
    record = journal.load();
  }

  if (record.stage === 'REMAINDER_CANCEL_BROADCAST') {
    const receipt = await exactSavedReceipt(readRpc, record, 'cancelTxHash');
    if (receipt === null) {
      return { status: 'cancel-receipt-pending', stage: record.stage, action: null, plan };
    }
    if (receipt.status === '0x0') {
      return { status: 'cancel-receipt-failed', stage: record.stage, action: null, plan };
    }
    parseOrderCancelReceipt(receipt, {
      account: record.mainAccount,
      orderId: record.orderId,
      clientOrderId: record.clientOrderId,
    });
  }

  if (record.stage === 'CLOSE_BROADCAST') {
    const receipt = await exactSavedReceipt(readRpc, record, 'closeTxHash');
    if (receipt === null) {
      return { status: 'close-receipt-pending', stage: record.stage, action: null, plan };
    }
    if (receipt.status === '0x0') {
      return { status: 'close-receipt-failed', stage: record.stage, action: null, plan };
    }
    const facts = await recoveryFacts({ accountClient, readRpc, record });
    try {
      assertCompletedFlat(facts);
    } catch {
      return { status: 'close-confirmed-not-flat', stage: record.stage, action: null, plan, facts };
    }
    journal.advance('CLOSE_BROADCAST', 'COMPLETED', {
      outcome: 'completed-flat',
      positionQtyWad: '0',
    });
    journal.clearCompleted();
    return { status: 'completed-flat', stage: record.stage, action: null, plan, facts };
  }

  const cancelConfirmed = record.stage === 'REMAINDER_CANCEL_BROADCAST';
  const facts = await recoveryFacts({ accountClient, readRpc, record, cancelConfirmed });
  if (record.stage === 'POSITION_CONFIRMED') {
    assertConfirmedLong(plan, facts, record.filledQtyWad);
    return { status: 'close-required', stage: record.stage, action: 'close', plan, facts };
  }
  const entry = classifyEntry(plan, facts);
  if (entry.kind === 'settling') {
    return { status: 'entry-facts-settling', stage: record.stage, action: null, plan, facts, entry };
  }
  if (entry.remainingQtyWad !== '0') {
    return { status: 'cancel-required', stage: record.stage, action: 'cancel', plan, facts, entry };
  }
  if (entry.filledQtyWad === '0') {
    journal.advance(record.stage, 'COMPLETED', {
      outcome: 'zero-fill-cleared',
      filledQtyWad: '0',
      remainingQtyWad: '0',
    });
    journal.clearCompleted();
    return { status: 'zero-fill-cleared', stage: record.stage, action: null, plan, facts, entry };
  }
  const position = assertConfirmedLong(plan, facts, entry.filledQtyWad);
  journal.advance(record.stage, 'POSITION_CONFIRMED', {
    filledQtyWad: entry.filledQtyWad,
    remainingQtyWad: '0',
    positionId: position.positionId,
    positionQtyWad: position.holdSizeWad,
  });
  return {
    status: 'close-required',
    stage: 'POSITION_CONFIRMED',
    action: 'close',
    plan,
    facts,
    entry,
  };
}

function recoveryJournal(deps) {
  return deps.journal ?? new PopdexFillCloseJournal({
    file: deps.journalFile ?? JOURNAL_FILE,
    fsImpl: deps.fsImpl,
    platform: deps.platform,
    now: deps.now,
  });
}

function recoveryTrading(deps, environment, readRpc, accountClient) {
  if (deps.trading) return deps.trading;
  if (typeof environment.agentPrivateKey !== 'string' || environment.agentPrivateKey.length === 0) {
    throw new Error('PopDEX 恢复写入缺少 POPDEX_AGENT_PRIVATE_KEY。');
  }
  const writeRpc = deps.writeRpc ?? new PopdexWriteRpcClient(deps.writeRpcOptions);
  return new PopdexTradingClient({
    mainAccount: environment.mainAccount,
    agentPrivateKey: environment.agentPrivateKey,
    readRpc,
    accountClient,
    writeRpc,
    now: deps.now,
    sleep: deps.sleep,
  });
}

async function runRecovery(mode, deps) {
  const journal = recoveryJournal(deps);
  const record = journal.load();
  if (record === null) return { mode, status: 'no-record' };
  if (mode === 'resume-cancel' && record.cancelTxHash !== null) {
    throw new Error('PopDEX 撤单已经广播，请继续运行普通 --resume。');
  }
  if (mode === 'resume-close' && record.closeTxHash !== null) {
    throw new Error('PopDEX 平仓已经广播，请继续运行普通 --resume。');
  }
  const environment = exactEnvironment(deps);
  exactRecoveryAccount(record, environment);
  const readRpc = deps.readRpc ?? new PopdexRpcClient(deps.readRpcOptions);
  const accountClient = deps.accountClient ?? new PopdexAccountClient(deps.accountOptions);
  await readRpc.verifyChain();
  const inspected = await inspectRecovery({ record, journal, readRpc, accountClient });
  if (mode === 'resume') return { mode, ...inspected };
  if (mode === 'resume-cancel') {
    const current = journal.load();
    if (inspected.action !== 'cancel' || current?.stage !== 'ENTRY_SETTLING'
        || current.cancelTxHash !== null || !inspected.facts?.order
        || inspected.entry?.remainingQtyWad === '0') {
      throw new Error('PopDEX 当前恢复事实不满足精确撤单条件。');
    }
    const trading = recoveryTrading(deps, environment, readRpc, accountClient);
    await trading.cancelFillCloseRemainder(inspected.plan, {
      orderId: current.orderId,
      clientOrderId: current.clientOrderId,
    }, journal);
    return { mode, status: 'cancel-broadcast', orderId: current.orderId };
  }
  if (mode === 'resume-close') {
    const current = journal.load();
    if (inspected.action !== 'close' || current?.stage !== 'POSITION_CONFIRMED'
        || current.closeTxHash !== null) {
      throw new Error('PopDEX 当前恢复事实不满足精确平仓条件。');
    }
    assertConfirmedLong(inspected.plan, inspected.facts, current.positionQtyWad);
    const trading = recoveryTrading(deps, environment, readRpc, accountClient);
    await trading.closeFillCloseLong(inspected.plan, journal);
    return { mode, status: 'close-broadcast', positionId: current.positionId };
  }
  throw new Error(`PopDEX 恢复模式 ${mode} 无效。`);
}

export async function runProbe(options, deps = {}) {
  if (!options || typeof options !== 'object' || typeof options.mode !== 'string') {
    throw new Error('PopDEX fill-close-probe options 无效。');
  }
  if (options.mode === 'dry-run') return runDryProbe(deps);
  if (options.mode === 'fill-close') return runFillClose(deps);
  if (['resume', 'resume-cancel', 'resume-close'].includes(options.mode)) {
    return runRecovery(options.mode, deps);
  }
  throw new Error(`PopDEX fill-close-probe ${options.mode} 模式尚未实现。`);
}

function maskedAddress(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function render(result) {
  if (result.mode.startsWith('resume')) {
    return [
      `PopDEX ${result.mode} status=${result.status}`,
      ...(result.stage ? [`stage=${result.stage}`] : []),
      ...(result.action ? [`requiredAction=${result.action}`] : []),
      ...(result.orderId ? [`orderId=${result.orderId}`] : []),
      ...(result.positionId ? [`positionId=${result.positionId}`] : []),
    ];
  }
  return [
    `PopDEX fill-close ${result.status}`,
    `market=${result.symbol} leverage=${result.currentLeverage}->${result.targetLeverage}`,
    `ask=${result.ask} price=${result.price} qty=${result.qty} notional=${result.notional}`,
    `availableMargin=${result.availableMargin}`,
    `main=${maskedAddress(result.mainAccount)} agent=${maskedAddress(result.agentAddress)}`,
    `clientOrderId=${result.clientOrderId}`,
    `calldata leverage=${result.calldataHashes.leverage}`,
    `calldata entry=${result.calldataHashes.entry}`,
    `calldata close=${result.calldataHashes.close}`,
  ];
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  try {
    const result = await runProbe(parseArgs(argv), deps);
    for (const line of render(result)) (deps.log ?? console.log)(line);
    process.exitCode = 0;
    return result;
  } catch (cause) {
    let message = (cause instanceof Error ? cause.message : String(cause))
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 1000);
    const env = deps.env ?? process.env;
    if (typeof env.POPDEX_AGENT_PRIVATE_KEY === 'string' && env.POPDEX_AGENT_PRIVATE_KEY) {
      message = message.replaceAll(env.POPDEX_AGENT_PRIVATE_KEY, '[REDACTED]');
    }
    (deps.error ?? console.error)(`PopDEX fill-close-probe 失败：${message}`);
    process.exitCode = 1;
    return null;
  }
}

const directEntry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (directEntry === import.meta.url) await main();
