import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ExchangeClient, InfoClient } from 'risex-client';
import { RisexOrderState } from './order-state.js';
import { RisexPrivateStream } from './private-stream.js';
import {
  normalizeRestFill,
  normalizeRestOpenOrder,
  normalizeRestOrderHistory,
  normalizeRestPosition,
  normalizeRisexMarkets,
} from './normalize.js';

const REQUIRED_CLIENT_VERSION = '0.1.11';
const MAINNET_API = 'https://api.rise.trade';
const MAINNET_WS = 'wss://api.rise.trade/ws/';
const require = createRequire(import.meta.url);

function readInstalledClientVersion() {
  let current = path.dirname(require.resolve('risex-client'));
  while (true) {
    const packageFile = path.join(current, 'package.json');
    if (fs.existsSync(packageFile)) {
      const parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      if (parsed.name === 'risex-client') return parsed.version;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('无法读取 risex-client package.json。');
}

function normalizedMarketName(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact === 'BTCPERP' || compact === 'BTCUSD') return 'BTC-PERP';
  if (compact === 'ETHPERP' || compact === 'ETHUSD') return 'ETH-PERP';
  return null;
}

function strictDecimal(value, field, { positive = false } = {}) {
  if (typeof value === 'string' && !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    throw new Error(`RISEx ${field} 不是十进制数字。`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || (positive && !(result > 0))) {
    throw new Error(`RISEx ${field} 数值非法。`);
  }
  return result;
}

export class RisexExchange extends EventEmitter {
  constructor(opts = {}, deps = {}) {
    super();
    this.mode = 'live';
    this.account = String(opts.account || '').toLowerCase();
    this.signerKey = opts.signerKey;
    this.baseUrl = opts.apiUrl;
    this.wsUrl = opts.wsUrl;
    this.network = opts.network;
    this.dataSource = null;
    this.connectionState = 'RECONCILING';
    this.haltReason = null;
    this.markets = new Map();
    this.balance = null;
    this.realizedPnl = null;
    this.lastOkAt = 0;
    this.lastRestAt = 0;
    this.lastOrderAt = 0;
    this.lastError = null;
    this.orderState = new RisexOrderState();
    this._positions = new Map();
    this._prices = new Map();
    this._officialOpen = new Map();
    this._restingIds = new Map();
    this._pendingRecoveryTerminals = new Map();
    this._recoverySnapshot = null;
    this._writeQueue = Promise.resolve();
    this._bulkCancel = false;
    this._initializing = false;
    this._timer = null;
    this._info = null;
    this._client = null;
    this._stream = null;

    this._packageVersion = deps.packageVersion;
    this._infoFactory = deps.infoFactory || ((clientOpts) => new InfoClient(clientOpts));
    this._clientFactory = deps.clientFactory || ((clientOpts) => new ExchangeClient(clientOpts));
    this._streamFactory = deps.streamFactory || ((streamOpts) => new RisexPrivateStream(streamOpts));
    this._now = deps.now || Date.now;
    this._sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._defer = deps.defer || queueMicrotask;
    this._logger = deps.logger || console;
  }

  setRecoverySnapshot(snapshot) {
    if (!(snapshot?.running && snapshot?.config)) {
      this._recoverySnapshot = null;
      return;
    }
    if (!Array.isArray(snapshot.active)) throw new Error('RISEx 恢复快照 active 必须是数组。');
    const fallbackSize = Number(snapshot.config.sizeBase);
    const active = new Map();
    for (const entry of snapshot.active) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error('RISEx 恢复快照订单格式非法。');
      const orderId = String(entry[0]);
      if (!orderId) throw new Error('RISEx 恢复快照包含空订单 ID。');
      const info = entry[1] || {};
      const sizeBase = Number(info.sizeBase ?? fallbackSize);
      const price = Number(info.price);
      if ((info.side !== 'buy' && info.side !== 'sell')
        || !Number.isFinite(sizeBase) || !(sizeBase > 0)
        || !Number.isFinite(price) || price < 0) {
        throw new Error(`RISEx 恢复快照订单 ${orderId} 元数据非法。`);
      }
      active.set(orderId, {
        orderId,
        side: info.side,
        sizeBase,
        price,
        levelIndex: info.levelIndex,
        clientOrderId: info.clientOrderId,
        recovery: !!info.recovery,
        opening: info.opening,
      });
    }
    this._recoverySnapshot = {
      running: true,
      displayName: String(snapshot.config.displayName || ''),
      active,
    };
  }

  async init() {
    this._initializing = true;
    this._setState('RECONCILING', '正在执行 RISEx 启动同步屏障');
    try {
      this._assertConfig();
      this._assertDependencyVersion();
      this._info = this._infoFactory({ baseUrl: this.baseUrl, wsUrl: this.wsUrl, logLevel: 'error' });
      this._client = this._clientFactory({
        account: this.account,
        signerKey: this.signerKey,
        baseUrl: this.baseUrl,
        wsUrl: this.wsUrl,
        logLevel: 'error',
      });
      await this._client.init();
      if (await this._client.isSignerRegistered() !== true) {
        throw new Error('RISEx session signer 未注册或已失效。');
      }
      await this._loadMarkets();
      this._stream = this._streamFactory({
        account: this.account,
        signerKey: this.signerKey,
        apiUrl: this.baseUrl,
        wsUrl: this.wsUrl,
        marketIds: [...this.markets.keys()],
        isSignerRegistered: () => this._client.isSignerRegistered(),
        logger: this._logger,
      });
      this._bindStream();
      this._stream.beginBuffering();
      await this._stream.connect();
      await this._stream.waitForOrderSnapshot();
      const snapshot = await this._readRestSnapshot();
      this._seedRestSnapshot(snapshot);
      for (const event of this._stream.drainBuffered()) this._applyPrivateEvent(event);
      this._validateRecoveryOwnership(snapshot);
      this._stream.releaseBuffer();
      this.dataSource = 'real';
      this.lastOkAt = this._now();
      this._setState('READY', '私有流认证和 REST/WS 对账完成');
      return this;
    } catch (cause) {
      this.lastError = cause?.message || String(cause);
      this.dataSource = null;
      this._setState('HALTED', this.lastError);
      this._stream?.stop?.();
      throw cause;
    } finally {
      this._initializing = false;
    }
  }

  async reconnect() {
    throw new Error('RISEx reconnect 尚未完成实现。');
  }

  async getMarkets() {
    return [...this.markets.values()].map((market) => ({ ...market }));
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const resolution = intervalSec >= 86400 ? '1D' : String(Math.max(1, Math.round(intervalSec / 60)));
    const to = Math.floor(this._now() / 1000);
    const from = to - intervalSec * n;
    const rows = await this._info.getCandles(Number(marketId), resolution, from, to);
    if (!Array.isArray(rows)) throw new Error('RISEx candles 响应不是数组。');
    return rows.map((row) => ({
      time: strictDecimal(row.time ?? row.timestamp, 'candle time') * 1000,
      open: strictDecimal(row.open, 'candle open'),
      high: strictDecimal(row.high, 'candle high'),
      low: strictDecimal(row.low, 'candle low'),
      close: strictDecimal(row.close, 'candle close'),
      volume: strictDecimal(row.volume, 'candle volume'),
    }));
  }

  async getPrice(marketId) {
    const id = Number(marketId);
    this._assertAllowedMarket(id, '读取价格');
    const book = await this._info.getOrderbook(id);
    const bid = strictDecimal(book?.bids?.[0]?.price ?? book?.bids?.[0]?.[0], 'best bid', { positive: true });
    const ask = strictDecimal(book?.asks?.[0]?.price ?? book?.asks?.[0]?.[0], 'best ask', { positive: true });
    if (!(ask >= bid)) throw new Error(`RISEx market ${id} orderbook 买卖价倒挂。`);
    const price = (bid + ask) / 2;
    this._prices.set(id, price);
    this.lastRestAt = this._now();
    this.lastOkAt = this._now();
    return price;
  }

  async setLeverage() { throw new Error('RISEx setLeverage 尚未完成实现。'); }
  async placeLimitOrder() { throw new Error('RISEx placeLimitOrder 尚未完成实现。'); }
  async cancelOrder() { throw new Error('RISEx cancelOrder 尚未完成实现。'); }
  async cancelAll() { throw new Error('RISEx cancelAll 尚未完成实现。'); }

  getOpenOrders(marketId) {
    return [...(this._officialOpen.get(Number(marketId)) || new Map()).values()]
      .map((order) => ({ ...order }));
  }

  async fetchOpenOrders(marketId) {
    if (this.connectionState !== 'READY') {
      throw new Error(`RISEx 对账不可用：${this.connectionState} ${this.haltReason || ''}`.trim());
    }
    return this.getOpenOrders(marketId);
  }

  adoptOrder(meta) {
    const id = String(meta.orderId);
    const current = this.orderState.get(id);
    if (!current) throw new Error(`RISEx 无法接管未知订单 ${id}。`);
    this.orderState.adopt({ ...meta, orderId: id, marketId: Number(meta.marketId) });
  }

  getPosition(marketId) {
    const position = this._positions.get(Number(marketId));
    return position && position.sizeBase !== 0 ? { ...position } : null;
  }

  async closePosition() { throw new Error('RISEx closePosition 尚未完成实现。'); }
  start() {}

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._stream?.stop?.();
  }

  _assertConfig() {
    if (this.network !== 'mainnet') throw new Error('RISEx 实盘只支持 mainnet。');
    if (this.baseUrl !== MAINNET_API) throw new Error(`RISEX_API_URL 必须为 ${MAINNET_API}`);
    if (this.wsUrl !== MAINNET_WS) throw new Error(`RISEX_WS_URL 必须为 ${MAINNET_WS}`);
    if (!/^0x[0-9a-f]{40}$/i.test(this.account)) throw new Error('RISEX_ACCOUNT 不是有效 EVM 地址。');
    if (typeof this.signerKey !== 'string' || !/^0x[0-9a-f]{64}$/i.test(this.signerKey)) {
      throw new Error('RISEX_SIGNER_KEY 不是有效 32 字节私钥。');
    }
  }

  _assertDependencyVersion() {
    const actual = this._packageVersion ?? readInstalledClientVersion();
    if (actual !== REQUIRED_CLIENT_VERSION) {
      throw new Error(`RISEx 要求 risex-client ${REQUIRED_CLIENT_VERSION}，实际为 ${actual}。`);
    }
  }

  async _loadMarkets() {
    const markets = normalizeRisexMarkets(await this._info.getMarkets());
    this.markets = new Map(markets.map((market) => [market.marketId, market]));
  }

  _bindStream() {
    this._stream.on?.('order', (order) => {
      try { this._applyPrivateEvent({ kind: 'order', data: order }); }
      catch (error) { this._haltFromAsync(error); }
    });
    this._stream.on?.('fill', (fill) => {
      try { this._applyPrivateEvent({ kind: 'fill', data: fill }); }
      catch (error) { this._haltFromAsync(error); }
    });
    this._stream.on?.('disconnected', () => {
      if (this.connectionState !== 'HALTED') this._setState('RECONCILING', 'RISEx 私有 WebSocket 已断开');
    });
    this._stream.on?.('fatal', (error) => this._haltFromAsync(error));
  }

  async _readRestSnapshot() {
    const marketRows = await Promise.all([...this.markets.values()].map(async (market) => {
      const [openRaw, historyRaw, fillsRaw] = await Promise.all([
        this._info.getOpenOrders(this.account, market.marketId),
        this._info.getOrderHistory(this.account, market.marketId, 100),
        this._info.getAccountTradeHistory(this.account, market.marketId, 100),
      ]);
      if (!Array.isArray(openRaw) || !Array.isArray(historyRaw) || !Array.isArray(fillsRaw)) {
        throw new Error(`RISEx market ${market.marketId} REST 订单快照格式非法。`);
      }
      return {
        market,
        open: openRaw.map((raw) => normalizeRestOpenOrder(raw, market)),
        history: historyRaw.map(normalizeRestOrderHistory),
        fills: fillsRaw.map(normalizeRestFill),
      };
    }));
    const [positionsRaw, balanceRaw] = await Promise.all([
      this._info.getAllPositions(this.account),
      this._info.getBalance(this.account),
    ]);
    if (!Array.isArray(positionsRaw)) throw new Error('RISEx positions 响应不是数组。');
    const allowed = new Set(this.markets.keys());
    const positions = positionsRaw
      .map(normalizeRestPosition)
      .filter((position) => position && allowed.has(position.marketId));
    const balance = strictDecimal(balanceRaw, 'balance');
    this.lastRestAt = this._now();
    return { marketRows, positions, balance };
  }

  _seedRestSnapshot(snapshot) {
    this._officialOpen = new Map();
    this._restingIds = new Map();
    for (const { market, open } of snapshot.marketRows) {
      const openMap = new Map();
      for (const order of open) {
        if (openMap.has(order.orderId)) throw new Error(`RISEx REST 开放订单 ${order.orderId} 重复。`);
        openMap.set(order.orderId, order);
        this._restingIds.set(order.orderId, order.restingOrderId);
        const expected = this._recoverySnapshot?.active.get(order.orderId);
        this.orderState.track({
          orderId: order.orderId,
          marketId: order.marketId,
          side: order.side,
          sizeBase: order.sizeBase,
          price: order.price,
          levelIndex: expected?.levelIndex,
          clientOrderId: expected?.clientOrderId,
          sizeTolerance: market.stepSize / 2,
        });
      }
      this._officialOpen.set(market.marketId, openMap);
    }
    this._positions = new Map(snapshot.positions.map((position) => [position.marketId, position]));
    this.balance = snapshot.balance;
  }

  _applyPrivateEvent(event) {
    if (!event || (event.kind !== 'order' && event.kind !== 'fill')) {
      throw new Error('RISEx 私有流事件类型未知。');
    }
    if (!this.markets.has(event.data.marketId)) {
      throw new Error(`RISEx 私有流收到未允许 market ${event.data.marketId}。`);
    }
    if (event.kind === 'fill') {
      this.orderState.applyFill(event.data);
      return;
    }
    this.lastOrderAt = this._now();
    const result = this.orderState.applyOrder(event.data);
    if (result?.pending && !this._initializing) {
      throw new Error(`RISEx 收到未知订单 ${event.data.orderId} 的状态。`);
    }
    if (!result?.terminal) return;
    this._officialOpen.get(event.data.marketId)?.delete(event.data.orderId);
    if (result.terminalFill) {
      const suppressRequote = this._bulkCancel;
      this._defer(() => this.emit('fill', { ...result.terminalFill, suppressRequote }));
    }
  }

  _validateRecoveryOwnership(snapshot) {
    const open = snapshot.marketRows.flatMap((row) => row.open);
    const positions = snapshot.positions.filter((position) => position.sizeBase !== 0);
    if (!this._recoverySnapshot) {
      if (open.length) throw new Error(`RISEx 没有运行快照却检测到遗留挂单：${open.map((order) => order.orderId).join(', ')}。`);
      if (positions.length) throw new Error(`RISEx 没有运行快照却检测到遗留仓位：market ${positions.map((position) => position.marketId).join(', ')}。`);
      if (this.orderState.unknownOrderIds().length) {
        throw new Error(`RISEx 没有运行快照却收到未知订单：${this.orderState.unknownOrderIds().join(', ')}。`);
      }
      return;
    }

    const displayName = normalizedMarketName(this._recoverySnapshot.displayName);
    const market = [...this.markets.values()].find((item) => item.displayName === displayName);
    if (!market) throw new Error(`RISEx 恢复快照市场不受支持：${this._recoverySnapshot.displayName}。`);
    const expected = this._recoverySnapshot.active;
    for (const order of open) {
      if (!expected.has(order.orderId)) throw new Error(`RISEx 检测到快照外订单 ${order.orderId}。`);
      if (order.marketId !== market.marketId) throw new Error(`RISEx 快照订单 ${order.orderId} 出现在其他市场。`);
    }
    for (const position of positions) {
      if (position.marketId !== market.marketId) {
        throw new Error(`RISEx 检测到恢复市场之外的遗留仓位 market ${position.marketId}。`);
      }
    }

    const history = new Map(snapshot.marketRows.flatMap((row) => row.history).map((order) => [order.orderId, order]));
    const fillsByOrder = new Map();
    for (const fill of snapshot.marketRows.flatMap((row) => row.fills)) {
      const rows = fillsByOrder.get(fill.orderId) || [];
      rows.push(fill);
      fillsByOrder.set(fill.orderId, rows);
    }
    for (const [orderId, meta] of expected) {
      const live = this._officialOpen.get(market.marketId)?.get(orderId);
      if (live) {
        const record = this.orderState.get(orderId);
        if (!record || (record.status !== 'OPEN' && record.status !== 'PARTIAL')) {
          throw new Error(`RISEx 订单 ${orderId} 在 REST 开放但未出现在 Orders WebSocket 快照。`);
        }
        this.orderState.adopt({ ...meta, marketId: market.marketId, sizeTolerance: market.stepSize / 2 });
        continue;
      }
      const terminal = history.get(orderId);
      if (!terminal || (terminal.status !== 'FILLED' && terminal.status !== 'CANCELLED')) {
        throw new Error(`RISEx 订单 ${orderId} 无法确认开放或终态。`);
      }
      const tracked = this.orderState.track({ ...meta, marketId: market.marketId, sizeTolerance: market.stepSize / 2 });
      for (const fill of (fillsByOrder.get(orderId) || []).sort((a, b) => Number(a.cursor.timestamp - b.cursor.timestamp))) {
        this.orderState.applyFill(fill);
      }
      const result = this.orderState.applyOrder(terminal) ?? tracked;
      if (!result?.terminal) throw new Error(`RISEx 订单 ${orderId} 终态历史无法合并。`);
      this._pendingRecoveryTerminals.set(orderId, result);
    }
    const unknown = this.orderState.unknownOrderIds();
    if (unknown.length) throw new Error(`RISEx 私有流存在快照外未知订单：${unknown.join(', ')}。`);
  }

  _assertAllowedMarket(marketId, action) {
    if (!this.markets.has(marketId)) throw new Error(`RISEx ${action} 只允许 BTC-PERP/ETH-PERP。`);
  }

  _setState(next, reason) {
    if (this.connectionState === 'HALTED' && next !== 'HALTED') return;
    const previous = this.connectionState;
    this.connectionState = next;
    if (next === 'HALTED') this.haltReason = reason;
    this._logger.log?.(`[RISEx] 状态 ${previous} -> ${next}：${reason}`);
  }

  _haltFromAsync(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.lastError = normalized.message;
    this._setState('HALTED', normalized.message);
    this.emit('error', normalized);
  }
}
