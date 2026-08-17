import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatUnits, keccak256, parseUnits } from 'ethers';
import { loadEnv, ROOT } from '../../config.js';
import { PopdexAccountClient } from './account-client.js';
import { deriveAgentAddress } from './agent.js';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import { strictAddress, strictDecimalString } from './normalize.js';
import { prepareProbeOrder } from './order-codec.js';
import { PopdexPublicClient } from './public-client.js';
import { PopdexRpcClient } from './rpc-client.js';
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
    if (arg === '--confirm-mainnet-write' || arg === '--resume') {
      if (seen.has(arg)) throw new Error(`PopDEX write-probe 重复参数 ${arg}。`);
      seen.add(arg);
      if (arg === '--confirm-mainnet-write') confirmMainnetWrite = true;
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

async function runResume({ mainAccount, readRpc, journal }) {
  const record = journal.load();
  if (record === null) return { mode: 'resume', status: 'no-record' };
  await readRpc.verifyChain();
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
    if (record.stage === 'BROADCAST' && typeof record.placeTxHash === 'string') {
      const txHash = record.placeTxHash.toLowerCase();
      const receipt = await readRpc.getReceipt(txHash);
      if (receipt?.status === '0x0') {
        exactFailedReceipt(receipt, txHash);
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
    }
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

export async function runProbe(options, deps = {}) {
  const journal = deps.journal ?? new PopdexWriteJournal({
    file: deps.journalFile ?? JOURNAL_FILE,
    fsImpl: deps.fsImpl,
    platform: deps.platform,
    now: deps.now,
  });
  const readRpc = deps.readRpc ?? new PopdexRpcClient(deps.readRpcOptions);
  if (options.resume) {
    const { mainAccount } = exactEnvironment(deps, { requireAgent: false });
    return runResume({ mainAccount, readRpc, journal });
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
    ? deps.createTradingClient({ mainAccount, agentPrivateKey, readRpc, writeRpc, now })
    : new PopdexTradingClient({ mainAccount, agentPrivateKey, readRpc, writeRpc, now });
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
