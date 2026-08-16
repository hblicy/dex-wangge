import { POPDEX_API_BASE } from './constants.js';
import { normalizeMarket, strictDecimalString, strictIntegerString } from './normalize.js';

const TARGET_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT']);

function sanitizedCause(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function positiveNumber(value, field) {
  const parsed = Number(strictDecimalString(value, field));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`PopDEX ${field} 必须是正有限数。`);
  }
  return parsed;
}

function targetSymbol(symbol) {
  if (typeof symbol !== 'string' || !TARGET_SYMBOLS.includes(symbol)) {
    throw new Error(`PopDEX symbol ${String(symbol)} 不在白名单。`);
  }
  return symbol;
}

export class PopdexPublicClient {
  constructor({ apiBase = POPDEX_API_BASE, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    this.apiBase = new URL(apiBase);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    if (this.apiBase.protocol !== 'https:') {
      throw new Error('PopDEX apiBase 必须使用 HTTPS。');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('PopDEX fetchImpl 必须是函数。');
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('PopDEX timeoutMs 必须是正安全整数。');
    }
  }

  async #requestArray(pathname, searchParams) {
    const url = new URL(pathname, this.apiBase);
    url.search = new URLSearchParams(searchParams).toString();
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
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
    if (!body || typeof body !== 'object' || body.code !== '200') {
      throw new Error(
        `PopDEX GET ${url.pathname} HTTP ${response.status} API code=${String(body?.code)}：${sanitizedCause(body?.msg ?? '未知错误')}`,
      );
    }
    if (!Array.isArray(body.data)) {
      throw new Error(`PopDEX GET ${url.pathname} HTTP ${response.status} data 必须是数组。`);
    }
    return body.data;
  }

  async getMarkets() {
    const rows = await this.#requestArray('/api/v1/config/symbols', { category: 'Futures' });
    return TARGET_SYMBOLS.map((symbol) => {
      const matches = rows.filter((row) => row?.symbol === symbol);
      if (matches.length !== 1) {
        throw new Error(`PopDEX ${symbol} 主网市场数量必须为 1，实际 ${matches.length}。`);
      }
      return normalizeMarket(matches[0]);
    });
  }

  async getTicker(symbol) {
    const target = targetSymbol(symbol);
    const rows = await this.#requestArray('/api/v1/public/market/tickers', {
      category: 'Futures',
      symbol: target,
    });
    const matches = rows.filter((row) => row?.symbol === target);
    if (matches.length !== 1) {
      throw new Error(`PopDEX ${target} ticker 数量必须为 1，实际 ${matches.length}。`);
    }
    const row = matches[0];
    return {
      bid: positiveNumber(row.bid1Price, `${target} bid1Price`),
      ask: positiveNumber(row.ask1Price, `${target} ask1Price`),
      last: positiveNumber(row.lastPrice, `${target} lastPrice`),
      index: positiveNumber(row.indexPrice, `${target} indexPrice`),
      mark: positiveNumber(row.markPrice, `${target} markPrice`),
    };
  }

  async getCandles(symbol, interval = '1H', limit = 200) {
    const target = targetSymbol(symbol);
    if (typeof interval !== 'string' || !/^(?:1m|5m|15m|30m|1H|4H|1D)$/.test(interval)) {
      throw new Error(`PopDEX candle interval ${String(interval)} 不受支持。`);
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new Error('PopDEX candle limit 必须是 1-1000 的安全整数。');
    }
    const rows = await this.#requestArray('/api/v1/public/market/candles', {
      category: 'Futures',
      symbol: target,
      interval,
      type: 'Market',
      limit: String(limit),
    });
    return rows.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`PopDEX ${target} candle[${index}] 必须是对象。`);
      }
      const time = strictIntegerString(row.time, `${target} candle[${index}].time`);
      const open = positiveNumber(row.open, `${target} candle[${index}].open`);
      const high = positiveNumber(row.high, `${target} candle[${index}].high`);
      const low = positiveNumber(row.low, `${target} candle[${index}].low`);
      const close = positiveNumber(row.close, `${target} candle[${index}].close`);
      if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
        throw new Error(`PopDEX ${target} candle[${index}] OHLC 关系无效。`);
      }
      return { time, open, high, low, close };
    });
  }
}
