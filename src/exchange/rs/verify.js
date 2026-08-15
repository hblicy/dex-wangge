import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Wallet, isAddress } from 'ethers';
import { InfoClient, WebSocketClient } from 'risex-client';
import { loadEnv } from '../../config.js';
import { normalizeRisexMarkets } from './normalize.js';
import { RisexPrivateStream } from './private-stream.js';

const REQUIRED_CLIENT_VERSION = '0.1.11';
const MAINNET_CHAIN_ID = 4153n;
const MAINNET_API = 'https://api.rise.trade';
const MAINNET_WS = 'wss://api.rise.trade/ws/';
const require = createRequire(import.meta.url);

function installedClientVersion() {
  let current = path.dirname(require.resolve('risex-client'));
  while (true) {
    const packageFile = path.join(current, 'package.json');
    if (fs.existsSync(packageFile)) {
      const parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      if (parsed.name === 'risex-client') return parsed.version;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('无法读取 risex-client package.json。');
}

function assertDependency(deps) {
  const actual = deps.packageVersion ?? installedClientVersion();
  if (actual !== REQUIRED_CLIENT_VERSION) {
    throw new Error(`RISEx 要求 risex-client ${REQUIRED_CLIENT_VERSION}，实际为 ${actual}。`);
  }
  return actual;
}

function assertDomain(domain) {
  if (!domain || domain.name !== 'RISEx' || domain.version !== '1') {
    throw new Error('RISEx EIP-712 domain 名称或版本不匹配。');
  }
  if (domain.chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`RISEx EIP-712 chain ID 不匹配：${String(domain.chainId)}。`);
  }
  if (!isAddress(domain.verifyingContract)) throw new Error('RISEx EIP-712 verifying contract 地址非法。');
}

function finiteDecimal(value, field, { positive = false } = {}) {
  if (typeof value === 'string' && !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    throw new Error(`RISEx ${field} 不是十进制数字。`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || (positive && !(result > 0))) {
    throw new Error(`RISEx ${field} 数值非法。`);
  }
  return result;
}

function bestPrice(level, field) {
  return finiteDecimal(level?.price ?? level?.[0], field, { positive: true });
}

function summarizeBook(book, market) {
  const bid = bestPrice(book?.bids?.[0], `${market.displayName} best bid`);
  const ask = bestPrice(book?.asks?.[0], `${market.displayName} best ask`);
  if (ask < bid) throw new Error(`RISEx ${market.displayName} orderbook 买卖价倒挂。`);
  return { bid, ask };
}

function withTimeout(promise, timeoutMs, label, deps) {
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => reject(new Error(`RISEx ${label} ${timeoutMs}ms 超时。`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimer(timer));
}

function maskAddress(address) {
  return `0x…${address.slice(-6).toLowerCase()}`;
}

async function readPublicRest(deps) {
  const version = assertDependency(deps);
  const info = (deps.infoFactory || ((options) => new InfoClient(options)))({
    baseUrl: MAINNET_API,
    wsUrl: MAINNET_WS,
    logLevel: 'error',
  });
  const [domain, rawMarkets] = await Promise.all([info.getEip712Domain(), info.getMarkets()]);
  assertDomain(domain);
  const markets = normalizeRisexMarkets(rawMarkets);
  const books = await Promise.all(markets.map(async (market) => ({
    ...market,
    ...summarizeBook(await info.getOrderbook(market.marketId), market),
  })));
  return { version, info, domain, markets: books };
}

async function verifyPublicWs(marketId, deps) {
  const ws = (deps.publicWsFactory || ((options) => new WebSocketClient(options)))({
    baseUrl: MAINNET_API,
    wsUrl: MAINNET_WS,
    logLevel: 'error',
  });
  let resolveMessage;
  let rejectMessage;
  const message = new Promise((resolve, reject) => {
    resolveMessage = resolve;
    rejectMessage = reject;
  });
  const onMessage = (value) => {
    if (value?.channel === 'orderbook') resolveMessage(value);
  };
  const onError = (error) => rejectMessage(error instanceof Error ? error : new Error(String(error)));
  ws.on('message', onMessage);
  ws.on('error', onError);
  try {
    await withTimeout(ws.connect(), 10_000, '公共 WebSocket 连接', deps);
    ws.subscribe({ channel: 'orderbook', market_ids: [marketId] });
    const first = await withTimeout(message, 10_000, '公共 orderbook 首条消息', deps);
    if (first.channel !== 'orderbook') throw new Error('RISEx 公共 WebSocket channel 不匹配。');
    return { channel: first.channel, type: String(first.type || '') };
  } finally {
    ws.off?.('message', onMessage);
    ws.off?.('error', onError);
    ws.disconnect();
  }
}

function summarizePosition(raw, marketId) {
  if (raw == null) return null;
  if (Number(raw.market_id) !== marketId) throw new Error(`RISEx market ${marketId} 仓位市场不匹配。`);
  if (raw.side !== 0 && raw.side !== 1 && raw.side !== '0' && raw.side !== '1') {
    throw new Error(`RISEx market ${marketId} 仓位方向非法。`);
  }
  const absolute = Math.abs(finiteDecimal(raw.size, `market ${marketId} position size`));
  if (absolute === 0) return null;
  const sizeBase = (raw.side === 0 || raw.side === '0') ? absolute : -absolute;
  return {
    sizeBase,
    entryPrice: finiteDecimal(raw.entry_price, `market ${marketId} entry price`, { positive: true }),
    leverage: raw.leverage == null ? null : finiteDecimal(raw.leverage, `market ${marketId} leverage`, { positive: true }),
  };
}

function assertPrivateConfig(config) {
  if (!config || !isAddress(config.account)) throw new Error('RISEX_ACCOUNT 不是有效 EVM 地址。');
  if (typeof config.signerKey !== 'string' || !/^0x[0-9a-f]{64}$/i.test(config.signerKey)) {
    throw new Error('RISEX_SIGNER_KEY 不是有效 32 字节私钥。');
  }
  if ((config.apiUrl || MAINNET_API) !== MAINNET_API) throw new Error(`RISEX_API_URL 必须为 ${MAINNET_API}`);
  if ((config.wsUrl || MAINNET_WS) !== MAINNET_WS) throw new Error(`RISEX_WS_URL 必须为 ${MAINNET_WS}`);
}

export async function verifyRisexPublic(deps = {}) {
  const rest = await readPublicRest(deps);
  const publicWs = await verifyPublicWs(rest.markets[0].marketId, deps);
  return {
    mode: 'public',
    dependency: rest.version,
    chainId: rest.domain.chainId.toString(),
    verifyingContract: rest.domain.verifyingContract,
    markets: rest.markets.map((market) => ({
      marketId: market.marketId,
      name: market.displayName,
      bid: market.bid,
      ask: market.ask,
    })),
    publicWs,
  };
}

export async function verifyRisexPrivate(config, deps = {}) {
  assertPrivateConfig(config);
  const rest = await readPublicRest(deps);
  const wallet = (deps.walletFactory || ((key) => new Wallet(key)))(config.signerKey);
  if (!wallet || !isAddress(wallet.address)) throw new Error('RISEX_SIGNER_KEY 无法派生有效 signer 地址。');
  const account = config.account.toLowerCase();
  const signer = wallet.address.toLowerCase();
  const status = await rest.info.getSessionKeyStatus(account, signer);
  if (status?.status !== 1) throw new Error('RISEx session signer 未注册或已失效。');

  const stream = (deps.privateStreamFactory || ((options) => new RisexPrivateStream(options)))({
    account,
    signerKey: config.signerKey,
    apiUrl: MAINNET_API,
    wsUrl: MAINNET_WS,
    marketIds: rest.markets.map((market) => market.marketId),
    isSignerRegistered: async () => true,
    logger: deps.privateLogger || { log() {}, error() {} },
  });
  stream.beginBuffering();
  try {
    await withTimeout(stream.connect(), 10_000, '私有 WebSocket 认证', deps);
    await withTimeout(stream.waitForOrderSnapshot(), 10_000, '私有 Orders 快照', deps);
    if (stream.authenticated !== true) throw new Error('RISEx 私有 WebSocket 未认证。');
    const [balance, markets] = await Promise.all([
      rest.info.getBalance(account),
      Promise.all(rest.markets.map(async (market) => {
        const [open, position, trades] = await Promise.all([
          rest.info.getOpenOrders(account, market.marketId),
          rest.info.getPosition(market.marketId, account),
          rest.info.getAccountTradeHistory(account, market.marketId, 100),
        ]);
        if (!Array.isArray(open) || !Array.isArray(trades)) {
          throw new Error(`RISEx ${market.displayName} 私有 REST 响应格式非法。`);
        }
        return {
          marketId: market.marketId,
          name: market.displayName,
          openOrders: open.length,
          trades: trades.length,
          position: summarizePosition(position, market.marketId),
        };
      })),
    ]);
    finiteDecimal(balance, 'balance');
    return {
      mode: 'private',
      dependency: rest.version,
      chainId: rest.domain.chainId.toString(),
      account: maskAddress(account),
      signer: maskAddress(signer),
      signerActive: true,
      privateWs: 'authenticated',
      balance: String(balance),
      markets,
    };
  } finally {
    stream.stop();
  }
}

function renderResult(result) {
  const lines = [
    `RISEx ${result.mode === 'private' ? '私有' : '公共'}只读验证通过`,
    `SDK=${result.dependency} chainId=${result.chainId}`,
  ];
  if (result.mode === 'public') {
    for (const market of result.markets) {
      lines.push(`${market.name} market=${market.marketId} bid=${market.bid} ask=${market.ask}`);
    }
    lines.push(`public WS=${result.publicWs.channel}/${result.publicWs.type || 'message'}`);
  } else {
    lines.push(`account=${result.account} signer=${result.signer} signerActive=true privateWS=authenticated`);
    lines.push(`balance=${result.balance}`);
    for (const market of result.markets) {
      const position = market.position
        ? `${market.position.sizeBase}@${market.position.entryPrice} (${market.position.leverage ?? '-'}x)`
        : 'none';
      lines.push(`${market.name} open=${market.openOrders} trades=${market.trades} position=${position}`);
    }
  }
  return lines;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  let signerKey = '';
  try {
    let result;
    if (argv.includes('--private')) {
      (deps.loadEnv || loadEnv)();
      const env = deps.env || process.env;
      signerKey = env.RISEX_SIGNER_KEY || '';
      result = await verifyRisexPrivate({
        account: env.RISEX_ACCOUNT || '',
        signerKey,
        apiUrl: env.RISEX_API_URL || MAINNET_API,
        wsUrl: env.RISEX_WS_URL || MAINNET_WS,
      }, deps);
    } else {
      result = await verifyRisexPublic(deps);
    }
    for (const line of renderResult(result)) (deps.log || console.log)(line);
    process.exitCode = 0;
    return result;
  } catch (cause) {
    let message = cause?.message || String(cause);
    if (signerKey) message = message.replaceAll(signerKey, '[REDACTED]');
    (deps.error || console.error)(`RISEx 只读验证失败：${message}`);
    process.exitCode = 1;
    return null;
  }
}

const directEntry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (directEntry === import.meta.url) await main();
