import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeBytes32String, formatUnits, keccak256, parseUnits } from 'ethers';
import { loadEnv, ROOT } from '../../config.js';
import { PopdexAccountClient } from './account-client.js';
import { deriveAgentAddress } from './agent.js';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import { strictAddress, strictDecimalString, strictIntegerString } from './normalize.js';
import { prepareProbeOrder } from './order-codec.js';
import { PopdexPublicClient } from './public-client.js';
import { PopdexRpcClient } from './rpc-client.js';
import { parseOrderCreateReceipt } from './receipt-events.js';
import { PopdexTradingClient, validateAgentAuthorization } from './trading-client.js';
import { PopdexWriteJournal } from './write-journal.js';
import { PopdexWriteRpcClient } from './write-rpc-client.js';

const VALUE_FLAGS = Object.freeze(['--symbol', '--side', '--price', '--qty']);
const JOURNAL_FILE = path.join(ROOT, '.popdex-write-probe.json');

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('PopDEX write-probe argv 必须是数组。');
  const values = new Map(VALUE_FLAGS.map((flag) => [flag, null]));
  const seen = new Set();
  let confirmMainnetWrite = false;
  let confirmMainnetCancel = false;
  let resume = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (VALUE_FLAGS.includes(arg)) {
      if (seen.has(arg)) throw new Error(`PopDEX write-probe 重复参数 ${arg}。`);
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(`PopDEX write-probe 参数 ${arg} 缺少值。`);
      }
      seen.add(arg);
      values.set(arg, value);
      index += 1;
      continue;
    }
    if (arg === '--confirm-mainnet-write'
        || arg === '--confirm-mainnet-cancel'
        || arg === '--resume') {
      if (seen.has(arg)) throw new Error(`PopDEX write-probe 重复参数 ${arg}。`);
      seen.add(arg);
      if (arg === '--confirm-mainnet-write') confirmMainnetWrite = true;
      else if (arg === '--confirm-mainnet-cancel') confirmMainnetCancel = true;
      else resume = true;
      continue;
    }
    throw new Error(`PopDEX write-probe 不支持参数 ${String(arg)}。`);
  }
  if (resume) {
    if (confirmMainnetWrite || VALUE_FLAGS.some((flag) => values.get(flag) !== null)) {
      throw new Error('PopDEX write-probe --resume 与下单参数及 --confirm-mainnet-write 互斥。');
    }
  } else {
    if (confirmMainnetCancel) {
      throw new Error('PopDEX write-probe --confirm-mainnet-cancel 必须与 --resume 同时使用。');
    }
    for (const flag of VALUE_FLAGS) {
      if (values.get(flag) === null) throw new Error(`PopDEX write-probe 缺少参数 ${flag}。`);
    }
  }
  return {
    symbol: values.get('--symbol'),
    side: values.get('--side'),
    price: values.get('--price'),
    qty: values.get('--qty'),
    confirmMainnetWrite,
    confirmMainnetCancel,
    resume,
  };
}

function exactEnvironment(deps, { requireAgent }) {
  if (deps.env === undefined) (deps.loadEnv ?? loadEnv)();
  const env = deps.env ?? process.env;
  const mainAccount = strictAddress(env.POPDEX_MAIN_ACCOUNT, 'POPDEX_MAIN_ACCOUNT');
  const agentPrivateKey = env.POPDEX_AGENT_PRIVATE_KEY || '';
  if (requireAgent && !agentPrivateKey) {
    throw new Error('PopDEX write-probe 缺少 POPDEX_AGENT_PRIVATE_KEY。');
  }
  return { mainAccount, agentPrivateKey };
}

