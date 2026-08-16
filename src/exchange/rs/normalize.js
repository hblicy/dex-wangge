const WAD_DECIMALS = 18;
const TARGET_SYMBOLS = ['BTC', 'ETH'];

function fail(field, message) {
  throw new Error(`RISEx ${field} ${message}`);
}

function stringId(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(field, '必须是非空字符串。');
  return value;
}

function decimal(value, field, { min = -Infinity, allowZero = true } = {}) {
  if (typeof value === 'string' && !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    fail(field, '必须是十进制数字字符串。');
  }
  if (typeof value !== 'string' && typeof value !== 'number') fail(field, '必须是数字。');
  const result = Number(value);
  if (!Number.isFinite(result)) fail(field, '不是有限数字。');
  if (result < min || (!allowZero && result === 0)) fail(field, '超出允许范围。');
  return result;
}

function decimalString(value, field, options = {}) {
  if (typeof value !== 'string') fail(field, '必须是十进制数字字符串。');
  return decimal(value, field, options);
}

function safeInteger(value, field, { min = 0 } = {}) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) fail(field, '必须是非负整数字符串。');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min) fail(field, '不是安全整数。');
  return result;
}

function restSide(value) {
  if (value === 0 || value === '0') return 'buy';
  if (value === 1 || value === '1') return 'sell';
  fail('side', `包含未知值 ${String(value)}。`);
}

function wsSide(value) {
  if (value === 'BUY') return 'buy';
  if (value === 'SELL') return 'sell';
  fail('side', `包含未知值 ${String(value)}。`);
}

function positionSide(value) {
  if (value === 'BUY' || value === 'SELL') return wsSide(value);
  return restSide(value);
}

function normalizeStatus(value, filledSize = 0) {
  const status = String(value || '').toUpperCase();
  if (status === 'ORDER_STATUS_OPEN' || status === 'OPEN') return filledSize > 0 ? 'PARTIAL' : 'OPEN';
  if (status === 'PARTIAL' || status === 'PARTIALLY_FILLED' || status === 'ORDER_STATUS_PARTIAL') return 'PARTIAL';
  if (status === 'ORDER_STATUS_FILLED' || status === 'FILLED') return 'FILLED';
  if (status === 'ORDER_STATUS_CANCELLED' || status === 'CANCELLED' || status === 'CANCELED') return 'CANCELLED';
  fail('订单状态', `包含未知值 ${status || '(empty)'}。`);
}

function cursorPart(value, field) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(field, '不是安全非负整数。');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(field, '必须是非负整数字符串。');
  return BigInt(value);
}

function cursorFrom(message, item = {}) {
  const timestamp = [message.block_timestamp, message.timestamp, item.created_at, item.time]
    .find((value) => value !== undefined && value !== null && value !== '');
  return {
    block: cursorPart(item.block_number ?? item.blockchain_data?.block_number ?? message.block_number, 'block_number'),
    log: cursorPart(item.log_index ?? item.blockchain_data?.log_index ?? message.log_index, 'log_index'),
    timestamp: cursorPart(timestamp, 'timestamp'),
  };
}

function restCursor(item) {
  const timestamp = cursorPart(item.created_at ?? item.timestamp ?? item.time, 'timestamp');
  const blockValue = item.block_number ?? item.blockchain_data?.block_number;
  const logValue = item.log_index ?? item.blockchain_data?.log_index;
  return {
    block: blockValue == null ? 0n : cursorPart(blockValue, 'block_number'),
    log: logValue == null ? 0n : cursorPart(logValue, 'log_index'),
    timestamp,
  };
}

export function wadToNumber(raw, field) {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
    fail(field, '必须是 18 位 WAD 整数字符串。');
  }
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(WAD_DECIMALS + 1, '0');
  const whole = padded.slice(0, -WAD_DECIMALS);
  const fraction = padded.slice(-WAD_DECIMALS).replace(/0+$/, '');
  const result = Number(`${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`);
  if (!Number.isFinite(result)) fail(field, 'WAD 数值超出可表示范围。');
  return result;
}

