import { PopdexAccountClient } from './account-client.js';
import { PopdexOperationJournal } from './operation-journal.js';
import { PopdexPaperExchange } from './paper.js';
import { PopdexExchange } from './popdex.js';
import { PopdexPublicClient } from './public-client.js';
import { PopdexRpcClient } from './rpc-client.js';
import { PopdexTradingClient } from './trading-client.js';
import { PopdexWriteRpcClient } from './write-rpc-client.js';

function requiredText(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`PopDEX live ${field} 必须是非空字符串。`);
  }
  return value;
}

export function createLiveExchange(cfg = {}, deps = {}) {
  const mainAccount = requiredText(cfg.mainAccount, 'mainAccount');
  const agentPrivateKey = requiredText(cfg.agentPrivateKey, 'agentPrivateKey');
  const journalFile = requiredText(cfg.journalFile, 'journalFile');
  const publicClient = deps.publicClient ?? new PopdexPublicClient();
  const accountClient = deps.accountClient ?? new PopdexAccountClient();
  const readRpc = deps.readRpc ?? new PopdexRpcClient();
  const writeRpc = deps.writeRpc ?? new PopdexWriteRpcClient();
  const tradingClient = deps.tradingClient ?? new PopdexTradingClient({
    mainAccount,
    agentPrivateKey,
    readRpc,
    accountClient,
    writeRpc,
  });
  const journal = deps.journal ?? new PopdexOperationJournal({ file: journalFile });
  return new PopdexExchange({
    mainAccount,
    publicClient,
    accountClient,
    readRpc,
    tradingClient,
    journal,
    ...(cfg.pollMs === undefined ? {} : { pollMs: cfg.pollMs }),
    ...(cfg.staleMs === undefined ? {} : { staleMs: cfg.staleMs }),
  });
}

export function createPaperExchange(cfg = {}, deps = {}) {
  return new PopdexPaperExchange({
    publicClient: deps.publicClient ?? new PopdexPublicClient(),
    feeRate: cfg.feeRate,
    ...(cfg.startBalance === undefined ? {} : { startBalance: cfg.startBalance }),
    ...(cfg.pollMs === undefined ? {} : { pollMs: cfg.pollMs }),
    ...(cfg.staleMs === undefined ? {} : { staleMs: cfg.staleMs }),
  });
}

export function createExchange(cfg = {}, deps = {}) {
  if (cfg.mode === 'paper') return createPaperExchange(cfg, deps);
  if (cfg.mode === 'live') return createLiveExchange(cfg, deps);
  throw new Error('PopDEX mode 必须显式为 paper 或 live。');
}

export { PopdexExchange, PopdexPaperExchange };
