import { POPDEX_CHAIN_ID, POPDEX_RPC_URL } from './constants.js';

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
