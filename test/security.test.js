import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as security from '../src/security.js';
import { SseClientPool } from '../src/sse.js';

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

test('服务端入口统一调用安全边界、严格请求体和有界 SSE', () => {
  const server = readProject('src/server.js');
  assert.match(server, /enforceRequestSecurity\(request, res, cfg\)/);
  assert.doesNotMatch(server, /function readBody\(/);
  assert.match(server, /readJsonBody\(request\)|readJsonBody\(req\)/);
  assert.match(server, /new SseClientPool\('de', cfg\.maxSseClients\)/);
  assert.doesNotMatch(server, /server\._overviewClients/);
});
