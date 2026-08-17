import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import * as security from '../src/security.js';
import { SseClientPool } from '../src/sse.js';
import { assertEnvFileSecure, writeEnvFile } from '../src/envfile.js';

function fakeResponse() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body += body;
    },
  };
}

test('安全配置要求至少 16 字符的仪表盘令牌', () => {
  assert.equal(typeof security.getSecurityConfig, 'function');
  assert.throws(
    () => security.getSecurityConfig({ DASHBOARD_TOKEN: 'too-short' }),
    /DASHBOARD_TOKEN.*16/,
  );
  assert.deepEqual(
    security.getSecurityConfig({ DASHBOARD_TOKEN: '0123456789abcdef' }),
    {
      dashboardToken: '0123456789abcdef',
      dashboardOrigins: [],
      maxSseClients: 10,
    },
  );
});

test('安全配置拒绝无效 Origin 和 SSE 配额', () => {
  const base = { DASHBOARD_TOKEN: '0123456789abcdef' };
  assert.throws(
    () => security.getSecurityConfig({ ...base, DASHBOARD_ORIGINS: 'ftp://vps.example' }),
    /DASHBOARD_ORIGINS/,
  );
  assert.throws(
    () => security.getSecurityConfig({ ...base, MAX_SSE_CLIENTS: '0' }),
    /MAX_SSE_CLIENTS/,
  );
  assert.deepEqual(
    security.getSecurityConfig({
      ...base,
      DASHBOARD_ORIGINS: 'https://vps.tail.example, http://127.0.0.1:8080',
      MAX_SSE_CLIENTS: '12',
    }).dashboardOrigins,
    ['https://vps.tail.example', 'http://127.0.0.1:8080'],
  );
});

test('Basic Auth 只接受固定 admin 用户和正确令牌', () => {
  assert.equal(typeof security.isAuthorized, 'function');
  const token = '0123456789abcdef';
  const basic = (value) => `Basic ${Buffer.from(value).toString('base64')}`;
  assert.equal(security.isAuthorized(undefined, token), false);
  assert.equal(security.isAuthorized(basic(`root:${token}`), token), false);
  assert.equal(security.isAuthorized(basic('admin:wrong-password'), token), false);
  assert.equal(security.isAuthorized(basic(`admin:${token}`), token), true);
});

test('未认证请求得到 401 和 Basic challenge', () => {
  assert.equal(typeof security.enforceRequestSecurity, 'function');
  const req = { method: 'GET', headers: {} };
  const res = fakeResponse();
  const allowed = security.enforceRequestSecurity(req, res, {
    dashboardToken: '0123456789abcdef',
    dashboardOrigins: [],
  });
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['WWW-Authenticate'], 'Basic realm="dex-wangge"');
});

function authHeader(token = '0123456789abcdef') {
  return `Basic ${Buffer.from(`admin:${token}`).toString('base64')}`;
}

function request({
  method = 'POST',
  contentType = 'application/json',
  marker = '1',
  origin,
  host = '127.0.0.1:8080',
} = {}) {
  return {
    method,
    headers: {
      authorization: authHeader(),
      host,
      ...(contentType === null ? {} : { 'content-type': contentType }),
      ...(marker === null ? {} : { 'x-dex-request': marker }),
      ...(origin === undefined ? {} : { origin }),
    },
  };
}

test('POST 要求 JSON Content-Type 和 X-Dex-Request', () => {
  const config = { dashboardToken: '0123456789abcdef', dashboardOrigins: [] };
  for (const [req, status] of [
    [request({ contentType: 'application/x-www-form-urlencoded' }), 415],
    [request({ marker: null }), 403],
  ]) {
    const res = fakeResponse();
    assert.equal(security.enforceRequestSecurity(req, res, config), false);
    assert.equal(res.statusCode, status);
  }
});

test('POST 接受本机 Origin 和配置的 Tailscale Origin，拒绝其他 Origin', () => {
  const config = {
    dashboardToken: '0123456789abcdef',
    dashboardOrigins: ['https://vps.tail.example'],
  };
  for (const origin of ['http://127.0.0.1:8080', 'https://vps.tail.example']) {
    assert.equal(security.enforceRequestSecurity(request({ origin }), fakeResponse(), config), true);
  }
  const res = fakeResponse();
  assert.equal(
    security.enforceRequestSecurity(request({ origin: 'https://evil.example' }), res, config),
    false,
  );
  assert.equal(res.statusCode, 403);
});

