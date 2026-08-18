import { EventEmitter } from 'node:events';
import { encodeBytes32String, formatUnits, parseUnits } from 'ethers';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import { strictAddress, strictDecimalString, strictIntegerString } from './normalize.js';

const MARKET_IDS = Object.freeze({ BTCUSDT: 20000, ETHUSDT: 20001 });
const SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT']);
const INTERVALS = new Map([
  [60, '1m'],
  [300, '5m'],
  [900, '15m'],
  [1800, '30m'],
  [3600, '1H'],
  [14400, '4H'],
  [86400, '1D'],
]);
const ACTIVE_ORDER_STATUSES = new Set([
  'WaitToSend',
  'PendingNew',
  'NewAccept',
  'PendingCancel',
  'PartiallyFilled',
]);

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`PopDEX ${field} 必须是正安全整数。`);
  }
  return value;
}

function exactNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('PopDEX now() 必须返回非负安全整数。');
  }
  return value;
}

function exactNumber(value, field, { positive = false } = {}) {
  const parsed = Number(strictDecimalString(value, field));
  if (!Number.isFinite(parsed) || (positive && parsed <= 0)) {
    throw new Error(`PopDEX ${field} 必须是${positive ? '正' : ''}有限数。`);
  }
  return parsed;
}

function exactNumeric(value, field, options) {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || (options?.positive && value <= 0)) {
    throw new Error(`PopDEX ${field} 必须是${options?.positive ? '正' : ''}有限数。`);
  }
  return value;
}

function decimalWad(value, field) {
  const normalized = strictDecimalString(value, field);
  if ((normalized.split('.')[1] ?? '').length > 18) {
    throw new Error(`PopDEX ${field} 最多支持 18 位小数。`);
  }
  return parseUnits(normalized, 18);
}

function wadNumber(value, field) {
  const normalized = strictIntegerString(value, field);
  const parsed = Number(formatUnits(normalized, 18));
  if (!Number.isFinite(parsed)) throw new Error(`PopDEX ${field} 超出可显示数值范围。`);
  return parsed;
}

function signedWadNumber(value, field) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`PopDEX ${field} 必须是整数字符串。`);
  }
  const parsed = Number(formatUnits(value, 18));
  if (!Number.isFinite(parsed)) throw new Error(`PopDEX ${field} 超出可显示数值范围。`);
  return parsed;
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function sanitizeError(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !messages.includes(message)) messages.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(' → ')
    .replace(/0x[0-9a-fA-F]{64}/g, '[redacted-hex32]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function stageError(stage, label, error) {
  const wrapped = new Error(`PopDEX ${label}失败：${sanitizeError(error)}`, { cause: error });
  wrapped.stage = stage;
  return wrapped;
}

async function atStage(stage, label, operation) {
  try {
    return await operation();
  } catch (error) {
    throw stageError(stage, label, error);
  }
}

function isTransient(error) {
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const code = String(current?.code ?? '');
    const name = String(current?.name ?? '');
    const message = current instanceof Error ? current.message : String(current);
    if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|ABORT_ERR/i.test(code)
        || /AbortError|TimeoutError|TypeError/i.test(name)
        || /fetch failed|network|网络失败|timeout|timed out|connection reset|socket/i.test(message)) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function exactMarket(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`market[${index}] 必须是对象。`);
  }
  const symbol = value.name;
  if (!SYMBOLS.includes(symbol) || value.displayName !== symbol) {
    throw new Error(`market[${index}] 名称不在 PopDEX 白名单。`);
  }
  const expected = POPDEX_EXPECTED_MARKETS[symbol];
  const expectedId = Number(expected.symbolId);
  if (value.marketId !== expectedId || value.symbol !== symbol.slice(0, -4)) {
    throw new Error(`PopDEX ${symbol} marketId 或 symbol 与主网身份不符。`);
  }
  for (const [field, expectedValue] of [
    ['stepPrice', Number(expected.tickSize)],
    ['stepSize', Number(expected.lotSize)],
    ['minOrderSize', Number(expected.minQty)],
    ['minNotional', Number(expected.minNotional)],
  ]) {
    if (value[field] !== expectedValue) {
      throw new Error(`PopDEX ${symbol} ${field} 与主网身份不符。`);
    }
  }
  if (!Number.isSafeInteger(value.defaultLeverage) || value.defaultLeverage <= 0) {
    throw new Error(`PopDEX ${symbol} defaultLeverage 必须是正安全整数。`);
  }
  return { ...value };
}

