import { decodeBytes32String, keccak256, parseUnits, Wallet } from 'ethers';
import { confirmMissingCancelledOrder } from './cancel-confirmation.js';
import {
  POPDEX_CHAIN_ID,
  POPDEX_EXPECTED_MARKETS,
  POPDEX_ORDER_PRECOMPILE,
  POPDEX_USER_CONFIG_PRECOMPILE,
} from './constants.js';
import {
  POPDEX_USER_CONFIG_INTERFACE,
  encodeBtcLeverageOne,
  encodeReduceOnlyMarketClose,
  parseLeverageUpdatedReceipt,
  verifyStage5Simulation,
} from './fill-close-codec.js';
import { assertConfirmedLong, classifyClose, exactBtcLeverage } from './fill-close-state.js';
import { encodeCancelOrder, POPDEX_ORDER_INTERFACE } from './order-codec.js';
import { strictAddress, strictIntegerString } from './normalize.js';
import { parseOrderCancelReceipt, parseOrderCreateReceipt } from './receipt-events.js';

const LEGACY_GAS_LIMIT = 1_000_000n;
const LEGACY_GAS_PRICE = 0n;

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`PopDEX ${field} 必须是正安全整数。`);
  }
  return value;
}

function exactHex(value, field) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`PopDEX ${field} 必须是非空偶数字节十六进制字符串。`);
  }
  return value.toLowerCase();
}

function exactReceiptHash(receipt, expectedTxHash, functionName) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error(`PopDEX ${functionName} 回执必须是对象。`);
  }
  const transactionHash = typeof receipt.transactionHash === 'string'
    ? receipt.transactionHash.toLowerCase()
    : '';
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new Error(`PopDEX ${functionName} 回执 transactionHash 无效。`);
  }
  if (transactionHash !== expectedTxHash) {
    throw new Error(
      `PopDEX ${functionName} 回执 transactionHash 不匹配：expected=${expectedTxHash} actual=${transactionHash}。`,
    );
  }
  return receipt;
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function sideCode(side) {
  return side === 'buy' ? '0' : '1';
}

function symbolForId(symbolId) {
  const symbol = Object.entries(POPDEX_EXPECTED_MARKETS)
    .find(([, market]) => market.symbolId === symbolId)?.[0];
  if (!symbol) {
    throw new Error(`PopDEX openOrder.symbolId ${String(symbolId)} 不在白名单。`);
  }
  return symbol;
}

function mismatch(stage, field, expected, actual) {
  throw new Error(
    `PopDEX ${stage} 订单 ${field} 不匹配：expected=${String(expected)} actual=${String(actual)}。`,
  );
}

function validateIdentity(order, plan, stage) {
  if (!sameAddress(order.walletId, plan.mainAccount)) {
    mismatch(stage, 'walletId', plan.mainAccount, order.walletId);
  }
  for (const [field, expected] of [
    ['clientOrderId', plan.clientOrderId],
    ['symbolId', plan.symbolId],
    ['side', sideCode(plan.side)],
    ['priceWad', plan.priceWad],
    ['qtyWad', plan.qtyWad],
  ]) {
    if (order[field] !== expected) mismatch(stage, field, expected, order[field]);
  }
  if (order.isReduceOnly !== false) mismatch(stage, 'isReduceOnly', false, order.isReduceOnly);
}

function restDecimalToWad(value, field) {
  if (typeof value !== 'string') throw new Error(`PopDEX ${field} 必须是十进制字符串。`);
  try {
    return parseUnits(value, 18).toString();
  } catch (cause) {
    throw new Error(`PopDEX ${field} 无法转换为 WAD：${cause?.message || cause}`, { cause });
  }
}

