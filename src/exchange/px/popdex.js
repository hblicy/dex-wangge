import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { encodeBytes32String, formatUnits, parseUnits } from 'ethers';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import {
  createBtcCloseClientOrderId,
  parseLeverageUpdatedReceipt,
} from './fill-close-codec.js';
import { classifyClose, exactBtcLeverage } from './fill-close-state.js';
import { strictAddress, strictDecimalString, strictIntegerString } from './normalize.js';
import { prepareLimitOrder } from './order-codec.js';
import { parseOrderCancelReceipt, parseOrderCreateReceipt } from './receipt-events.js';

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
  if (typeof value.reduceOnly !== 'boolean') {
    throw new Error(`PopDEX ${symbol} order[${index}].reduceOnly 必须是布尔值。`);
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
    reduceOnly: value.reduceOnly,
    status: value.status,
    clientOid,
    clientOrderId: encodedClientOrderId(clientOid),
    walletId,
    symbolId: String(MARKET_IDS[symbol]),
    isReduceOnly: value.reduceOnly,
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

function exactGridIntent({ side, reduceOnly, levelIndex, opening, intentId, parentFillEventId }) {
  if (!Number.isSafeInteger(levelIndex) || levelIndex < 0) {
    throw new Error('PopDEX levelIndex 必须是非负安全整数。');
  }
  if (typeof intentId !== 'string' || intentId.length === 0 || intentId.length > 300
      || /[\r\n]/.test(intentId)) {
    throw new Error('PopDEX intentId 必须是 1-300 字符的单行字符串。');
  }
  if (typeof opening !== 'boolean' || typeof reduceOnly !== 'boolean'
      || opening === reduceOnly) {
    throw new Error('PopDEX opening 与 reduceOnly 必须是互斥布尔值。');
  }
  if ((opening && side !== 'buy') || (reduceOnly && side !== 'sell')) {
    throw new Error('PopDEX long-only 网格只允许 buy opening 或 sell reduce-only。');
  }
  if (parentFillEventId !== null
      && (typeof parentFillEventId !== 'string'
        || !/^px-fill-[0-9a-f]{64}$/.test(parentFillEventId))) {
    throw new Error('PopDEX parentFillEventId 无效。');
  }
  if (reduceOnly && parentFillEventId === null) {
    throw new Error('PopDEX reduce-only 补单必须包含 parentFillEventId。');
  }
  return { levelIndex, opening, intentId, reduceOnly, parentFillEventId };
}

function durableOrderMetadata(order) {
  return {
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    marketId: order.marketId,
    side: order.side,
    price: wadNumber(order.priceWad, 'ownership.priceWad'),
    sizeBase: wadNumber(order.qtyWad, 'ownership.qtyWad'),
    reduceOnly: order.reduceOnly,
    levelIndex: order.levelIndex,
    opening: order.opening,
    parentFillEventId: order.parentFillEventId,
  };
}

function durableOrderFromPlacement(plan, order, intent) {
  return {
    orderId: String(order.orderId),
    clientOrderId: plan.clientOrderId,
    marketId: MARKET_IDS.BTCUSDT,
    levelIndex: intent.levelIndex,
    side: plan.side,
    priceWad: plan.priceWad,
    qtyWad: plan.qtyWad,
    opening: intent.opening,
    reduceOnly: intent.reduceOnly,
    parentFillEventId: intent.parentFillEventId,
    state: 'OPEN',
    filledQtyWad: '0',
    fillIds: [],
    terminalEvent: null,
  };
}

function sameDurablePlacement(left, right) {
  return left.orderId === right.orderId
    && left.clientOrderId === right.clientOrderId
    && left.marketId === right.marketId
    && left.levelIndex === right.levelIndex
    && left.side === right.side
    && left.priceWad === right.priceWad
    && left.qtyWad === right.qtyWad
    && left.opening === right.opening
    && left.reduceOnly === right.reduceOnly
    && left.parentFillEventId === right.parentFillEventId;
}

export class PopdexExchange extends EventEmitter {
  constructor({
    mainAccount,
    publicClient,
    accountClient,
    readRpc,
    tradingClient,
    journal,
    ownershipStore,
    reconciler,
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
      publicClient, accountClient, readRpc, tradingClient, journal, ownershipStore, reconciler,
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
    this.ownershipStore = ownershipStore;
    this.reconciler = reconciler;
    this.strictOrderRecovery = true;
    this.requiresDurableFillAck = true;
    this.releasedFillEvents = new Set();
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
    this.ownedOrders = new Map();
    this.writeTail = Promise.resolve();
    this.lastQueueError = null;
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

  #assertLiveWriteMarket(marketId, operation) {
    const id = this.#assertMarket(marketId);
    if (id === MARKET_IDS.ETHUSDT) {
      throw new Error(`PopDEX ETHUSDT ${operation}实盘写操作尚未开放。`);
    }
    if (id !== MARKET_IDS.BTCUSDT) {
      throw new Error(`PopDEX market ${id} ${operation}实盘写操作不受支持。`);
    }
    return id;
  }

  #assertReadyForWrite(operation) {
    const health = this.getHealth();
    if (health.state !== 'READY' || health.status !== 'ok') {
      throw new Error(
        `PopDEX ${operation}被拒绝：当前状态 ${health.state}`
        + `${health.stale ? '，官方快照已过期' : ''}。`,
      );
    }
    if (!this.snapshot.authorization) {
      throw new Error(`PopDEX ${operation}被拒绝：缺少已验证 Agent 授权。`);
    }
  }

  #writeIdentity(kind, fields = {}) {
    return {
      kind,
      mainAccount: this.mainAccount,
      agentAddress: this.snapshot.authorization.agent,
      symbol: 'BTCUSDT',
      symbolId: '20000',
      ...fields,
    };
  }

  #haltWrite(operation, error) {
    this.lastErrorStage = `write-${operation}`;
    this.lastErrorMessage = sanitizeError(error);
    this.#setState('HALTED', this.lastErrorMessage);
    this.emit('fault', error);
  }

  #finishPreparedAfterFailure() {
    const record = this.journal.load();
    if (record?.stage !== 'PREPARED') return;
    this.journal.completePreparedWithoutBroadcast('safe-no-broadcast');
    this.journal.clearConfirmed();
  }

  #enqueueWrite(operation, task) {
    const run = this.writeTail.then(async () => {
      this.#assertReadyForWrite(operation);
      this.writeInFlight = operation;
      try {
        const result = await task();
        this.lastQueueError = null;
        return result;
      } catch (originalError) {
        let error = originalError;
        try {
          this.#finishPreparedAfterFailure();
        } catch (journalError) {
          error = new AggregateError(
            [originalError, journalError],
            `PopDEX ${operation}失败，且 PREPARED 日志安全清理失败。`,
          );
        }
        this.#haltWrite(operation, error);
        throw error;
      } finally {
        this.writeInFlight = false;
      }
    });
    this.writeTail = run.catch((error) => {
      this.lastQueueError = sanitizeError(error);
    });
    return run;
  }

  async #refreshAndClearConfirmed(operation) {
    try {
      await this.refresh();
    } catch (error) {
      throw stageError(`write-${operation}-refresh`, '写后官方快照刷新', error);
    }
    this.journal.clearConfirmed();
  }

  #officialOrder(marketId, orderId) {
    return this.snapshot.orders.get(marketId)?.get(String(orderId)) ?? null;
  }

  async #cancelOwnedOrder(owned) {
    const official = this.#officialOrder(MARKET_IDS.BTCUSDT, owned.orderId);
    if (official === null) {
      throw new Error(`PopDEX 订单 ${owned.orderId} 不在当前官方活动订单中，拒绝盲目撤单。`);
    }
    if (official.clientOrderId !== owned.clientOrderId) {
      throw new Error(`PopDEX 订单 ${owned.orderId} clientOrderId 与所有权记录冲突。`);
    }
    this.journal.create(this.#writeIdentity('cancel', {
      orderId: official.orderId,
      clientOrderId: official.clientOrderId,
    }));
    await this.tradingClient.cancelAdapterOrder({
      ...official,
      side: official.side === 'buy' ? '0' : '1',
      isReduceOnly: official.reduceOnly,
    }, this.journal);
    try {
      await this.refresh();
    } catch (error) {
      throw stageError('write-cancel-refresh', '撤单后官方快照刷新', error);
    }
    const reconciliation = await this.#reconcileOwned({
      marketId: MARKET_IDS.BTCUSDT,
      reason: `cancel:${official.orderId}`,
      suppressRequote: true,
    });
    if (reconciliation.activeOrders.some((order) => order.orderId === official.orderId)) {
      throw new Error(`PopDEX 订单 ${official.orderId} 撤单后仍为活动状态。`);
    }
    this.ownedOrders.delete(official.orderId);
    this.journal.clearConfirmed();
  }

  async #buildSnapshot() {
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

  #validateRecoveryIdentity(record, authorization) {
    if (!record || typeof record !== 'object') {
      throw new Error('PopDEX 恢复记录必须是对象。');
    }
    const mainAccount = strictAddress(record.mainAccount, 'recovery.mainAccount');
    const agentAddress = strictAddress(record.agentAddress, 'recovery.agentAddress');
    if (!sameAddress(mainAccount, this.mainAccount)
        || !sameAddress(agentAddress, authorization.agent)) {
      throw new Error('PopDEX 恢复记录账户或 Agent 身份与当前授权不匹配。');
    }
    if (record.symbol !== 'BTCUSDT' || record.symbolId !== '20000') {
      throw new Error('PopDEX 恢复记录只允许 BTCUSDT symbolId=20000。');
    }
  }

  async #exactRecoveryReceipt(record) {
    const receipt = await this.readRpc.getReceipt(record.txHash);
    if (receipt === null) {
      throw new Error(`PopDEX BROADCAST ${record.kind} 回执不可用：txHash=${record.txHash}。`);
    }
    if (!receipt || typeof receipt !== 'object'
        || typeof receipt.transactionHash !== 'string'
        || receipt.transactionHash.toLowerCase() !== record.txHash.toLowerCase()) {
      throw new Error(`PopDEX BROADCAST ${record.kind} 回执交易哈希冲突。`);
    }
    if (receipt.status !== '0x1') {
      throw new Error(`PopDEX BROADCAST ${record.kind} 回执未成功：status=${String(receipt.status)}。`);
    }
    return receipt;
  }

  async #recoverPlace(record, receipt) {
    const order = parseOrderCreateReceipt(receipt, {
      account: record.mainAccount,
      symbolId: record.symbolId,
      clientOrderId: record.clientOrderId,
      priceWad: decimalWad(record.price, 'recovery.place.price').toString(),
      qtyWad: decimalWad(record.qty, 'recovery.place.qty').toString(),
    });
    const official = exactOpenOrder(
      await this.accountClient.findUniqueOrderByClientId(
        this.mainAccount,
        'BTCUSDT',
        record.clientOrderId,
      ),
      'BTCUSDT',
      this.mainAccount,
      0,
    );
    if (official.orderId !== order.orderId
        || official.clientOrderId !== record.clientOrderId
        || official.side !== record.side
        || official.reduceOnly !== (record.reduceOnly ?? false)
        || official.priceWad !== decimalWad(record.price, 'recovery.place.price').toString()
        || official.qtyWad !== decimalWad(record.qty, 'recovery.place.qty').toString()) {
      throw new Error('PopDEX BROADCAST place 官方订单身份冲突。');
    }
    if (record.intentId !== null) {
      this.ownershipStore.upsertOrder(durableOrderFromPlacement({
        side: record.side,
        clientOrderId: record.clientOrderId,
        priceWad: decimalWad(record.price, 'recovery.place.price').toString(),
        qtyWad: decimalWad(record.qty, 'recovery.place.qty').toString(),
      }, order, {
        levelIndex: record.levelIndex,
        opening: record.opening,
        reduceOnly: record.reduceOnly,
        parentFillEventId: record.parentFillEventId,
      }));
    }
    this.journal.advance('BROADCAST', 'CONFIRMED', { orderId: order.orderId });
  }

  async #recoverCancel(record, receipt) {
    parseOrderCancelReceipt(receipt, {
      account: record.mainAccount,
      orderId: record.orderId,
      clientOrderId: record.clientOrderId,
    });
    let official = null;
    try {
      official = await this.accountClient.findUniqueOrderByClientId(
        this.mainAccount,
        'BTCUSDT',
        record.clientOrderId,
      );
    } catch (error) {
      if (error?.code !== 'POPDEX_ORDER_NOT_FOUND') throw error;
    }
    if (official !== null) {
      if (String(official.orderId) !== record.orderId
          || !['Cancelled', 'PartiallyFilledCancelled'].includes(official.status)
          || decimalWad(official.filledQty, 'recovery.cancel.filledQty') !== 0n
          || decimalWad(official.remainingQty, 'recovery.cancel.remainingQty') !== 0n) {
        throw new Error('PopDEX BROADCAST cancel 官方订单终态冲突。');
      }
    } else {
      const [fills, positions] = await Promise.all([
        this.accountClient.getAllFills(this.mainAccount, 'BTCUSDT'),
        this.readRpc.getAllOpenPositions(this.mainAccount),
      ]);
      if (!Array.isArray(fills) || !Array.isArray(positions)) {
        throw new Error('PopDEX BROADCAST cancel 官方成交或仓位快照无效。');
      }
      if (fills.some((fill) => String(fill?.orderId) === record.orderId)) {
        throw new Error('PopDEX BROADCAST cancel 订单已经发生成交。');
      }
      if (positions.some((position) => String(position?.symbolId) === '20000'
          && BigInt(strictIntegerString(position.holdSizeWad, 'recovery.position.holdSizeWad')) > 0n)) {
        throw new Error('PopDEX BROADCAST cancel 后 BTCUSDT 仍有仓位。');
      }
    }
    this.journal.advance('BROADCAST', 'CONFIRMED');
  }

  async #recoverClose(record, receipt) {
    const closeQtyWad = decimalWad(record.qty, 'recovery.close.qty').toString();
    const order = parseOrderCreateReceipt(receipt, {
      account: record.mainAccount,
      symbolId: record.symbolId,
      clientOrderId: record.closeClientOrderId,
      priceWad: '0',
      priceRule: 'positive-execution',
      qtyWad: closeQtyWad,
    });
    const [fills, openOrders, positions] = await Promise.all([
      this.accountClient.getAllFills(this.mainAccount, 'BTCUSDT'),
      this.accountClient.getAllOpenOrders(this.mainAccount, 'BTCUSDT'),
      this.readRpc.getAllOpenPositions(this.mainAccount),
    ]);
    const result = classifyClose({
      mainAccount: this.mainAccount,
      closeOrderId: order.orderId,
      closeQtyWad,
      closeClientOrderId: record.closeClientOrderId,
    }, { fills, openOrders, positions });
    if (result.kind !== 'completed-flat') {
      throw new Error(
        `PopDEX BROADCAST close 官方终态未确认：kind=${result.kind} `
        + `remaining=${result.remainingPositionQtyWad}。`,
      );
    }
    this.journal.advance('BROADCAST', 'CONFIRMED', { closeOrderId: order.orderId });
  }

  async #recoverOperation(record, authorization) {
    this.#validateRecoveryIdentity(record, authorization);
    if (record.stage === 'CONFIRMED') return;
    if (record.stage === 'PREPARED') {
      if (record.txHash !== null) {
        throw new Error('PopDEX PREPARED 恢复记录不能包含 txHash。');
      }
      this.journal.completePreparedWithoutBroadcast('safe-no-broadcast');
      return;
    }
    if (record.stage !== 'BROADCAST' || typeof record.txHash !== 'string') {
      throw new Error(`PopDEX 恢复阶段 ${String(record.stage)} 无效。`);
    }
    const receipt = await this.#exactRecoveryReceipt(record);
    if (record.kind === 'leverage') {
      parseLeverageUpdatedReceipt(receipt, { mainAccount: record.mainAccount });
      if (exactBtcLeverage(await this.readRpc.getAccountConfig(this.mainAccount)) !== '1') {
        throw new Error('PopDEX BROADCAST leverage 官方回读不是 BTCUSDT 1x。');
      }
      this.journal.advance('BROADCAST', 'CONFIRMED');
      return;
    }
    if (record.kind === 'place') return this.#recoverPlace(record, receipt);
    if (record.kind === 'cancel') return this.#recoverCancel(record, receipt);
    if (record.kind === 'close') return this.#recoverClose(record, receipt);
    throw new Error(`PopDEX 恢复操作 kind ${String(record.kind)} 无效。`);
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
    let recoveryRecord = null;
    try {
      if (checkJournal) {
        recoveryRecord = await atStage(
          'journal-recovery',
          '恢复日志读取',
          async () => this.journal.load(),
        );
      }
      let candidate = await this.#buildSnapshot();
      if (recoveryRecord !== null) {
        await atStage(
          'journal-recovery',
          '只读恢复',
          () => this.#recoverOperation(recoveryRecord, candidate.authorization),
        );
        candidate = await this.#buildSnapshot();
      }
      this.#publish(candidate);
      if (recoveryRecord !== null) {
        await atStage('journal-recovery', '恢复日志清理', async () => this.journal.clearConfirmed());
      }
      return this;
    } catch (error) {
      this.lastErrorStage = error?.stage ?? 'reconcile';
      this.lastErrorMessage = sanitizeError(error);
      if (this.lastPublicOkAt === 0) this.dataSource = null;
      const nextState = recoveryRecord !== null || !isTransient(error) ? 'HALTED' : 'RECONCILING';
      this.#setState(nextState, this.lastErrorMessage);
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

  async setLeverage(marketId, leverage) {
    this.#assertLiveWriteMarket(marketId, '设置杠杆');
    if (leverage !== 1 && leverage !== '1') {
      throw new Error('PopDEX BTCUSDT 实盘只允许设置 1x 杠杆。');
    }
    return this.#enqueueWrite('set-leverage', async () => {
      this.journal.create(this.#writeIdentity('leverage', { leverage: '1' }));
      await this.tradingClient.setAdapterBtcLeverageOne(this.journal);
      await this.#refreshAndClearConfirmed('set-leverage');
      return true;
    });
  }

  async placeLimitOrder({
    marketId,
    side,
    price,
    sizeBase,
    reduceOnly = false,
    levelIndex,
    opening,
    intentId,
    parentFillEventId = null,
  } = {}) {
    this.#assertLiveWriteMarket(marketId, '限价下单');
    const intent = exactGridIntent({
      side, reduceOnly, levelIndex, opening, intentId, parentFillEventId,
    });
    const ticker = this.snapshot.tickers.get(MARKET_IDS.BTCUSDT);
    const plan = prepareLimitOrder({
      mainAccount: this.mainAccount,
      symbol: 'BTCUSDT',
      side,
      price: String(price),
      qty: String(sizeBase),
      bid: String(ticker.bid),
      ask: String(ticker.ask),
      randomBytesImpl: randomBytes,
      nowMs: exactNow(this.now),
      reduceOnly,
      positionSide: '0',
      intentId,
    });

    if (reduceOnly) {
      const position = this.snapshot.positions.get(MARKET_IDS.BTCUSDT);
      if (!position || position.side !== 'long' || position.sizeBase <= 0) {
        throw new Error('PopDEX reduce-only sell 必须有已验证 BTCUSDT 多仓。');
      }
      if (BigInt(plan.qtyWad) > BigInt(position.holdSizeWad)) {
        throw new Error('PopDEX reduce-only sell 数量超过已验证 BTCUSDT 多仓。');
      }
    }

    const existing = this.ownershipStore.listOrders()
      .find((order) => order.clientOrderId === plan.clientOrderId);
    if (existing) {
      const expected = durableOrderFromPlacement(plan, { orderId: existing.orderId }, intent);
      if (!sameDurablePlacement(existing, expected)) {
        const error = new Error(`PopDEX intentId ${intentId} 与已有所有权事实冲突。`);
        this.haltFromBot(error);
        throw error;
      }
      return durableOrderMetadata(existing);
    }

    return this.#enqueueWrite('place-limit-order', async () => {
      this.journal.create(this.#writeIdentity('place', {
        side: plan.side,
        price: plan.price,
        qty: plan.qty,
        clientOrderId: plan.clientOrderId,
        intentId,
        levelIndex,
        opening,
        reduceOnly,
        parentFillEventId,
      }));
      const order = await this.tradingClient.placeAdapterOrder(plan, this.journal);
      if (Boolean(order.isReduceOnly) !== reduceOnly
          || String(order.priceWad) !== plan.priceWad
          || String(order.qtyWad) !== plan.qtyWad) {
        throw new Error('PopDEX 下单回执与网格意图不匹配。');
      }
      const durable = durableOrderFromPlacement(plan, order, intent);
      this.ownershipStore.upsertOrder(durable);
      const owned = durableOrderMetadata(durable);
      this.ownedOrders.set(owned.orderId, owned);
      await this.#refreshAndClearConfirmed('place-limit-order');
      return { ...owned };
    });
  }

  async cancelOrder(marketId, orderId) {
    this.#assertLiveWriteMarket(marketId, '撤单');
    const id = String(orderId);
    return this.#enqueueWrite('cancel-order', async () => {
      const owned = this.ownedOrders.get(id);
      if (!owned || owned.marketId !== MARKET_IDS.BTCUSDT) {
        throw new Error(`PopDEX 订单 ${id} 不属于适配器，拒绝撤单。`);
      }
      await this.#cancelOwnedOrder(owned);
      return true;
    });
  }

  async cancelAll(marketId) {
    this.#assertLiveWriteMarket(marketId, '批量撤单');
    return this.#enqueueWrite('cancel-all', async () => {
      const owned = [...this.ownedOrders.values()]
        .filter((entry) => entry.marketId === MARKET_IDS.BTCUSDT)
        .filter((entry) => this.#officialOrder(MARKET_IDS.BTCUSDT, entry.orderId) !== null);
      for (const order of owned) await this.#cancelOwnedOrder(order);
      return true;
    });
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

  adoptOrder(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('PopDEX adoptOrder 必须提供完整订单元数据。');
    }
    const required = ['orderId', 'marketId', 'clientOrderId', 'side', 'price', 'sizeBase', 'levelIndex'];
    if (required.some((field) => metadata[field] === undefined || metadata[field] === null)) {
      throw new Error('PopDEX adoptOrder 必须提供完整订单元数据。');
    }
    const marketId = this.#assertLiveWriteMarket(metadata.marketId, '订单接管');
    const orderId = String(metadata.orderId);
    const official = this.#officialOrder(marketId, orderId);
    if (official === null) {
      throw new Error(`PopDEX adoptOrder 官方活动订单 ${orderId} 不存在。`);
    }
    if (typeof metadata.clientOrderId !== 'string'
        || !/^0x[0-9a-fA-F]{64}$/.test(metadata.clientOrderId)) {
      throw new Error('PopDEX adoptOrder clientOrderId 必须是 bytes32。');
    }
    const clientOrderId = metadata.clientOrderId.toLowerCase();
    if (official.clientOrderId !== clientOrderId) {
      throw new Error('PopDEX adoptOrder clientOrderId 与官方订单冲突。');
    }
    if (metadata.side !== official.side) {
      throw new Error('PopDEX adoptOrder side 与官方订单冲突。');
    }
    if (decimalWad(String(metadata.price), 'adoptOrder.price').toString() !== official.priceWad) {
      throw new Error('PopDEX adoptOrder price 与官方订单冲突。');
    }
    if (decimalWad(String(metadata.sizeBase), 'adoptOrder.sizeBase').toString() !== official.qtyWad) {
      throw new Error('PopDEX adoptOrder sizeBase 与官方订单冲突。');
    }
    if (!Number.isSafeInteger(metadata.levelIndex) || metadata.levelIndex < 0) {
      throw new Error('PopDEX adoptOrder levelIndex 必须是非负安全整数。');
    }
    const adopted = {
      orderId,
      marketId,
      clientOrderId,
      side: metadata.side,
      price: Number(metadata.price),
      sizeBase: Number(metadata.sizeBase),
      levelIndex: metadata.levelIndex,
    };
    const existing = this.ownedOrders.get(orderId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(adopted)) {
      throw new Error(`PopDEX adoptOrder 订单 ${orderId} 与已有所有权记录冲突。`);
    }
    this.ownedOrders.set(orderId, adopted);
    return { ...adopted };
  }

  getPosition(marketId) {
    const id = this.#assertMarket(marketId);
    const position = this.snapshot.positions.get(id);
    return position ? { ...position } : null;
  }

  async closePosition(marketId) {
    this.#assertLiveWriteMarket(marketId, '平仓');
    return this.#enqueueWrite('close-position', async () => {
      const position = this.snapshot.positions.get(MARKET_IDS.BTCUSDT);
      if (!position) return true;
      if (position.side !== 'long' || position.sizeBase <= 0) {
        throw new Error('PopDEX 实盘平仓只允许已确认的 BTCUSDT 多仓。');
      }
      if ((this.snapshot.orders.get(MARKET_IDS.BTCUSDT)?.size ?? 0) !== 0) {
        throw new Error('PopDEX BTCUSDT 平仓前必须先撤销全部活动订单。');
      }
      const closeClientOrderId = createBtcCloseClientOrderId(randomBytes(16));
      const qty = formatUnits(position.holdSizeWad, 18).replace(/\.0$/, '');
      this.journal.create(this.#writeIdentity('close', {
        qty,
        closeClientOrderId,
        positionId: position.positionId,
      }));
      await this.tradingClient.closeAdapterBtcLong({
        positionId: position.positionId,
        qtyWad: position.holdSizeWad,
        closeClientOrderId,
      }, this.journal);
      await this.#refreshAndClearConfirmed('close-position');
      if (this.snapshot.positions.has(MARKET_IDS.BTCUSDT)) {
        throw new Error('PopDEX 平仓写入已确认，但刷新后的官方快照仍有 BTCUSDT 仓位。');
      }
      return true;
    });
  }

  async #reconcileOwned(options) {
    const marketId = this.#assertLiveWriteMarket(options?.marketId, '订单对账');
    const reason = options?.reason;
    const suppressRequote = options?.suppressRequote ?? false;
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new Error('PopDEX owned reconcile reason 必须是非空字符串。');
    }
    try {
      const result = await this.reconciler.reconcile({ reason, suppressRequote });
      for (const order of result.activeOrders) {
        const metadata = durableOrderMetadata(order);
        this.ownedOrders.set(metadata.orderId, metadata);
      }
      this.#setState(result.status, `owned reconcile ${reason}`);
      return {
        ...result,
        marketId,
        activeOrders: result.activeOrders.map(durableOrderMetadata),
        pendingEvents: structuredClone(result.pendingEvents),
      };
    } catch (error) {
      if (isTransient(error)) {
        this.lastErrorStage = 'owned-reconcile';
        this.lastErrorMessage = sanitizeError(error);
        this.#setState('RECONCILING', this.lastErrorMessage);
      } else {
        this.haltFromBot(error);
      }
      throw error;
    }
  }

  recoverOwnedOrders(options) {
    return this.#reconcileOwned(options);
  }

  reconcileOwnedOrders(options) {
    return this.#reconcileOwned(options);
  }

  pendingFillEvents() {
    return this.ownershipStore.pendingEvents();
  }

  releaseRecoveredEvents() {
    for (const event of this.pendingFillEvents()) {
      if (event.stage !== 'EVENT_PENDING' || this.releasedFillEvents.has(event.fillEventId)) continue;
      this.releasedFillEvents.add(event.fillEventId);
      this.emit('fill', {
        ...structuredClone(event),
        price: wadNumber(event.priceWad, 'fillEvent.priceWad'),
        sizeBase: wadNumber(event.filledQtyWad, 'fillEvent.filledQtyWad'),
      });
    }
  }

  acknowledgeFillEvent(fillEventId, replacementOrderId) {
    const event = this.pendingFillEvents()
      .find((candidate) => candidate.fillEventId === fillEventId);
    if (!event) throw new Error(`PopDEX 成交事件 ${String(fillEventId)} 不存在。`);
    if (event.suppressRequote) {
      if (replacementOrderId !== null) {
        throw new Error('PopDEX suppression 事件不允许 replacementOrderId。');
      }
      this.ownershipStore.completeSuppressedEvent(fillEventId);
      return;
    }
    const replacement = this.ownershipStore.listOrders()
      .find((order) => order.orderId === String(replacementOrderId));
    if (!replacement || replacement.parentFillEventId !== fillEventId) {
      throw new Error('PopDEX 补单身份不匹配。');
    }
    this.ownershipStore.markReplacementConfirmed(fillEventId, replacement.orderId);
    this.ownershipStore.completeEvent(fillEventId);
  }

  haltFromBot(error) {
    if (this.state === 'HALTED' && this.lastErrorMessage !== null) return;
    this.lastErrorStage = 'bot';
    this.lastErrorMessage = sanitizeError(error);
    this.#setState('HALTED', this.lastErrorMessage);
    this.emit('fault', error);
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
      lastQueueError: this.lastQueueError,
      dataSource: this.dataSource,
    };
  }
}