function exactMarkets(values) {
  if (!Array.isArray(values) || values.length !== 2) {
    throw new Error(`PopDEX markets 必须恰好包含 BTCUSDT 和 ETHUSDT，实际 ${String(values?.length)}。`);
  }
  const result = values.map(exactMarket);
  if (new Set(result.map((market) => market.marketId)).size !== 2
      || !SYMBOLS.every((symbol) => result.some((market) => market.name === symbol))) {
    throw new Error('PopDEX markets 存在重复或缺少目标市场。');
  }
  return result.sort((left, right) => left.marketId - right.marketId);
}

function exactTicker(value, symbol) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PopDEX ${symbol} ticker 必须是对象。`);
  }
  const ticker = Object.fromEntries(['bid', 'ask', 'last', 'index', 'mark']
    .map((field) => [field, exactNumeric(value[field], `${symbol} ticker.${field}`, { positive: true })]));
  if (ticker.bid >= ticker.ask) {
    throw new Error(`PopDEX ${symbol} ticker 必须满足 bid < ask。`);
  }
  return ticker;
}

function exactOverview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PopDEX overview 必须是对象。');
  }
  return {
    accountEquity: exactNumber(value.accountEquity, 'overview.accountEquity'),
    availableMargin: exactNumber(value.availableMargin, 'overview.availableMargin'),
    totalCollateral: exactNumber(value.totalCollateral, 'overview.totalCollateral'),
  };
}

function encodedClientOrderId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('PopDEX order.clientOid 必须是非空字符串。');
  }
  try {
    return encodeBytes32String(value).toLowerCase();
  } catch {
    return null;
  }
}

function exactOpenOrder(value, symbol, mainAccount, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PopDEX ${symbol} order[${index}] 必须是对象。`);
  }
  const walletId = strictAddress(value.walletId, `${symbol} order[${index}].walletId`);
  if (!sameAddress(walletId, mainAccount)) {
    throw new Error(`PopDEX ${symbol} order[${index}].walletId 与主账户不匹配。`);
  }
  const orderId = strictIntegerString(value.orderId, `${symbol} order[${index}].orderId`);
  if (BigInt(orderId) <= 0n) throw new Error(`PopDEX ${symbol} order[${index}].orderId 必须大于 0。`);
  if (value.symbol !== symbol || String(value.symbolId) !== String(MARKET_IDS[symbol])) {
    throw new Error(`PopDEX ${symbol} order[${index}] 市场身份冲突。`);
  }
  const side = value.side === 'Buy' ? 'buy' : value.side === 'Sell' ? 'sell' : null;
  if (side === null) throw new Error(`PopDEX ${symbol} order[${index}].side 无效。`);
  if (!ACTIVE_ORDER_STATUSES.has(value.status)) {
    throw new Error(`PopDEX ${symbol} order[${index}].status ${String(value.status)} 不是活动状态。`);
  }
  if (value.reduceOnly !== false) {
    throw new Error(`PopDEX ${symbol} order[${index}].reduceOnly 必须是 false。`);
  }
  const priceWad = decimalWad(value.price, `${symbol} order[${index}].price`);
  const qtyWad = decimalWad(value.qty, `${symbol} order[${index}].qty`);
  const filledQtyWad = decimalWad(value.filledQty, `${symbol} order[${index}].filledQty`);
  const remainingQtyWad = decimalWad(value.remainingQty, `${symbol} order[${index}].remainingQty`);
  const cancelledQtyWad = decimalWad(value.cancelledQty, `${symbol} order[${index}].cancelledQty`);
  if (priceWad <= 0n || qtyWad <= 0n
      || qtyWad !== filledQtyWad + remainingQtyWad + cancelledQtyWad
      || remainingQtyWad <= 0n) {
    throw new Error(`PopDEX ${symbol} order[${index}] 数量或价格事实冲突。`);
  }
  const clientOid = value.clientOid ?? value.clientOrderId ?? null;
  return {
    orderId,
    marketId: MARKET_IDS[symbol],
    symbol,
    side,
    price: Number(formatUnits(priceWad, 18)),
    sizeBase: Number(formatUnits(qtyWad, 18)),
    filledSizeBase: Number(formatUnits(filledQtyWad, 18)),
    remainingSizeBase: Number(formatUnits(remainingQtyWad, 18)),
    reduceOnly: false,
    status: value.status,
    clientOid,
    clientOrderId: encodedClientOrderId(clientOid),
    walletId,
    symbolId: String(MARKET_IDS[symbol]),
    isReduceOnly: false,
    priceWad: priceWad.toString(),
    qtyWad: qtyWad.toString(),
    filledQtyWad: filledQtyWad.toString(),
    remainingQtyWad: remainingQtyWad.toString(),
    cancelledQtyWad: cancelledQtyWad.toString(),
  };
}