function assertMarketIdentity(markets, symbol) {
  if (!Array.isArray(markets)) throw new Error('PopDEX markets 必须是数组。');
  const matches = markets.filter((market) => market?.name === symbol);
  if (matches.length !== 1) {
    throw new Error(`PopDEX ${symbol} 主网市场数量必须为 1，实际 ${matches.length}。`);
  }
  const market = matches[0];
  const expected = POPDEX_EXPECTED_MARKETS[symbol];
  if (!expected || String(market.marketId) !== expected.symbolId
      || String(market.stepPrice) !== String(Number(expected.tickSize))
      || String(market.stepSize) !== String(Number(expected.lotSize))
      || String(market.minOrderSize) !== String(Number(expected.minQty))
      || String(market.minNotional) !== String(Number(expected.minNotional))) {
    throw new Error(`PopDEX ${symbol} 主网市场身份或精度不匹配。`);
  }
  return market;
}

function maskedAddress(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function safeFailureMessage(value, mainAccount) {
  const raw = typeof value?.message === 'string'
    ? value.message
    : JSON.stringify(value);
  const text = typeof raw === 'string' && raw.length > 0 ? raw : '链上未返回失败详情';
  return text
    .replace(new RegExp(mainAccount, 'ig'), maskedAddress(mainAccount))
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function exactFailedReceipt(receipt, expectedTxHash) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('PopDEX 失败下单回执必须是对象。');
  }
  const transactionHash = String(receipt.transactionHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new Error('PopDEX 失败下单回执 transactionHash 无效。');
  }
  if (transactionHash !== expectedTxHash) {
    throw new Error(
      `PopDEX 失败下单回执 transactionHash 不匹配：expected=${expectedTxHash} actual=${transactionHash}。`,
    );
  }
  if (receipt.status !== '0x0') {
    throw new Error(`PopDEX 失败下单回执 status 必须是 0x0，实际 ${String(receipt.status)}。`);
  }
}

function exactSuccessfulReceipt(receipt, expectedTxHash) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('PopDEX 成功下单回执必须是对象。');
  }
  const transactionHash = String(receipt.transactionHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new Error('PopDEX 成功下单回执 transactionHash 无效。');
  }
  if (transactionHash !== expectedTxHash) {
    throw new Error(
      `PopDEX 成功下单回执 transactionHash 不匹配：expected=${expectedTxHash} actual=${transactionHash}。`,
    );
  }
  if (receipt.status !== '0x1') {
    throw new Error(`PopDEX 成功下单回执 status 必须是 0x1，实际 ${String(receipt.status)}。`);
  }
}

function exactAvailableMargin(overview) {
  if (!overview || typeof overview !== 'object' || Array.isArray(overview)) {
    throw new Error('PopDEX account overview 必须是对象。');
  }
  return strictDecimalString(overview.availableMargin, 'overview.availableMargin');
}

function assertProbeCapacity(availableMargin, orderPlan) {
  const availableWad = parseUnits(availableMargin, 18);
  const oneWad = 10n ** 18n;
  const notionalWad = (BigInt(orderPlan.priceWad) * BigInt(orderPlan.qtyWad)) / oneWad;
  if (availableWad < notionalWad) {
    throw new Error(
      `PopDEX availableMargin=${availableMargin} 小于本次保守验收所需名义金额 ${formatUnits(notionalWad, 18)}，无法下单。请先给 POPDEX_MAIN_ACCOUNT 充值保证金。`,
    );
  }
}

function exactRecoveredIdentity(record, order, mainAccount) {
  const expected = POPDEX_EXPECTED_MARKETS[record.symbol];
  if (!expected) throw new Error(`PopDEX journal symbol ${String(record.symbol)} 不在白名单。`);
  const fields = [
    ['walletId', mainAccount.toLowerCase(), String(order.walletId).toLowerCase()],
    ['clientOrderId', record.clientOrderId.toLowerCase(), String(order.clientOrderId).toLowerCase()],
    ['symbolId', expected.symbolId, order.symbolId],
    ['side', record.side === 'buy' ? '0' : '1', order.side],
    ['priceWad', parseUnits(record.price, 18).toString(), order.priceWad],
    ['qtyWad', parseUnits(record.qty, 18).toString(), order.qtyWad],
  ];
  for (const [field, wanted, actual] of fields) {
    if (actual !== wanted) {
      throw new Error(
        `PopDEX resume ${field} 不匹配：expected=${wanted} actual=${String(actual)}。`,
      );
    }
  }
  if (order.isReduceOnly !== false) throw new Error('PopDEX resume isReduceOnly 必须是 false。');
  if (record.orderId !== null && record.orderId !== undefined && record.orderId !== order.orderId) {
    throw new Error(
      `PopDEX resume orderId 不匹配：expected=${record.orderId} actual=${order.orderId}。`,
    );
  }
}

