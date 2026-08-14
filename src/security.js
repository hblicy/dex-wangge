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