function exactOrders(rowsBySymbol, mainAccount) {
  const orders = new Map(SYMBOLS.map((symbol) => [MARKET_IDS[symbol], new Map()]));
  const seen = new Set();
  for (const symbol of SYMBOLS) {
    const rows = rowsBySymbol.get(symbol);
    if (!Array.isArray(rows)) throw new Error(`PopDEX ${symbol} open orders 必须是数组。`);
    for (const [index, value] of rows.entries()) {
      const order = exactOpenOrder(value, symbol, mainAccount, index);
      if (seen.has(order.orderId)) throw new Error(`PopDEX orderId ${order.orderId} 重复。`);
      seen.add(order.orderId);
      orders.get(order.marketId).set(order.orderId, order);
    }
  }
  return orders;
}

function exactPositions(rows, mainAccount, tickers) {
  if (!Array.isArray(rows)) throw new Error('PopDEX positions 必须是数组。');
  const positions = new Map();
  const seenIds = new Set();
  for (const [index, value] of rows.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`PopDEX position[${index}] 必须是对象。`);
    }
    const walletId = strictAddress(value.walletId, `position[${index}].walletId`);
    if (!sameAddress(walletId, mainAccount)) {
      throw new Error(`PopDEX position.walletId 与主账户不匹配。`);
    }
    const positionId = strictIntegerString(value.positionId, `position[${index}].positionId`);
    if (BigInt(positionId) <= 0n || seenIds.has(positionId)) {
      throw new Error(`PopDEX positionId ${positionId} 无效或重复。`);
    }
    seenIds.add(positionId);
    const symbolId = strictIntegerString(value.symbolId, `position[${index}].symbolId`);
    const marketId = Number(symbolId);
    const symbol = SYMBOLS.find((candidate) => MARKET_IDS[candidate] === marketId);
    if (!symbol) throw new Error(`PopDEX position symbolId ${symbolId} 不在白名单。`);
    if (positions.has(marketId)) throw new Error(`PopDEX market ${marketId} 持仓重复。`);
    if (value.side !== '1' && value.side !== '2') {
      throw new Error(`PopDEX position[${index}].side 必须是 Long=1 或 Short=2。`);
    }
    const quantity = wadNumber(value.holdSizeWad, `position[${index}].holdSizeWad`);
    const entryPrice = wadNumber(value.avgOpenPriceWad, `position[${index}].avgOpenPriceWad`);
    const realizedPnl = signedWadNumber(
      value.realizedPnlWad,
      `position[${index}].realizedPnlWad`,
    );
    if (quantity <= 0 || entryPrice <= 0) {
      throw new Error(`PopDEX position[${index}] 数量和开仓价必须大于 0。`);
    }
    const sizeBase = value.side === '1' ? quantity : -quantity;
    const markPrice = tickers.get(marketId).mark;
    positions.set(marketId, {
      positionId,
      marketId,
      symbol,
      side: value.side === '1' ? 'long' : 'short',
      sizeBase,
      entryPrice,
      markPrice,
      unrealizedPnl: sizeBase * (markPrice - entryPrice),
      realizedPnl,
      walletId,
      holdSizeWad: value.holdSizeWad,
    });
  }
  return positions;
}

