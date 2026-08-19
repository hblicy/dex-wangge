import { EventEmitter } from 'node:events';
import { Wallet, isAddress } from 'ethers';
import { describeError, isTransientNetworkError } from './error-details.js';
import { WebSocket as UndiciWebSocket } from 'undici';
import { compareRisexCursor, parseFillEnvelope, parseOrderEnvelope } from './normalize.js';

const MAINNET_CHAIN_ID = 4153n;
const AUTH_MESSAGE = 'sign in with RISEx';
const AUTH_TYPES = {
  RegisterV2: [
    { name: 'signer', type: 'address' },
    { name: 'message', type: 'string' },
    { name: 'nonce', type: 'uint256' },
  ],
};

function positiveTimeout(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RISEx ${field} 必须是安全正整数毫秒。`);
  }
  return value;
}

export class RisexPrivateStream extends EventEmitter {
  constructor({
    account,
    signerKey,
    apiUrl,
    wsUrl,
    marketIds,
    fetchImpl = fetch,
    WebSocketImpl = UndiciWebSocket,
    walletFactory = (key) => new Wallet(key),
    isSignerRegistered,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    connectTimeoutMs = 15_000,
    snapshotTimeoutMs = 15_000,
    requestTimeoutMs = 15_000,
    setDeadline = setTimeout,
    clearDeadline = clearTimeout,
    logger = console,
  }) {
    super();
    if (!isAddress(account)) throw new Error('RISEx WebSocket account 不是有效 EVM 地址。');
    if (!Array.isArray(marketIds) || marketIds.length !== 2
      || marketIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('RISEx WebSocket marketIds 必须是两个安全正整数。');
    }
    if (typeof isSignerRegistered !== 'function') {
      throw new Error('RISEx WebSocket 缺少 signer 状态检查函数。');
    }
    this.account = account.toLowerCase();
    this.signerKey = signerKey;
    this.apiUrl = apiUrl;
    this.wsUrl = wsUrl;
    this.marketIds = [...marketIds];
    this._marketSet = new Set(marketIds);
    this._fetch = fetchImpl;
    this._WebSocket = WebSocketImpl;
    this._wallet = walletFactory(signerKey);
    if (!this._wallet || !isAddress(this._wallet.address)) {
      throw new Error('RISEx WebSocket signer key 无法派生有效地址。');
    }
    this._isSignerRegistered = isSignerRegistered;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._connectTimeoutMs = positiveTimeout(connectTimeoutMs, 'WebSocket 认证超时');
    this._snapshotTimeoutMs = positiveTimeout(snapshotTimeoutMs, 'Orders 快照超时');
    this._requestTimeoutMs = positiveTimeout(requestTimeoutMs, '认证 GET 超时');
    this._setDeadline = setDeadline;
    this._clearDeadline = clearDeadline;
    this._logger = logger;
    this._socket = null;
    this._connectPromise = null;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectDeadline = null;
    this._authAttempt = 0;
    this._domain = null;
    this._stopped = true;
    this._reconnectTimer = null;
    this._reconnectDelay = 1000;
    this._buffering = false;
    this._buffer = [];
    this._orderSnapshotSeen = false;
    this._snapshotWaiters = [];
    this.authenticated = false;
    this._everAuthenticated = false;
  }

  async connect() {
    if (this.authenticated) return;
    if (this._connectPromise) return this._connectPromise;
    this._stopped = false;
    this._authAttempt = 0;
    this._domain = null;
    this._orderSnapshotSeen = false;
    this._connectPromise = new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
    });
    this._startConnectDeadline();
    try {
      this._socket = new this._WebSocket(this.wsUrl);
      this._bindSocket(this._socket);
    } catch (error) {
      this._rejectConnect(error);
    }
    return this._connectPromise;
  }

  beginBuffering() {
    this._buffering = true;
  }

  drainBuffered() {
    const drained = [...this._buffer]
      .sort((left, right) => compareRisexCursor(left.data.cursor, right.data.cursor));
    this._buffer = [];
    return drained;
  }

  releaseBuffer() {
    this._buffering = false;
  }

  async waitForOrderSnapshot() {
    if (this._orderSnapshotSeen) return;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, deadline: null };
      waiter.deadline = this._setDeadline(() => {
        waiter.deadline = null;
        const index = this._snapshotWaiters.indexOf(waiter);
        if (index >= 0) this._snapshotWaiters.splice(index, 1);
        reject(new Error(`RISEx 私有 Orders 快照 ${this._snapshotTimeoutMs}ms 超时。`));
      }, this._snapshotTimeoutMs);
      this._snapshotWaiters.push(waiter);
    });
  }

  stop() {
    this._stopped = true;
    this.authenticated = false;
    this._everAuthenticated = false;
    if (this._reconnectTimer != null) {
      this._clearTimer(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const error = new Error('RISEx 私有 WebSocket 已停止。');
    this._rejectSnapshotWaiters(error);
    this._rejectConnect(error);
    const socket = this._socket;
    this._socket = null;
    socket?.close?.();
  }

  _bindSocket(socket) {
    socket.addEventListener('open', () => {
      this._logger.log?.('[RISEx WS] 已连接，开始 auth_v2。');
      this._authenticate().catch((error) => this._handleConnectionFailure(error));
    });
    socket.addEventListener('message', (event) => this._handleMessage(event));
    socket.addEventListener('error', (event) => {
      const error = event?.error instanceof Error ? event.error : new Error('RISEx 私有 WebSocket 连接错误。');
      this._logger.error?.(`[RISEx WS] 连接错误：${error.message}`);
    });
    socket.addEventListener('close', (event) => this._handleClose(event));
  }

  async _authenticate() {
    this._authAttempt += 1;
    if (this._authAttempt > 3) throw new Error('RISEx auth_v2 连续失败 3 次。');
    if (await this._isSignerRegistered() !== true) {
      throw new Error('RISEx session signer 未注册或已失效。');
    }
    if (!this._domain) {
      const body = await this._getJson(`${this.apiUrl}/v1/auth/eip712-domain`);
      this._domain = this._parseDomain(body);
    }
    const nonceBody = await this._getJson(
      `${this.apiUrl}/v1/auth/nonce?account=${encodeURIComponent(this.account)}`,
    );
    const rawNonce = nonceBody?.data?.nonce;
    if (typeof rawNonce !== 'string' || !/^(?:0x)?[0-9a-fA-F]+$/.test(rawNonce)) {
      throw new Error('RISEx auth_v2 服务端 nonce 格式非法。');
    }
    const nonce = `0x${rawNonce.replace(/^0x/i, '')}`;
    const message = { signer: this._wallet.address, message: AUTH_MESSAGE, nonce };
    const signature = await this._wallet.signTypedData(this._domain, AUTH_TYPES, message);
    this._send({
      method: 'auth_v2',
      params: {
        account: this.account,
        signer: this._wallet.address,
        message: AUTH_MESSAGE,
        nonce,
        expiration: Math.floor(this._now() / 1000) + 365 * 24 * 60 * 60,
        signature,
      },
    });
    this._logger.log?.(`[RISEx WS] 已发送 auth_v2（第 ${this._authAttempt}/3 次）。`);
  }

  _parseDomain(body) {
    const data = body?.data;
    if (!data || data.name !== 'RISEx' || data.version !== '1') {
      throw new Error('RISEx auth_v2 EIP-712 domain 名称或版本不匹配。');
    }
    let chainId;
    try { chainId = BigInt(data.chain_id); }
    catch { throw new Error('RISEx auth_v2 chain ID 格式非法。'); }
    if (chainId !== MAINNET_CHAIN_ID) {
      throw new Error(`RISEx auth_v2 chain ID 不匹配：${chainId}。`);
    }
    if (!isAddress(data.verifying_contract)) {
      throw new Error('RISEx auth_v2 verifying contract 地址非法。');
    }
    return {
      name: data.name,
      version: data.version,
      chainId,
      verifyingContract: data.verifying_contract,
    };
  }

  async _getJson(url) {
    const controller = new AbortController();
    const pathname = new URL(url).pathname;
    const deadline = this._setDeadline(() => controller.abort(), this._requestTimeoutMs);
    try {
      const response = await this._fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response?.ok) {
        throw new Error(`RISEx GET ${pathname} 失败：HTTP ${response?.status ?? 'unknown'}。`);
      }
      return await response.json();
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`RISEx GET ${pathname} ${this._requestTimeoutMs}ms 超时。`, { cause: error });
      }
      throw new Error(`RISEx GET ${pathname} 失败：${describeError(error)}。`, { cause: error });
    } finally {
      this._clearDeadline(deadline);
    }
  }

  _handleMessage(event) {
    let message;
    try {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      message = JSON.parse(text);
    } catch (error) {
      this._fatal(new Error(`RISEx WebSocket JSON 解析失败：${error.message}`, { cause: error }));
      return;
    }

    if (message?.method === 'auth_v2' || message?.method === 'auth') {
      if (message.status === 'success') this._authSucceeded();
      else this._retryAuthentication().catch((error) => this._fatal(error));
      return;
    }
    if (message?.status === 'error') {
      this._fatal(new Error(`RISEx WebSocket 服务端拒绝：${message.message || message.channel || 'unknown'}`));
      return;
    }
    if (message?.method === 'subscribe' || message?.type === 'subscribed' || message?.type === 'pong') return;

    try {
      if (message?.channel === 'orders') {
        const orders = parseOrderEnvelope(message);
        for (const order of orders) {
          if (!this._marketSet.has(order.marketId)) throw new Error(`RISEx Orders 收到未允许的 market ${order.marketId}。`);
          if (order.sender !== this.account) throw new Error(`RISEx Orders 收到其他账户 ${order.sender} 的订单。`);
          this._deliver('order', order);
        }
        if (message.type === 'snapshot') {
          this._orderSnapshotSeen = true;
          this._resolveSnapshotWaiters();
        }
        return;
      }
      if (message?.channel === 'fills') {
        for (const fill of parseFillEnvelope(message)) {
          if (!this._marketSet.has(fill.marketId)) throw new Error(`RISEx Fills 收到未允许的 market ${fill.marketId}。`);
          this._deliver('fill', fill);
        }
        return;
      }
    } catch (error) {
      if (message?.channel === 'orders') {
        const row = Array.isArray(message.data) ? message.data[0] : null;
        const orderId = typeof row?.id === 'string' && row.id ? row.id : '(unknown)';
        const fields = ['size', 'price', 'filled_size', 'avg_price']
          .map((name) => `${name}:${row?.[name] === null ? 'null' : typeof row?.[name]}`)
          .join(',');
        const cursorFields = [
          ['timestamp', message.timestamp],
          ['block_timestamp', message.block_timestamp],
          ['created_at', row?.created_at],
          ['time', row?.time],
          ['block_number', row?.block_number ?? message.block_number],
          ['log_index', row?.log_index ?? message.log_index],
        ]
          .map(([name, value]) => `${name}:${value === null ? 'null' : typeof value}`)
          .join(',');
        this._fatal(new Error(
          `RISEx Orders 解析失败 type=${String(message.type || '(unknown)')} order=${orderId} fields=${fields} cursor=${cursorFields}：${error.message}`,
          { cause: error },
        ));
        return;
      }
      this._fatal(error);
    }
  }

  _authSucceeded() {
    if (this.authenticated) return;
    this.authenticated = true;
    this._everAuthenticated = true;
    this._reconnectDelay = 1000;
    this._send({ method: 'subscribe', params: { channel: 'orders', market_ids: this.marketIds, makers: [this.account] } });
    this._send({ method: 'subscribe', params: { channel: 'fills', market_ids: this.marketIds } });
    this._logger.log?.('[RISEx WS] auth_v2 成功，已订阅 orders/fills。');
    this.emit('authenticated');
    this._resolveConnect();
  }

  async _retryAuthentication() {
    if (this._authAttempt >= 3) throw new Error('RISEx auth_v2 连续失败 3 次。');
    if (await this._isSignerRegistered() !== true) {
      throw new Error('RISEx session signer 未注册或已失效，停止认证重试。');
    }
    await new Promise((resolve) => this._setTimer(resolve, 1000));
    await this._authenticate();
  }

  _deliver(kind, data) {
    const event = { kind, data };
    if (this._buffering) this._buffer.push(event);
    else this.emit(kind, data);
  }

  _send(value) {
    if (!this._socket || this._socket.readyState !== 1) {
      throw new Error('RISEx WebSocket 未打开，无法发送消息。');
    }
    this._socket.send(JSON.stringify(value));
  }

  _handleClose(event) {
    const wasAuthenticated = this.authenticated;
    this.authenticated = false;
    this._socket = null;
    const error = new Error(`RISEx 私有 WebSocket 已断开（code=${event?.code ?? 'unknown'}）。`);
    this._rejectSnapshotWaiters(error);
    this._rejectConnect(error);
    if (this._stopped) return;
    this.emit('disconnected', { code: event?.code, reason: event?.reason || '', wasAuthenticated });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer != null) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    this._logger.log?.(`[RISEx WS] ${delay}ms 后重连。`);
    this._reconnectTimer = this._setTimer(async () => {
      this._reconnectTimer = null;
      try { await this.connect(); }
      catch (error) {
        this._logger.error?.(`[RISEx WS] 重连失败：${error.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _handleConnectionFailure(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!this._everAuthenticated || !isTransientNetworkError(normalized)) {
      this._fatal(normalized);
      return;
    }
    this._logger.error?.(`[RISEx WS] 临时认证错误：${describeError(normalized)}`);
    this.authenticated = false;
    this._rejectSnapshotWaiters(normalized);
    this._rejectConnect(normalized);
    const socket = this._socket;
    this._socket = null;
    socket?.close?.();
    this._scheduleReconnect();
  }

  _fatal(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this._logger.error?.(`[RISEx WS] 严重错误：${normalized.message}`);
    this._stopped = true;
    this.authenticated = false;
    this._rejectSnapshotWaiters(normalized);
    this._rejectConnect(normalized);
    this.emit('fatal', normalized);
    const socket = this._socket;
    this._socket = null;
    socket?.close?.();
  }

  _resolveConnect() {
    this._clearConnectDeadline();
    const resolve = this._connectResolve;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectPromise = null;
    resolve?.();
  }

  _rejectConnect(error) {
    this._clearConnectDeadline();
    const reject = this._connectReject;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectPromise = null;
    reject?.(error);
  }

  _rejectSnapshotWaiters(error) {
    for (const waiter of this._snapshotWaiters.splice(0)) {
      if (waiter.deadline != null) this._clearDeadline(waiter.deadline);
      waiter.deadline = null;
      waiter.reject(error);
    }
  }

  _resolveSnapshotWaiters() {
    for (const waiter of this._snapshotWaiters.splice(0)) {
      if (waiter.deadline != null) this._clearDeadline(waiter.deadline);
      waiter.deadline = null;
      waiter.resolve();
    }
  }

  _startConnectDeadline() {
    this._clearConnectDeadline();
    this._connectDeadline = this._setDeadline(() => {
      this._connectDeadline = null;
      this._fatal(new Error(`RISEx 私有 WebSocket 认证 ${this._connectTimeoutMs}ms 超时。`));
    }, this._connectTimeoutMs);
  }

  _clearConnectDeadline() {
    if (this._connectDeadline == null) return;
    this._clearDeadline(this._connectDeadline);
    this._connectDeadline = null;
  }
}
