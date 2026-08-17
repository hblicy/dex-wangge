import { decodeBytes32String } from 'ethers';
import { POPDEX_API_BASE, POPDEX_EXPECTED_MARKETS, POPDEX_WEB_BASE } from './constants.js';
import {
  normalizeFill,
  normalizeOrder,
  strictAddress,
  strictIntegerString,
} from './normalize.js';

const ACCOUNT_HEADERS = Object.freeze({
  Accept: 'application/json',
  website: 'mix',
  terminaltype: '1',
  language: 'en',
  locale: 'en',
  enterPointSource: 'web',
});

function sanitizedCause(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function targetSymbol(symbol) {
  if (typeof symbol !== 'string' || !(symbol in POPDEX_EXPECTED_MARKETS)) {
    throw new Error(`PopDEX symbol ${String(symbol)} 不在白名单。`);
  }
  return symbol;
}

function clientOidFromBytes32(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('PopDEX clientOrderId 必须是 bytes32 十六进制字符串。');
  }
  let decoded;
  try {
    decoded = decodeBytes32String(value);
  } catch (cause) {
    throw new Error(`PopDEX clientOrderId 不是规范 UTF-8 bytes32：${sanitizedCause(cause)}`, { cause });
  }
  if (!/^dw-[be][bs]-[0-9a-f]{24}$/.test(decoded)) {
    throw new Error(`PopDEX clientOrderId 标签格式无效：${decoded}。`);
  }
  return decoded;
}

function orderNotFound(clientOrderId) {
  const error = new Error(`PopDEX clientOrderId ${clientOrderId} 在 REST 订单中未找到。`);
  error.code = 'POPDEX_ORDER_NOT_FOUND';
  return error;
}

function listFrom(payload, keys, label) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') {
    throw new Error(`PopDEX ${label} 必须是数组或包含数组的对象。`);
  }
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) {
      if (!Array.isArray(payload[key])) {
        throw new Error(`PopDEX ${label}.${key} 必须是数组。`);
      }
      return payload[key];
    }
  }
  throw new Error(`PopDEX ${label} 缺少已验证的数组字段 ${keys.join('/')}。`);
}

function attachCursor(items, ...sources) {
  const cursors = sources.flatMap((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
    return [source.cursor, source.nextCursor]
      .filter((value) => value !== undefined && value !== null && value !== '');
  });
  const unique = [...new Set(cursors)];
  if (unique.length === 0) return items;
  if (unique.length !== 1) {
    throw new Error('PopDEX cursor 与 nextCursor 冲突。');
  }
  const exactCursor = strictIntegerString(unique[0], 'cursor');
  Object.defineProperty(items, 'cursor', {
    value: exactCursor,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return items;
}

export class PopdexAccountClient {
  constructor({
    apiBase = POPDEX_API_BASE,
    webBase = POPDEX_WEB_BASE,
    fetchImpl = fetch,
    timeoutMs = 10000,
  } = {}) {
    this.apiBase = new URL(apiBase);
    this.webBase = new URL(webBase);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    if (this.apiBase.protocol !== 'https:' || this.webBase.protocol !== 'https:') {
      throw new Error('PopDEX 账户端点必须使用 HTTPS。');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('PopDEX fetchImpl 必须是函数。');
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('PopDEX timeoutMs 必须是正安全整数。');
    }
  }

  async #request(base, pathname, searchParams = {}) {
    const url = new URL(pathname, base);
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: ACCOUNT_HEADERS,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `PopDEX GET ${url.pathname} 网络失败：${sanitizedCause(error)}`,
        { cause: error },
      );
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(
        `PopDEX GET ${url.pathname} HTTP ${response.status} 返回非 JSON：${sanitizedCause(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(
        `PopDEX GET ${url.pathname} HTTP ${response.status}：${sanitizedCause(body?.msg ?? '请求失败')}`,
      );
    }
    if (body?.code === '11100') {
      throw new Error(`PopDEX GET ${url.pathname} API 11100：${sanitizedCause(body.msg ?? 'Account does not exist')}`);
    }
    if (!body || typeof body !== 'object' || body.code !== '200') {
      throw new Error(
        `PopDEX GET ${url.pathname} HTTP ${response.status} API code=${String(body?.code)}：${sanitizedCause(body?.msg ?? '未知错误')}`,
      );
    }
    if (!Object.hasOwn(body, 'data')) {
      throw new Error(`PopDEX GET ${url.pathname} 成功响应缺少 data。`);
    }
    return body;
  }

  async #orders(account, symbol, cursor = null) {
    const wallet = strictAddress(account, 'account');
    const target = targetSymbol(symbol);
    if (cursor !== null) strictIntegerString(cursor, 'cursor');
    const envelope = await this.#request(
      this.apiBase,
      `/api/v1/account/${wallet}/orders`,
      { limit: 100, symbol: target, cursor },
    );
    const payload = envelope.data;
    const rows = listFrom(payload, ['data', 'list', 'rows', 'orders'], 'orders');
    return attachCursor(rows.map(normalizeOrder), envelope, payload);
  }

  async getOpenOrders(account, symbol) {
    return this.#orders(account, symbol);
  }

  async getOrderHistory(account, symbol, cursor = null) {
    return this.#orders(account, symbol, cursor);
  }

  async findUniqueOrderByClientId(account, symbol, clientOrderId, { maxPages = 10 } = {}) {
    const wallet = strictAddress(account, 'account');
    const target = targetSymbol(symbol);
    const clientOid = clientOidFromBytes32(clientOrderId);
    if (!Number.isSafeInteger(maxPages) || maxPages <= 0 || maxPages > 100) {
      throw new Error('PopDEX REST maxPages 必须是 1-100 的安全整数。');
    }
    let cursor = null;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const orders = await this.#orders(wallet, target, cursor);
      const matches = orders.filter((order) => order.clientOid === clientOid);
      if (matches.length > 1) {
        throw new Error(`PopDEX clientOid ${clientOid} 在 REST 订单中重复。`);
      }
      if (matches.length === 1) return matches[0];
      if (orders.cursor === undefined) throw orderNotFound(clientOrderId);
      cursor = orders.cursor;
    }
    throw new Error(`PopDEX REST 订单分页超过 maxPages=${maxPages}，拒绝继续。`);
  }

  async getFills(account, symbol, cursor = null) {
    const wallet = strictAddress(account, 'account');
    const target = targetSymbol(symbol);
    if (cursor !== null) strictIntegerString(cursor, 'cursor');
    const envelope = await this.#request(
      this.apiBase,
      `/api/v1/account/${wallet}/trade/fills`,
      { limit: 100, symbol: target, cursor },
    );
    const payload = envelope.data;
    const rows = listFrom(payload, ['data', 'list', 'rows', 'fills'], 'fills');
    return attachCursor(rows.map(normalizeFill), envelope, payload);
  }

  async getOverview(account) {
    const wallet = strictAddress(account, 'account');
    const envelope = await this.#request(
      this.webBase,
      `/web/v1/account/${wallet}/overview`,
    );
    const payload = envelope.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('PopDEX overview.data 必须是对象。');
    }
    return payload;
  }
}