function cloneOrders(source) {
  return new Map([...source].map(([marketId, orders]) => [
    marketId,
    new Map([...orders].map(([orderId, order]) => [orderId, { ...order }])),
  ]));
}

function emptySnapshot() {
  return {
    markets: new Map(),
    tickers: new Map(),
    orders: new Map(),
    positions: new Map(),
    overview: null,
    authorization: null,
  };
}

export class PopdexExchange extends EventEmitter {
  constructor({
    mainAccount,
    publicClient,
    accountClient,
    readRpc,
    tradingClient,
    journal,
    now = () => Date.now(),
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    pollMs = 10000,
    staleMs = 30000,
  } = {}) {
    super();
    this.mode = 'live';
    this.mainAccount = strictAddress(mainAccount, 'mainAccount');
    for (const [name, dependency] of Object.entries({
      publicClient, accountClient, readRpc, tradingClient, journal,
    })) {
      if (!dependency || typeof dependency !== 'object') {
        throw new Error(`PopDEX ${name} 必须是对象。`);
      }
    }
    if (typeof now !== 'function'
        || typeof setIntervalImpl !== 'function'
        || typeof clearIntervalImpl !== 'function') {
      throw new Error('PopDEX now 和定时器依赖必须是函数。');
    }
    this.publicClient = publicClient;
    this.accountClient = accountClient;
    this.readRpc = readRpc;
    this.tradingClient = tradingClient;
    this.journal = journal;
    this.now = now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.pollMs = positiveSafeInteger(pollMs, 'pollMs');
    this.staleMs = positiveSafeInteger(staleMs, 'staleMs');

    this.state = 'RECONCILING';
    this.dataSource = null;
    this.lastPublicOkAt = 0;
    this.lastAccountOkAt = 0;
    this.lastAuthorizationOkAt = 0;
    this.lastErrorStage = null;
    this.lastErrorMessage = null;
    this.writeInFlight = false;
    this.snapshot = emptySnapshot();
    this.balance = null;
    this.equity = null;
    this.realizedPnl = 0;
    this.refreshPromise = null;
    this.timer = null;
  }