function exactRestOpenOrder(order, plan, receiptOrder) {
  if (!order || typeof order !== 'object') throw new Error('PopDEX REST 活动订单必须是对象。');
  const expectedClientOid = decodeBytes32String(plan.clientOrderId);
  const fields = [
    ['walletId', plan.mainAccount.toLowerCase(), strictAddress(order.walletId, 'REST order.walletId').toLowerCase()],
    ['orderId', receiptOrder.orderId, strictIntegerString(order.orderId, 'REST order.orderId')],
    ['clientOid', expectedClientOid, order.clientOid],
    ['symbolId', plan.symbolId, String(order.symbolId)],
    ['symbol', plan.symbol, order.symbol],
    ['side', plan.side === 'buy' ? 'Buy' : 'Sell', order.side],
    ['priceWad', plan.priceWad, restDecimalToWad(order.price, 'REST order.price')],
    ['qtyWad', plan.qtyWad, restDecimalToWad(order.qty, 'REST order.qty')],
    ['filledQtyWad', '0', restDecimalToWad(order.filledQty, 'REST order.filledQty')],
    ['remainingQtyWad', plan.qtyWad, restDecimalToWad(order.remainingQty, 'REST order.remainingQty')],
    ['cancelledQtyWad', '0', restDecimalToWad(order.cancelledQty, 'REST order.cancelledQty')],
    ['status', 'NewAccept', order.status],
  ];
  for (const [field, expected, actual] of fields) {
    if (actual !== expected) mismatch('OPEN_CONFIRMED REST', field, expected, actual);
  }
  if (order.reduceOnly !== false) mismatch('OPEN_CONFIRMED REST', 'reduceOnly', false, order.reduceOnly);
  return {
    walletId: plan.mainAccount,
    orderId: receiptOrder.orderId,
    clientOrderId: plan.clientOrderId,
    symbolId: plan.symbolId,
    side: sideCode(plan.side),
    isReduceOnly: false,
    priceWad: plan.priceWad,
    qtyWad: plan.qtyWad,
    filledQtyWad: '0',
    remainingQtyWad: plan.qtyWad,
    cancelledQtyWad: '0',
  };
}

function exactRestCancelledOrder(order, openOrder) {
  if (!order || typeof order !== 'object') throw new Error('PopDEX REST 撤单终态必须是对象。');
  const expectedClientOid = decodeBytes32String(openOrder.clientOrderId);
  const filledQtyWad = restDecimalToWad(order.filledQty, 'REST order.filledQty');
  const remainingQtyWad = restDecimalToWad(order.remainingQty, 'REST order.remainingQty');
  const cancelledQtyWad = restDecimalToWad(order.cancelledQty, 'REST order.cancelledQty');
  const fields = [
    ['walletId', openOrder.walletId.toLowerCase(), strictAddress(order.walletId, 'REST order.walletId').toLowerCase()],
    ['orderId', openOrder.orderId, strictIntegerString(order.orderId, 'REST order.orderId')],
    ['clientOid', expectedClientOid, order.clientOid],
    ['symbolId', openOrder.symbolId, String(order.symbolId)],
    ['side', openOrder.side === '0' ? 'Buy' : 'Sell', order.side],
    ['priceWad', openOrder.priceWad, restDecimalToWad(order.price, 'REST order.price')],
    ['qtyWad', openOrder.qtyWad, restDecimalToWad(order.qty, 'REST order.qty')],
  ];
  for (const [field, expected, actual] of fields) {
    if (actual !== expected) mismatch('CANCEL_CONFIRMED REST', field, expected, actual);
  }
  if (BigInt(openOrder.qtyWad) !== BigInt(filledQtyWad) + BigInt(remainingQtyWad) + BigInt(cancelledQtyWad)) {
    throw new Error('PopDEX CANCEL_CONFIRMED REST qty 不等于 filled + remaining + cancelled。');
  }
  if (filledQtyWad !== '0') {
    throw new Error(
      `PopDEX CANCEL_CONFIRMED 订单 ${openOrder.orderId} 发生成交 ${filledQtyWad}，请人工处理仓位。`,
    );
  }
  for (const [field, expected, actual] of [
    ['status', 'Cancelled', order.status],
    ['remainingQtyWad', '0', remainingQtyWad],
    ['cancelledQtyWad', openOrder.qtyWad, cancelledQtyWad],
  ]) {
    if (actual !== expected) mismatch('CANCEL_CONFIRMED REST', field, expected, actual);
  }
  if (order.reduceOnly !== openOrder.isReduceOnly) {
    mismatch('CANCEL_CONFIRMED REST', 'reduceOnly', openOrder.isReduceOnly, order.reduceOnly);
  }
  return {
    ...openOrder,
    filledQtyWad,
    remainingQtyWad,
    cancelledQtyWad,
  };
}

function safeJournalError(journal, stage, error) {
  try {
    journal.recordError(stage, error);
  } catch (journalError) {
    throw new AggregateError(
      [error, journalError],
      `PopDEX ${stage} 失败，且恢复记录错误写入失败。`,
    );
  }
}

