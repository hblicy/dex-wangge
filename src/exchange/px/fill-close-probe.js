import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatUnits, keccak256, parseUnits } from 'ethers';
import { loadEnv } from '../../config.js';
import { PopdexAccountClient } from './account-client.js';
import { deriveAgentAddress } from './agent.js';
import {
  POPDEX_REVERSE_INTERFACE,
  POPDEX_USER_CONFIG_INTERFACE,
  prepareFillClosePlan,
  verifyStage5Simulation,
} from './fill-close-codec.js';
import { assertInitialFlat, exactBtcLeverage } from './fill-close-state.js';
import {
  POPDEX_EXPECTED_MARKETS,
  POPDEX_ORDER_PRECOMPILE,
  POPDEX_USER_CONFIG_PRECOMPILE,
} from './constants.js';
import { strictAddress, strictDecimalString } from './normalize.js';
import { POPDEX_ORDER_INTERFACE } from './order-codec.js';
import { PopdexPublicClient } from './public-client.js';
import { PopdexRpcClient } from './rpc-client.js';
import { validateAgentAuthorization } from './trading-client.js';
import { PopdexWriteRpcClient } from './write-rpc-client.js';

const FLAGS = new Set([
  '--confirm-mainnet-fill-close',
  '--resume',
  '--confirm-mainnet-cancel',
  '--confirm-mainnet-close',
]);

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

async function runDryProbe(deps) {
  const { mainAccount, agentAddress } = exactEnvironment(deps);
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
  return {
    mode: 'dry-run',
    status: 'dry-run-ready',
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

export async function runProbe(options, deps = {}) {
  if (!options || typeof options !== 'object' || typeof options.mode !== 'string') {
    throw new Error('PopDEX fill-close-probe options 无效。');
  }
  if (options.mode === 'dry-run') return runDryProbe(deps);
  throw new Error(`PopDEX fill-close-probe ${options.mode} 模式尚未实现。`);
}

function maskedAddress(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function render(result) {
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