async function findOptional(readRpc, account, clientOrderId, completed) {
  try {
    return await readRpc.findUniqueOrderByClientId(account, clientOrderId, { completed });
  } catch (error) {
    if (error?.code === 'POPDEX_ORDER_NOT_FOUND') return null;
    throw error;
  }
}

async function findRestOptional(accountClient, account, symbol, clientOrderId) {
  try {
    return await accountClient.findUniqueOrderByClientId(account, symbol, clientOrderId);
  } catch (error) {
    if (error?.code === 'POPDEX_ORDER_NOT_FOUND') return null;
    throw error;
  }
}

function recoveredRestOrder(record, order, mainAccount, receiptOrder) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    throw new Error('PopDEX resume REST order 必须是对象。');
  }
  const market = POPDEX_EXPECTED_MARKETS[record.symbol];
  if (!market) throw new Error(`PopDEX journal symbol ${String(record.symbol)} 不在白名单。`);
  const wad = (value, field) => parseUnits(strictDecimalString(value, field), 18).toString();
  const filledQtyWad = wad(order.filledQty, 'resume REST order.filledQty');
  const remainingQtyWad = wad(order.remainingQty, 'resume REST order.remainingQty');
  const cancelledQtyWad = wad(order.cancelledQty, 'resume REST order.cancelledQty');
  const qtyWad = parseUnits(record.qty, 18).toString();
  const fields = [
    ['walletId', mainAccount.toLowerCase(), strictAddress(order.walletId, 'resume REST order.walletId').toLowerCase()],
    ['orderId', receiptOrder.orderId, strictIntegerString(order.orderId, 'resume REST order.orderId')],
    ['clientOid', decodeBytes32String(record.clientOrderId), order.clientOid],
    ['symbolId', market.symbolId, String(order.symbolId)],
    ['symbol', record.symbol, order.symbol],
    ['side', record.side === 'buy' ? 'Buy' : 'Sell', order.side],
    ['priceWad', parseUnits(record.price, 18).toString(), wad(order.price, 'resume REST order.price')],
    ['qtyWad', qtyWad, wad(order.qty, 'resume REST order.qty')],
  ];
  for (const [field, expected, actual] of fields) {
    if (expected !== actual) {
      throw new Error(
        `PopDEX resume REST ${field} 不匹配：expected=${String(expected)} actual=${String(actual)}。`,
      );
    }
  }
  if (order.reduceOnly !== false) throw new Error('PopDEX resume REST reduceOnly 必须是 false。');
  if (BigInt(qtyWad) !== BigInt(filledQtyWad) + BigInt(remainingQtyWad) + BigInt(cancelledQtyWad)) {
    throw new Error('PopDEX resume REST qty 不等于 filled + remaining + cancelled。');
  }
  return {
    walletId: mainAccount,
    orderId: receiptOrder.orderId,
    clientOrderId: record.clientOrderId,
    symbolId: market.symbolId,
    side: record.side === 'buy' ? '0' : '1',
    priceWad: parseUnits(record.price, 18).toString(),
    qtyWad,
    filledQtyWad,
    remainingQtyWad,
    cancelledQtyWad,
    isReduceOnly: false,
    status: order.status,
  };
}

