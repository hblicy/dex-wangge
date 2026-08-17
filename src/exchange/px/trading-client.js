import { keccak256, Wallet } from 'ethers';
import { POPDEX_CHAIN_ID, POPDEX_ORDER_PRECOMPILE } from './constants.js';
import { encodeCancelOrder, POPDEX_ORDER_INTERFACE } from './order-codec.js';
import { strictAddress, strictIntegerString } from './normalize.js';

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

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function sideCode(side) {
  return side === 'buy' ? '0' : '1';
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
    if (!readRpc || typeof readRpc !== 'object' || !writeRpc || typeof writeRpc !== 'object') {
      throw new Error('PopDEX readRpc 和 writeRpc 必须是对象。');
    }
    if (typeof now !== 'function' || typeof sleep !== 'function') {
      throw new Error('PopDEX now 和 sleep 必须是函数。');
    }
    this.readRpc = readRpc;
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

  async #sign(data) {
    return this.wallet.signTransaction({
      to: POPDEX_ORDER_PRECOMPILE,
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
    let decoded;
    try {
      decoded = POPDEX_ORDER_INTERFACE.decodeFunctionResult(functionName, raw);
    } catch (cause) {
      throw new Error(`PopDEX ${functionName} 模拟结果解码失败：${cause?.message || cause}`, { cause });
    }
    if (decoded[0] !== true) {
      throw new Error(`PopDEX ${functionName} 模拟返回 false。`);
    }
  }

  async #submit({ data, functionName, journal, expectedStage, nextStage, txHashField }) {
    const calldata = exactHex(data, `${functionName} calldata`);
    const simulated = await this.writeRpc.simulate({
      from: this.wallet.address,
      to: POPDEX_ORDER_PRECOMPILE,
      data: calldata,
      value: '0x0',
    });
    this.#verifySimulation(functionName, simulated);
    const serialized = await this.#sign(calldata);
    const localTxHash = keccak256(serialized).toLowerCase();
    journal.advance(expectedStage, nextStage, { [txHashField]: localTxHash });
    try {
      const remoteTxHash = (await this.writeRpc.broadcast(serialized)).toLowerCase();
      if (remoteTxHash !== localTxHash) {
        throw new Error(
          `PopDEX ${functionName} RPC txHash 不匹配：local=${localTxHash} remote=${remoteTxHash}。`,
        );
      }
      await this.writeRpc.waitForReceipt(localTxHash);
      return localTxHash;
    } catch (error) {
      safeJournalError(journal, nextStage, error);
      throw error;
    }
  }

  async #findOrder(clientOrderId, completed) {
    try {
      return await this.readRpc.findUniqueOrderByClientId(
        this.mainAccount,
        clientOrderId,
        { completed },
      );
    } catch (error) {
      if (error?.code === 'POPDEX_ORDER_NOT_FOUND') return null;
      throw error;
    }
  }

  async #pollOpenConfirmation(plan) {
    const attempts = Math.ceil(this.orderTimeoutMs / this.orderPollMs) + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const order = await this.#findOrder(plan.clientOrderId, false);
      if (order !== null) return order;
      const completed = await this.#findOrder(plan.clientOrderId, true);
      if (completed !== null) {
        validateIdentity(completed, plan, 'OPEN_CONFIRMED');
        if (completed.filledQtyWad !== '0') {
          throw new Error(
            `PopDEX OPEN_CONFIRMED 订单 ${completed.orderId} 发生成交 ${completed.filledQtyWad}，请人工处理仓位。`,
          );
        }
        throw new Error(
          `PopDEX OPEN_CONFIRMED 订单 ${completed.orderId} 已进入完成集合，未能确认活动挂单。`,
        );
      }
      if (attempt < attempts) await this.sleep(this.orderPollMs);
    }
    throw new Error(`PopDEX OPEN_CONFIRMED 超时：clientOrderId=${plan.clientOrderId}。`);
  }

  async #pollCancelled(clientOrderId) {
    const attempts = Math.ceil(this.orderTimeoutMs / this.orderPollMs) + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const active = await this.#findOrder(clientOrderId, false);
      if (active === null) {
        const completed = await this.#findOrder(clientOrderId, true);
        if (completed !== null) return completed;
      }
      if (attempt < attempts) await this.sleep(this.orderPollMs);
    }
    throw new Error(`PopDEX CANCEL_CONFIRMED 超时：clientOrderId=${clientOrderId}。`);
  }

  async placeAndConfirm(plan, journal) {
    if (!plan || typeof plan !== 'object' || !sameAddress(plan.mainAccount, this.mainAccount)) {
      throw new Error('PopDEX 下单计划 mainAccount 与交易客户端不匹配。');
    }
    await this.preflight();
    await this.#submit({
      data: plan.data,
      functionName: 'placeOrder',
      journal,
      expectedStage: 'PREPARED',
      nextStage: 'BROADCAST',
      txHashField: 'placeTxHash',
    });
    try {
      const order = await this.#pollOpenConfirmation(plan);
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
    await this.preflight();
    const data = encodeCancelOrder({
      mainAccount: this.mainAccount,
      orderId: openOrder.orderId,
      clientOrderId: openOrder.clientOrderId,
    });
    await this.#submit({
      data,
      functionName: 'cancelOrder',
      journal,
      expectedStage: 'OPEN_CONFIRMED',
      nextStage: 'CANCEL_BROADCAST',
      txHashField: 'cancelTxHash',
    });
    const plan = {
      mainAccount: this.mainAccount,
      clientOrderId: openOrder.clientOrderId,
      symbolId: openOrder.symbolId,
      side: openOrder.side === '0' ? 'buy' : 'sell',
      priceWad: openOrder.priceWad,
      qtyWad: openOrder.qtyWad,
    };
    try {
      const completed = await this.#pollCancelled(openOrder.clientOrderId);
      validateIdentity(completed, plan, 'CANCEL_CONFIRMED');
      if (completed.filledQtyWad !== '0') {
        throw new Error(
          `PopDEX CANCEL_CONFIRMED 订单 ${completed.orderId} 发生成交 ${completed.filledQtyWad}，请人工处理仓位。`,
        );
      }
      if (completed.remainingQtyWad !== '0') {
        mismatch('CANCEL_CONFIRMED', 'remainingQtyWad', '0', completed.remainingQtyWad);
      }
      if (completed.cancelledQtyWad !== openOrder.qtyWad) {
        mismatch('CANCEL_CONFIRMED', 'cancelledQtyWad', openOrder.qtyWad, completed.cancelledQtyWad);
      }
      journal.advance('CANCEL_BROADCAST', 'CANCEL_CONFIRMED');
      return completed;
    } catch (error) {
      safeJournalError(journal, 'CANCEL_BROADCAST', error);
      throw error;
    }
  }
}
