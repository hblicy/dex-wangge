import { getAddress, Interface, isAddress, ZeroAddress } from 'ethers';
import { POPDEX_ACCOUNT_INTERFACE } from './agent.js';
import {
  POPDEX_ACCOUNT_PRECOMPILE,
  POPDEX_CHAIN_ID,
  POPDEX_ORDER_PRECOMPILE,
  POPDEX_RPC_URL,
} from './constants.js';
import { strictAddress } from './normalize.js';

const OPEN_POSITIONS_INTERFACE = new Interface([
  'function getOpenPositionsByAccount(address account,uint32 offset,uint32 limit) view returns ((tuple(address walletId,uint128 positionId,uint16 symbolId,uint8 side,uint256 holdSize,uint256 avgOpenPrice,uint256 closeSize,uint256 lockedSize,int256 realizedPnl,uint64 createdTime,uint64 updatedTime)[] positions,bool hasMore) page)',
]);

const ORDER_PAGE_INTERFACE = new Interface([
  'function getActiveOrdersByAccount(address account,uint32 offset,uint32 limit) view returns ((tuple(address walletId,uint8 category,uint8 source,uint128 orderId,bytes32 clientOrderId,uint16 symbolId,uint8 side,bool isReduceOnly,uint8 orderType,uint8 timeInForce,uint8 stpMode,address stpKey,uint8 status,uint256 price,tuple(uint256 qty,uint256 filledQty,uint256 remainingQty,uint256 cancelledQty,uint256 quoteQty,uint256 filledQuoteQty,uint256 remainingQuoteQty,uint256 cancelledQuoteQty) quantities,uint256 averagePrice,uint64 nonce,uint64 createdAt,uint64 updatedAt,uint256 makerFeeRate,uint256 takerFeeRate)[] orders,bool hasMore) page)',
  'function getCompletedOrdersByAccount(address account,uint32 offset,uint32 limit) view returns ((tuple(address walletId,uint8 category,uint8 source,uint128 orderId,bytes32 clientOrderId,uint16 symbolId,uint8 side,bool isReduceOnly,uint8 orderType,uint8 timeInForce,uint8 stpMode,address stpKey,uint8 status,uint256 price,tuple(uint256 qty,uint256 filledQty,uint256 remainingQty,uint256 cancelledQty,uint256 quoteQty,uint256 filledQuoteQty,uint256 remainingQuoteQty,uint256 cancelledQuoteQty) quantities,uint256 averagePrice,uint64 nonce,uint64 createdAt,uint64 updatedAt,uint256 makerFeeRate,uint256 takerFeeRate)[] orders,bool hasMore) page)',
]);

const TARGET_SYMBOL_IDS = new Set(['20000', '20001']);
const ORDER_PAGE_SIZE = 100;

export class PopdexOrderNotFoundError extends Error {
  constructor(clientOrderId) {
    super(`PopDEX clientOrderId ${clientOrderId} 在链上订单中未找到。`);
    this.name = 'PopdexOrderNotFoundError';
    this.code = 'POPDEX_ORDER_NOT_FOUND';
    this.clientOrderId = clientOrderId;
  }
}

const READ_ONLY_METHODS = new Set([
  'eth_chainId',
  'eth_call',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'core_getTransactionFailure',
]);

function sanitizedCause(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message && !messages.includes(message)) messages.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(' → ').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function exactTxHash(value, field = 'txHash') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`PopDEX ${field} 必须是 32 字节十六进制字符串。`);
  }
  return value;
}

function errorData(value) {
  if (value === undefined) return '';
  try {
    return ` data=${JSON.stringify(value).slice(0, 500)}`;
  } catch {
    return ' data=[无法序列化]';
  }
}

function uint32(value, field, { allowZero = true } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 0xffffffff) {
    throw new Error(`PopDEX ${field} 必须是有效 uint32。`);
  }
  return value;
}

function exactPosition(value) {
  return {
    walletId: strictAddress(value.walletId, 'position.walletId'),
    positionId: value.positionId.toString(),
    symbolId: value.symbolId.toString(),
    side: value.side.toString(),
    holdSizeWad: value.holdSize.toString(),
    avgOpenPriceWad: value.avgOpenPrice.toString(),
    closeSizeWad: value.closeSize.toString(),
    lockedSizeWad: value.lockedSize.toString(),
    realizedPnlWad: value.realizedPnl.toString(),
    createdTime: value.createdTime.toString(),
    updatedTime: value.updatedTime.toString(),
  };
}