function resumeFromRestOrder(record, order, journal) {
  const activeStatuses = new Set(['WaitToSend', 'PendingNew', 'NewAccept', 'PendingCancel', 'PartiallyFilled']);
  const terminalStatuses = new Set(['Cancelled', 'FullyFilled', 'PartiallyFilledCancelled']);
  if (!activeStatuses.has(order.status) && !terminalStatuses.has(order.status)) {
    throw new Error(`PopDEX resume REST order.status 未验证：${String(order.status)}。`);
  }
  if (order.filledQtyWad !== '0') {
    return {
      mode: 'resume',
      status: 'filled-manual-position-required',
      source: 'receipt+REST',
      orderId: order.orderId,
      filledQtyWad: order.filledQtyWad,
    };
  }
  if (activeStatuses.has(order.status)) {
    if (order.remainingQtyWad !== order.qtyWad || order.cancelledQtyWad !== '0') {
      throw new Error(
        `PopDEX resume REST 活动订单零成交数量不一致：remaining=${order.remainingQtyWad} cancelled=${order.cancelledQtyWad}。`,
      );
    }
    const { status: restStatus, ...openOrder } = order;
    return {
      mode: 'resume',
      status: 'active-manual-cancel-required',
      source: 'receipt+REST',
      restStatus,
      orderId: order.orderId,
      clientOrderId: record.clientOrderId,
      openOrder,
    };
  }
  if (order.status !== 'Cancelled'
      || order.remainingQtyWad !== '0'
      || order.cancelledQtyWad !== order.qtyWad) {
    throw new Error(
      `PopDEX resume REST 零成交终态不一致：status=${order.status} remaining=${order.remainingQtyWad} cancelled=${order.cancelledQtyWad}。`,
    );
  }
  if (record.stage !== 'CANCEL_CONFIRMED') journal.completeFromChain(order.orderId);
  journal.clearCompleted();
  return {
    mode: 'resume',
    status: 'completed-zero-fill-cleared',
    source: 'receipt+REST',
    orderId: order.orderId,
  };
}

async function runResume({ mainAccount, readRpc, accountClient, journal }) {
  const record = journal.load();
  if (record === null) return { mode: 'resume', status: 'no-record' };
  await readRpc.verifyChain();
  if (typeof record.placeTxHash === 'string') {
    const txHash = record.placeTxHash.toLowerCase();
    const receipt = await readRpc.getReceipt(txHash);
    if (receipt?.status === '0x0') {
      exactFailedReceipt(receipt, txHash);
      const active = await findOptional(readRpc, mainAccount, record.clientOrderId, false);
      const completed = await findOptional(readRpc, mainAccount, record.clientOrderId, true);
      const rest = await findRestOptional(
        accountClient,
        mainAccount,
        record.symbol,
        record.clientOrderId,
      );
      if (active !== null || completed !== null || rest !== null) {
        throw new Error('PopDEX 失败下单回执与订单查询事实冲突。');
      }
      const failure = safeFailureMessage(
        await readRpc.getTransactionFailure(txHash),
        mainAccount,
      );
      journal.clearRevertedPlacement(txHash);
      return {
        mode: 'resume',
        status: 'reverted-placement-cleared',
        txHash,
        failure,
      };
    }
    if (receipt?.status === '0x1') {
      exactSuccessfulReceipt(receipt, txHash);
      const market = POPDEX_EXPECTED_MARKETS[record.symbol];
      if (!market) throw new Error(`PopDEX journal symbol ${String(record.symbol)} 不在白名单。`);
      const receiptOrder = parseOrderCreateReceipt(receipt, {
        account: mainAccount,
        symbolId: market.symbolId,
        clientOrderId: record.clientOrderId,
        priceWad: parseUnits(record.price, 18).toString(),
        qtyWad: parseUnits(record.qty, 18).toString(),
      });
      const rest = await findRestOptional(
        accountClient,
        mainAccount,
        record.symbol,
        record.clientOrderId,
      );
      if (rest !== null) {
        return resumeFromRestOrder(
          record,
          recoveredRestOrder(record, rest, mainAccount, receiptOrder),
          journal,
        );
      }
    }
  }
  const active = await findOptional(readRpc, mainAccount, record.clientOrderId, false);
  if (active !== null) {
    exactRecoveredIdentity(record, active, mainAccount);
    if (active.filledQtyWad !== '0') {
      return {
        mode: 'resume',
        status: 'filled-manual-position-required',
        orderId: active.orderId,
        filledQtyWad: active.filledQtyWad,
      };
    }
    return {
      mode: 'resume',
      status: 'active-manual-cancel-required',
      orderId: active.orderId,
      clientOrderId: record.clientOrderId,
    };
  }
  const completed = await findOptional(readRpc, mainAccount, record.clientOrderId, true);
  if (completed === null) {
    return { mode: 'resume', status: 'order-fact-unresolved', clientOrderId: record.clientOrderId };
  }
  exactRecoveredIdentity(record, completed, mainAccount);
  if (completed.filledQtyWad !== '0') {
    return {
      mode: 'resume',
      status: 'filled-manual-position-required',
      orderId: completed.orderId,
      filledQtyWad: completed.filledQtyWad,
    };
  }
  const expectedQtyWad = parseUnits(record.qty, 18).toString();
  if (completed.remainingQtyWad !== '0' || completed.cancelledQtyWad !== expectedQtyWad) {
    throw new Error(
      `PopDEX resume 零成交终态数量不一致：remaining=${completed.remainingQtyWad} cancelled=${completed.cancelledQtyWad}。`,
    );
  }
  if (record.stage !== 'CANCEL_CONFIRMED') journal.completeFromChain(completed.orderId);
  journal.clearCompleted();
  return { mode: 'resume', status: 'completed-zero-fill-cleared', orderId: completed.orderId };
}

