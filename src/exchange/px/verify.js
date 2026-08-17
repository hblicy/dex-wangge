import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../../config.js';
import { PopdexAccountClient } from './account-client.js';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import {
  inspectOfficialArtifacts,
  POPDEX_REQUIRED_PROTOCOL_TOKENS,
} from './official-artifacts.js';
import { strictAddress } from './normalize.js';
import { PopdexPublicClient } from './public-client.js';
import { PopdexRpcClient } from './rpc-client.js';

const TARGET_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT']);
const FORBIDDEN_FLAGS = Object.freeze([
  '--agent-key',
  '--private-key',
  '--place',
  '--cancel',
  '--leverage',
  '--close',
]);

function assertReadOnlyConfig(config) {
  for (const key of ['agentKey', 'agentPrivateKey', 'privateKey', 'signerKey']) {
    if (config?.[key] !== undefined) {
      throw new Error(`PopDEX 只读验证拒绝配置字段 ${key}。`);
    }
  }
}

function assertVerifiedMarkets(markets) {
  if (!Array.isArray(markets) || markets.length !== TARGET_SYMBOLS.length) {
    throw new Error('PopDEX 公共验证必须精确返回 BTCUSDT 和 ETHUSDT 两个市场。');
  }
  for (let index = 0; index < TARGET_SYMBOLS.length; index += 1) {
    const symbol = TARGET_SYMBOLS[index];
    const market = markets[index];
    const expected = POPDEX_EXPECTED_MARKETS[symbol];
    if (market?.name !== symbol || String(market.marketId) !== expected.symbolId) {
      throw new Error(`PopDEX ${symbol} 市场身份不匹配。`);
    }
    const fields = [
      ['stepPrice', 'tickSize'],
      ['stepSize', 'lotSize'],
      ['minOrderSize', 'minQty'],
      ['minNotional', 'minNotional'],
    ];
    for (const [actualField, expectedField] of fields) {
      if (market[actualField] !== Number(expected[expectedField])) {
        throw new Error(`PopDEX ${symbol} ${expectedField} 验证值不匹配。`);
      }
    }
  }
}

function verifyArtifactEvidence(artifacts) {
  if (!artifacts || !Array.isArray(artifacts.scripts) || !Array.isArray(artifacts.matches)) {
    throw new Error('PopDEX 官方前端扫描结果格式无效。');
  }
  return POPDEX_REQUIRED_PROTOCOL_TOKENS.filter(
    (token) => !artifacts.matches.some((entry) => entry?.token === token),
  );
}

export async function verifyPopdexPublic(config = {}, deps = {}) {
  assertReadOnlyConfig(config);
  const rpcClient = deps.rpcClient ?? new PopdexRpcClient(deps.rpcOptions);
  const publicClient = deps.publicClient ?? new PopdexPublicClient(deps.publicOptions);
  const artifactInspector = deps.inspectArtifacts ?? inspectOfficialArtifacts;
  const candleInterval = config.candleInterval ?? '1H';
  const candleLimit = config.candleLimit ?? 200;

  const chainId = await rpcClient.verifyChain();
  const markets = await publicClient.getMarkets();
  assertVerifiedMarkets(markets);
  const marketReads = [];
  for (const market of markets) {
    const ticker = await publicClient.getTicker(market.name);
    const candles = await publicClient.getCandles(market.name, candleInterval, candleLimit);
    if (!Array.isArray(candles) || candles.length === 0) {
      throw new Error(`PopDEX ${market.name} candles 必须是非空数组。`);
    }
    marketReads.push({ ...market, ticker, candleCount: candles.length });
  }
  const artifacts = await artifactInspector(deps.artifactOptions);
  const missingArtifactTokens = verifyArtifactEvidence(artifacts);
  if (missingArtifactTokens.length > 0 && config.allowMissingArtifactTokens !== true) {
    throw new Error(`PopDEX 官方前端协议证据 ${missingArtifactTokens[0]} 未找到。`);
  }

  return {
    mode: 'public',
    fetchedAt: artifacts.fetchedAt,
    chainId: chainId.toString(),
    markets: marketReads,
    artifacts,
    missingArtifactTokens,
    writeMethodsCalled: 0,
  };
}

