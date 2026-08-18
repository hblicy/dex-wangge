import { EventEmitter } from 'node:events';
import { formatUnits, parseUnits } from 'ethers';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import { strictDecimalString, strictIntegerString } from './normalize.js';

const MARKET_IDS = Object.freeze({ BTCUSDT: 20000, ETHUSDT: 20001 });
const SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT']);
const INTERVALS = new Map([
  [60, '1m'], [300, '5m'], [900, '15m'], [1800, '30m'],
  [3600, '1H'], [14400, '4H'], [86400, '1D'],
]);

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`PopDEX Paper ${field} 必须是正安全整数。`);
  }
  return value;
}

function exactNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('PopDEX Paper now() 必须返回非负安全整数。');
  }
  return value;
}

function decimalWad(value, field) {
  const normalized = strictDecimalString(String(value), `Paper ${field}`);
  if ((normalized.split('.')[1] ?? '').length > 18) {
    throw new Error(`PopDEX Paper ${field} 最多支持 18 位小数。`);
  }
  return parseUnits(normalized, 18);
}

function exactMarket(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PopDEX Paper market[${index}] 必须是对象。`);
  }
  const symbol = value.name;
  const expected = POPDEX_EXPECTED_MARKETS[symbol];
  if (!expected || value.displayName !== symbol || value.symbol !== symbol.slice(0, -4)
      || value.marketId !== Number(expected.symbolId)
      || value.stepPrice !== Number(expected.tickSize)
      || value.stepSize !== Number(expected.lotSize)
      || value.minOrderSize !== Number(expected.minQty)
      || value.minNotional !== Number(expected.minNotional)) {
    throw new Error(`PopDEX Paper market[${index}] 与官方市场身份不符。`);
  }
  return { ...value };
}

function exactMarkets(values) {
  if (!Array.isArray(values) || values.length !== 2) {
    throw new Error('PopDEX Paper 官方市场必须恰好包含 BTCUSDT 和 ETHUSDT。');
  }
  const result = values.map(exactMarket).sort((left, right) => left.marketId - right.marketId);
  if (!SYMBOLS.every((symbol) => result.some((market) => market.name === symbol))
      || new Set(result.map((market) => market.marketId)).size !== 2) {
    throw new Error('PopDEX Paper 官方市场重复或缺失。');
  }
  return result;
}

function exactTicker(value, symbol) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PopDEX Paper ${symbol} ticker 必须是对象。`);
  }
  const result = {};
  for (const field of ['bid', 'ask', 'last', 'index', 'mark']) {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] <= 0) {
      throw new Error(`PopDEX Paper ${symbol} ticker.${field} 必须是正有限数。`);
    }
    result[field] = value[field];
  }
  if (result.bid >= result.ask) throw new Error(`PopDEX Paper ${symbol} ticker 必须满足 bid < ask。`);
  return result;
}

function exactOrderInput(input, market) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('PopDEX Paper 订单必须是对象。');
  }
  if (input.side !== 'buy' && input.side !== 'sell') {
    throw new Error('PopDEX Paper side 必须是 buy 或 sell。');
  }
  if (input.reduceOnly !== undefined && typeof input.reduceOnly !== 'boolean') {
    throw new Error('PopDEX Paper reduceOnly 必须是布尔值。');
  }
  const priceWad = decimalWad(input.price, 'order.price');
  const qtyWad = decimalWad(input.sizeBase, 'order.sizeBase');
  const tickWad = decimalWad(market.stepPrice, `${market.name} tickSize`);
  const lotWad = decimalWad(market.stepSize, `${market.name} lotSize`);
  const minQtyWad = decimalWad(market.minOrderSize, `${market.name} minQty`);
  const minNotionalWad = decimalWad(market.minNotional, `${market.name} minNotional`);
  if (priceWad <= 0n || priceWad % tickWad !== 0n) {
    throw new Error(`PopDEX Paper ${market.name} price 未对齐 tickSize ${market.stepPrice}。`);
  }
  if (qtyWad < minQtyWad) {
    throw new Error(`PopDEX Paper ${market.name} qty 低于 minQty ${market.minOrderSize}。`);
  }
  if (qtyWad % lotWad !== 0n) {
    throw new Error(`PopDEX Paper ${market.name} qty 未对齐 lotSize ${market.stepSize}。`);
  }
  if ((priceWad * qtyWad) / (10n ** 18n) < minNotionalWad) {
    throw new Error(`PopDEX Paper ${market.name} 名义金额低于 minNotional ${market.minNotional}。`);
  }
  if (input.levelIndex !== undefined
      && (!Number.isSafeInteger(input.levelIndex) || input.levelIndex < 0)) {
    throw new Error('PopDEX Paper levelIndex 必须是非负安全整数。');
  }
  if (input.clientOrderId !== undefined
      && (typeof input.clientOrderId !== 'string' || input.clientOrderId.length === 0)) {
    throw new Error('PopDEX Paper clientOrderId 必须是非空字符串。');
  }
  return {
    side: input.side,
    price: Number(formatUnits(priceWad, 18)),
    sizeBase: Number(formatUnits(qtyWad, 18)),
    reduceOnly: input.reduceOnly === true,
    levelIndex: input.levelIndex ?? null,
    clientOrderId: input.clientOrderId ?? null,
  };
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