async function runRecoveryCancel({
  result,
  mainAccount,
  agentPrivateKey,
  readRpc,
  accountClient,
  journal,
  deps,
}) {
  if (result.status !== 'active-manual-cancel-required'
      || result.source !== 'receipt+REST'
      || result.restStatus !== 'NewAccept'
      || !result.openOrder) {
    throw new Error(
      'PopDEX 恢复撤单只允许回执与 REST 已确认的 NewAccept 零成交订单。',
    );
  }
  const current = journal.load();
  if (current === null) throw new Error('PopDEX 恢复撤单记录不存在。');
  if (current.stage === 'CANCEL_BROADCAST') {
    throw new Error('PopDEX 撤单已经广播，禁止重复广播；请运行普通 --resume。');
  }
  if (current.stage !== 'BROADCAST' && current.stage !== 'OPEN_CONFIRMED') {
    throw new Error(`PopDEX 恢复撤单不允许 journal 阶段 ${current.stage}。`);
  }
  if (current.orderId !== null && current.orderId !== result.orderId) {
    throw new Error(
      `PopDEX 恢复撤单 orderId 冲突：journal=${current.orderId} recovered=${result.orderId}。`,
    );
  }
  const now = deps.now ?? (() => Date.now());
  const writeRpc = deps.createWriteRpc
    ? deps.createWriteRpc()
    : new PopdexWriteRpcClient(deps.writeRpcOptions);
  const trading = deps.createTradingClient
    ? deps.createTradingClient({
      mainAccount,
      agentPrivateKey,
      readRpc,
      accountClient,
      writeRpc,
      now,
    })
    : new PopdexTradingClient({
      mainAccount,
      agentPrivateKey,
      readRpc,
      accountClient,
      writeRpc,
      now,
    });
  await trading.preflight();
  if (current.stage === 'BROADCAST') {
    journal.advance('BROADCAST', 'OPEN_CONFIRMED', { orderId: result.orderId });
  }
  const cancelled = await trading.cancelAndConfirm(result.openOrder, journal);
  const completedRecord = journal.load();
  if (completedRecord?.stage !== 'CANCEL_CONFIRMED') {
    throw new Error('PopDEX 恢复撤单完成后 journal 未处于 CANCEL_CONFIRMED。');
  }
  const cancelTxHash = completedRecord.cancelTxHash;
  if (typeof cancelTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(cancelTxHash)) {
    throw new Error('PopDEX 恢复撤单完成后 journal cancelTxHash 无效。');
  }
  if (cancelled.filledQtyWad !== '0'
      || cancelled.remainingQtyWad !== '0'
      || cancelled.cancelledQtyWad !== result.openOrder.qtyWad) {
    throw new Error(
      `PopDEX 恢复撤单终态数量不一致：filled=${String(cancelled.filledQtyWad)} remaining=${String(cancelled.remainingQtyWad)} cancelled=${String(cancelled.cancelledQtyWad)}。`,
    );
  }
  journal.clearCompleted();
  return {
    mode: 'resume-cancel',
    status: 'cancelled-zero-fill-cleared',
    orderId: result.orderId,
    cancelTxHash,
    filledQtyWad: cancelled.filledQtyWad,
    cancelledQtyWad: cancelled.cancelledQtyWad,
  };
}