export async function verifyPopdexAccount(config = {}, deps = {}) {
  assertReadOnlyConfig(config);
  const account = strictAddress(config.account, 'account');
  const accountClient = deps.accountClient ?? new PopdexAccountClient(deps.accountOptions);
  const rpcClient = deps.rpcClient ?? new PopdexRpcClient(deps.rpcOptions);
  const markets = [];
  for (const symbol of TARGET_SYMBOLS) {
    const openOrders = await accountClient.getOpenOrders(account, symbol);
    const fills = await accountClient.getFills(account, symbol);
    if (!Array.isArray(openOrders) || !Array.isArray(fills)) {
      throw new Error(`PopDEX ${symbol} 账户订单或成交不是数组。`);
    }
    markets.push({
      name: symbol,
      openOrders: openOrders.length,
      fills: fills.length,
      orderCursor: openOrders.cursor ?? null,
      fillCursor: fills.cursor ?? null,
    });
  }
  const overview = await accountClient.getOverview(account);
  const positionPage = await rpcClient.getOpenPositions(account);
  if (!overview || typeof overview !== 'object' || Array.isArray(overview)) {
    throw new Error('PopDEX overview 必须是对象。');
  }
  if (!positionPage || !Array.isArray(positionPage.positions)
      || typeof positionPage.hasMore !== 'boolean') {
    throw new Error('PopDEX 链上 positions 页格式无效。');
  }
  if (positionPage.hasMore) {
    throw new Error('PopDEX 链上 positions 超过单页上限，验证器拒绝截断。');
  }

  return {
    mode: 'account',
    account,
    agentKeyRequired: false,
    markets,
    overviewKeys: Object.keys(overview).sort(),
    positions: positionPage.positions.length,
    positionSource: 'rpc:getOpenPositionsByAccount',
    writeMethodsCalled: 0,
  };
}

function parseArgs(argv) {
  let accountEnv = null;
  let artifactsJson = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const forbidden = FORBIDDEN_FLAGS.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (forbidden) {
      throw new Error(`PopDEX 只读验证拒绝参数 ${forbidden}。`);
    }
    if (arg === '--artifacts-json') {
      artifactsJson = true;
      continue;
    }
    if (arg === '--account-env') {
      const value = argv[index + 1];
      if (value !== 'POPDEX_MAIN_ACCOUNT') {
        throw new Error('--account-env 只允许 POPDEX_MAIN_ACCOUNT。');
      }
      accountEnv = value;
      index += 1;
      continue;
    }
    throw new Error(`PopDEX 只读验证不支持参数 ${String(arg)}。`);
  }
  return { accountEnv, artifactsJson };
}

function maskAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function renderPublic(result) {
  const lines = [
    'PopDEX 公共只读验证通过',
    `chainId=${result.chainId}`,
  ];
  for (const market of result.markets) {
    lines.push(
      `${market.name} symbolId=${market.marketId} tick=${market.stepPrice} lot=${market.stepSize} minNotional=${market.minNotional}`,
    );
  }
  lines.push(`writeMethodsCalled=${result.writeMethodsCalled}`);
  return lines;
}

function renderAccount(result) {
  const lines = [
    'PopDEX 账户只读验证通过',
    `account=${maskAddress(result.account)} agentKeyRequired=false`,
  ];
  for (const market of result.markets) {
    lines.push(`${market.name} open=${market.openOrders} fills=${market.fills}`);
  }
  lines.push(`positions=${result.positions} writeMethodsCalled=${result.writeMethodsCalled}`);
  return lines;
}

function redactAddress(message, account) {
  if (!account) return message;
  return message.replace(new RegExp(account, 'ig'), maskAddress(account));
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  let account = '';
  try {
    const args = parseArgs(argv);
    if (args.accountEnv && deps.env === undefined) {
      (deps.loadEnv ?? loadEnv)();
    }
    const publicResult = await verifyPopdexPublic(
      { allowMissingArtifactTokens: args.artifactsJson },
      deps,
    );
    for (const line of renderPublic(publicResult)) (deps.log ?? console.log)(line);
    let accountResult = null;
    if (args.accountEnv) {
      const env = deps.env ?? process.env;
      account = strictAddress(env[args.accountEnv], args.accountEnv);
      accountResult = await verifyPopdexAccount({ account }, deps);
      for (const line of renderAccount(accountResult)) (deps.log ?? console.log)(line);
    }
    if (args.artifactsJson) {
      (deps.log ?? console.log)(JSON.stringify(publicResult.artifacts, null, 2));
      if (publicResult.missingArtifactTokens.length > 0) {
        throw new Error(
          `PopDEX 官方前端协议证据 ${publicResult.missingArtifactTokens[0]} 未找到。`,
        );
      }
    }
    process.exitCode = 0;
    return { public: publicResult, account: accountResult };
  } catch (cause) {
    const rawMessage = cause instanceof Error ? cause.message : String(cause);
    (deps.error ?? console.error)(`PopDEX 只读验证失败：${redactAddress(rawMessage, account)}`);
    process.exitCode = 1;
    return null;
  }
}

const directEntry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (directEntry === import.meta.url) await main();
