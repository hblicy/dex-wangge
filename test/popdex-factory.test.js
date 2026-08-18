import assert from 'node:assert/strict';
import test from 'node:test';
import { createExchange, createLiveExchange } from '../src/exchange/px/index.js';
import { PopdexExchange } from '../src/exchange/px/popdex.js';
import { PopdexPaperExchange } from '../src/exchange/px/paper.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const AGENT_KEY = `0x${'22'.repeat(32)}`;

function injectedLiveDependencies() {
  return {
    publicClient: {},
    accountClient: {},
    readRpc: {},
    writeRpc: {},
    tradingClient: {},
    journal: {},
  };
}

test('PopDEX factory creates only explicit paper or live adapters', () => {
  const paper = createExchange({ mode: 'paper', feeRate: 0.0005, startBalance: 1000 }, {
    publicClient: {},
  });
  assert.ok(paper instanceof PopdexPaperExchange);

  const live = createExchange({
    mode: 'live',
    mainAccount: ACCOUNT,
    agentPrivateKey: AGENT_KEY,
    journalFile: '.popdex-operation.json',
  }, injectedLiveDependencies());
  assert.ok(live instanceof PopdexExchange);
  assert.throws(() => createExchange({ mode: 'unknown' }), /mode.*paper.*live/);
});

test('live factory requires all explicit secret and recovery configuration', () => {
  const deps = injectedLiveDependencies();
  assert.throws(() => createLiveExchange({
    agentPrivateKey: AGENT_KEY, journalFile: '.popdex-operation.json',
  }, deps), /mainAccount/);
  assert.throws(() => createLiveExchange({
    mainAccount: ACCOUNT, journalFile: '.popdex-operation.json',
  }, deps), /agentPrivateKey/);
  assert.throws(() => createLiveExchange({
    mainAccount: ACCOUNT, agentPrivateKey: AGENT_KEY,
  }, deps), /journalFile/);
});

test('injected dependencies remain isolated and are passed through unchanged', () => {
  const deps = injectedLiveDependencies();
  const exchange = createLiveExchange({
    mainAccount: ACCOUNT,
    agentPrivateKey: AGENT_KEY,
    journalFile: '.popdex-operation.json',
  }, deps);
  assert.equal(exchange.publicClient, deps.publicClient);
  assert.equal(exchange.accountClient, deps.accountClient);
  assert.equal(exchange.readRpc, deps.readRpc);
  assert.equal(exchange.tradingClient, deps.tradingClient);
  assert.equal(exchange.journal, deps.journal);
});