  #setState(state, reason = null) {
    const previous = this.state;
    this.state = state;
    if (previous !== state || reason !== null) {
      this.emit('state', { previous, state, reason });
    }
  }

  #assertMarket(marketId) {
    const id = Number(marketId);
    if (!Number.isSafeInteger(id) || !this.snapshot.markets.has(id)) {
      throw new Error(`PopDEX marketId ${String(marketId)} 不在已验证市场中。`);
    }
    return id;
  }

  async #buildSnapshot(checkJournal) {
    if (checkJournal) {
      const recovery = await atStage('journal-recovery', '恢复日志检查', async () => this.journal.load());
      if (recovery !== null) {
        const error = new Error(
          `发现未完成 ${String(recovery.kind)} 操作 stage=${String(recovery.stage)}，需要只读恢复。`,
        );
        error.stage = 'journal-recovery';
        throw error;
      }
    }
    const marketList = await atStage(
      'public-refresh',
      '公共市场刷新',
      async () => exactMarkets(await this.publicClient.getMarkets()),
    );
    const tickerRows = await atStage('public-refresh', '公共行情刷新', () => Promise.all(
      marketList.map(async (market) => [market.marketId, exactTicker(
        await this.publicClient.getTicker(market.name),
        market.name,
      )]),
    ));
    const authorization = await atStage(
      'authorization-refresh',
      'Agent 授权刷新',
      async () => {
        const result = await this.tradingClient.preflight();
        if (!result || typeof result !== 'object'
            || !sameAddress(
              strictAddress(result.mainAccount, 'authorization.mainAccount'),
              this.mainAccount,
            )
            || typeof result.agent !== 'string') {
          throw new Error('授权身份与适配器不匹配。');
        }
        strictAddress(result.agent, 'authorization.agent');
        strictIntegerString(result.expiresAt, 'authorization.expiresAt');
        return result;
      },
    );
    const accountSnapshot = await atStage(
      'account-refresh',
      '账户刷新',
      async () => {
        const [overview, btcOrders, ethOrders, positions] = await Promise.all([
          this.accountClient.getOverview(this.mainAccount),
          this.accountClient.getAllOpenOrders(this.mainAccount, 'BTCUSDT'),
          this.accountClient.getAllOpenOrders(this.mainAccount, 'ETHUSDT'),
          this.readRpc.getAllOpenPositions(this.mainAccount),
        ]);
        const orderRows = new Map([
          ['BTCUSDT', btcOrders],
          ['ETHUSDT', ethOrders],
        ]);
        const tickers = new Map(tickerRows);
        return {
          overview: exactOverview(overview),
          orders: exactOrders(orderRows, this.mainAccount),
          positions: exactPositions(positions, this.mainAccount, tickers),
        };
      },
    );
    const tickers = new Map(tickerRows);
    return {
      markets: new Map(marketList.map((market) => [market.marketId, market])),
      tickers,
      orders: accountSnapshot.orders,
      positions: accountSnapshot.positions,
      overview: accountSnapshot.overview,
      authorization: { ...authorization },
    };
  }

  #publish(candidate) {
    const now = exactNow(this.now);
    this.snapshot = {
      markets: new Map([...candidate.markets].map(([id, value]) => [id, { ...value }])),
      tickers: new Map([...candidate.tickers].map(([id, value]) => [id, { ...value }])),
      orders: cloneOrders(candidate.orders),
      positions: new Map([...candidate.positions].map(([id, value]) => [id, { ...value }])),
      overview: { ...candidate.overview },
      authorization: { ...candidate.authorization },
    };
    this.balance = candidate.overview.availableMargin;
    this.equity = candidate.overview.accountEquity;
    this.realizedPnl = [...candidate.positions.values()]
      .reduce((total, position) => total + position.realizedPnl, 0);
    this.lastPublicOkAt = now;
    this.lastAccountOkAt = now;
    this.lastAuthorizationOkAt = now;
    this.lastErrorStage = null;
    this.lastErrorMessage = null;
    this.dataSource = 'real';
    this.#setState('READY', '完整官方快照已验证');
  }

  async #reconcile(reason, allowHalted, checkJournal) {
    if (this.state === 'HALTED' && !allowHalted) {
      throw new Error('PopDEX 当前为 HALTED，必须人工重连。');
    }
    this.#setState('RECONCILING', reason);
    try {
      this.#publish(await this.#buildSnapshot(checkJournal));
      return this;
    } catch (error) {
      this.lastErrorStage = error?.stage ?? 'reconcile';
      this.lastErrorMessage = sanitizeError(error);
      if (this.lastPublicOkAt === 0) this.dataSource = null;
      this.#setState(isTransient(error) ? 'RECONCILING' : 'HALTED', this.lastErrorMessage);
      throw error;
    }
  }

  async init() {
    await this.#reconcile('init', false, true);
    this.start();
    return this;
  }

  async reconnect() {
    await this.#reconcile('manual-reconnect', true, true);
    this.start();
    return this;
  }

  refresh() {
    if (this.state === 'HALTED') {
      return Promise.reject(new Error('PopDEX 当前为 HALTED，必须人工重连。'));
    }
    if (this.refreshPromise !== null) return this.refreshPromise;
    this.refreshPromise = this.#reconcile('refresh', false, false)
      .finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async getMarkets() {
    return [...this.snapshot.markets.values()].map((market) => ({ ...market }));
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const id = this.#assertMarket(marketId);
    if (!INTERVALS.has(intervalSec)) {
      throw new Error(`PopDEX candle intervalSec ${String(intervalSec)} 不受支持。`);
    }
    if (!Number.isSafeInteger(n) || n <= 0 || n > 1000) {
      throw new Error('PopDEX candle n 必须是 1-1000 的安全整数。');
    }
    const symbol = this.snapshot.markets.get(id).name;
    const rows = await this.publicClient.getCandles(symbol, INTERVALS.get(intervalSec), n);
    if (!Array.isArray(rows)) throw new Error(`PopDEX ${symbol} candles 必须是数组。`);
    return rows.map((row, index) => {
      const timeText = strictIntegerString(row?.time, `${symbol} candle[${index}].time`);
      const time = Number(timeText);
      if (!Number.isSafeInteger(time)) {
        throw new Error(`PopDEX ${symbol} candle[${index}].time 不是安全整数。`);
      }
      return {
        time,
        open: exactNumeric(row.open, `${symbol} candle[${index}].open`, { positive: true }),
        high: exactNumeric(row.high, `${symbol} candle[${index}].high`, { positive: true }),
        low: exactNumeric(row.low, `${symbol} candle[${index}].low`, { positive: true }),
        close: exactNumeric(row.close, `${symbol} candle[${index}].close`, { positive: true }),
      };
    });
  }

  async getPrice(marketId) {
    const id = this.#assertMarket(marketId);
    if (this.lastPublicOkAt === 0 || exactNow(this.now) - this.lastPublicOkAt > this.staleMs) {
      throw new Error(`PopDEX market ${id} 行情已过期。`);
    }
    return this.snapshot.tickers.get(id).mark;
  }

  async setLeverage() {
    throw new Error('PopDEX Stage 6 live 写操作尚未实现。');
  }

  async placeLimitOrder() {
    throw new Error('PopDEX Stage 6 live 写操作尚未实现。');
  }

  async cancelOrder() {
    throw new Error('PopDEX Stage 6 live 写操作尚未实现。');
  }

  async cancelAll() {
    throw new Error('PopDEX Stage 6 live 写操作尚未实现。');
  }

  getOpenOrders(marketId) {
    const id = this.#assertMarket(marketId);
    return [...(this.snapshot.orders.get(id) ?? new Map()).values()]
      .map((order) => ({ ...order }));
  }

  async fetchOpenOrders(marketId) {
    const id = this.#assertMarket(marketId);
    await this.refresh();
    return this.getOpenOrders(id);
  }

  adoptOrder() {
    throw new Error('PopDEX Stage 6 live 订单接管尚未实现。');
  }

  getPosition(marketId) {
    const id = this.#assertMarket(marketId);
    const position = this.snapshot.positions.get(id);
    return position ? { ...position } : null;
  }

  async closePosition() {
    throw new Error('PopDEX Stage 6 live 写操作尚未实现。');
  }

  start() {
    if (this.timer !== null) return;
    this.timer = this.setIntervalImpl(() => {
      if (this.state === 'HALTED') return;
      this.refresh().catch((error) => this.emit('fault', error));
    }, this.pollMs);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer !== null) this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  getHealth() {
    const now = exactNow(this.now);
    const publicAgeMs = this.lastPublicOkAt > 0 ? Math.max(0, now - this.lastPublicOkAt) : null;
    const accountAgeMs = this.lastAccountOkAt > 0 ? Math.max(0, now - this.lastAccountOkAt) : null;
    const stale = publicAgeMs === null || accountAgeMs === null
      || publicAgeMs > this.staleMs || accountAgeMs > this.staleMs;
    return {
      state: this.state,
      status: this.state === 'READY' && !stale ? 'ok' : 'error',
      lastPublicOkAt: this.lastPublicOkAt,
      lastAccountOkAt: this.lastAccountOkAt,
      lastAuthorizationOkAt: this.lastAuthorizationOkAt,
      publicAgeMs,
      accountAgeMs,
      stale,
      lastErrorStage: this.lastErrorStage,
      lastErrorMessage: this.lastErrorMessage,
      writeInFlight: this.writeInFlight,
      dataSource: this.dataSource,
    };
  }
}