export function normalizeRisexMarkets(rawMarkets) {
  if (!Array.isArray(rawMarkets)) fail('markets', '必须是数组。');
  const selected = new Map();
  for (const raw of rawMarkets) {
    const sourceSymbol = String(raw?.base_asset_symbol || '').trim().toUpperCase();
    const symbolMatch = /^(BTC|ETH)(?:\/USDC)?$/.exec(sourceSymbol);
    if (!symbolMatch) continue;
    const symbol = symbolMatch[1];
    const name = `${symbol}-PERP`;
    if (selected.has(symbol)) fail(name, '市场重复。');
    if (raw.visible === false || raw.config?.unlocked === false) fail(name, '市场不可用。');
    const marketId = safeInteger(raw.market_id, `${name} market_id`, { min: 1 });
    const stepSize = decimal(raw.config?.step_size, `${name} step_size`, { min: 0, allowZero: false });
    const stepPrice = decimal(raw.config?.step_price, `${name} step_price`, { min: 0, allowZero: false });
    const minOrderSize = decimal(raw.config?.min_order_size, `${name} min_order_size`, { min: 0, allowZero: false });
    const maxLeverage = decimal(raw.config?.max_leverage, `${name} max_leverage`, { min: 0, allowZero: false });
    const lastPrice = decimal(raw.mark_price || raw.last_price, `${name} mark_price`, { min: 0, allowZero: false });
    selected.set(symbol, {
      marketId,
      displayName: name,
      name,
      symbol: name,
      lastPrice,
      stepSize,
      stepPrice,
      minOrderSize,
      maxLeverage,
    });
  }
  for (const symbol of TARGET_SYMBOLS) {
    if (!selected.has(symbol)) fail('markets', `缺少 ${symbol}-PERP。`);
  }
  const result = TARGET_SYMBOLS.map((symbol) => selected.get(symbol));
  if (new Set(result.map((market) => market.marketId)).size !== result.length) {
    fail('markets', 'BTC-PERP 与 ETH-PERP 的 market_id 重复。');
  }
  return result;
}

export function parseOrderEnvelope(message) {
  if (message?.channel !== 'orders') fail('Orders channel', '不匹配。');
  if (message.type !== 'snapshot' && message.type !== 'update') fail('Orders type', '不是 snapshot/update。');
  if (!Array.isArray(message.data)) fail('Orders data', '必须是数组。');
  return message.data.map((raw) => {
    const orderId = stringId(raw?.id, '订单 ID');
    const marketId = safeInteger(raw.market_id, `订单 ${orderId} market_id`, { min: 1 });
    const sizeBase = decimalString(raw.size, `订单 ${orderId} size`, { min: 0, allowZero: false });
    const price = decimalString(raw.price, `订单 ${orderId} price`, { min: 0 });
    const filledSize = decimalString(raw.filled_size, `订单 ${orderId} filled_size`, { min: 0 });
    const avgPrice = decimalString(raw.avg_price, `订单 ${orderId} avg_price`, { min: 0 });
    if (!(sizeBase > 0)) fail(`订单 ${orderId}`, '总量必须大于零。');
    if (price < 0 || filledSize < 0 || avgPrice < 0) fail(`订单 ${orderId}`, '包含负数价格或数量。');
    if (filledSize > sizeBase + 1e-12) fail(`订单 ${orderId}`, '累计成交量超过订单总量。');
    return {
      orderId,
      marketId,
      side: wsSide(raw.side),
      sizeBase,
      price,
      filledSize,
      avgPrice,
      status: normalizeStatus(raw.status, filledSize),
      sender: stringId(raw.sender, `订单 ${orderId} sender`).toLowerCase(),
      cursor: cursorFrom(message, raw),
    };
  });
}

export function parseFillEnvelope(message) {
  if (message?.channel !== 'fills') fail('Fills channel', '不匹配。');
  if (message.type !== 'update') fail('Fills type', '不是 update。');
  if (!message.data || Array.isArray(message.data) || typeof message.data !== 'object') {
    fail('Fills data', '必须是对象。');
  }
  const raw = message.data;
  const fillId = stringId(raw.id, 'fill ID');
  const orderId = stringId(raw.order_id, `fill ${fillId} order ID`);
  const marketId = safeInteger(raw.market_id, `fill ${fillId} market_id`, { min: 1 });
  const sizeBase = decimal(raw.size, `fill ${fillId} size`, { min: 0, allowZero: false });
  const price = decimal(raw.price, `fill ${fillId} price`, { min: 0, allowZero: false });
  const fee = raw.fee == null || raw.fee === '' ? 0 : decimal(raw.fee, `fill ${fillId} fee`);
  return [{ fillId, orderId, marketId, side: wsSide(raw.side), price, sizeBase, fee, cursor: cursorFrom(message, raw) }];
}