export class PopdexPaperExchange extends EventEmitter {
  constructor({
    publicClient,
    feeRate,
    startBalance = 10000,
    now = () => Date.now(),
    pollMs = 5000,
    staleMs = 30000,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    super();
    if (!publicClient || typeof publicClient !== 'object') {
      throw new Error('PopDEX Paper publicClient 必须是对象。');
    }
    if (feeRate === undefined) throw new Error('PopDEX Paper feeRate 必须显式传入。');
    if (typeof feeRate !== 'number' || !Number.isFinite(feeRate) || feeRate < 0) {
      throw new Error('PopDEX Paper feeRate 必须是非负有限数。');
    }
    if (typeof startBalance !== 'number' || !Number.isFinite(startBalance) || startBalance < 0) {
      throw new Error('PopDEX Paper startBalance 必须是非负有限数。');
    }
    if (typeof now !== 'function' || typeof setIntervalImpl !== 'function'
        || typeof clearIntervalImpl !== 'function') {
      throw new Error('PopDEX Paper 时钟和定时器依赖必须是函数。');
    }
    this.mode = 'paper';
    this.publicClient = publicClient;
    this.feeRate = feeRate;
    this.balance = startBalance;
    this.equity = startBalance;
    this.realizedPnl = 0;
    this.now = now;
    this.pollMs = positiveSafeInteger(pollMs, 'pollMs');
    this.staleMs = positiveSafeInteger(staleMs, 'staleMs');
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.markets = new Map();
    this.tickers = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this.leverages = new Map();
    this.sequence = 1;
    this.state = 'RECONCILING';
    this.lastPublicOkAt = 0;
    this.lastErrorMessage = null;
    this.timer = null;
    this.refreshPromise = null;
  }

  #market(marketId) {
    const id = Number(marketId);
    const market = this.markets.get(id);
    if (!Number.isSafeInteger(id) || !market) {
      throw new Error(`PopDEX Paper marketId ${String(marketId)} 不在已验证市场中。`);
    }
    return market;
  }

