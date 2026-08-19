import { decodeBytes32String } from 'ethers';
import { strictAddress, strictIntegerString } from './normalize.js';
import { reconcileOwnedOrder } from './order-state.js';

const TERMINAL_REST_STATUSES = new Set([
  'FullyFilled', 'PartiallyFilledCancelled', 'Cancelled', 'Rejected', 'Expired',
]);

function fault(code, message, cause = undefined) {
  const error = new Error(`PopDEX ${code}：${message}`, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function exactNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('PopDEX reconciler now() 必须返回非负安全整数。');
  }
  return value;
}

function orderId(value, field) {
  return strictIntegerString(String(value?.orderId), field);
}

function officialClientId(value) {
  if (typeof value?.clientOrderId === 'string') return value.clientOrderId.toLowerCase();
  if (typeof value?.clientOid === 'string') return value.clientOid;
  throw fault('POPDEX_IDENTITY_CONFLICT', '官方订单缺少 clientOrderId/clientOid。');
}

function matchesClient(official, owned) {
  const value = officialClientId(official);
  return value.startsWith('0x')
    ? value === owned.clientOrderId.toLowerCase()
    : value === decodeBytes32String(owned.clientOrderId);
}

function verifyOfficialSet(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`PopDEX ${label} 必须是数组。`);
  const ids = new Set();
  const clients = new Set();
  for (const row of rows) {
    const id = orderId(row, `${label}.orderId`);
    const client = officialClientId(row);
    if (ids.has(id) || clients.has(client)) {
      throw fault('POPDEX_IDENTITY_CONFLICT', `${label} 存在重复订单身份 orderId=${id}。`);
    }
    ids.add(id);
    clients.add(client);
  }
}

function exactOfficial(rows, owned, label) {
  const byId = rows.filter((row) => orderId(row, `${label}.orderId`) === owned.orderId);
  const byClient = rows.filter((row) => matchesClient(row, owned));
  if (byId.length > 1 || byClient.length > 1) {
    throw fault('POPDEX_IDENTITY_CONFLICT', `${label} 订单身份重复 orderId=${owned.orderId}。`);
  }
  if (byId.length === 1 && !matchesClient(byId[0], owned)) {
    throw fault('POPDEX_IDENTITY_CONFLICT', `${label} orderId=${owned.orderId} 的 clientOrderId 冲突。`);
  }
  if (byClient.length === 1
      && orderId(byClient[0], `${label}.orderId`) !== owned.orderId) {
    throw fault('POPDEX_IDENTITY_CONFLICT', `${label} clientOrderId 对应不同 orderId。`);
  }
  return byId[0] ?? null;
}

function rejectExternalOpen(rows, owned, label) {
  for (const row of rows) {
    const id = orderId(row, `${label}.orderId`);
    const candidate = owned.find((order) => order.orderId === id);
    if (!candidate) {
      throw fault('POPDEX_EXTERNAL_ORDER', `${label} 出现非本机器人订单 orderId=${id}。`);
    }
    if (!matchesClient(row, candidate)) {
      throw fault('POPDEX_IDENTITY_CONFLICT', `${label} orderId=${id} 的 clientOrderId 冲突。`);
    }
  }
}

function restTerminalRows(history) {
  return history.filter((order) => TERMINAL_REST_STATUSES.has(order?.status));
}

function sameResult(left, right) {
  return left.state === right.state
    && (left.filledQtyWad ?? null) === (right.filledQtyWad ?? null)
    && (left.event?.fillEventId ?? null) === (right.event?.fillEventId ?? null);
}

function btcPositions(values) {
  if (!Array.isArray(values)) throw new Error('PopDEX positions 必须是数组。');
  return values.filter((position) => String(position?.symbolId) === '20000');
}

function verifyPositions(owned, results, positions) {
  const btc = btcPositions(positions);
  let longQty = 0n;
  for (const position of btc) {
    const hold = BigInt(strictIntegerString(position.holdSizeWad, 'position.holdSizeWad'));
    if (hold === 0n) continue;
    if (String(position.side) !== '1') {
      throw fault('POPDEX_POSITION_MISMATCH', `BTCUSDT 出现非 Long 持仓 positionId=${String(position.positionId)}。`);
    }
    longQty += hold;
  }

  const coveredEvents = new Set(
    owned.filter((order) => order.reduceOnly && order.parentFillEventId !== null)
      .map((order) => order.parentFillEventId),
  );
  let requiredLongQty = 0n;
  for (const order of owned) {
    const result = results.get(order.orderId);
    const filled = BigInt(result?.filledQtyWad ?? order.filledQtyWad);
    if (order.reduceOnly) {
      if (result?.state === 'OPEN' || result?.state === 'PARTIAL') {
        requiredLongQty += BigInt(order.qtyWad) - filled;
      }
      continue;
    }
    if (!order.opening || filled === 0n) continue;
    const eventId = result?.event?.fillEventId ?? order.terminalEvent?.fillEventId ?? null;
    if (eventId === null || !coveredEvents.has(eventId)) requiredLongQty += filled;
  }
  if (longQty < requiredLongQty) {
    throw fault(
      'POPDEX_POSITION_MISMATCH',
      `BTCUSDT Long 持仓不足：required=${requiredLongQty} actual=${longQty}。`,
    );
  }
}

