# Dex Wangge Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复五个已确认的安全问题，使仪表盘具备应用内认证、POST 防跨站保护、安全文本渲染、本地 Chart.js 供应链和有界 SSE 资源使用。

**Architecture:** 在现有原生 Node.js HTTP 服务前增加一个统一安全边界，`src/security.js` 负责配置校验、Basic Auth、POST 校验和严格 JSON 解析，`src/sse.js` 负责 SSE 配额与背压。现有路由、三交易所对象和单文件前端保持原结构，仅在入口处接入安全边界，并用 DOM 文本 API 切断不可信字符串到 HTML 的路径。

**Tech Stack:** Node.js 20 ESM、原生 `node:http`、`node:test`、原生 DOM API、Chart.js 4.4.1、npm

---

## 文件结构

- Create: `src/security.js` — HTTP 安全配置、Basic Auth、POST/Origin 校验、严格 JSON 请求体解析。
- Create: `src/sse.js` — 每类 SSE 流的连接配额、清理和写背压处理。
- Create: `test/security.test.js` — 安全边界、SSE、静态集成、前端数据流和文档回归测试。
- Modify: `src/config.js` — 将强制安全配置并入启动配置。
- Modify: `src/server.js` — 全局接入认证/CSRF、严格请求体、SSE 池和固定 vendor 路由。
- Modify: `public/index.html` — 本地 Chart.js、统一 POST 请求头和安全 DOM 渲染。
- Modify: `package.json` — 固定 Chart.js 版本并运行安全测试。
- Modify: `package-lock.json` — 锁定 Chart.js 及其传递依赖。
- Modify: `.env.example` — 增加认证、Origin 和 SSE 配额配置。
- Modify: `README.md` — 增加 Windows、SSH 隧道和 Tailscale Serve 安全部署说明。

### Task 1: Basic Auth 与启动配置

**Files:**
- Create: `src/security.js`
- Create: `test/security.test.js`
- Modify: `src/config.js`
- Modify: `package.json`

- [ ] **Step 1: 写 Basic Auth 和配置校验失败测试**

先创建 `test/security.test.js`。首次测试通过容错动态导入把“模块尚不存在”变成明确断言失败，而不是加载错误：

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

let security = {};
try {
  security = await import('../src/security.js');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

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
```

- [ ] **Step 2: 运行测试并确认因安全函数不存在而失败**

Run: `node --test test/security.test.js`

Expected: FAIL；首个失败为 `actual: 'undefined'`、`expected: 'function'`，不是语法错误或测试加载错误。

- [ ] **Step 3: 实现最小认证与安全配置模块**

创建 `src/security.js`：

```js
import { timingSafeEqual } from 'node:crypto';

export class HttpRequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpRequestError';
    this.statusCode = statusCode;
  }
}

function normalizeConfiguredOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`DASHBOARD_ORIGINS 包含无效地址: ${value}`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`DASHBOARD_ORIGINS 只能包含 HTTP/HTTPS Origin: ${value}`);
  }
  return parsed.origin;
}

export function getSecurityConfig(env = process.env) {
  const dashboardToken = String(env.DASHBOARD_TOKEN || '');
  if (dashboardToken.length < 16 || /[\x00-\x1f\x7f]/.test(dashboardToken)) {
    throw new Error('[启动失败] DASHBOARD_TOKEN 必填且至少 16 个字符，不能包含控制字符。');
  }

  const dashboardOrigins = String(env.DASHBOARD_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeConfiguredOrigin);

  const maxRaw = String(env.MAX_SSE_CLIENTS || '10');
  if (!/^[1-9]\d*$/.test(maxRaw) || Number(maxRaw) > 100) {
    throw new Error('[启动失败] MAX_SSE_CLIENTS 必须是 1-100 的整数。');
  }

  return {
    dashboardToken,
    dashboardOrigins: [...new Set(dashboardOrigins)],
    maxSseClients: Number(maxRaw),
  };
}