export async function runProbe(options, deps = {}) {
  const journal = deps.journal ?? new PopdexWriteJournal({
    file: deps.journalFile ?? JOURNAL_FILE,
    fsImpl: deps.fsImpl,
    platform: deps.platform,
    now: deps.now,
  });
  const readRpc = deps.readRpc ?? new PopdexRpcClient(deps.readRpcOptions);
  if (options.resume) {
    const { mainAccount, agentPrivateKey } = exactEnvironment(deps, {
      requireAgent: options.confirmMainnetCancel,
    });
    const accountClient = deps.accountClient ?? new PopdexAccountClient(deps.accountOptions);
    const result = await runResume({ mainAccount, readRpc, accountClient, journal });
    if (!options.confirmMainnetCancel) return result;
    return runRecoveryCancel({
      result,
      mainAccount,
      agentPrivateKey,
      readRpc,
      accountClient,
      journal,
      deps,
    });
  }

  const existing = journal.load();
  if (existing !== null) {
    throw new Error(
      `PopDEX 已有 ${existing.stage} 恢复记录，请先运行 npm run popdex:write-probe -- --resume。`,
    );
  }
  const { mainAccount, agentPrivateKey } = exactEnvironment(deps, { requireAgent: true });
  const publicClient = deps.publicClient ?? new PopdexPublicClient(deps.publicOptions);
  const accountClient = deps.accountClient ?? new PopdexAccountClient(deps.accountOptions);
  await readRpc.verifyChain();
  assertMarketIdentity(await publicClient.getMarkets(), options.symbol);
  const ticker = await publicClient.getTicker(options.symbol);
  const agent = deriveAgentAddress(agentPrivateKey);
  const agentInfo = await readRpc.getAgentInfo(agent);
  const now = deps.now ?? (() => Date.now());
  const nowMs = now();
  const authorization = validateAgentAuthorization({
    mainAccount,
    agentAddress: agent,
    info: agentInfo,
    nowMs,
  });
  const orderPlan = prepareProbeOrder({
    mainAccount,
    symbol: options.symbol,
    side: options.side,
    price: options.price,
    qty: options.qty,
    bid: String(ticker.bid),
    ask: String(ticker.ask),
    randomBytesImpl: deps.randomBytesImpl ?? randomBytes,
    nowMs,
  });
  const availableMargin = exactAvailableMargin(await accountClient.getOverview(mainAccount));
  const safeResult = {
    mode: options.confirmMainnetWrite ? 'mainnet-write' : 'dry-run',
    symbol: orderPlan.symbol,
    side: orderPlan.side,
    price: orderPlan.price,
    qty: orderPlan.qty,
    bid: orderPlan.bid,
    ask: orderPlan.ask,
    symbolId: orderPlan.symbolId,
    mainAccount,
    agent,
    agentExpiresAt: authorization.expiresAt,
    clientOrderId: orderPlan.clientOrderId,
    calldataHash: keccak256(orderPlan.data),
    availableMargin,
  };
  if (!options.confirmMainnetWrite) return safeResult;
  assertProbeCapacity(availableMargin, orderPlan);

  const writeRpc = deps.createWriteRpc
    ? deps.createWriteRpc()
    : new PopdexWriteRpcClient(deps.writeRpcOptions);
  const trading = deps.createTradingClient
    ? deps.createTradingClient({ mainAccount, agentPrivateKey, readRpc, accountClient, writeRpc, now })
    : new PopdexTradingClient({ mainAccount, agentPrivateKey, readRpc, accountClient, writeRpc, now });
  journal.create({
    symbol: orderPlan.symbol,
    side: orderPlan.side,
    price: orderPlan.price,
    qty: orderPlan.qty,
    clientOrderId: orderPlan.clientOrderId,
  });
  let open;
  try {
    open = await trading.placeAndConfirm(orderPlan, journal);
  } catch (error) {
    try {
      const current = journal.load();
      if (current?.stage === 'PREPARED') journal.clearPrepared();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'PopDEX 下单前失败，且 PREPARED 恢复记录清理失败。',
      );
    }
    throw error;
  }
  const cancelled = await trading.cancelAndConfirm(open, journal);
  journal.clearCompleted();
  return {
    ...safeResult,
    orderId: open.orderId,
    filledQtyWad: cancelled.filledQtyWad,
    cancelledQtyWad: cancelled.cancelledQtyWad,
  };
}