function bytes32(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`PopDEX ${field} 必须是 bytes32 十六进制字符串。`);
  }
  return value.toLowerCase();
}

function addressAllowZero(value, field) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`PopDEX ${field} 必须是有效 EVM 地址字符串。`);
  }
  return getAddress(value);
}

function exactOrder(value, expectedWallet, index) {
  const field = `order[${index}]`;
  const walletId = strictAddress(value.walletId, `${field}.walletId`);
  if (walletId.toLowerCase() !== expectedWallet.toLowerCase()) {
    throw new Error(`PopDEX ${field}.walletId 与请求 account 不匹配。`);
  }
  const symbolId = value.symbolId.toString();
  if (!TARGET_SYMBOL_IDS.has(symbolId)) {
    throw new Error(`PopDEX ${field}.symbolId ${symbolId} 不在白名单。`);
  }
  const quantities = value.quantities;
  const qty = BigInt(quantities.qty);
  const filledQty = BigInt(quantities.filledQty);
  const remainingQty = BigInt(quantities.remainingQty);
  const cancelledQty = BigInt(quantities.cancelledQty);
  if (qty !== filledQty + remainingQty + cancelledQty) {
    throw new Error(
      `PopDEX ${field} qty 必须等于 filledQty + remainingQty + cancelledQty。`,
    );
  }
  const quoteQty = BigInt(quantities.quoteQty);
  const filledQuoteQty = BigInt(quantities.filledQuoteQty);
  const remainingQuoteQty = BigInt(quantities.remainingQuoteQty);
  const cancelledQuoteQty = BigInt(quantities.cancelledQuoteQty);
  if (quoteQty !== filledQuoteQty + remainingQuoteQty + cancelledQuoteQty) {
    throw new Error(
      `PopDEX ${field} quoteQty 必须等于 filledQuoteQty + remainingQuoteQty + cancelledQuoteQty。`,
    );
  }
  return {
    walletId,
    category: value.category.toString(),
    source: value.source.toString(),
    orderId: value.orderId.toString(),
    clientOrderId: bytes32(value.clientOrderId, `${field}.clientOrderId`),
    symbolId,
    side: value.side.toString(),
    isReduceOnly: value.isReduceOnly,
    orderType: value.orderType.toString(),
    timeInForce: value.timeInForce.toString(),
    stpMode: value.stpMode.toString(),
    stpKey: addressAllowZero(value.stpKey, `${field}.stpKey`),
    status: value.status.toString(),
    priceWad: value.price.toString(),
    qtyWad: qty.toString(),
    filledQtyWad: filledQty.toString(),
    remainingQtyWad: remainingQty.toString(),
    cancelledQtyWad: cancelledQty.toString(),
    quoteQtyWad: quoteQty.toString(),
    filledQuoteQtyWad: filledQuoteQty.toString(),
    remainingQuoteQtyWad: remainingQuoteQty.toString(),
    cancelledQuoteQtyWad: cancelledQuoteQty.toString(),
    averagePriceWad: value.averagePrice.toString(),
    nonce: value.nonce.toString(),
    createdAt: value.createdAt.toString(),
    updatedAt: value.updatedAt.toString(),
    makerFeeRateWad: value.makerFeeRate.toString(),
    takerFeeRateWad: value.takerFeeRate.toString(),
  };
}