export class PopdexReconciler {
  constructor({
    mainAccount,
    accountClient,
    readRpc,
    ownershipStore,
    logger = console,
    now = () => Date.now(),
    settleMs = 30_000,
  }) {
    this.mainAccount = strictAddress(mainAccount, 'reconciler mainAccount');
    for (const [name, value] of [
      ['accountClient', accountClient],
      ['readRpc', readRpc],
      ['ownershipStore', ownershipStore],
      ['logger', logger],
    ]) {
      if (!value || typeof value !== 'object') throw new Error(`PopDEX reconciler ${name} 必须是对象。`);
    }
    if (typeof now !== 'function') throw new Error('PopDEX reconciler now 必须是函数。');
    if (!Number.isSafeInteger(settleMs) || settleMs <= 0) {
      throw new Error('PopDEX reconciler settleMs 必须是正安全整数。');
    }
    this.accountClient = accountClient;
    this.readRpc = readRpc;
    this.ownershipStore = ownershipStore;
    this.logger = logger;
    this.now = now;
    this.settleMs = settleMs;
    this.inFlight = null;
    this.unsettledSince = new Map();
  }

  reconcile(options = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#run(options).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async #run({ reason = 'refresh', suppressRequote = false } = {}) {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new Error('PopDEX reconciler reason 必须是非空字符串。');
    }
    if (typeof suppressRequote !== 'boolean') {
      throw new Error('PopDEX reconciler suppressRequote 必须是布尔值。');
    }
    const startedAt = exactNow(this.now);
    const owned = this.ownershipStore.listOrders();
    const [restOpen, history, fills, chainActive, completed, positions] = await Promise.all([
      this.accountClient.getAllOpenOrders(this.mainAccount, 'BTCUSDT'),
      this.accountClient.getAllOrderHistory(this.mainAccount, 'BTCUSDT'),
      this.accountClient.getAllFills(this.mainAccount, 'BTCUSDT'),
      this.readRpc.getAllActiveOrders(this.mainAccount),
      this.readRpc.getAllCompletedOrders(this.mainAccount),
      this.readRpc.getAllOpenPositions(this.mainAccount),
    ]);

    verifyOfficialSet(restOpen, 'REST open');
    verifyOfficialSet(chainActive, 'chain active');
    verifyOfficialSet(completed, 'chain completed');
    const terminalHistory = restTerminalRows(history);
    verifyOfficialSet(terminalHistory, 'REST history terminal');
    rejectExternalOpen(restOpen, owned, 'REST open');
    rejectExternalOpen(chainActive, owned, 'chain active');

    const results = new Map();
    const transient = new Set();
    for (const order of owned) {
      const restActive = exactOfficial(restOpen, order, 'REST open');
      const activeOnChain = exactOfficial(chainActive, order, 'chain active');
      const restCompleted = exactOfficial(terminalHistory, order, 'REST history terminal');
      const chainCompleted = exactOfficial(completed, order, 'chain completed');
      if ((restActive === null) !== (activeOnChain === null)) transient.add(order.orderId);
      if ((restActive !== null || activeOnChain !== null)
          && (restCompleted !== null || chainCompleted !== null)) {
        throw fault('POPDEX_IDENTITY_CONFLICT', `orderId=${order.orderId} 同时存在活动和终态事实。`);
      }
      if (order.cancelProof !== null && (restActive !== null || activeOnChain !== null)) {
        throw fault('POPDEX_IDENTITY_CONFLICT', `orderId=${order.orderId} 同时存在撤单证明和活动订单事实。`);
      }

      const active = restActive ?? activeOnChain;
      const terminal = restCompleted ?? chainCompleted;
      const primary = reconcileOwnedOrder(order, {
        active,
        completed: terminal,
        fills,
        cancelProof: terminal === null ? order.cancelProof : null,
        suppressRequote,
      });
      if (terminal !== null && order.cancelProof !== null) {
        const proofResult = reconcileOwnedOrder(order, {
          fills,
          cancelProof: order.cancelProof,
          suppressRequote,
        });
        if (!sameResult(primary, proofResult)) {
          throw fault('POPDEX_IDENTITY_CONFLICT', `orderId=${order.orderId} 撤单证明与官方终态冲突。`);
        }
      }
      if (restCompleted !== null && chainCompleted !== null) {
        const cross = reconcileOwnedOrder(order, {
          completed: chainCompleted,
          fills,
          suppressRequote,
        });
        if (!sameResult(primary, cross)) transient.add(order.orderId);
      }
      if (restActive !== null && activeOnChain !== null) {
        const cross = reconcileOwnedOrder(order, { active: activeOnChain, fills });
        if (!sameResult(primary, cross)) transient.add(order.orderId);
      }
      if (primary.state === 'SETTLING' || primary.state === 'UNKNOWN_TERMINAL') {
        transient.add(order.orderId);
      }
      results.set(order.orderId, primary);
    }

    const now = exactNow(this.now);
    for (const order of owned) {
      if (!transient.has(order.orderId)) {
        this.unsettledSince.delete(order.orderId);
        continue;
      }
      const since = this.unsettledSince.get(order.orderId) ?? now;
      this.unsettledSince.set(order.orderId, since);
      if (now - since >= this.settleMs) {
        throw fault(
          'POPDEX_UNKNOWN_TERMINAL',
          `orderId=${order.orderId} 对账超过 ${this.settleMs}ms 仍无法闭合。`,
        );
      }
    }

    verifyPositions(owned, results, positions);
    for (const order of owned) {
      this.ownershipStore.applyResult(order.orderId, results.get(order.orderId));
    }
    const current = this.ownershipStore.listOrders();
    const activeOrders = current.filter((order) => ['OPEN', 'PARTIAL'].includes(order.state));
    const pendingEvents = this.ownershipStore.pendingEvents();
    const status = transient.size === 0 ? 'READY' : 'RECONCILING';
    return {
      status,
      activeOrders,
      pendingEvents,
      positions,
      diagnostics: {
        reason,
        elapsedMs: exactNow(this.now) - startedAt,
        owned: owned.length,
        restOpen: restOpen.length,
        chainActive: chainActive.length,
        completed: completed.length,
        fills: fills.length,
        pending: pendingEvents.length,
      },
    };
  }
}
