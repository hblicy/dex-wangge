import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const readProject = (file) => fs.readFileSync(new URL(file, root), 'utf8');

test('PopDEX Agent routes stay outside every exchange and GridBot runtime', () => {
  const server = readProject('src/server.js');
  assert.match(server, /new PopdexAgentService/);
  for (const route of ['status', 'prepare-approval', 'verify', 'save', 'prepare-revoke', 'clear']) {
    assert.match(server, new RegExp(`/api/px/agent/${route}`));
  }
  assert.doesNotMatch(server, /createPxExchange/);
  assert.doesNotMatch(server, /saveSnapshot\('px'/);
  assert.doesNotMatch(server, /new GridBot\([^\n]*px/i);
  assert.match(server, /const deHandler = makeExchangeHandler\('\/api\/de'/);
  assert.match(server, /const rsHandler = makeExchangeHandler\('\/api\/rs'/);
});

test('PopDEX Agent modules do not import Bot, persistence, AI, Decibel or RISEx', () => {
  const combined = [
    readProject('src/exchange/px/agent.js'),
    readProject('src/exchange/px/agent-service.js'),
  ].join('\n');
  for (const forbidden of [
    '../../bot.js',
    '../../persist.js',
    '../../startup.js',
    '../../recovery.js',
    '../../ai/',
    '../de/',
    '../rs/',
  ]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
});