test('严格 JSON 解析拒绝非法和超限正文', async () => {
  assert.equal(typeof security.readJsonBody, 'function');
  const invalid = new EventEmitter();
  const invalidPromise = security.readJsonBody(invalid);
  invalid.emit('data', Buffer.from('{bad'));
  invalid.emit('end');
  await assert.rejects(invalidPromise, (error) => error.statusCode === 400);

  const oversized = new EventEmitter();
  const oversizedPromise = security.readJsonBody(oversized, 4);
  oversized.emit('data', Buffer.from('12345'));
  oversized.emit('end');
  await assert.rejects(oversizedPromise, (error) => error.statusCode === 413);
});

test('严格 JSON 解析接受空正文和合法对象', async () => {
  assert.equal(typeof security.readJsonBody, 'function');
  const empty = new EventEmitter();
  const emptyPromise = security.readJsonBody(empty);
  empty.emit('end');
  assert.deepEqual(await emptyPromise, {});

  const valid = new EventEmitter();
  const validPromise = security.readJsonBody(valid);
  valid.emit('data', Buffer.from('{"closePosition":false}'));
  valid.emit('end');
  assert.deepEqual(await validPromise, { closePosition: false });
});

function fakeSseResponse(writeResult = true) {
  const res = new EventEmitter();
  res.ended = false;
  res.writes = [];
  res.write = (value) => {
    res.writes.push(value);
    return writeResult;
  };
  res.end = () => { res.ended = true; };
  return res;
}

test('SSE 达到上限时拒绝新连接，关闭后释放配额', () => {
  assert.equal(typeof SseClientPool, 'function');
  const logger = { warn() {} };
  const pool = new SseClientPool('test', 1, logger);
  const req1 = new EventEmitter();
  const res1 = fakeSseResponse();
  assert.equal(pool.add(req1, res1), true);
  assert.equal(pool.add(new EventEmitter(), fakeSseResponse()), false);
  req1.emit('close');
  assert.equal(pool.size, 0);
  const req2 = new EventEmitter();
  const res2 = fakeSseResponse();
  assert.equal(pool.add(req2, res2), true);
  res2.emit('close');
  assert.equal(pool.size, 0);
});

test('SSE 写背压会结束并移除慢客户端', () => {
  assert.equal(typeof SseClientPool, 'function');
  const logger = { warn() {} };
  const pool = new SseClientPool('test', 1, logger);
  const res = fakeSseResponse(false);
  pool.add(new EventEmitter(), res);
  pool.broadcast('data: {}\n\n');
  assert.equal(pool.size, 0);
  assert.equal(res.ended, true);
});

const root = new URL('..', import.meta.url);
const readProject = (file) => fs.readFileSync(new URL(file, root), 'utf8');