  #assertFresh(marketId, operation) {
    this.#market(marketId);
    const age = this.lastPublicOkAt > 0 ? exactNow(this.now) - this.lastPublicOkAt : Infinity;
    if (this.state !== 'READY' || age > this.staleMs) {
      throw new Error(`PopDEX Paper ${operation}被拒绝：官方行情不可用或已过期。`);
    }
  }

  #updateEquity() {
    let unrealized = 0;
    for (const [marketId, position] of this.positions) {
      const mark = this.tickers.get(marketId)?.mark;
      if (mark !== undefined) unrealized += position.sizeBase * (mark - position.entryPrice);
    }
    this.equity = this.balance + unrealized;
  }

  #applyFill(marketId, side, price, requestedQty, reduceOnly = false) {
    const current = this.positions.get(marketId) ?? { sizeBase: 0, entryPrice: 0 };
    const signedRequested = side === 'buy' ? requestedQty : -requestedQty;
    let qty = requestedQty;
    if (reduceOnly && Math.sign(current.sizeBase) !== 0
        && Math.sign(current.sizeBase) !== Math.sign(signedRequested)) {
      qty = Math.min(requestedQty, Math.abs(current.sizeBase));
    }
    const signed = side === 'buy' ? qty : -qty;
    const fee = price * qty * this.feeRate;
    this.balance -= fee;
    this.realizedPnl -= fee;

    if (current.sizeBase === 0 || Math.sign(current.sizeBase) === Math.sign(signed)) {
      const nextSize = current.sizeBase + signed;
      current.entryPrice = (
        Math.abs(current.sizeBase) * current.entryPrice + Math.abs(signed) * price
      ) / Math.abs(nextSize);
      current.sizeBase = nextSize;
    } else {
      const previousSize = current.sizeBase;
      const closeQty = Math.min(Math.abs(previousSize), qty);
      const pnl = previousSize > 0
        ? closeQty * (price - current.entryPrice)
        : closeQty * (current.entryPrice - price);
      this.balance += pnl;
      this.realizedPnl += pnl;
      const nextSize = previousSize + signed;
      current.sizeBase = nextSize;
      if (nextSize === 0) current.entryPrice = 0;
      else if (Math.sign(nextSize) !== Math.sign(previousSize)) current.entryPrice = price;
    }
    if (current.sizeBase === 0) this.positions.delete(marketId);
    else this.positions.set(marketId, current);
    this.#updateEquity();
    return { qty, fee };
  }

  #match() {
    for (const order of [...this.orders.values()]) {
      const ticker = this.tickers.get(order.marketId);
      const crossed = order.side === 'buy'
        ? ticker.ask <= order.price
        : ticker.bid >= order.price;
      if (!crossed) continue;
      if (order.reduceOnly) {
        const position = this.positions.get(order.marketId);
        const reduces = position && position.sizeBase !== 0
          && ((order.side === 'sell' && position.sizeBase > 0)
            || (order.side === 'buy' && position.sizeBase < 0));
        if (!reduces) {
          this.orders.delete(order.orderId);
          this.emit('fault', new Error(
            `PopDEX Paper reduce-only 订单 ${order.orderId} 不能减少仓位，已终止。`,
          ));
          continue;
        }
      }
      this.orders.delete(order.orderId);
      const { qty, fee } = this.#applyFill(
        order.marketId,
        order.side,
        order.price,
        order.sizeBase,
        order.reduceOnly,
      );
      this.emit('fill', {
        orderId: order.orderId,
        marketId: order.marketId,
        side: order.side,
        price: order.price,
        sizeBase: qty,
        levelIndex: order.levelIndex,
        clientOrderId: order.clientOrderId,
        fee,
      });
    }
  }

  async #readOfficial(matchOrders) {
    try {
      const marketList = exactMarkets(await this.publicClient.getMarkets());
      const tickerRows = await Promise.all(marketList.map(async (market) => [
        market.marketId,
        exactTicker(await this.publicClient.getTicker(market.name), market.name),
      ]));
      this.markets = new Map(marketList.map((market) => [market.marketId, market]));
      this.tickers = new Map(tickerRows);
      this.lastPublicOkAt = exactNow(this.now);
      this.lastErrorMessage = null;
      this.state = 'READY';
      for (const [marketId, ticker] of this.tickers) {
        this.emit('price', { marketId, price: ticker.mark });
      }
      this.#updateEquity();
      if (matchOrders) this.#match();
      return this;
    } catch (error) {
      this.state = 'RECONCILING';
      this.lastErrorMessage = errorMessage(error);
      throw error;
    }
  }

  async init() {
    await this.#readOfficial(false);
    this.start();
    return this;
  }

  async reconnect() {
    await this.#readOfficial(true);
    this.start();
    return this;
  }

  refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.#readOfficial(true).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async getMarkets() {
    return [...this.markets.values()].map((market) => ({ ...market }));
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const market = this.#market(marketId);
    if (!INTERVALS.has(intervalSec)) {
      throw new Error(`PopDEX Paper candle intervalSec ${String(intervalSec)} 不受支持。`);
    }
    if (!Number.isSafeInteger(n) || n <= 0 || n > 1000) {
      throw new Error('PopDEX Paper candle n 必须是 1-1000 的安全整数。');
    }
    const rows = await this.publicClient.getCandles(market.name, INTERVALS.get(intervalSec), n);
    if (!Array.isArray(rows)) throw new Error(`PopDEX Paper ${market.name} candles 必须是数组。`);
    return rows.map((row, index) => {
      const time = Number(strictIntegerString(row?.time, `${market.name} candle[${index}].time`));
      if (!Number.isSafeInteger(time)) throw new Error('PopDEX Paper candle.time 不是安全整数。');
      const candle = { time };
      for (const field of ['open', 'high', 'low', 'close']) {
        if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] <= 0) {
          throw new Error(`PopDEX Paper candle.${field} 必须是正有限数。`);
        }
        candle[field] = row[field];
      }
      return candle;
    });
  }

  async getPrice(marketId) {
    const market = this.#market(marketId);
    this.#assertFresh(market.marketId, '读取价格');
    return this.tickers.get(market.marketId).mark;
  }

  async setLeverage(marketId, leverage) {
    const market = this.#market(marketId);
    this.#assertFresh(market.marketId, '设置杠杆');
    if (!Number.isSafeInteger(leverage) || leverage < 1 || leverage > 255) {
      throw new Error('PopDEX Paper leverage 必须是 1-255 的安全整数。');
    }
    this.leverages.set(market.marketId, leverage);
    return true;
  }

  async placeLimitOrder(input) {
    const market = this.#market(input?.marketId);
    this.#assertFresh(market.marketId, '新增订单');
    const normalized = exactOrderInput(input, market);
    const orderId = `paper-${this.sequence++}`;
    this.orders.set(orderId, { orderId, marketId: market.marketId, ...normalized });
    return { orderId };
  }

  async cancelOrder(marketId, orderId) {
    const market = this.#market(marketId);
    const id = String(orderId);
    const order = this.orders.get(id);
    if (!order || order.marketId !== market.marketId) {
      throw new Error(`PopDEX Paper 订单 ${id} 不存在或市场不匹配。`);
    }
    this.orders.delete(id);
    return true;
  }

  async cancelAll(marketId) {
    const market = this.#market(marketId);
    for (const [orderId, order] of this.orders) {
      if (order.marketId === market.marketId) this.orders.delete(orderId);
    }
    return true;
  }

  getOpenOrders(marketId) {
    const market = this.#market(marketId);
    return [...this.orders.values()]
      .filter((order) => order.marketId === market.marketId)
      .map((order) => ({ ...order }));
  }

  async fetchOpenOrders(marketId) {
    return this.getOpenOrders(marketId);
  }

  adoptOrder(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('PopDEX Paper adoptOrder 必须提供完整订单元数据。');
    }
    const required = [
      'orderId', 'marketId', 'side', 'price', 'sizeBase',
      'levelIndex', 'clientOrderId', 'reduceOnly',
    ];
    if (required.some((field) => metadata[field] === undefined || metadata[field] === null)) {
      throw new Error('PopDEX Paper adoptOrder 必须提供完整订单元数据。');
    }
    const market = this.#market(metadata.marketId);
    const orderId = String(metadata.orderId);
    if (orderId.length === 0) throw new Error('PopDEX Paper adoptOrder orderId 不能为空。');
    const normalized = exactOrderInput(metadata, market);
    const adopted = { orderId, marketId: market.marketId, ...normalized };
    const existing = this.orders.get(orderId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(adopted)) {
      throw new Error(`PopDEX Paper adoptOrder 订单 ${orderId} 与已有订单冲突。`);
    }
    this.orders.set(orderId, adopted);
    return { ...adopted };
  }

  getPosition(marketId) {
    const market = this.#market(marketId);
    const position = this.positions.get(market.marketId);
    if (!position) return null;
    const markPrice = this.tickers.get(market.marketId).mark;
    return {
      sizeBase: position.sizeBase,
      entryPrice: position.entryPrice,
      markPrice,
      unrealizedPnl: position.sizeBase * (markPrice - position.entryPrice),
    };
  }

  async closePosition(marketId) {
    const market = this.#market(marketId);
    this.#assertFresh(market.marketId, '平仓');
    const position = this.positions.get(market.marketId);
    if (!position) return true;
    const price = this.tickers.get(market.marketId).mark;
    this.#applyFill(
      market.marketId,
      position.sizeBase > 0 ? 'sell' : 'buy',
      price,
      Math.abs(position.sizeBase),
    );
    return true;
  }

  start() {
    if (this.timer) return;
    this.timer = this.setIntervalImpl(() => {
      this.refresh().catch((error) => this.emit('fault', error));
    }, this.pollMs);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  getHealth() {
    const publicAgeMs = this.lastPublicOkAt > 0
      ? Math.max(0, exactNow(this.now) - this.lastPublicOkAt)
      : null;
    const stale = publicAgeMs === null || publicAgeMs > this.staleMs;
    return {
      state: this.state,
      status: this.state === 'READY' && !stale ? 'ok' : 'error',
      lastPublicOkAt: this.lastPublicOkAt,
      lastAccountOkAt: null,
      lastAuthorizationOkAt: null,
      publicAgeMs,
      stale,
      lastErrorStage: this.lastErrorMessage ? 'public-refresh' : null,
      lastErrorMessage: this.lastErrorMessage,
      writeInFlight: false,
      dataSource: 'popdex-public',
    };
  }
}