export function isAuthorized(header, dashboardToken) {
  if (typeof header !== 'string') return false;
  const match = header.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return false;

  const expected = Buffer.from(`admin:${dashboardToken}`, 'utf8');
  const decoded = Buffer.from(match[1], 'base64');
  const sameLength = decoded.length === expected.length;
  const candidate = sameLength ? decoded : Buffer.alloc(expected.length);
  return timingSafeEqual(candidate, expected) && sameLength;
}

function sendJsonError(res, statusCode, message, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify({ error: message }));
}

export function enforceRequestSecurity(req, res, config) {
  if (!isAuthorized(req.headers?.authorization, config.dashboardToken)) {
    sendJsonError(res, 401, 'authentication required', {
      'WWW-Authenticate': 'Basic realm="dex-wangge"',
    });
    return false;
  }
  return true;
}
```

- [ ] **Step 4: 将安全配置并入 `src/config.js`**

在导入区增加：

```js
import { getSecurityConfig } from './security.js';
```

在 `getConfig()` 完成 `loadEnv()` 后计算：

```js
const security = getSecurityConfig(process.env);
```

在返回对象中加入：

```js
...security,
```

- [ ] **Step 5: 接入测试脚本并改为直接导入**

将 `test/security.test.js` 的容错动态导入替换为：

```js
import * as security from '../src/security.js';
```

将 `package.json` 脚本改为：

```json
"test": "node test/grid.test.js && node --test test/security.test.js"
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test test/security.test.js`

Expected: PASS，4 tests passed。

- [ ] **Step 7: 提交认证与配置**

```bash
git add src/security.js src/config.js test/security.test.js package.json
git commit -m "安全：增加仪表盘认证与启动校验"
```

### Task 2: CSRF 防护与严格 JSON 请求体

**Files:**
- Modify: `src/security.js`
- Modify: `test/security.test.js`

- [ ] **Step 1: 写 POST、Origin、非法 JSON 和超限正文失败测试**

在 `test/security.test.js` 追加：

```js
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
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
      ...(marker === undefined ? {} : { 'x-dex-request': marker }),
      ...(origin === undefined ? {} : { origin }),
    },
  };
}

