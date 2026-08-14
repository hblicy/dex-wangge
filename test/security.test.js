import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as security from '../src/security.js';

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
