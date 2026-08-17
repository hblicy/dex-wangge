import { POPDEX_CHAIN_ID, POPDEX_RPC_URL } from './constants.js';
import { strictAddress } from './normalize.js';

const WRITE_RPC_METHODS = new Set([
  'eth_chainId',
  'eth_call',
  'eth_sendRawTransaction',
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

function errorData(value) {
  if (value === undefined) return '';
  try {
    return ` data=${JSON.stringify(value).slice(0, 500)}`;
  } catch {
    return ' data=[无法序列化]';
  }
}

function exactTxHash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('PopDEX txHash 必须是 32 字节十六进制字符串。');
  }
  return value.toLowerCase();
}

function exactHex(value, field, { allowEmpty = false } = {}) {
  const pattern = allowEmpty ? /^0x(?:[0-9a-fA-F]{2})*$/ : /^0x(?:[0-9a-fA-F]{2})+$/;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`PopDEX ${field} 必须是 0x 前缀十六进制字符串。`);
  }
  if (!pattern.test(value)) {
    throw new Error(`PopDEX ${field} 必须包含偶数个十六进制字符。`);
  }
  return value;
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`PopDEX ${field} 必须是正安全整数。`);
  }
  return value;
}

export class PopdexWriteRpcClient {
  constructor({
    rpcUrl = POPDEX_RPC_URL,
    fetchImpl = fetch,
    timeoutMs = 10000,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.rpcUrl = new URL(rpcUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = positiveSafeInteger(timeoutMs, 'timeoutMs');
    this.now = now;
    this.sleep = sleep;
    this.nextId = 1;
    if (this.rpcUrl.href !== new URL(POPDEX_RPC_URL).href) {
      throw new Error(`PopDEX 写 RPC 必须是官方地址 ${POPDEX_RPC_URL}。`);
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('PopDEX fetchImpl 必须是函数。');
    }
    if (typeof this.now !== 'function' || typeof this.sleep !== 'function') {
      throw new Error('PopDEX now 和 sleep 必须是函数。');
    }
  }

  async #request(method, params = []) {
    if (!WRITE_RPC_METHODS.has(method)) {
      throw new Error(`PopDEX 写 RPC 拒绝方法 ${String(method)}。`);
    }
    const id = this.nextId;
    this.nextId += 1;
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
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`PopDEX 写 RPC ${method} 网络失败：${sanitizedCause(error)}`, { cause: error });
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(
        `PopDEX 写 RPC ${method} HTTP ${response.status} 返回非 JSON：${sanitizedCause(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(`PopDEX 写 RPC ${method} HTTP ${response.status}。`);
    }
    if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || body.id !== id) {
      throw new Error(`PopDEX 写 RPC ${method} 返回无效 JSON-RPC 信封。`);
    }
    if (body.error !== undefined) {
      throw new Error(
        `PopDEX 写 RPC ${method} error ${String(body.error?.code)}：${String(body.error?.message)}`
        + errorData(body.error?.data),
      );
    }
    if (!Object.hasOwn(body, 'result')) {
      throw new Error(`PopDEX 写 RPC ${method} 成功响应缺少 result。`);
    }
    return body.result;
  }

  async verifyChain() {
    const raw = await this.#request('eth_chainId');
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw new Error(`PopDEX 写 RPC eth_chainId 返回无效值 ${String(raw)}。`);
    }
    const chainId = BigInt(raw);
    if (chainId !== POPDEX_CHAIN_ID) {
      throw new Error(`PopDEX 写 RPC chainId 必须是 2184，实际 ${chainId}。`);
    }
    return chainId;
  }

  async simulate({ from, to, data, value = '0x0' }) {
    const transaction = {
      from: strictAddress(from, 'simulate.from'),
      to: strictAddress(to, 'simulate.to'),
      data: exactHex(data, 'simulate.data', { allowEmpty: true }),
      value,
    };
    if (value !== '0x0') {
      throw new Error('PopDEX simulate.value 必须是 0x0。');
    }
    return this.#request('eth_call', [transaction, 'latest']);
  }

  async broadcast(serializedTransaction) {
    const raw = exactHex(serializedTransaction, 'serializedTransaction');
    return exactTxHash(await this.#request('eth_sendRawTransaction', [raw]));
  }

  async getReceipt(txHash) {
    return this.#request('eth_getTransactionReceipt', [exactTxHash(txHash)]);
  }

  async getTransactionFailure(txHash) {
    return this.#request('core_getTransactionFailure', [exactTxHash(txHash)]);
  }

  async waitForReceipt(txHash, { timeoutMs = 30000, pollMs = 1000 } = {}) {
    const hash = exactTxHash(txHash);
    const timeout = positiveSafeInteger(timeoutMs, 'receipt timeoutMs');
    const poll = positiveSafeInteger(pollMs, 'receipt pollMs');
    const startedAt = this.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
      throw new Error('PopDEX now() 必须返回非负安全整数。');
    }
    const deadline = startedAt + timeout;
    if (!Number.isSafeInteger(deadline)) {
      throw new Error('PopDEX receipt deadline 超出安全整数范围。');
    }
    while (true) {
      const receipt = await this.getReceipt(hash);
      if (receipt !== null) {
        if (!receipt || typeof receipt !== 'object') {
          throw new Error(`PopDEX 交易 ${hash} 回执格式无效。`);
        }
        if (receipt.status === '0x1') return receipt;
        if (receipt.status !== '0x0') {
          throw new Error(`PopDEX 交易 ${hash} 回执 status 无效：${String(receipt.status)}。`);
        }
        let failure;
        try {
          failure = await this.getTransactionFailure(hash);
        } catch (error) {
          failure = { lookupError: sanitizedCause(error) };
        }
        throw new Error(
          `PopDEX 交易 ${hash} 回执失败：${errorData(failure).trim() || '无失败详情'}`,
        );
      }
      const current = this.now();
      if (!Number.isSafeInteger(current) || current < startedAt) {
        throw new Error('PopDEX now() 在等待回执期间返回无效时间。');
      }
      if (current >= deadline) {
        throw new Error(`PopDEX 等待交易回执超时：${hash}。`);
      }
      await this.sleep(Math.min(poll, deadline - current));
    }
  }
}