test('POST 要求 JSON Content-Type 和 X-Dex-Request', () => {
  const config = { dashboardToken: '0123456789abcdef', dashboardOrigins: [] };
  for (const [req, status] of [
    [request({ contentType: 'application/x-www-form-urlencoded' }), 415],
    [request({ marker: undefined }), 403],
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
```

- [ ] **Step 2: 运行测试并确认防护缺失**

Run: `node --test test/security.test.js`

Expected: FAIL；POST 测试实际得到 `true`，请求体测试报告 `security.readJsonBody is not a function`。

- [ ] **Step 3: 在 `src/security.js` 实现 POST 校验**

在 `sendJsonError` 之前增加：

```js
function requestHeader(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestOrigin(req) {
  const value = requestHeader(req, 'origin');
  if (value === undefined) return null;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function hostOrigin(req) {
  const host = requestHeader(req, 'host');
  if (!host) return null;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function validateMutationRequest(req, dashboardOrigins) {
  if (req.method !== 'POST') return;

  const contentType = String(requestHeader(req, 'content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpRequestError(415, 'POST requests require application/json');
  }
  if (requestHeader(req, 'x-dex-request') !== '1') {
    throw new HttpRequestError(403, 'missing X-Dex-Request header');
  }

  const rawOrigin = requestHeader(req, 'origin');
  if (rawOrigin !== undefined) {
    const origin = requestOrigin(req);
    const allowed = new Set(dashboardOrigins);
    const local = hostOrigin(req);
    if (local) allowed.add(local);
    if (!origin || !allowed.has(origin)) {
      throw new HttpRequestError(403, 'request Origin is not allowed');
    }
  }
}
```

把 `enforceRequestSecurity` 的认证成功分支改为：

```js
try {
  validateMutationRequest(req, config.dashboardOrigins);
  return true;
} catch (error) {
  if (!(error instanceof HttpRequestError)) throw error;
  sendJsonError(res, error.statusCode, error.message);
  return false;
}
```

- [ ] **Step 4: 实现严格 JSON 解析**

在 `src/security.js` 追加：

```js
export function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        settled = true;
        reject(new HttpRequestError(413, 'request body too large'));
        return;
      }
      chunks.push(buffer);
    });

    req.once('end', () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpRequestError(400, 'invalid JSON body'));
      }
    });

    req.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/security.test.js`

Expected: PASS，8 tests passed。

- [ ] **Step 6: 提交 CSRF 和请求体边界**

```bash
git add src/security.js test/security.test.js
git commit -m "安全：拒绝跨站与畸形控制请求"
```

### Task 3: 有界 SSE 客户端池

**Files:**
- Create: `src/sse.js`
- Modify: `test/security.test.js`

- [ ] **Step 1: 写配额释放和背压失败测试**

在 `test/security.test.js` 增加导入：

```js
import { SseClientPool } from '../src/sse.js';
```

为避免模块不存在导致加载错误，实际 RED 顺序先改为条件动态导入：

```js
let SseClientPool;
try {
  ({ SseClientPool } = await import('../src/sse.js'));
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
```

并追加：

```js
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
  assert.equal(pool.add(new EventEmitter(), fakeSseResponse()), true);
});

test('SSE 写背压会结束并移除慢客户端', () => {
  const logger = { warn() {} };
  const pool = new SseClientPool('test', 1, logger);
  const res = fakeSseResponse(false);
  pool.add(new EventEmitter(), res);
  pool.broadcast('data: {}\n\n');
  assert.equal(pool.size, 0);
  assert.equal(res.ended, true);
});
```

- [ ] **Step 2: 运行测试确认因 SSE 类不存在而失败**

Run: `node --test test/security.test.js`

Expected: FAIL；断言 `typeof SseClientPool` 实际为 `undefined`。

- [ ] **Step 3: 实现 `src/sse.js`**

```js
export class SseClientPool {
  #clients = new Set();

  constructor(name, maxClients, logger = console) {
    if (!name || !Number.isInteger(maxClients) || maxClients < 1) {
      throw new Error('SseClientPool requires a name and positive integer limit');
    }
    this.name = name;
    this.maxClients = maxClients;
    this.logger = logger;
  }

  get size() {
    return this.#clients.size;
  }

  add(req, res) {
    if (this.#clients.size >= this.maxClients) {
      this.logger.warn(`[SSE] ${this.name} connection rejected: limit ${this.maxClients}`);
      return false;
    }
    this.#clients.add(res);
    req.once('close', () => this.#clients.delete(res));
    res.once('error', (error) => this.#drop(res, `response error: ${error?.message || error}`));
    return true;
  }

  write(res, data) {
    if (!this.#clients.has(res)) return false;
    try {
      if (res.write(data)) return true;
      this.#drop(res, 'slow client backpressure');
      return false;
    } catch (error) {
      this.#drop(res, `write error: ${error?.message || error}`);
      return false;
    }
  }

  broadcast(data) {
    for (const res of [...this.#clients]) this.write(res, data);
  }

  #drop(res, reason) {
    if (!this.#clients.delete(res)) return;
    this.logger.warn(`[SSE] ${this.name} client dropped: ${reason}`);
    try { res.end(); } catch (error) {
      this.logger.warn(`[SSE] ${this.name} client close failed: ${error?.message || error}`);
    }
  }
}
```

- [ ] **Step 4: 改为直接导入并确认测试通过**

把条件动态导入替换为：

```js
import { SseClientPool } from '../src/sse.js';
```

Run: `node --test test/security.test.js`

Expected: PASS，10 tests passed。

- [ ] **Step 5: 提交 SSE 资源边界**

```bash
git add src/sse.js test/security.test.js
git commit -m "安全：限制SSE连接与慢客户端缓冲"
```

### Task 4: 服务端集成与本地 Chart.js

**Files:**
- Modify: `src/server.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/security.test.js`

- [ ] **Step 1: 写服务端集成和供应链失败测试**

在 `test/security.test.js` 追加：

```js
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
```

- [ ] **Step 2: 运行测试并确认旧 CDN 和旧服务端边界导致失败**

Run: `node --test test/security.test.js`

Expected: FAIL；Chart.js 依赖为 `undefined`，HTML 仍包含 cdnjs，服务端仍有本地 `readBody` 和无界 `Set`。

- [ ] **Step 3: 安装固定 Chart.js 版本**

Run: `npm install --save-exact chart.js@4.4.1`

Expected: `package.json` 出现 `"chart.js": "4.4.1"`，`package-lock.json` 锁定相同版本且安装成功。

- [ ] **Step 4: 在 `src/server.js` 接入安全模块和 SSE 池**

增加导入：

```js
import { enforceRequestSecurity, HttpRequestError, readJsonBody } from './security.js';
import { SseClientPool } from './sse.js';
```

将四个无界集合替换为：

```js
const deClients = new SseClientPool('de', cfg.maxSseClients);
const exClients = new SseClientPool('ex', cfg.maxSseClients);
const rsClients = new SseClientPool('rs', cfg.maxSseClients);
const overviewClients = new SseClientPool('overview', cfg.maxSseClients);
```

删除本地 `readBody`，增加状态选择函数：

```js
function errorStatus(error, fallback) {
  return error instanceof HttpRequestError ? error.statusCode : fallback;
}
```

将调用正文解析的地方全部从 `readBody(...)` 改成 `readJsonBody(...)`。交易所控制路由的 catch 使用：

```js
catch (error) {
  return send(res, errorStatus(error, 400), { error: error?.message || String(error) });
}
```

AI 和 `/api/env` 的 catch 保留原业务默认状态，但允许请求体错误透传：

```js
catch (error) {
  return send(res, errorStatus(error, 500), { error: error?.message || String(error) });
}
```

在 HTTP 回调的第一行路由逻辑前加入：

```js
if (!enforceRequestSecurity(request, res, cfg)) return;
```

交易所 SSE 路由替换为：

```js
if (subPath === '/stream') {
  if (!clients.add(req, res)) {
    return send(res, 503, { error: 'SSE connection limit reached' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  clients.write(res, `data: ${JSON.stringify(bot.getState())}\n\n`);
  return;
}
```

总览 SSE 使用相同的“先 `add`、后 SSE headers、再 `write`”顺序。删除 `server._overviewClients`，定时器里的四段手工循环分别替换为：

```js
deClients.broadcast(`data: ${stringify(deBot.getState())}\n\n`);
exClients.broadcast(`data: ${stringify(exBot.getState())}\n\n`);
rsClients.broadcast(`data: ${stringify(rsBot.getState())}\n\n`);
overviewClients.broadcast(`data: ${stringify(overview)}\n\n`);
```

- [ ] **Step 5: 增加唯一 Chart.js 路由并替换 HTML 引用**

在服务端常量区增加：

```js
const CHART_JS_FILE = path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
```

在静态目录路由之前增加唯一映射：

```js
if (p === '/vendor/chart.js') {
  if (!fs.existsSync(CHART_JS_FILE)) {
    return send(res, 500, { error: 'Chart.js is not installed; run npm install' });
  }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  return fs.createReadStream(CHART_JS_FILE).pipe(res);
}
```

将 `public/index.html` 头部 CDN 标签替换为：

```html
<script src="/vendor/chart.js"></script>
```

- [ ] **Step 6: 运行安全测试与语法检查**

Run: `node --test test/security.test.js`

Expected: PASS，12 tests passed。

Run: `node --check src/security.js && node --check src/sse.js && node --check src/server.js`

Expected: 三条命令退出码均为 0，无输出。

- [ ] **Step 7: 提交服务端集成与依赖**

```bash
git add src/server.js public/index.html package.json package-lock.json test/security.test.js
git commit -m "安全：统一保护HTTP入口并本地化Chart.js"
```

### Task 5: 前端 POST 标记与不可信文本安全渲染

**Files:**
- Modify: `public/index.html`
- Modify: `test/security.test.js`

- [ ] **Step 1: 写前端请求和 XSS 数据流失败测试**

在 `test/security.test.js` 追加：

```js
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
    "P('alerts').innerHTML = (s.alerts||[]).map",
    'box.innerHTML = `🔴 ${sym}',
    'box.innerHTML = `⚠️ ${sym}',
    '$(statusId).innerHTML = `<span class="up">✓ 已写入',
    '$(statusId).innerHTML = `<span class="down">✗ 写入失败：${e.message}',
    'el.innerHTML = `<span class="up">✓ 代理正常',
    'el.innerHTML = `<span class="down">✗ 代理无法联网：${j.error}',
    'el.innerHTML = `<span class="down">✗ 检测请求失败：${e.message}',
    'badge.innerHTML = `<span class="ai-badge ${lv}">',
  ];
  for (const fragment of unsafeFragments) {
    assert.equal(html.includes(fragment), false, fragment);
  }
  assert.match(html, /option\.textContent = String\(market\.displayName/);
  assert.match(html, /item\.textContent = `\$\{new Date\(alert\.t\)/);
});
```

- [ ] **Step 2: 运行测试并确认旧直接 fetch/innerHTML 路径导致失败**

Run: `node --test test/security.test.js`

Expected: FAIL；找不到 `apiFetch`，并报告首个旧不安全片段仍存在。

- [ ] **Step 3: 增加统一 API 请求和文本状态助手**

在页面工具函数区增加：

```js
function apiFetch(input, init = {}) {
  const options = { ...init };
  if (String(options.method || 'GET').toUpperCase() === 'POST') {
    const headers = new Headers(options.headers || {});
    headers.set('X-Dex-Request', '1');
    options.headers = headers;
  }
  return fetch(input, options);
}

function setStatusText(element, className, message) {
  element.replaceChildren();
  const span = document.createElement('span');
  span.className = className;
  span.textContent = message;
  element.appendChild(span);
}
```

将页面中所有现有 API `fetch(...)` 调用改为 `apiFetch(...)`；`apiFetch` 内部保留唯一原生 `fetch(input, options)`。这样所有现有 POST 自动携带 `X-Dex-Request: 1`，GET 行为不变。

- [ ] **Step 4: 用 DOM API 渲染市场和告警**

市场下拉替换为：

```js
P('market').replaceChildren();
for (const market of markets) {
  const option = document.createElement('option');
  option.value = String(market.marketId);
  option.textContent = String(market.displayName || market.name || market.marketId);
  P('market').appendChild(option);
}
```

告警列表替换为：

```js
const alerts = s.alerts || [];
P('alerts').replaceChildren();
if (alerts.length === 0) {
  const empty = document.createElement('div');
  empty.className = 'log-item muted';
  empty.textContent = '暂无日志';
  P('alerts').appendChild(empty);
} else {
  for (const alert of alerts) {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.textContent = `${new Date(alert.t).toLocaleTimeString()} · ${String(alert.message || '')}`;
    P('alerts').appendChild(item);
  }
}
```

- [ ] **Step 5: 移除市场名、代理响应和 AI 等级的 HTML 插值**

趋势提醒三条分支只设置固定 class 和文本：

```js
if (reversed) {
  box.className = 'trend-box trend-alert';
  box.textContent = `🔴 ${sym} 趋势反转为${tl}（强度${pct}%），当前为${MODE_LABEL[mode]}网格，风险较高，建议尽快复核`;
} else if (mode === 'neutral') {
  box.className = 'trend-box trend-watch';
  box.textContent = `⚠️ ${sym} 出现${tl}趋势（强度${pct}%），中性网格或将单边突破区间`;
} else {
  box.className = 'trend-box trend-watch';
  box.textContent = `⚠️ ${sym} 趋势转为${tl}（强度${pct}%），与${MODE_LABEL[mode]}网格不一致`;
}
```

代理相关状态全部使用 `setStatusText`：

```js
setStatusText($(statusId), 'up', `✓ 已写入 .env（${fieldMap[target]}=${value || '（已清空）'}）。重启服务器后生效。`);
setStatusText($(statusId), 'down', `✗ 写入失败：${e.message}`);
setStatusText(el, 'muted', '检测中...');
setStatusText(el, 'up', `✓ 代理正常，当前出口 IP：${j.ip}`);
setStatusText(el, 'down', `✗ 代理无法联网：${j.error}。请检查代理地址是否正确。`);
setStatusText(el, 'down', `✗ 检测请求失败：${e.message}`);
```

AI 等级渲染替换为固定映射和 DOM：

```js
const levelMap = {
  ok: { className: 'ok', text: '正常' },
  warn: { className: 'warn', text: '注意' },
  critical: { className: 'critical', text: '严重' },
};
const level = levelMap[s.sentinel.level] || { className: 'unknown', text: '未知' };
const levelBadge = document.createElement('span');
levelBadge.className = `ai-badge ${level.className}`;
levelBadge.textContent = level.text;
badge.replaceChildren(levelBadge);
```

- [ ] **Step 6: 审计剩余 `innerHTML` 并运行测试**

Run: `rg -n "innerHTML" public/index.html`

Expected: 剩余用法只拼接固定模板、枚举 class 或经过 `Number`/格式化函数的数值；输出中没有市场名、告警消息、代理响应、异常消息、AI 原始等级或用户输入。

Run: `node --test test/security.test.js`

Expected: PASS，14 tests passed。

- [ ] **Step 7: 提交前端边界**

```bash
git add public/index.html test/security.test.js
git commit -m "安全：阻断前端不可信HTML注入"
```

### Task 6: 安全部署配置与文档

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `test/security.test.js`

- [ ] **Step 1: 写部署文档配置回归测试**

在 `test/security.test.js` 追加：

```js
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
});
```

- [ ] **Step 2: 运行测试并确认文档缺失**

Run: `node --test test/security.test.js`

Expected: FAIL；`.env.example` 缺少至少 `DASHBOARD_TOKEN=`，README 缺少 Tailscale 配置。

- [ ] **Step 3: 更新 `.env.example`**

在 `PORT=8080` 附近加入：

```dotenv
# 只监听本机；VPS 通过 SSH 隧道或 Tailscale Serve 访问
HOST=127.0.0.1

# 仪表盘 HTTP Basic Auth：用户名固定 admin；令牌至少 16 字符
# Linux 生成：openssl rand -hex 32
DASHBOARD_TOKEN=

# 允许的反向代理 HTTPS Origin，多个值用英文逗号分隔
# Tailscale 示例：https://your-vps.your-tailnet.ts.net
DASHBOARD_ORIGINS=

# 每个交易所流及总览流允许的最大 SSE 连接数（1-100）
MAX_SSE_CLIENTS=10
```

- [ ] **Step 4: 更新 README 的首次启动和 VPS 部署说明**

README 必须给出以下可复制命令和约束：

```powershell
$tokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tokenBytes)
-join ($tokenBytes | ForEach-Object { $_.ToString('x2') })
```

将生成值只写入本机 `.env` 的 `DASHBOARD_TOKEN`，浏览器登录用户名固定 `admin`；令牌不得提交到 Git。

Linux VPS 配置示例：

```dotenv
HOST=127.0.0.1
PORT=8080
DASHBOARD_TOKEN=<使用 openssl rand -hex 32 生成并只保存在 VPS>
MAX_SSE_CLIENTS=10
DASHBOARD_ORIGINS=https://your-vps.your-tailnet.ts.net
```

Tailscale Serve 命令：

```bash
sudo tailscale up
sudo tailscale serve --bg 8080
tailscale serve status
```

写明访问 `https://your-vps.your-tailnet.ts.net`，Tailscale ACL/Grants 是外层控制，应用 Basic Auth 仍然启用；不要使用 `tailscale funnel`，不要在云安全组或 VPS 防火墙公开 8080。

同时保留 SSH 隧道方案：

```bash
ssh -L 8080:127.0.0.1:8080 user@vps
```

- [ ] **Step 5: 运行文档回归测试和完整测试**

Run: `npm test`

Expected: 现有 16 项网格测试通过，安全测试 15 tests passed，命令退出码为 0。

- [ ] **Step 6: 提交部署文档**

```bash
git add .env.example README.md test/security.test.js
git commit -m "文档：补充认证与Tailscale安全部署"
```

### Task 7: 五项修复的最终验证

**Files:**
- Verify only: all changed files

- [ ] **Step 1: 运行完整测试和语法检查**

Run: `npm test`

Expected: 现有 16 项测试和新增 15 项安全测试全部通过，退出码 0。

Run: `node --check src/config.js && node --check src/security.js && node --check src/sse.js && node --check src/server.js`

Expected: 无输出，退出码 0。

- [ ] **Step 2: 验证锁文件与离线依赖审计**

Run: `npm ls chart.js --depth=0`

Expected: 输出 `chart.js@4.4.1`，退出码 0。

Run: `npm audit --offline --omit=dev`

Expected: 输出 `found 0 vulnerabilities`，退出码 0。

- [ ] **Step 3: 验证敏感数据流和配置未被提交**

Run: `rg -n "cdnjs|cdn.jsdelivr|P\('alerts'\)\.innerHTML|P\('market'\)\.innerHTML|badge\.innerHTML.*ai-badge|server\._overviewClients|function readBody" public/index.html src/server.js`

Expected: 无匹配，退出码 1 表示未找到旧不安全路径。

Run: `git status --short --ignored`

Expected: `.env` 若存在只显示为 ignored，不出现在 staged/untracked 列表；只包含本计划涉及的预期修改。

- [ ] **Step 4: 检查差异质量**

Run: `git diff --check 3fa2d27..HEAD`

Expected: 无尾随空格或冲突标记，退出码 0。

Run: `git log -6 --oneline`

Expected: 依次看到设计、实施计划和六个中文实现提交，每个提交职责单一。

- [ ] **Step 5: 手工边界验收（使用非实盘测试配置）**

用临时、非敏感令牌启动服务，验证以下 HTTP 语义；不得输出真实 `.env` 或交易密钥：

```text
无 Authorization 的 GET /                 -> 401 + WWW-Authenticate
错误 Basic Auth 的 GET /api/overview       -> 401
正确 Basic Auth 的 GET /                   -> 200
缺 X-Dex-Request 的 POST /api/de/stop       -> 403，机器人处理器未执行
表单 Content-Type 的 POST /api/de/stop      -> 415，机器人处理器未执行
非法 JSON 的 POST /api/de/stop              -> 400，机器人处理器未执行
超限 JSON 的 POST /api/de/stop              -> 413，机器人处理器未执行
超过 MAX_SSE_CLIENTS 的新连接               -> 503，且未先发送 SSE headers
GET /vendor/chart.js                        -> 200 JavaScript
GET /node_modules/chart.js/dist/chart.umd.js -> 404
```

若本地服务启动会连接真实交易所，则只使用 `DE_MODE=paper`、`EX_MODE=paper`、`RS_MODE=paper`，且不要执行交易控制 POST；自动化测试已覆盖 POST 在处理器之前被拒绝的条件。

## 自检结果

- Spec coverage：Task 1 覆盖认证，Task 2 覆盖 CSRF/请求体，Task 3 覆盖 SSE，Task 4 覆盖统一服务端边界和 Chart.js，Task 5 覆盖 XSS，Task 6 覆盖 SSH/Tailscale/Windows 文档，Task 7 覆盖五项验收。
- Placeholder scan：计划未保留未定义实现步骤；所有新增函数、类、配置字段和命令均给出具体名称与代码。
- Type consistency：统一使用 `dashboardToken`、`dashboardOrigins`、`maxSseClients`、`enforceRequestSecurity`、`readJsonBody`、`SseClientPool.add/write/broadcast/size`，服务端和测试名称一致。