export function compareRisexCursor(left, right) {
  for (const key of ['block', 'log', 'timestamp']) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

export function normalizeRestOpenOrder(raw, market) {
  const orderId = stringId(raw?.order_id, 'REST 订单 ID');
  const restingOrderId = stringId(raw.resting_order_id, `REST 订单 ${orderId} resting_order_id`);
  const marketId = safeInteger(raw.market_id, `REST 订单 ${orderId} market_id`, { min: 1 });
  if (!market || market.marketId !== marketId) fail(`REST 订单 ${orderId}`, '市场元数据不匹配。');
  const priceTicks = safeInteger(raw.price_ticks, `REST 订单 ${orderId} price_ticks`);
  const sizeSteps = safeInteger(raw.size_steps, `REST 订单 ${orderId} size_steps`, { min: 1 });
  return {
    orderId,
    restingOrderId,
    marketId,
    side: restSide(raw.side),
    price: priceTicks * market.stepPrice,
    sizeBase: sizeSteps * market.stepSize,
    reduceOnly: raw.reduce_only === true,
  };
}

export function normalizeRestOrderHistory(raw) {
  const orderId = stringId(raw?.id, 'REST 历史订单 ID');
  const sizeBase = decimalString(raw.size, `REST 历史订单 ${orderId} size`, { min: 0, allowZero: false });
  const filledSize = decimalString(raw.filled_size, `REST 历史订单 ${orderId} filled_size`, { min: 0 });
  const price = decimalString(raw.price, `REST 历史订单 ${orderId} price`, { min: 0 });
  const avgPrice = decimalString(raw.avg_price, `REST 历史订单 ${orderId} avg_price`, { min: 0 });
  if (!(sizeBase > 0)) fail(`REST 历史订单 ${orderId}`, '总量必须大于零。');
  if (price < 0 || filledSize < 0 || avgPrice < 0) {
    fail(`REST 历史订单 ${orderId}`, '包含负数价格或数量。');
  }
  if (filledSize > sizeBase + 1e-12) fail(`REST 历史订单 ${orderId}`, '累计成交量超过订单总量。');
  return {
    orderId,
    marketId: safeInteger(raw.market_id, `REST 历史订单 ${orderId} market_id`, { min: 1 }),
    side: wsSide(raw.side),
    sizeBase,
    price,
    filledSize,
    avgPrice,
    status: normalizeStatus(raw.status, filledSize),
    cursor: restCursor(raw),
  };
}

export function normalizeRestFill(raw) {
  const fillId = stringId(raw?.id, 'REST fill ID');
  const orderId = stringId(raw.order_id, `REST fill ${fillId} order ID`);
  return {
    fillId,
    orderId,
    marketId: safeInteger(raw.market_id, `REST fill ${fillId} market_id`, { min: 1 }),
    side: wsSide(raw.side),
    sizeBase: decimal(raw.size, `REST fill ${fillId} size`, { min: 0, allowZero: false }),
    price: decimal(raw.price, `REST fill ${fillId} price`, { min: 0, allowZero: false }),
    fee: raw.fee == null || raw.fee === '' ? 0 : decimal(raw.fee, `REST fill ${fillId} fee`),
    cursor: restCursor(raw),
  };
}

export function normalizeRestPosition(raw, { markPrice: trustedMarkPrice } = {}) {
  if (raw == null) return null;
  const marketId = safeInteger(raw.market_id, 'REST position market_id', { min: 1 });
  const absoluteSize = Math.abs(wadToNumber(raw.size, `REST position ${marketId} size`));
  if (absoluteSize === 0) return { marketId, sizeBase: 0, entryPrice: 0, unrealizedPnl: 0, leverage: null };
  const side = positionSide(raw.side);
  const entryRaw = [raw.avg_entry_price, raw.entry_price]
    .find((value) => value !== undefined && value !== null && value !== '');
  const entryPrice = wadToNumber(entryRaw, `REST position ${marketId} avg_entry_price/entry_price`);
  if (!(entryPrice > 0)) fail(`REST position ${marketId} avg_entry_price/entry_price`, '必须大于零。');
  let unrealizedPnl;
  if (raw.unrealized_pnl != null && raw.unrealized_pnl !== '') {
    unrealizedPnl = wadToNumber(raw.unrealized_pnl, `REST position ${marketId} unrealized_pnl`);
  } else if (raw.mark_price != null && raw.mark_price !== '') {
    const markPrice = wadToNumber(raw.mark_price, `REST position ${marketId} mark_price`);
    if (!(markPrice > 0)) fail(`REST position ${marketId} mark_price`, '必须大于零。');
    const signedSize = side === 'buy' ? absoluteSize : -absoluteSize;
    unrealizedPnl = signedSize * (markPrice - entryPrice);
  } else if (trustedMarkPrice != null && trustedMarkPrice !== '') {
    const markPrice = decimal(trustedMarkPrice, `REST position ${marketId} trusted mark_price`, { min: 0, allowZero: false });
    const signedSize = side === 'buy' ? absoluteSize : -absoluteSize;
    unrealizedPnl = signedSize * (markPrice - entryPrice);
  } else {
    fail(`REST position ${marketId}`, '缺少 unrealized_pnl 或 mark_price。');
  }
  const leverage = raw.leverage == null || raw.leverage === ''
    ? null
    : wadToNumber(raw.leverage, `REST position ${marketId} leverage`);
  if (leverage != null && !(leverage > 0)) fail(`REST position ${marketId} leverage`, '必须大于零。');
  return {
    marketId,
    sizeBase: side === 'buy' ? absoluteSize : -absoluteSize,
    entryPrice,
    unrealizedPnl,
    leverage,
  };
}
