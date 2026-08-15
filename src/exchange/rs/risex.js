import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  InfoClient,
  OrderType,
  Side,
  StpMode,
  TimeInForce,
} from 'risex-client';
import { RisexMainnetClient } from './mainnet-client.js';
import { RisexOrderState } from './order-state.js';
import { RisexPrivateStream } from './private-stream.js';
import {
  compareRisexCursor,
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
    this.stateReason = '尚未初始化';
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
    this._pendingPlaceCount = 0;
    this._orderWaiters = new Map();
    this._bulkCancel = false;
    this._closingPosition = false;
    this._initializing = false;
    this._manualReconnecting = false;
    this._reconcilePromise = null;
    this._reconcileExpected = null;
    this._refreshPromise = null;
    this._refreshError = null;
    this._timer = null;
    this._info = null;
    this._client = null;
    this._stream = null;

    this._packageVersion = deps.packageVersion;
    this._infoFactory = deps.infoFactory || ((clientOpts) => new InfoClient(clientOpts));
    this._clientFactory = deps.clientFactory || ((clientOpts) => new RisexMainnetClient(clientOpts));
    this._streamFactory = deps.streamFactory || ((streamOpts) => new RisexPrivateStream(streamOpts));
    this._now = deps.now || Date.now;
    this._sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._defer = deps.defer || setImmediate;
    this._setInterval = deps.setInterval || setInterval;
    this._clearInterval = deps.clearInterval || clearInterval;
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
      this._createClients();
      await this._client.init();
      if (await this._client.isSignerRegistered() !== true) {
        throw new Error('RISEx session signer 未注册或已失效。');
      }
      await this._loadMarkets();
      this._createStream();
      this._bindStream();
      this._stream.beginBuffering();
      await this._stream.connect();
      await this._stream.waitForOrderSnapshot();
      this.lastOrderAt = this._now();
      const snapshot = await this._readRestSnapshot();
      this._seedRestSnapshot(snapshot);
      for (const event of this._stream.drainBuffered()) this._applyPrivateEvent(event);
      this._validateRecoveryOwnership(snapshot);
      this._stream.releaseBuffer();
      this.dataSource = 'real';
      this.lastOkAt = this._now();
      this._setState('READY', '私有流认证和 REST/WS 对账完成');
      this.start();
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
    const expected = this._captureLiveOwnership();
    this._manualReconnecting = true;
    this._reconcileExpected = expected;
    this._unbindStream();
    this._stream?.stop?.();
    this._setState('RECONCILING', '用户请求重建 RISEx 客户端和私有流', { allowHalted: true });
    try {
      this._assertConfig();
      this._assertDependencyVersion();
      this._createClients();
      await this._client.init();
      if (await this._client.isSignerRegistered() !== true) {
        throw new Error('RISEx session signer 未注册或已失效。');
      }
      await this._loadMarkets();
      this._createStream();
      this._bindStream();
      this._stream.beginBuffering();
      await this._stream.connect();
      await this._synchronizeLiveState(expected, '手动重连');
      this.start();
      return this;
    } catch (cause) {
      this.lastError = cause?.message || String(cause);
      this.dataSource = null;
      this._setState('HALTED', this.lastError);
      this._stream?.stop?.();
      throw cause;
    } finally {
      this._manualReconnecting = false;
    }
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

  async setLeverage(marketId, leverage) {
    const id = Number(marketId);
    this._assertWritable(id, '设置杠杆', { newRisk: true });
    const market = this.markets.get(id);
    if (!Number.isSafeInteger(leverage) || leverage <= 0 || leverage > market.maxLeverage) {
      throw new Error(`RISEx market ${id} 杠杆必须是 1-${market.maxLeverage} 的整数。`);
    }
    return this._serialWrite(id, '设置杠杆', async () => {
      const response = await this._client.updateLeverage(id, BigInt(leverage));
      if (response == null || response === false || response?.success === false) {
        throw new Error(`RISEx market ${id} 设置杠杆失败。`);
      }
      const position = this._positions.get(id);
      if (position?.sizeBase) {
        const confirmed = normalizeRestPosition(await this._info.getPosition(id, this.account));
        this.lastRestAt = this._now();
        if (!confirmed || confirmed.sizeBase === 0 || confirmed.leverage !== leverage) {
          throw new Error(`RISEx market ${id} 仓位杠杆回读与目标 ${leverage} 不一致。`);
        }
        this._positions.set(id, confirmed);
      }
      return true;
    }, { newRisk: true });
  }

  async placeLimitOrder(order) {
    const marketId = Number(order?.marketId);
    this._assertWritable(marketId, '下单', { newRisk: true });
    if (order.side !== 'buy' && order.side !== 'sell') throw new Error('RISEx 下单 side 必须是 buy/sell。');
    const requestedPrice = strictDecimal(order.price, '下单价格', { positive: true });
    const requestedSize = strictDecimal(order.sizeBase, '下单数量', { positive: true });
    const market = this.markets.get(marketId);
    const priceTicks = Math.round(requestedPrice / market.stepPrice);
    const sizeSteps = Math.round(requestedSize / market.stepSize);
    if (!Number.isSafeInteger(priceTicks) || priceTicks <= 0) throw new Error('RISEx 下单价格无法对齐 price tick。');
    if (!Number.isSafeInteger(sizeSteps) || sizeSteps <= 0) throw new Error('RISEx 下单数量无法对齐 size step。');
    const price = priceTicks * market.stepPrice;
    const sizeBase = sizeSteps * market.stepSize;
    if (sizeBase + market.stepSize / 2 < market.minOrderSize) {
      throw new Error(`RISEx ${market.displayName} 下单数量低于最小值 ${market.minOrderSize}。`);
    }
    const clientOrderId = BigInt(`0x${randomBytes(8).toString('hex')}`).toString();
    const meta = {
      marketId,
      side: order.side,
      price,
      sizeBase,
      levelIndex: order.levelIndex,
      clientOrderId,
      reduceOnly: order.reduceOnly === true,
      sizeTolerance: market.stepSize / 2,
    };

    this._pendingPlaceCount += 1;
    try {
      return await this._serialWrite(marketId, '限价下单', async () => {
        const response = await this._client.placeOrder({
          market_id: marketId,
          side: order.side === 'buy' ? Side.Long : Side.Short,
          order_type: OrderType.Limit,
          price_ticks: priceTicks,
          size_steps: sizeSteps,
          time_in_force: TimeInForce.GoodTillCancelled,
          post_only: false,
          reduce_only: meta.reduceOnly,
          stp_mode: StpMode.ExpireTaker,
          ttl_units: 0,
          client_order_id: clientOrderId,
        });
        if (typeof response?.order_id !== 'string' || !response.order_id) {
          this._haltAndThrow('RISEx 下单响应缺少非空字符串订单 ID。');
        }
        const orderId = response.order_id;
        const result = this.orderState.track({ ...meta, orderId });
        this._handleOrderResult(result, { ...meta, orderId });
        this._syncOfficialOrder(orderId);

        let record = this.orderState.get(orderId);
        if (record?.status === 'PENDING') {
          await this._waitForOrderUpdate(orderId, 10_000);
          record = this.orderState.get(orderId);
        }
        if (record?.status === 'PENDING') {
          await this._confirmOrderFromRest(orderId, marketId);
          record = this.orderState.get(orderId);
        }
        if (!record || record.status === 'PENDING') {
          this._haltAndThrow(`RISEx 订单 ${orderId} 经 WebSocket 超时且 REST 无法确认。`);
        }
        this._syncOfficialOrder(orderId);
        return { orderId };
      }, { newRisk: true });
    } finally {
      this._pendingPlaceCount -= 1;
      if (this._pendingPlaceCount === 0) this._assertNoUnexpectedPrivateOrders();
    }
  }
  async cancelOrder(marketId, orderId) {
    const id = Number(marketId);
    this._assertWritable(id, '撤单');
    if (typeof orderId !== 'string' || !orderId) throw new Error('RISEx 撤单 orderId 必须是非空字符串。');
    let record = this.orderState.get(orderId);
    if (!record || record.marketId !== id) throw new Error(`RISEx 无法撤销未知订单 ${orderId}。`);
    if (record.status === 'FILLED' || record.status === 'CANCELLED') return true;

    const open = await this._readOpenOrders(id);
    const target = open.find((order) => order.orderId === orderId);
    if (!target) {
      await this._confirmOrderFromRest(orderId, id);
      record = this.orderState.get(orderId);
      if (record?.status === 'FILLED' || record?.status === 'CANCELLED') return true;
      throw new Error(`RISEx 订单 ${orderId} 未在开放订单中，且历史未确认终态。`);
    }
    this._restingIds.set(orderId, target.restingOrderId);

    const response = await this._serialWrite(id, '单笔撤单', () => this._client.cancelOrder({
      market_id: id,
      order_id: orderId,
      resting_order_id: target.restingOrderId,
    }));
    if (response?.success !== true) throw new Error(`RISEx 订单 ${orderId} 撤单请求未成功。`);

    record = this.orderState.get(orderId);
    if (record?.status !== 'FILLED' && record?.status !== 'CANCELLED') {
      await this._waitForOrderUpdate(orderId, 10_000);
      record = this.orderState.get(orderId);
    }
    if (record?.status !== 'FILLED' && record?.status !== 'CANCELLED') {
      await this._confirmOrderFromRest(orderId, id);
      record = this.orderState.get(orderId);
    }
    if (record?.status !== 'FILLED' && record?.status !== 'CANCELLED') {
      throw new Error(`RISEx 订单 ${orderId} 撤单后未确认终态，仍保留跟踪。`);
    }
    return true;
  }

  async cancelAll(marketId) {
    const id = Number(marketId);
    this._assertWritable(id, '批量撤单');
    this._bulkCancel = true;
    try {
      const response = await this._serialWrite(
        id,
        '批量撤单',
        () => this._client.cancelAllOrders(id),
        { allowBulkCancel: true },
      );
      if (response?.success !== true) throw new Error(`RISEx market ${id} 批量撤单请求未成功。`);

      let remaining = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        remaining = await this._readOpenOrders(id);
        this._replaceOfficialOpenFromRest(id, remaining);
        this._logger.log?.(`[RISEx] market ${id} 批量撤单确认 ${attempt}/5，剩余订单：${remaining.map((order) => order.orderId).join(', ') || '0'}`);
        if (remaining.length === 0) return true;
        if (attempt < 5) await this._sleep(1_000);
      }
      this._haltAndThrow(`RISEx market ${id} 批量撤单后仍有挂单：${remaining.map((order) => order.orderId).join(', ')}。`);
    } finally {
      this._bulkCancel = false;
    }
  }

  getOpenOrders(marketId) {
    return [...(this._officialOpen.get(Number(marketId)) || new Map()).values()]
      .map((order) => ({ ...order }));
  }

  async fetchOpenOrders(marketId) {
    if (this.connectionState !== 'READY') {
      throw new Error(`RISEx 对账不可用：${this.connectionState} ${this.haltReason || ''}`.trim());
    }
    const health = this.getHealth();
    if (health.status === 'error') {
      throw new Error(`RISEx 开放订单数据不可用：健康检查未通过（${health.reason}）。`);
    }
    return this.getOpenOrders(marketId);
  }

  adoptOrder(meta) {
    const id = String(meta.orderId);
    const current = this.orderState.get(id);
    if (!current) throw new Error(`RISEx 无法接管未知订单 ${id}。`);
    this.orderState.adopt({ ...meta, orderId: id, marketId: Number(meta.marketId) });
    this._syncOfficialOrder(id);
    const terminal = this._pendingRecoveryTerminals.get(id);
    if (!terminal) return;
    this._pendingRecoveryTerminals.delete(id);
    const record = this.orderState.get(id);
    this._defer(() => {
      if (!terminal.terminalFill) return;
      this.emit('fill', {
        ...terminal.terminalFill,
        levelIndex: record.meta.levelIndex,
        clientOrderId: record.meta.clientOrderId,
      });
    });
  }

  getPosition(marketId) {
    const position = this._positions.get(Number(marketId));
    return position && position.sizeBase !== 0 ? { ...position } : null;
  }

  getHealth() {
    const now = this._now();
    const age = (timestamp) => (timestamp > 0 ? Math.max(0, now - timestamp) : null);
    const unknownOrders = this.orderState.unknownOrderIds().length;
    const lastOrderAgeMs = age(this.lastOrderAt);
    const lastRestAgeMs = age(this.lastRestAt);
    const privateStream = this._stream?.authenticated ? 'authenticated' : 'disconnected';
    let status = 'ok';
    let reason = 'RISEx 私有流和 REST 正常';
    if (this.connectionState === 'HALTED') {
      status = 'error';
      reason = this.haltReason || 'RISEx 已停机';
    } else if (this.connectionState === 'RECONCILING') {
      status = 'error';
      reason = this.stateReason || 'RISEx 正在对账';
    } else if (privateStream !== 'authenticated') {
      status = 'error';
      reason = 'RISEx 私有流断开';
    } else if (unknownOrders > 0) {
      status = 'error';
      reason = `RISEx 存在 ${unknownOrders} 个未知订单`;
    } else if (this._refreshError) {
      status = 'error';
      reason = `RISEx 只读刷新失败：${this._refreshError}`;
    } else if (lastRestAgeMs == null || lastRestAgeMs > 30_000) {
      status = 'error';
      reason = 'RISEx REST 数据超过 30 秒未成功更新';
    } else if (lastOrderAgeMs == null || lastOrderAgeMs > 30_000) {
      status = 'warn';
      reason = 'RISEx 私有订单流超过 30 秒未更新';
    }
    return {
      status,
      reason,
      privateStream,
      reconciling: this.connectionState === 'RECONCILING',
      halted: this.connectionState === 'HALTED',
      unknownOrders,
      lastOrderAgeMs,
      lastRestAgeMs,
    };
  }

  async closePosition(marketId) {
    const id = Number(marketId);
    this._assertWritable(id, '平仓');
    await this.cancelAll(id);
    this._closingPosition = true;
    try {
      let position = await this._readPosition(id);
      if (!position) {
        await this._sleep(1_000);
        position = await this._readPosition(id);
        if (!position) return true;
      }

      const market = this.markets.get(id);
      const sizeSteps = Math.round(Math.abs(position.sizeBase) / market.stepSize);
      if (!Number.isSafeInteger(sizeSteps) || sizeSteps <= 0) {
        this._haltAndThrow(`RISEx market ${id} 仓位数量无法对齐 size step。`);
      }
      const side = position.sizeBase > 0 ? 'sell' : 'buy';
      const clientOrderId = BigInt(`0x${randomBytes(8).toString('hex')}`).toString();
      this._pendingPlaceCount += 1;
      try {
        const response = await this._serialWrite(id, '市价平仓', () => this._client.placeOrder({
          market_id: id,
          side: side === 'buy' ? Side.Long : Side.Short,
          order_type: OrderType.Market,
          price_ticks: 0,
          size_steps: sizeSteps,
          time_in_force: TimeInForce.ImmediateOrCancel,
          post_only: false,
          reduce_only: true,
          stp_mode: StpMode.ExpireTaker,
          ttl_units: 0,
          client_order_id: clientOrderId,
        }), { allowClosingPosition: true });
        if (typeof response?.order_id !== 'string' || !response.order_id) {
          this._haltAndThrow('RISEx 平仓响应缺少非空字符串订单 ID。');
        }
        const result = this.orderState.track({
          orderId: response.order_id,
          marketId: id,
          side,
          price: 0,
          sizeBase: sizeSteps * market.stepSize,
          reduceOnly: true,
          clientOrderId,
          sizeTolerance: market.stepSize / 2,
        });
        this._handleOrderResult(result, {
          orderId: response.order_id,
          marketId: id,
        });
        this._syncOfficialOrder(response.order_id);
      } finally {
        this._pendingPlaceCount -= 1;
        if (this._pendingPlaceCount === 0) this._assertNoUnexpectedPrivateOrders();
      }

      let zeroStreak = 0;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const current = await this._readPosition(id);
        zeroStreak = current ? 0 : zeroStreak + 1;
        this._logger.log?.(`[RISEx] market ${id} 平仓确认 ${attempt}/6，连续空仓 ${zeroStreak}/2`);
        if (zeroStreak >= 2) return true;
        if (attempt < 6) await this._sleep(1_000);
      }
      this._haltAndThrow(`RISEx market ${id} 平仓后仓位仍未归零。`);
    } catch (cause) {
      if (this.connectionState === 'HALTED') throw cause;
      this._haltAndThrow(`RISEx market ${id} 平仓确认失败：${cause?.message || String(cause)}`);
    } finally {
      this._closingPosition = false;
    }
  }
  start() {
    if (this._timer != null) return;
    const tick = () => {
      if (this.connectionState !== 'READY') {
        this._logger.log?.(`[RISEx] 跳过只读刷新：${this.connectionState} ${this.stateReason}`);
        return undefined;
      }
      if (this._refreshPromise) return this._refreshPromise;
      this._refreshPromise = this._refreshReadOnly()
        .catch((cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          this.lastError = error.message;
          this._refreshError = error.message;
          this._logger.error?.(`[RISEx] 只读刷新失败：${error.message}`);
          this.emit('error', error);
        })
        .finally(() => { this._refreshPromise = null; });
      return this._refreshPromise;
    };
    this._timer = this._setInterval(tick, 10_000);
    this._timer?.unref?.();
  }

  stop() {
    if (this._timer != null) this._clearInterval(this._timer);
    this._timer = null;
    this._unbindStream();
    this._stream?.stop?.();
    if (this.connectionState !== 'HALTED') this._setState('RECONCILING', 'RISEx 适配器已停止');
  }

  async _refreshReadOnly() {
    if (this.connectionState !== 'READY') {
      throw new Error(`RISEx 只读刷新被拒绝：${this.connectionState}。`);
    }
    const [prices, positionsRaw, balanceRaw] = await Promise.all([
      Promise.all([...this.markets.keys()].map(async (marketId) => ({
        marketId,
        price: await this.getPrice(marketId),
      }))),
      this._info.getAllPositions(this.account),
      this._info.getBalance(this.account),
    ]);
    if (!Array.isArray(positionsRaw)) throw new Error('RISEx positions 刷新响应不是数组。');
    const allowed = new Set(this.markets.keys());
    const positions = positionsRaw.map(normalizeRestPosition)
      .filter((position) => position && position.sizeBase !== 0 && allowed.has(position.marketId));
    this._positions = new Map(positions.map((position) => [position.marketId, position]));
    this.balance = strictDecimal(balanceRaw, 'balance');
    this.lastRestAt = this._now();
    this.lastOkAt = this._now();
    this._refreshError = null;
    for (const price of prices) this.emit('price', price);
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

  _createClients() {
    this._info = this._infoFactory({ baseUrl: this.baseUrl, wsUrl: this.wsUrl, logLevel: 'error' });
    this._client = this._clientFactory({
      account: this.account,
      signerKey: this.signerKey,
      baseUrl: this.baseUrl,
      wsUrl: this.wsUrl,
      logLevel: 'error',
    });
  }

  _createStream() {
    this._stream = this._streamFactory({
      account: this.account,
      signerKey: this.signerKey,
      apiUrl: this.baseUrl,
      wsUrl: this.wsUrl,
      marketIds: [...this.markets.keys()],
      isSignerRegistered: () => this._client.isSignerRegistered(),
      logger: this._logger,
    });
  }

  async _loadMarkets() {
    const markets = normalizeRisexMarkets(await this._info.getMarkets());
    this.markets = new Map(markets.map((market) => [market.marketId, market]));
  }

  _bindStream() {
    const handlers = {
      order: (order) => {
        try { this._applyPrivateEvent({ kind: 'order', data: order }); }
        catch (error) { this._haltFromAsync(error); }
      },
      fill: (fill) => {
        try { this._applyPrivateEvent({ kind: 'fill', data: fill }); }
        catch (error) { this._haltFromAsync(error); }
      },
      disconnected: () => {
        if (this.connectionState === 'HALTED') return;
        this._reconcileExpected = this._captureLiveOwnership();
        this._stream.beginBuffering();
        this._setState('RECONCILING', 'RISEx 私有 WebSocket 已断开');
      },
      authenticated: () => {
        if (this._initializing || this._manualReconnecting
          || this.connectionState === 'READY' || this.connectionState === 'HALTED') return;
        this._reconcileAfterAuthentication();
      },
      fatal: (error) => this._haltFromAsync(error),
    };
    this._streamHandlers = handlers;
    for (const [event, handler] of Object.entries(handlers)) this._stream.on?.(event, handler);
  }

  _unbindStream() {
    if (!this._streamHandlers || !this._stream?.off) return;
    for (const [event, handler] of Object.entries(this._streamHandlers)) this._stream.off(event, handler);
    this._streamHandlers = null;
  }

  _reconcileAfterAuthentication() {
    if (this._reconcilePromise) return this._reconcilePromise;
    const expected = this._reconcileExpected || this._captureLiveOwnership();
    this._reconcilePromise = this._synchronizeLiveState(expected, '自动重连')
      .catch((error) => this._haltFromAsync(error))
      .finally(() => { this._reconcilePromise = null; });
    return this._reconcilePromise;
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

  _seedRestSnapshot(snapshot, expectedOwnership = null) {
    this._officialOpen = new Map();
    this._restingIds = new Map();
    for (const { market, open } of snapshot.marketRows) {
      const openMap = new Map();
      for (const order of open) {
        if (openMap.has(order.orderId)) throw new Error(`RISEx REST 开放订单 ${order.orderId} 重复。`);
        const liveExpected = expectedOwnership?.get(order.orderId);
        if (expectedOwnership && !liveExpected) {
          throw new Error(`RISEx REST 检测到无法归属的开放订单 ${order.orderId}。`);
        }
        openMap.set(order.orderId, order);
        this._restingIds.set(order.orderId, order.restingOrderId);
        const expected = liveExpected || this._recoverySnapshot?.active.get(order.orderId);
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

  _captureLiveOwnership() {
    const expected = new Map();
    for (const marketId of this.markets.keys()) {
      for (const record of this.orderState.getOpen(marketId)) {
        expected.set(record.orderId, {
          ...record.meta,
          orderId: record.orderId,
          marketId: record.marketId,
          side: record.side,
          sizeBase: record.sizeBase,
          price: record.price,
        });
      }
    }
    return expected;
  }

  async _synchronizeLiveState(expected, reason) {
    const startedAt = this._now();
    const stream = this._stream;
    await stream.waitForOrderSnapshot();
    this.lastOrderAt = this._now();
    const snapshot = await this._readRestSnapshot();
    this._seedRestSnapshot(snapshot, expected);
    const buffered = stream.drainBuffered();
    for (const event of buffered) this._applyPrivateEvent(event);
    const wsOrderIds = new Set(buffered.filter((event) => event.kind === 'order').map((event) => event.data.orderId));
    this._validateLiveOwnership(snapshot, expected, wsOrderIds);
    stream.releaseBuffer();
    this._reconcileExpected = null;
    this.dataSource = 'real';
    this.lastOkAt = this._now();
    const restOpenCount = snapshot.marketRows.reduce((sum, row) => sum + row.open.length, 0);
    this._logger.log?.(
      `[RISEx] ${reason}对账完成：expected=${expected.size} REST open=${restOpenCount} WS buffered=${buffered.length}，耗时 ${this._now() - startedAt}ms`,
    );
    this._setState('READY', `${reason} REST/WS 对账完成`, { allowHalted: false });
  }

  _validateLiveOwnership(snapshot, expected, wsOrderIds) {
    const openIds = new Set(snapshot.marketRows.flatMap((row) => row.open).map((order) => order.orderId));
    const history = new Map(snapshot.marketRows.flatMap((row) => row.history).map((order) => [order.orderId, order]));
    const fillsByOrder = new Map();
    for (const fill of snapshot.marketRows.flatMap((row) => row.fills)) {
      const rows = fillsByOrder.get(fill.orderId) || [];
      rows.push(fill);
      fillsByOrder.set(fill.orderId, rows);
    }

    for (const [orderId, meta] of expected) {
      if (openIds.has(orderId)) {
        const record = this.orderState.get(orderId);
        if (!wsOrderIds.has(orderId) || !record || !['OPEN', 'PARTIAL', 'FILLED', 'CANCELLED'].includes(record.status)) {
          throw new Error(`RISEx 重连订单 ${orderId} 未被 Orders WebSocket 快照确认。`);
        }
        continue;
      }
      let record = this.orderState.get(orderId);
      if (record?.status === 'FILLED' || record?.status === 'CANCELLED') continue;
      const terminal = history.get(orderId);
      if (!terminal || (terminal.status !== 'FILLED' && terminal.status !== 'CANCELLED')) {
        throw new Error(`RISEx 重连订单 ${orderId} 无法确认开放或终态。`);
      }
      this.orderState.track({ ...meta, orderId });
      const fills = (fillsByOrder.get(orderId) || [])
        .sort((left, right) => compareRisexCursor(left.cursor, right.cursor));
      for (const fill of fills) this.orderState.applyFill(fill);
      const result = this.orderState.applyOrder(terminal);
      this._handleOrderResult(result, terminal);
      this._syncOfficialOrder(orderId);
      record = this.orderState.get(orderId);
      if (record?.status !== 'FILLED' && record?.status !== 'CANCELLED') {
        throw new Error(`RISEx 重连订单 ${orderId} 终态历史与私有流冲突。`);
      }
    }
    const unknown = this.orderState.unknownOrderIds();
    if (unknown.length) throw new Error(`RISEx 重连存在无法归属的私有订单：${unknown.join(', ')}。`);
  }

  _applyPrivateEvent(event) {
    if (!event || (event.kind !== 'order' && event.kind !== 'fill')) {
      throw new Error('RISEx 私有流事件类型未知。');
    }
    if (!this.markets.has(event.data.marketId)) {
      throw new Error(`RISEx 私有流收到未允许 market ${event.data.marketId}。`);
    }
    if (event.kind === 'fill') {
      this._logger.log?.(
        `[RISEx] fill ${event.data.fillId} order=${event.data.orderId} cursor=${event.data.cursor.block}:${event.data.cursor.log}:${event.data.cursor.timestamp}`,
      );
      const result = this.orderState.applyFill(event.data);
      if (result?.pending && !this._initializing && this._pendingPlaceCount === 0) {
        throw new Error(`RISEx 收到未知订单 ${event.data.orderId} 的成交。`);
      }
      return;
    }
    this.lastOrderAt = this._now();
    this._logger.log?.(
      `[RISEx] order ${event.data.orderId} status=${event.data.status} filled=${event.data.filledSize} cursor=${event.data.cursor.block}:${event.data.cursor.log}:${event.data.cursor.timestamp}`,
    );
    const result = this.orderState.applyOrder(event.data);
    if (result?.pending && !this._initializing && this._pendingPlaceCount === 0) {
      throw new Error(`RISEx 收到未知订单 ${event.data.orderId} 的状态。`);
    }
    this._handleOrderResult(result, event.data);
    this._syncOfficialOrder(event.data.orderId);
    this._notifyOrderWaiters(event.data.orderId);
  }

  _handleOrderResult(result, context) {
    if (!result?.terminal) return;
    this._officialOpen.get(Number(context.marketId))?.delete(String(context.orderId));
    if (!result.terminalFill) return;
    const suppressRequote = this._bulkCancel;
    this._defer(() => this.emit('fill', { ...result.terminalFill, suppressRequote }));
  }

  _syncOfficialOrder(orderId) {
    const record = this.orderState.get(orderId);
    if (!record) return;
    const open = this._officialOpen.get(record.marketId);
    if (!open) throw new Error(`RISEx market ${record.marketId} 缺少开放订单容器。`);
    if (record.status === 'OPEN' || record.status === 'PARTIAL') {
      open.set(record.orderId, {
        orderId: record.orderId,
        marketId: record.marketId,
        side: record.side,
        price: record.price,
        sizeBase: record.sizeBase,
        reduceOnly: record.meta.reduceOnly === true,
        levelIndex: record.meta.levelIndex,
        clientOrderId: record.meta.clientOrderId,
      });
      return;
    }
    if (record.status === 'FILLED' || record.status === 'CANCELLED') open.delete(record.orderId);
  }

  _notifyOrderWaiters(orderId) {
    const id = String(orderId);
    const waiters = this._orderWaiters.get(id);
    if (!waiters) return;
    this._orderWaiters.delete(id);
    for (const resolve of waiters) resolve();
  }

  async _waitForOrderUpdate(orderId, timeoutMs) {
    const id = String(orderId);
    let resolveUpdate;
    const update = new Promise((resolve) => { resolveUpdate = resolve; });
    const waiters = this._orderWaiters.get(id) || new Set();
    waiters.add(resolveUpdate);
    this._orderWaiters.set(id, waiters);
    try {
      await Promise.race([update, this._sleep(timeoutMs)]);
    } finally {
      const current = this._orderWaiters.get(id);
      current?.delete(resolveUpdate);
      if (current?.size === 0) this._orderWaiters.delete(id);
    }
  }

  async _confirmOrderFromRest(orderId, marketId) {
    const raw = await this._client.getOrderById(orderId, marketId);
    this.lastRestAt = this._now();
    if (raw == null) return false;
    const confirmed = normalizeRestOrderHistory(raw);
    if (confirmed.orderId !== orderId || confirmed.marketId !== marketId) {
      throw new Error(`RISEx 订单 ${orderId} 单笔确认身份不匹配。`);
    }
    const result = this.orderState.applyOrder(confirmed);
    this._handleOrderResult(result, confirmed);
    this._syncOfficialOrder(orderId);
    return true;
  }

  async _readOpenOrders(marketId) {
    const market = this.markets.get(Number(marketId));
    if (!market) throw new Error(`RISEx market ${marketId} 不受支持。`);
    const rows = await this._info.getOpenOrders(this.account, market.marketId);
    if (!Array.isArray(rows)) throw new Error(`RISEx market ${market.marketId} REST 开放订单格式非法。`);
    this.lastRestAt = this._now();
    return rows.map((row) => normalizeRestOpenOrder(row, market));
  }

  _replaceOfficialOpenFromRest(marketId, orders) {
    const id = Number(marketId);
    const next = new Map();
    for (const order of orders) {
      const record = this.orderState.get(order.orderId);
      if (!record) this._haltAndThrow(`RISEx market ${id} REST 出现无法归属的订单 ${order.orderId}。`);
      this.orderState.track({
        ...record.meta,
        orderId: order.orderId,
        marketId: order.marketId,
        side: order.side,
        sizeBase: order.sizeBase,
        price: order.price,
        sizeTolerance: this.markets.get(id).stepSize / 2,
      });
      this._restingIds.set(order.orderId, order.restingOrderId);
      if (record.status === 'OPEN' || record.status === 'PARTIAL') next.set(order.orderId, order);
    }
    this._officialOpen.set(id, next);
  }

  async _readPosition(marketId) {
    const id = Number(marketId);
    const position = normalizeRestPosition(await this._info.getPosition(id, this.account));
    this.lastRestAt = this._now();
    if (!position || position.sizeBase === 0) {
      this._positions.delete(id);
      return null;
    }
    if (position.marketId !== id) throw new Error(`RISEx market ${id} 仓位回读市场不匹配。`);
    this._positions.set(id, position);
    return position;
  }

  _assertWritable(marketId, action, { newRisk = false } = {}) {
    this._assertWriteBoundary(marketId, action, { newRisk });
  }

  _assertWriteBoundary(marketId, action, {
    newRisk = false,
    allowBulkCancel = false,
    allowClosingPosition = false,
  } = {}) {
    if (this.connectionState !== 'READY') {
      throw new Error(`RISEx ${action}被拒绝：${this.connectionState} ${this.haltReason || ''}`.trim());
    }
    if (this._bulkCancel && !allowBulkCancel) throw new Error(`RISEx ${action}被拒绝：正在批量撤单。`);
    if (this._closingPosition && !allowClosingPosition) throw new Error(`RISEx ${action}被拒绝：正在确认平仓。`);
    this._assertAllowedMarket(marketId, action);
    if (newRisk) {
      const health = this.getHealth();
      if (health.status === 'error') {
        throw new Error(`RISEx ${action}被拒绝：健康检查未通过（${health.reason}）。`);
      }
    }
  }

  _serialWrite(marketId, action, operation, boundaryOptions = {}) {
    const run = this._writeQueue.then(async () => {
      const startedAt = this._now();
      this._logger.log?.(`[RISEx] 写操作开始：${action}`);
      try {
        this._assertWriteBoundary(marketId, action, boundaryOptions);
        const result = await operation();
        this._logger.log?.(`[RISEx] 写操作完成：${action}，耗时 ${this._now() - startedAt}ms`);
        return result;
      } catch (error) {
        this._logger.error?.(`[RISEx] 写操作失败：${action}：${error?.message || String(error)}`);
        throw error;
      }
    });
    this._writeQueue = run.catch(() => undefined);
    return run;
  }

  _assertNoUnexpectedPrivateOrders() {
    const unknown = this.orderState.unknownOrderIds();
    if (unknown.length) this._haltAndThrow(`RISEx 私有流收到无法归属的订单：${unknown.join(', ')}。`);
  }

  _haltAndThrow(message) {
    const error = new Error(message);
    this.lastError = message;
    this._setState('HALTED', message);
    throw error;
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
      for (const fill of (fillsByOrder.get(orderId) || [])
        .sort((left, right) => compareRisexCursor(left.cursor, right.cursor))) {
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

  _setState(next, reason, { allowHalted = false } = {}) {
    if (this.connectionState === 'HALTED' && next !== 'HALTED' && !allowHalted) return;
    const previous = this.connectionState;
    this.connectionState = next;
    this.stateReason = reason;
    if (next === 'HALTED') this.haltReason = reason;
    else this.haltReason = null;
    this._logger.log?.(`[RISEx] 状态 ${previous} -> ${next}：${reason}`);
  }

  _haltFromAsync(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.lastError = normalized.message;
    this._setState('HALTED', normalized.message);
    this.emit('error', normalized);
  }
}