export class PopdexRpcClient {
  constructor({ rpcUrl = POPDEX_RPC_URL, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    this.rpcUrl = new URL(rpcUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    if (this.rpcUrl.protocol !== 'https:') {
      throw new Error('PopDEX RPC 必须使用 HTTPS。');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('PopDEX fetchImpl 必须是函数。');
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('PopDEX timeoutMs 必须是正安全整数。');
    }
  }

  async call(method, params = []) {
    if (typeof method !== 'string' || !READ_ONLY_METHODS.has(method)) {
      throw new Error(`PopDEX RPC 是只读边界，拒绝方法 ${String(method)}。`);
    }
    if (!Array.isArray(params)) {
      throw new Error('PopDEX RPC params 必须是数组。');
    }
    const id = this.nextId;
    this.nextId += 1;
    const request = { jsonrpc: '2.0', method, params, id };
    let response;
    try {
      response = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: 'https://app.popdex.xyz',
          Referer: 'https://app.popdex.xyz/',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`PopDEX RPC ${method} 网络失败：${sanitizedCause(error)}`, { cause: error });
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(
        `PopDEX RPC ${method} HTTP ${response.status} 返回非 JSON：${sanitizedCause(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(`PopDEX RPC ${method} HTTP ${response.status}。`);
    }
    if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || body.id !== id) {
      throw new Error(`PopDEX RPC ${method} 返回无效 JSON-RPC 信封。`);
    }
    if (body.error !== undefined) {
      const code = body.error?.code;
      const message = body.error?.message;
      throw new Error(
        `PopDEX RPC ${method} error ${String(code)}：${String(message)}${errorData(body.error?.data)}`,
      );
    }
    if (!Object.hasOwn(body, 'result')) {
      throw new Error(`PopDEX RPC ${method} 成功响应缺少 result。`);
    }
    return body.result;
  }

  async verifyChain() {
    const raw = await this.call('eth_chainId');
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw new Error(`PopDEX RPC eth_chainId 返回无效值 ${String(raw)}。`);
    }
    const chainId = BigInt(raw);
    if (chainId !== POPDEX_CHAIN_ID) {
      throw new Error(`PopDEX RPC chainId 必须是 2184，实际 ${chainId}。`);
    }
    return chainId;
  }

  async getOpenPositions(account, offset = 0, limit = 100) {
    const wallet = strictAddress(account, 'account');
    const exactOffset = uint32(offset, 'position offset');
    const exactLimit = uint32(limit, 'position limit', { allowZero: false });
    const data = OPEN_POSITIONS_INTERFACE.encodeFunctionData(
      'getOpenPositionsByAccount',
      [wallet, exactOffset, exactLimit],
    );
    const raw = await this.call('eth_call', [{ to: POPDEX_ORDER_PRECOMPILE, data }, 'latest']);
    let decoded;
    try {
      [decoded] = OPEN_POSITIONS_INTERFACE.decodeFunctionResult(
        'getOpenPositionsByAccount',
        raw,
      );
    } catch (error) {
      throw new Error(
        `PopDEX RPC getOpenPositionsByAccount 解码失败：${sanitizedCause(error)}`,
        { cause: error },
      );
    }
    return {
      positions: decoded.positions.map(exactPosition),
      hasMore: decoded.hasMore,
    };
  }

  async #getOrderPage(functionName, account, offset, limit) {
    const wallet = strictAddress(account, 'account');
    const exactOffset = uint32(offset, 'order offset');
    const exactLimit = uint32(limit, 'order limit', { allowZero: false });
    const data = ORDER_PAGE_INTERFACE.encodeFunctionData(
      functionName,
      [wallet, exactOffset, exactLimit],
    );
    const raw = await this.call('eth_call', [{ to: POPDEX_ORDER_PRECOMPILE, data }, 'latest']);
    let decoded;
    try {
      [decoded] = ORDER_PAGE_INTERFACE.decodeFunctionResult(functionName, raw);
    } catch (error) {
      throw new Error(
        `PopDEX RPC ${functionName} 解码失败：${sanitizedCause(error)}`,
        { cause: error },
      );
    }
    if (typeof decoded.hasMore !== 'boolean') {
      throw new Error(`PopDEX RPC ${functionName} hasMore 必须是布尔值。`);
    }
    return {
      orders: decoded.orders.map((order, index) => exactOrder(order, wallet, index)),
      hasMore: decoded.hasMore,
    };
  }

  async getActiveOrders(account, offset = 0, limit = ORDER_PAGE_SIZE) {
    return this.#getOrderPage('getActiveOrdersByAccount', account, offset, limit);
  }

  async getCompletedOrders(account, offset = 0, limit = ORDER_PAGE_SIZE) {
    return this.#getOrderPage('getCompletedOrdersByAccount', account, offset, limit);
  }

  async findUniqueOrderByClientId(
    account,
    clientOrderId,
    { completed = false, maxPages = 10 } = {},
  ) {
    const wallet = strictAddress(account, 'account');
    const wanted = bytes32(clientOrderId, 'clientOrderId');
    if (typeof completed !== 'boolean') {
      throw new Error('PopDEX completed 必须是布尔值。');
    }
    if (!Number.isSafeInteger(maxPages) || maxPages <= 0 || maxPages > 100) {
      throw new Error('PopDEX maxPages 必须是 1-100 的安全整数。');
    }

    const matches = [];
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const offset = pageIndex * ORDER_PAGE_SIZE;
      const page = completed
        ? await this.getCompletedOrders(wallet, offset, ORDER_PAGE_SIZE)
        : await this.getActiveOrders(wallet, offset, ORDER_PAGE_SIZE);
      for (const order of page.orders) {
        if (order.clientOrderId === wanted) matches.push(order);
      }
      if (matches.length > 1) {
        throw new Error(`PopDEX clientOrderId ${wanted} 在链上订单中重复。`);
      }
      if (!page.hasMore) {
        if (matches.length === 0) {
          throw new PopdexOrderNotFoundError(wanted);
        }
        return matches[0];
      }
    }
    throw new Error(`PopDEX 订单分页超过 maxPages=${maxPages}，拒绝继续。`);
  }

  async getAgentInfo(agentAddress) {
    const agent = strictAddress(agentAddress, 'agentAddress');
    const data = POPDEX_ACCOUNT_INTERFACE.encodeFunctionData('getAgentInfo', [agent]);
    const raw = await this.call('eth_call', [
      { to: POPDEX_ACCOUNT_PRECOMPILE, data },
      'latest',
    ]);
    let decoded;
    try {
      decoded = POPDEX_ACCOUNT_INTERFACE.decodeFunctionResult('getAgentInfo', raw);
    } catch (error) {
      throw new Error(
        `PopDEX RPC getAgentInfo 解码失败：${sanitizedCause(error)}`,
        { cause: error },
      );
    }
    const exists = decoded.exists;
    if (typeof exists !== 'boolean' || typeof decoded.isExpired !== 'boolean' || typeof decoded.isGlobal !== 'boolean') {
      throw new Error('PopDEX RPC getAgentInfo 布尔字段无效。');
    }
    let delegator = null;
    if (exists) {
      delegator = strictAddress(decoded.delegator, 'agent.delegator');
    } else if (decoded.delegator !== ZeroAddress) {
      throw new Error('PopDEX RPC getAgentInfo 未存在 Agent 却返回非零 delegator。');
    }
    return {
      exists,
      expiresAt: decoded.expiresAt.toString(),
      isExpired: decoded.isExpired,
      delegator,
      name: bytes32(decoded.name, 'agent.name'),
      isGlobal: decoded.isGlobal,
    };
  }

  async getAgents(delegatorAddress) {
    const delegator = strictAddress(delegatorAddress, 'delegator');
    const data = POPDEX_ACCOUNT_INTERFACE.encodeFunctionData('getAgents', [delegator]);
    const raw = await this.call('eth_call', [
      { to: POPDEX_ACCOUNT_PRECOMPILE, data },
      'latest',
    ]);
    let decoded;
    try {
      decoded = POPDEX_ACCOUNT_INTERFACE.decodeFunctionResult('getAgents', raw);
    } catch (error) {
      throw new Error(
        `PopDEX RPC getAgents 解码失败：${sanitizedCause(error)}`,
        { cause: error },
      );
    }
    const arrays = [
      decoded.agents,
      decoded.expiresAts,
      decoded.isExpireds,
      decoded.names,
      decoded.isGlobals,
    ];
    if (arrays.some((value) => !Array.isArray(value) && !ArrayBuffer.isView(value))) {
      throw new Error('PopDEX RPC getAgents 返回字段不是数组。');
    }
    const length = decoded.agents.length;
    if (arrays.some((value) => value.length !== length)) {
      throw new Error('PopDEX RPC getAgents 数组长度不一致。');
    }
    return Array.from({ length }, (_unused, index) => {
      if (typeof decoded.isExpireds[index] !== 'boolean' || typeof decoded.isGlobals[index] !== 'boolean') {
        throw new Error(`PopDEX RPC getAgents[${index}] 布尔字段无效。`);
      }
      return {
        agent: strictAddress(decoded.agents[index], `agents[${index}].agent`),
        expiresAt: decoded.expiresAts[index].toString(),
        isExpired: decoded.isExpireds[index],
        name: bytes32(decoded.names[index], `agents[${index}].name`),
        isGlobal: decoded.isGlobals[index],
      };
    });
  }

  async getTransaction(txHash) {
    return this.call('eth_getTransactionByHash', [exactTxHash(txHash)]);
  }

  async getReceipt(txHash) {
    return this.call('eth_getTransactionReceipt', [exactTxHash(txHash)]);
  }

  async getTransactionFailure(txHash) {
    return this.call('core_getTransactionFailure', [exactTxHash(txHash)]);
  }
}