test('Chart.js 固定为本地生产依赖和唯一 vendor 路由', () => {
  const pkg = JSON.parse(readProject('package.json'));
  const html = readProject('public/index.html');
  const server = readProject('src/server.js');
  assert.equal(pkg.dependencies['chart.js'], '4.4.1');
  assert.match(html, /<script src="\/vendor\/chart\.js"><\/script>/);
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/);
  assert.match(server, /p === '\/vendor\/chart\.js'/);
  assert.match(server, /path\.join\(ROOT, 'node_modules', 'chart\.js', 'dist', 'chart\.umd\.js'\)/);
  assert.doesNotMatch(server, /startsWith\(['"]\/node_modules/);
});

test('Ethers 浏览器包固定为本地依赖和单一 vendor 路由', () => {
  const pkg = JSON.parse(readProject('package.json'));
  const server = readProject('src/server.js');
  assert.equal(pkg.dependencies.ethers, '6.13.5');
  assert.match(server, /p === '\/vendor\/ethers\.js'/);
  assert.match(server, /path\.join\(ROOT, 'node_modules', 'ethers', 'dist', 'ethers\.umd\.min\.js'\)/);
  assert.doesNotMatch(server, /startsWith\(['"]\/node_modules/);

  const context = { crypto: webcrypto, setTimeout, clearTimeout };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  vm.runInNewContext(readProject('node_modules/ethers/dist/ethers.umd.min.js'), context);
  assert.equal(typeof context.ethers?.Wallet?.createRandom, 'function');
});

test('服务端入口统一调用安全边界、严格请求体和有界 SSE', () => {
  const server = readProject('src/server.js');
  assert.match(server, /enforceRequestSecurity\(request, res, cfg\)/);
  assert.doesNotMatch(server, /function readBody\(/);
  assert.match(server, /readJsonBody\(request\)|readJsonBody\(req\)/);
  assert.match(server, /new SseClientPool\('de', cfg\.maxSseClients\)/);
  assert.doesNotMatch(server, /server\._overviewClients/);
});

test('页面所有 API fetch 都通过统一助手添加 POST 标记', () => {
  const html = readProject('public/index.html');
  assert.match(html, /function apiFetch\(input, init = \{\}\)/);
  assert.match(html, /headers\.set\('X-Dex-Request', '1'\)/);
  assert.equal([...html.matchAll(/\bfetch\((['"`])\/api\//g)].length, 0);
});

test('外部字符串不再插入 innerHTML', () => {
  const html = readProject('public/index.html');
  const unsafeFragments = [
    "P('market').innerHTML = markets.map",
    "P('smart-note').innerHTML =",
    "P('st-pos').innerHTML =",
    "P('orphan-info').innerHTML =",
    "P('fills').innerHTML =",
    "P('alerts').innerHTML = (s.alerts||[]).map",
    'box.innerHTML = `🔴 ${sym}',
    'box.innerHTML = `⚠️ ${sym}',
    '$(statusId).innerHTML = `<span class="up">✓ 已写入',
    '$(statusId).innerHTML = `<span class="down">✗ 写入失败：${e.message}',
    'el.innerHTML = `<span class="up">✓ 代理正常',
    'el.innerHTML = `<span class="down">✗ 代理无法联网：${j.error}',
    'el.innerHTML = `<span class="down">✗ 检测请求失败：${e.message}',
    'badge.innerHTML = `<span class="ai-badge ${lv}">',
    'gc.innerHTML = `<div class="gc-title">',
  ];
  for (const fragment of unsafeFragments) {
    assert.equal(html.includes(fragment), false, fragment);
  }
  assert.match(html, /option\.textContent = String\(market\.displayName/);
  assert.match(html, /item\.textContent = `\$\{new Date\(alert\.t\)/);
});

test('示例配置和 README 记录认证及 Tailscale 安全边界', () => {
  const envExample = readProject('.env.example');
  const readme = readProject('README.md');
  for (const key of ['HOST=127.0.0.1', 'DASHBOARD_TOKEN=', 'DASHBOARD_ORIGINS=', 'MAX_SSE_CLIENTS=10']) {
    assert.match(envExample, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(readme, /用户名.*admin/);
  assert.match(readme, /tailscale serve --bg 8080/);
  assert.match(readme, /DASHBOARD_ORIGINS=https:\/\//);
  assert.match(readme, /不要使用.*tailscale funnel/i);
  for (const script of ['一键启动.bat', '实盘启动.bat']) {
    assert.match(readProject(script), /DASHBOARD_TOKEN/);
  }
});

test('env writer uses and enforces owner-only mode on POSIX', () => {
  const calls = [];
  const fs = {
    existsSync: () => true,
    chmodSync: (...args) => calls.push(['chmod', ...args]),
    writeFileSync: (...args) => calls.push(['write', ...args]),
  };

  writeEnvFile('/app/.env', 'TOKEN=x\n', { fsImpl: fs, platform: 'linux' });

  assert.deepEqual(calls[0], ['chmod', '/app/.env', 0o600]);
  assert.equal(calls[1][3].mode, 0o600);
  assert.deepEqual(calls[2], ['chmod', '/app/.env', 0o600]);
});

test('startup rejects group-readable env file', () => {
  const fs = { existsSync: () => true, statSync: () => ({ mode: 0o100644 }) };
  assert.throws(
    () => assertEnvFileSecure('/app/.env', { fsImpl: fs, platform: 'linux' }),
    /chmod 600/,
  );
});

test('owner-only env file is accepted', () => {
  const fs = { existsSync: () => true, statSync: () => ({ mode: 0o100600 }) };
  assert.doesNotThrow(
    () => assertEnvFileSecure('/app/.env', { fsImpl: fs, platform: 'linux' }),
  );
});

test('config loading and dashboard writes both enforce the env permission boundary', () => {
  const configSource = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  const serverSource = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  assert.match(configSource, /assertEnvFileSecure\(file\)/);
  assert.match(serverSource, /writeEnvFile\(envFile, content\)/);
  assert.doesNotMatch(serverSource, /fs\.writeFileSync\(envFile/);
});
