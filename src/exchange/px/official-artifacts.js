import { createHash } from 'node:crypto';
import {
  POPDEX_ACCOUNT_PRECOMPILE,
  POPDEX_ORDER_PRECOMPILE,
} from './constants.js';

const OFFICIAL_ORIGIN = 'https://app.popdex.xyz';
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 1200;

export const POPDEX_REQUIRED_PROTOCOL_TOKENS = Object.freeze([
  'approveAgent',
  'revokeAgent',
  'placeOrder',
  'cancelOrder',
  'getActiveOrdersByAccount',
  'getCompletedOrdersByAccount',
  'updateLeverage',
  'placeReverseOrder',
  'clientOrderId',
  POPDEX_ORDER_PRECOMPILE,
  POPDEX_ACCOUNT_PRECOMPILE,
]);

export const POPDEX_PROTOCOL_TOKENS = Object.freeze([
  ...POPDEX_REQUIRED_PROTOCOL_TOKENS,
  'replaceAgent',
  'getAgent',
  'AgentApproved',
  'eth_sendRawTransaction',
  'sendRawTransaction',
  'signTransaction',
  'writeContract',
  'readContract',
  'getTransactionReceipt',
]);

function sanitizedCause(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

async function fetchBytes(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: '*/*' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new Error(`PopDEX artifact ${url.pathname} 网络失败：${sanitizedCause(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`PopDEX artifact ${url.pathname} HTTP ${response.status}。`);
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARTIFACT_BYTES) {
      throw new Error(`PopDEX artifact ${url.pathname} Content-Length 无效或超过 20 MB。`);
    }
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`PopDEX artifact ${url.pathname} 实际大小超过 20 MB。`);
  }
  return body;
}

function scriptSources(html) {
  const sources = [];
  const pattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    if (match[2].length > 0) sources.push(match[2]);
  }
  return sources;
}

function boundedContext(content, offset, tokenLength) {
  const start = Math.max(0, offset - 550);
  const end = Math.min(content.length, offset + tokenLength + 550);
  return content.slice(start, end).slice(0, MAX_CONTEXT_CHARS);
}

export async function inspectOfficialArtifacts({
  appUrl = 'https://app.popdex.xyz/',
  fetchImpl = fetch,
  tokens = POPDEX_PROTOCOL_TOKENS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('PopDEX artifact fetchImpl 必须是函数。');
  }
  const root = new URL(appUrl);
  if (root.origin !== OFFICIAL_ORIGIN || root.protocol !== 'https:') {
    throw new Error(`PopDEX appUrl 必须是官方地址 ${OFFICIAL_ORIGIN}。`);
  }
  if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== 'string' || token.length === 0)) {
    throw new Error('PopDEX artifact tokens 必须是非空字符串数组。');
  }

  const fetchedAt = new Date().toISOString();
  const htmlBytes = await fetchBytes(fetchImpl, root);
  const html = new TextDecoder('utf-8', { fatal: true }).decode(htmlBytes);
  const resolved = [];
  const seen = new Set();
  for (const source of scriptSources(html)) {
    const scriptUrl = new URL(source, root);
    if (scriptUrl.origin !== OFFICIAL_ORIGIN || scriptUrl.protocol !== 'https:') {
      throw new Error(`PopDEX 官方 HTML 引用了非同源脚本：${scriptUrl.origin}`);
    }
    const path = `${scriptUrl.pathname}${scriptUrl.search}`;
    if (!seen.has(path)) {
      seen.add(path);
      resolved.push({ url: scriptUrl, path });
    }
  }
  if (resolved.length === 0) {
    throw new Error('PopDEX 官方 HTML 未发现 application chunks 脚本。');
  }

  const scripts = [];
  const matches = [];
  for (const entry of resolved) {
    const bytes = await fetchBytes(fetchImpl, entry.url);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    scripts.push({
      path: entry.path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    });
    for (const token of tokens) {
      let offset = content.indexOf(token);
      while (offset !== -1) {
        matches.push({
          path: entry.path,
          token,
          offset,
          context: boundedContext(content, offset, token.length),
        });
        offset = content.indexOf(token, offset + token.length);
      }
    }
  }

  return {
    fetchedAt,
    appUrl: root.href,
    scripts,
    matches,
  };
}
