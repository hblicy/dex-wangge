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
    readProject('src/exchange/px/order-codec.js'),
    readProject('src/exchange/px/trading-client.js'),
    readProject('src/exchange/px/write-journal.js'),
    readProject('src/exchange/px/write-probe.js'),
    readProject('src/exchange/px/write-rpc-client.js'),
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

test('PopDEX write probe stays CLI-only and is not exposed as a grid or server route', () => {
  const server = readProject('src/server.js');
  const readme = readProject('README.md');
  const agents = readProject('AGENTS.md');
  const packageJson = readProject('package.json');
  assert.match(packageJson, /"popdex:write-probe"/);
  assert.match(readme, /popdex:write-probe/);
  assert.match(readme, /--confirm-mainnet-write/);
  assert.match(readme, /尚未.*PopDEX.*网格/s);
  assert.match(agents, /单笔.*下单.*撤单.*探针/s);
  assert.match(agents, /尚未.*自动网格/s);
  assert.doesNotMatch(server, /createPxExchange|new GridBot\([^\n]*px/i);
  assert.doesNotMatch(server, /\/api\/px\/(?:start|stop|orders|cancel|leverage|close)/i);
});

test('PopDEX Stage 5 close stays CLI-only and contains no reverse-order primitive', () => {
  const serverSource = readProject('src/server.js');
  const codec = readProject('src/exchange/px/fill-close-codec.js');
  const trading = readProject('src/exchange/px/trading-client.js');
  assert.doesNotMatch(codec, /POPDEX_REVERSE_INTERFACE|placeReverseOrder/);
  assert.doesNotMatch(trading, /POPDEX_REVERSE_INTERFACE|placeReverseOrder/);
  assert.doesNotMatch(serverSource, /fill-close-probe|closeFillCloseLong/);
  assert.doesNotMatch(serverSource, /\/api\/px\/(?:start|stop|orders|cancel|leverage|close)/i);
});

test('only the isolated PopDEX write RPC boundary can broadcast raw transactions', () => {
  const pxFiles = fs.readdirSync(new URL('src/exchange/px/', root))
    .filter((file) => file.endsWith('.js'));
  const broadcasters = pxFiles.filter((file) => (
    readProject(`src/exchange/px/${file}`).includes('eth_sendRawTransaction')
  ));
  assert.deepEqual(broadcasters.sort(), ['official-artifacts.js', 'write-rpc-client.js']);
  assert.doesNotMatch(readProject('src/exchange/px/write-probe.js'), /eth_sendRawTransaction/);
});

test('PopDEX Stage 6 factory remains absent from application entry points', () => {
  for (const file of [
    'src/server.js',
    'src/bot.js',
    'src/config.js',
    'src/startup.js',
    'src/recovery.js',
    'public/index.html',
  ]) {
    const source = readProject(file);
    assert.doesNotMatch(source, /exchange\/px\/index|createPopdexExchange|PX_MODE/, file);
  }
});

test('living documentation records Stage 6 boundary and Stage 7 gate', () => {
  const agents = readProject('AGENTS.md');
  const readme = readProject('README.md');
  assert.match(agents, /Stage 6.*IExchange.*Paper/s);
  assert.match(agents, /Stage 7.*成交补单.*恢复/s);
  assert.match(readme, /PopDEX 网格尚未开放/);
  assert.doesNotMatch(readme, /PopDEX.*可上实盘网格/);
});