export function validateAgentAuthorization({ mainAccount, agentAddress, info, nowMs }) {
  const main = strictAddress(mainAccount, 'mainAccount');
  const agent = strictAddress(agentAddress, 'agentAddress');
  if (sameAddress(main, agent)) {
    throw new Error('PopDEX Agent 地址不能与主账户相同。');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('PopDEX Agent 当前时间必须是非负安全整数。');
  }
  if (!info || typeof info !== 'object' || !info.exists) {
    throw new Error('PopDEX Agent 链上授权不存在。');
  }
  if (info.isExpired || BigInt(strictIntegerString(info.expiresAt, 'Agent expiresAt')) <= BigInt(nowMs)) {
    throw new Error(`PopDEX Agent 授权已过期：expiresAt=${String(info.expiresAt)}。`);
  }
  if (info.isGlobal !== false) {
    throw new Error('PopDEX Agent 必须是 isGlobal=false 的非 global 授权。');
  }
  if (typeof info.delegator !== 'string' || !sameAddress(info.delegator, main)) {
    throw new Error('PopDEX Agent delegator 与主账户不匹配。');
  }
  return { mainAccount: main, agent, expiresAt: info.expiresAt };
}

export class PopdexTradingClient {
  constructor({
    mainAccount,
    agentPrivateKey,
    readRpc,
    accountClient,
    writeRpc,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    orderTimeoutMs = 30000,
    orderPollMs = 1000,
  }) {
    this.mainAccount = strictAddress(mainAccount, 'mainAccount');
    try {
      this.wallet = new Wallet(agentPrivateKey);
    } catch {
      throw new Error('PopDEX Agent 私钥无效。');
    }
    if (sameAddress(this.wallet.address, this.mainAccount)) {
      throw new Error('PopDEX Agent 地址不能与主账户相同。');
    }
    if (!readRpc || typeof readRpc !== 'object'
        || !accountClient || typeof accountClient !== 'object'
        || !writeRpc || typeof writeRpc !== 'object') {
      throw new Error('PopDEX readRpc、accountClient 和 writeRpc 必须是对象。');
    }
    if (typeof now !== 'function' || typeof sleep !== 'function') {
      throw new Error('PopDEX now 和 sleep 必须是函数。');
    }
    this.readRpc = readRpc;
    this.accountClient = accountClient;
    this.writeRpc = writeRpc;
    this.now = now;
    this.sleep = sleep;
    this.orderTimeoutMs = positiveSafeInteger(orderTimeoutMs, 'orderTimeoutMs');
    this.orderPollMs = positiveSafeInteger(orderPollMs, 'orderPollMs');
    this.lastNonce = -1;
  }