function renderResult(result) {
  if (result.mode === 'dry-run' || result.mode === 'mainnet-write') {
    return [
      `PopDEX ${result.mode} 完成`,
      `market=${result.symbol} side=${result.side} price=${result.price} qty=${result.qty}`,
      `book bid=${result.bid} ask=${result.ask}`,
      `availableMargin=${result.availableMargin}`,
      `main=${maskedAddress(result.mainAccount)} agent=${maskedAddress(result.agent)}`,
      `clientOrderId=${result.clientOrderId} calldataHash=${result.calldataHash}`,
      ...(result.orderId ? [`orderId=${result.orderId} cancelledQtyWad=${result.cancelledQtyWad}`] : []),
    ];
  }
  if (result.mode === 'resume-cancel') {
    return [
      `PopDEX recovery-cancel status=${result.status}`,
      `orderId=${result.orderId}`,
      `cancelTxHash=${result.cancelTxHash}`,
      `filledQtyWad=${result.filledQtyWad} cancelledQtyWad=${result.cancelledQtyWad}`,
      '已确认零成交撤单并安全清理恢复记录。',
    ];
  }
  const lines = [`PopDEX resume status=${result.status}`];
  if (result.orderId) lines.push(`orderId=${result.orderId}`);
  if (result.filledQtyWad) lines.push(`filledQtyWad=${result.filledQtyWad}，请人工检查并处理仓位。`);
  if (result.status === 'active-manual-cancel-required') {
    lines.push('订单仍为活动状态，请先在 PopDEX 网页人工撤单，再重新运行 --resume。');
  }
  if (result.status === 'reverted-placement-cleared') {
    lines.push(`txHash=${result.txHash}`);
    lines.push(`failure=${result.failure}`);
    lines.push('已确认下单交易回执失败且没有活动/完成订单，恢复记录已安全清理。');
  }
  return lines;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  try {
    const result = await runProbe(parseArgs(argv), deps);
    for (const line of renderResult(result)) (deps.log ?? console.log)(line);
    process.exitCode = 0;
    return result;
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    const env = deps.env ?? process.env;
    let message = raw.replace(/[\r\n]+/g, ' ').slice(0, 1000);
    for (const secret of [env.POPDEX_AGENT_PRIVATE_KEY, env.POPDEX_MAIN_ACCOUNT]) {
      if (typeof secret === 'string' && secret.length > 0) {
        message = message.replaceAll(secret, secret === env.POPDEX_MAIN_ACCOUNT
          ? maskedAddress(secret)
          : '[REDACTED]');
      }
    }
    (deps.error ?? console.error)(`PopDEX write-probe 失败：${message}`);
    process.exitCode = 1;
    return null;
  }
}

const directEntry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (directEntry === import.meta.url) await main();