  #currentTime() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('PopDEX now() 必须返回非负安全整数。');
    }
    return value;
  }

  #nextNonce() {
    const nonce = Math.max(this.#currentTime(), this.lastNonce + 1);
    if (!Number.isSafeInteger(nonce)) {
      throw new Error('PopDEX Agent nonce 超出安全整数范围。');
    }
    this.lastNonce = nonce;
    return nonce;
  }

  async preflight() {
    const [readChain, writeChain] = await Promise.all([
      this.readRpc.verifyChain(),
      this.writeRpc.verifyChain(),
    ]);
    if (readChain !== POPDEX_CHAIN_ID || writeChain !== POPDEX_CHAIN_ID) {
      throw new Error('PopDEX 读写 RPC chainId 必须同时为 2184。');
    }
    const info = await this.readRpc.getAgentInfo(this.wallet.address);
    return validateAgentAuthorization({
      mainAccount: this.mainAccount,
      agentAddress: this.wallet.address,
      info,
      nowMs: this.#currentTime(),
    });
  }

  #allowedTarget(to) {
    const target = strictAddress(to, 'write target');
    if (![POPDEX_ORDER_PRECOMPILE, POPDEX_USER_CONFIG_PRECOMPILE]
      .some((allowed) => sameAddress(allowed, target))) {
      throw new Error(`PopDEX 写入目标 ${target} 不在允许列表。`);
    }
    return target;
  }

  async #sign(to, data) {
    return this.wallet.signTransaction({
      to: this.#allowedTarget(to),
      data,
      value: 0n,
      chainId: POPDEX_CHAIN_ID,
      type: 0,
      nonce: this.#nextNonce(),
      gasLimit: LEGACY_GAS_LIMIT,
      gasPrice: LEGACY_GAS_PRICE,
    });
  }

  #verifySimulation(functionName, raw) {
    if (raw !== '0x') {
      throw new Error(`PopDEX ${functionName} 模拟必须返回主网预编译的空结果 0x。`);
    }
  }

  async #submit({
    data,
    functionName,
    journal,
    expectedStage,
    nextStage,
    txHashField,
    journalFields = {},
    to = POPDEX_ORDER_PRECOMPILE,
    simulationInterface = null,
  }) {
    const calldata = exactHex(data, `${functionName} calldata`);
    const target = this.#allowedTarget(to);
    const simulated = await this.writeRpc.simulate({
      from: this.wallet.address,
      to: target,
      data: calldata,
      value: '0x0',
    });
    if (simulationInterface === null) {
      this.#verifySimulation(functionName, simulated);
    } else {
      verifyStage5Simulation(simulated, simulationInterface, functionName);
    }
    const serialized = await this.#sign(target, calldata);
    const localTxHash = keccak256(serialized).toLowerCase();
    journal.advance(expectedStage, nextStage, {
      ...journalFields,
      [txHashField]: localTxHash,
    });
    try {
      const remoteTxHash = (await this.writeRpc.broadcast(serialized)).toLowerCase();
      if (remoteTxHash !== localTxHash) {
        throw new Error(
          `PopDEX ${functionName} RPC txHash 不匹配：local=${localTxHash} remote=${remoteTxHash}。`,
        );
      }
      return exactReceiptHash(
        await this.writeRpc.waitForReceipt(localTxHash),
        localTxHash,
        functionName,
      );
    } catch (error) {
      safeJournalError(journal, nextStage, error);
      throw error;
    }
  }

  async #pollOpenConfirmation(plan, receiptOrder) {
    const attempts = Math.ceil(this.orderTimeoutMs / this.orderPollMs) + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const order = await this.accountClient.findUniqueOrderByClientId(
          this.mainAccount,
          plan.symbol,
          plan.clientOrderId,
        );
        if (['WaitToSend', 'PendingNew'].includes(order.status)) {
          exactRestOpenOrder({ ...order, status: 'NewAccept' }, plan, receiptOrder);
          if (attempt < attempts) await this.sleep(this.orderPollMs);
          continue;
        }
        return exactRestOpenOrder(order, plan, receiptOrder);
      } catch (error) {
        if (error?.code !== 'POPDEX_ORDER_NOT_FOUND') throw error;
      }
      if (attempt < attempts) await this.sleep(this.orderPollMs);
    }
    throw new Error(`PopDEX OPEN_CONFIRMED 超时：clientOrderId=${plan.clientOrderId}。`);
  }

  async #pollCancelled(openOrder) {
    const symbol = symbolForId(openOrder.symbolId);
    const attempts = Math.ceil(this.orderTimeoutMs / this.orderPollMs) + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const order = await this.accountClient.findUniqueOrderByClientId(
          this.mainAccount,
          symbol,
          openOrder.clientOrderId,
        );
        if (!['WaitToSend', 'PendingNew', 'NewAccept', 'PendingCancel'].includes(order.status)) {
          return exactRestCancelledOrder(order, openOrder);
        }
      } catch (error) {
        if (error?.code !== 'POPDEX_ORDER_NOT_FOUND') throw error;
        const evidence = await confirmMissingCancelledOrder({
          accountClient: this.accountClient,
          readRpc: this.readRpc,
          mainAccount: this.mainAccount,
          symbol,
          orderId: openOrder.orderId,
        });
        if (evidence.status === 'filled') {
          throw new Error(
            `PopDEX CANCEL_CONFIRMED 订单 ${openOrder.orderId} 发生成交 ${evidence.filledQtyWad}，请人工处理仓位。`,
          );
        }
        if (evidence.status === 'position-open') {
          throw new Error(
            `PopDEX CANCEL_CONFIRMED market ${symbol} 仍有持仓 ${evidence.holdSizeWad}，请人工处理仓位。`,
          );
        }
        return {
          ...openOrder,
          filledQtyWad: '0',
          remainingQtyWad: '0',
          cancelledQtyWad: openOrder.qtyWad,
          confirmationSource: 'OrderCancel+REST-open+fills+positions',
        };
      }
      if (attempt < attempts) await this.sleep(this.orderPollMs);
    }
    throw new Error(`PopDEX CANCEL_CONFIRMED 超时：clientOrderId=${openOrder.clientOrderId}。`);
  }

  async placeAndConfirm(plan, journal) {
    if (!plan || typeof plan !== 'object' || !sameAddress(plan.mainAccount, this.mainAccount)) {
      throw new Error('PopDEX 下单计划 mainAccount 与交易客户端不匹配。');
    }
    await this.preflight();
    const receipt = await this.#submit({
      data: plan.data,
      functionName: 'placeOrder',
      journal,
      expectedStage: 'PREPARED',
      nextStage: 'BROADCAST',
      txHashField: 'placeTxHash',
    });
    try {
      const receiptOrder = parseOrderCreateReceipt(receipt, {
        account: plan.mainAccount,
        symbolId: plan.symbolId,
        clientOrderId: plan.clientOrderId,
        priceWad: plan.priceWad,
        qtyWad: plan.qtyWad,
      });
      const order = await this.#pollOpenConfirmation(plan, receiptOrder);
      validateIdentity(order, plan, 'OPEN_CONFIRMED');
      if (order.filledQtyWad !== '0') mismatch('OPEN_CONFIRMED', 'filledQtyWad', '0', order.filledQtyWad);
      if (order.remainingQtyWad !== plan.qtyWad) {
        mismatch('OPEN_CONFIRMED', 'remainingQtyWad', plan.qtyWad, order.remainingQtyWad);
      }
      if (order.cancelledQtyWad !== '0') {
        mismatch('OPEN_CONFIRMED', 'cancelledQtyWad', '0', order.cancelledQtyWad);
      }
      const orderId = strictIntegerString(order.orderId, 'orderId');
      if (BigInt(orderId) <= 0n) throw new Error('PopDEX OPEN_CONFIRMED orderId 必须是正整数。');
      journal.advance('BROADCAST', 'OPEN_CONFIRMED', { orderId });
      return order;
    } catch (error) {
      safeJournalError(journal, 'BROADCAST', error);
      throw error;
    }
  }

  async cancelAndConfirm(openOrder, journal) {
    if (!openOrder || typeof openOrder !== 'object') {
      throw new Error('PopDEX openOrder 必须是对象。');
    }
    if (typeof openOrder.walletId !== 'string' || !sameAddress(openOrder.walletId, this.mainAccount)) {
      throw new Error('PopDEX openOrder.walletId 与主账户不匹配。');
    }
    if (openOrder.side !== '0' && openOrder.side !== '1') {
      throw new Error('PopDEX openOrder.side 必须是 0 或 1。');
    }
    if (openOrder.isReduceOnly !== false) {
      throw new Error('PopDEX openOrder.isReduceOnly 必须是 false。');
    }
    symbolForId(openOrder.symbolId);
    await this.preflight();
    const data = encodeCancelOrder({
      mainAccount: this.mainAccount,
      orderId: openOrder.orderId,
      clientOrderId: openOrder.clientOrderId,
    });
    const receipt = await this.#submit({
      data,
      functionName: 'cancelOrder',
      journal,
      expectedStage: 'OPEN_CONFIRMED',
      nextStage: 'CANCEL_BROADCAST',
      txHashField: 'cancelTxHash',
    });
    try {
      parseOrderCancelReceipt(receipt, {
        account: this.mainAccount,
        orderId: openOrder.orderId,
        clientOrderId: openOrder.clientOrderId,
      });
      const completed = await this.#pollCancelled(openOrder);
      journal.advance('CANCEL_BROADCAST', 'CANCEL_CONFIRMED');
      return completed;
    } catch (error) {
      safeJournalError(journal, 'CANCEL_BROADCAST', error);
      throw error;
    }
  }

  async placeAdapterOrder(plan, journal) {
    if (!plan || typeof plan !== 'object' || !sameAddress(plan.mainAccount, this.mainAccount)) {
      throw new Error('PopDEX 下单计划 mainAccount 与交易客户端不匹配。');
    }
    await this.preflight();
    const receipt = await this.#submit({
      data: plan.data,
      functionName: 'placeOrder',
      journal,
      expectedStage: 'PREPARED',
      nextStage: 'BROADCAST',
      txHashField: 'txHash',
    });
    try {
      const receiptOrder = parseOrderCreateReceipt(receipt, {
        account: plan.mainAccount,
        symbolId: plan.symbolId,
        clientOrderId: plan.clientOrderId,
        priceWad: plan.priceWad,
        qtyWad: plan.qtyWad,
      });
      const order = await this.#pollOpenConfirmation(plan, receiptOrder);
      validateIdentity(order, plan, 'CONFIRMED');
      if (order.filledQtyWad !== '0') mismatch('CONFIRMED', 'filledQtyWad', '0', order.filledQtyWad);
      if (order.remainingQtyWad !== plan.qtyWad) {
        mismatch('CONFIRMED', 'remainingQtyWad', plan.qtyWad, order.remainingQtyWad);
      }
      if (order.cancelledQtyWad !== '0') {
        mismatch('CONFIRMED', 'cancelledQtyWad', '0', order.cancelledQtyWad);
      }
      const orderId = strictIntegerString(order.orderId, 'orderId');
      if (BigInt(orderId) <= 0n) throw new Error('PopDEX CONFIRMED orderId 必须是正整数。');
      journal.advance('BROADCAST', 'CONFIRMED', { orderId });
      return order;
    } catch (error) {
      safeJournalError(journal, 'BROADCAST', error);
      throw error;
    }
  }

  async cancelAdapterOrder(openOrder, journal) {
    if (!openOrder || typeof openOrder !== 'object') {
      throw new Error('PopDEX openOrder 必须是对象。');
    }
    if (typeof openOrder.walletId !== 'string' || !sameAddress(openOrder.walletId, this.mainAccount)) {
      throw new Error('PopDEX openOrder.walletId 与主账户不匹配。');
    }
    if (openOrder.side !== '0' && openOrder.side !== '1') {
      throw new Error('PopDEX openOrder.side 必须是 0 或 1。');
    }
    if (typeof openOrder.isReduceOnly !== 'boolean') {
      throw new Error('PopDEX openOrder.isReduceOnly 必须是布尔值。');
    }
    symbolForId(openOrder.symbolId);
    await this.preflight();
    const receipt = await this.#submit({
      data: encodeCancelOrder({
        mainAccount: this.mainAccount,
        orderId: openOrder.orderId,
        clientOrderId: openOrder.clientOrderId,
      }),
      functionName: 'cancelOrder',
      journal,
      expectedStage: 'PREPARED',
      nextStage: 'BROADCAST',
      txHashField: 'txHash',
    });
    try {
      parseOrderCancelReceipt(receipt, {
        account: this.mainAccount,
        orderId: openOrder.orderId,
        clientOrderId: openOrder.clientOrderId,
      });
      const completed = await this.#pollCancelled(openOrder);
      journal.advance('BROADCAST', 'CONFIRMED');
      return completed;
    } catch (error) {
      safeJournalError(journal, 'BROADCAST', error);
      throw error;
    }
  }

  async setAdapterBtcLeverageOne(journal) {
    await this.preflight();
    const current = exactBtcLeverage(await this.readRpc.getAccountConfig(this.mainAccount));
    if (current === '1') {
      journal.completePreparedWithoutBroadcast('safe-no-broadcast');
      return { leverage: '1', changed: false };
    }
    const receipt = await this.#submit({
      data: encodeBtcLeverageOne(this.mainAccount),
      functionName: 'updateLeverage',
      journal,
      expectedStage: 'PREPARED',
      nextStage: 'BROADCAST',
      txHashField: 'txHash',
      to: POPDEX_USER_CONFIG_PRECOMPILE,
      simulationInterface: POPDEX_USER_CONFIG_INTERFACE,
    });
    try {
      const event = parseLeverageUpdatedReceipt(receipt, { mainAccount: this.mainAccount });
      const readback = exactBtcLeverage(
        await this.readRpc.getAccountConfig(this.mainAccount),
      );
      if (readback !== '1') {
        throw new Error(`PopDEX BTCUSDT 杠杆回读必须是 1，实际 ${String(readback)}。`);
      }
      journal.advance('BROADCAST', 'CONFIRMED');
      return { ...event, changed: true };
    } catch (error) {
      safeJournalError(journal, 'BROADCAST', error);
      throw error;
    }
  }

  async #pollAdapterClose(plan) {
    const attempts = Math.ceil(this.orderTimeoutMs / this.orderPollMs) + 1;
    let latest = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const [fills, openOrders, positions] = await Promise.all([
        this.accountClient.getAllFills(this.mainAccount, 'BTCUSDT'),
        this.accountClient.getAllOpenOrders(this.mainAccount, 'BTCUSDT'),
        this.readRpc.getAllOpenPositions(this.mainAccount),
      ]);
      latest = classifyClose(plan, { fills, openOrders, positions });
      if (latest.kind === 'completed-flat') return latest;
      if (attempt < attempts) await this.sleep(this.orderPollMs);
    }
    throw new Error(
      `PopDEX close CONFIRMED 超时：closeOrderId=${plan.closeOrderId} `
      + `kind=${String(latest?.kind)} remaining=${String(latest?.remainingPositionQtyWad)}。`,
    );
  }

  async closeAdapterBtcLong(position, journal) {
    if (!position || typeof position !== 'object') {
      throw new Error('PopDEX adapter 平仓 position 必须是对象。');
    }
    const positionId = strictIntegerString(position.positionId, 'adapter positionId');
    const qtyWad = strictIntegerString(position.qtyWad, 'adapter qtyWad');
    if (BigInt(positionId) <= 0n || BigInt(qtyWad) <= 0n) {
      throw new Error('PopDEX adapter positionId 和 qtyWad 必须是正整数字符串。');
    }
    await this.preflight();
    const [openOrders, positions] = await Promise.all([
      this.accountClient.getAllOpenOrders(this.mainAccount, 'BTCUSDT'),
      this.readRpc.getAllOpenPositions(this.mainAccount),
    ]);
    const livePosition = assertConfirmedLong(
      { mainAccount: this.mainAccount, symbol: 'BTCUSDT', symbolId: '20000' },
      { openOrders, positions },
      qtyWad,
    );
    if (String(livePosition.positionId) !== positionId) {
      throw new Error(
        `PopDEX adapter 平仓 positionId 不匹配：expected=${positionId} actual=${String(livePosition.positionId)}。`,
      );
    }
    const receipt = await this.#submit({
      data: encodeReduceOnlyMarketClose({
        mainAccount: this.mainAccount,
        closeClientOrderId: position.closeClientOrderId,
        closeQtyWad: qtyWad,
      }),
      functionName: 'placeOrder',
      journal,
      expectedStage: 'PREPARED',
      nextStage: 'BROADCAST',
      txHashField: 'txHash',
      simulationInterface: POPDEX_ORDER_INTERFACE,
    });
    try {
      const order = parseOrderCreateReceipt(receipt, {
        account: this.mainAccount,
        symbolId: '20000',
        clientOrderId: position.closeClientOrderId,
        priceWad: '0',
        priceRule: 'positive-execution',
        qtyWad,
      });
      const settled = await this.#pollAdapterClose({
        mainAccount: this.mainAccount,
        closeOrderId: order.orderId,
        closeQtyWad: qtyWad,
        closeClientOrderId: position.closeClientOrderId,
      });
      journal.advance('BROADCAST', 'CONFIRMED', { closeOrderId: order.orderId });
      return {
        ...order,
        closeOrderId: order.orderId,
        filledQtyWad: settled.filledQtyWad,
        positionQtyWad: settled.remainingPositionQtyWad,
      };
    } catch (error) {
      safeJournalError(journal, 'BROADCAST', error);
      throw error;
    }
  }

  #assertFillClosePlan(plan) {
    if (!plan || typeof plan !== 'object'
        || typeof plan.mainAccount !== 'string'
        || !sameAddress(plan.mainAccount, this.mainAccount)) {
      throw new Error('PopDEX Stage 5 计划 mainAccount 与交易客户端不匹配。');
    }
    for (const [field, expected] of [
      ['symbol', 'BTCUSDT'],
      ['symbolId', '20000'],
      ['side', 'buy'],
      ['leverage', '1'],
      ['positionMode', '0'],
      ['positionSide', '1'],
      ['category', '2'],
    ]) {
      if (plan[field] !== expected) {
        throw new Error(
          `PopDEX Stage 5 计划 ${field} 不匹配：expected=${expected} actual=${String(plan[field])}。`,
        );
      }
    }
  }

  async setBtcLeverageOne(plan, journal) {
    this.#assertFillClosePlan(plan);
    await this.preflight();
    const current = exactBtcLeverage(await this.readRpc.getAccountConfig(this.mainAccount));
    if (current === '1') {
      journal.advance('PREPARED', 'LEVERAGE_CONFIRMED');
      return { leverage: '1', changed: false };
    }
    const receipt = await this.#submit({
      data: plan.leverageData,
      functionName: 'updateLeverage',
      journal,
      expectedStage: 'PREPARED',
      nextStage: 'LEVERAGE_BROADCAST',
      txHashField: 'leverageTxHash',
      to: POPDEX_USER_CONFIG_PRECOMPILE,
      simulationInterface: POPDEX_USER_CONFIG_INTERFACE,
    });
    try {
      const event = parseLeverageUpdatedReceipt(receipt, plan);
      const readback = exactBtcLeverage(
        await this.readRpc.getAccountConfig(this.mainAccount),
      );
      if (readback !== '1') {
        throw new Error(`PopDEX BTCUSDT 杠杆回读必须是 1，实际 ${readback}。`);
      }
      journal.advance('LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED');
      return { ...event, changed: true };
    } catch (error) {
      safeJournalError(journal, 'LEVERAGE_BROADCAST', error);
      throw error;
    }
  }

  async placeFillCloseEntry(plan, journal) {
    this.#assertFillClosePlan(plan);
    await this.preflight();
    const receipt = await this.#submit({
      data: plan.entryData,
      functionName: 'placeOrder',
      journal,
      expectedStage: 'LEVERAGE_CONFIRMED',
      nextStage: 'ENTRY_BROADCAST',
      txHashField: 'entryTxHash',
      simulationInterface: POPDEX_ORDER_INTERFACE,
    });
    try {
      const order = parseOrderCreateReceipt(receipt, {
        account: plan.mainAccount,
        symbolId: plan.symbolId,
        clientOrderId: plan.clientOrderId,
        priceWad: plan.priceWad,
        qtyWad: plan.qtyWad,
      });
      journal.advance('ENTRY_BROADCAST', 'ENTRY_SETTLING', { orderId: order.orderId });
      return order;
    } catch (error) {
      safeJournalError(journal, 'ENTRY_BROADCAST', error);
      throw error;
    }
  }

  async cancelFillCloseRemainder(plan, order, journal) {
    this.#assertFillClosePlan(plan);
    if (!order || typeof order !== 'object') {
      throw new Error('PopDEX Stage 5 撤单 order 必须是对象。');
    }
    if (order.clientOrderId !== plan.clientOrderId) {
      throw new Error('PopDEX Stage 5 撤单 clientOrderId 与入场计划不匹配。');
    }
    await this.preflight();
    const data = encodeCancelOrder({
      mainAccount: this.mainAccount,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
    });
    const receipt = await this.#submit({
      data,
      functionName: 'cancelOrder',
      journal,
      expectedStage: 'ENTRY_SETTLING',
      nextStage: 'REMAINDER_CANCEL_BROADCAST',
      txHashField: 'cancelTxHash',
      simulationInterface: POPDEX_ORDER_INTERFACE,
    });
    try {
      return parseOrderCancelReceipt(receipt, {
        account: this.mainAccount,
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
      });
    } catch (error) {
      safeJournalError(journal, 'REMAINDER_CANCEL_BROADCAST', error);
      throw error;
    }
  }

  async closeFillCloseLong(plan, position, journal) {
    this.#assertFillClosePlan(plan);
    if (!position || position.closeClientOrderId !== plan.closeClientOrderId
        || position.positionQtyWad !== position.closeQtyWad
        || typeof position.positionId !== 'string') {
      throw new Error('PopDEX Stage 5 平仓身份或数量与已确认持仓不匹配。');
    }
    await this.preflight();
    const [openOrders, positions] = await Promise.all([
      this.accountClient.getAllOpenOrders(this.mainAccount, 'BTCUSDT'),
      this.readRpc.getAllOpenPositions(this.mainAccount),
    ]);
    const livePosition = assertConfirmedLong(
      plan,
      { openOrders, positions },
      position.positionQtyWad,
    );
    if (String(livePosition.positionId) !== position.positionId) {
      throw new Error('PopDEX Stage 5 平仓前持仓 ID 与 journal 不匹配。');
    }
    const data = encodeReduceOnlyMarketClose({
      mainAccount: this.mainAccount,
      closeClientOrderId: position.closeClientOrderId,
      closeQtyWad: position.closeQtyWad,
    });
    const receipt = await this.#submit({
      data,
      functionName: 'placeOrder',
      journal,
      expectedStage: 'POSITION_CONFIRMED',
      nextStage: 'CLOSE_BROADCAST',
      txHashField: 'closeTxHash',
      journalFields: {
        closeKind: 'reduce-only-market',
        closeQtyWad: position.closeQtyWad,
      },
      simulationInterface: POPDEX_ORDER_INTERFACE,
    });
    try {
      const order = parseOrderCreateReceipt(receipt, {
        account: plan.mainAccount,
        symbolId: plan.symbolId,
        clientOrderId: position.closeClientOrderId,
        priceWad: '0',
        priceRule: 'positive-execution',
        qtyWad: position.closeQtyWad,
      });
      journal.advance('CLOSE_BROADCAST', 'CLOSE_SETTLING', {
        closeOrderId: order.orderId,
      });
      return order;
    } catch (error) {
      safeJournalError(journal, 'CLOSE_BROADCAST', error);
      throw error;
    }
  }
}
