import test from 'node:test';
import assert from 'node:assert/strict';
import { RisexPrivateStream } from '../src/exchange/rs/private-stream.js';
import { isTransientNetworkError } from '../src/exchange/rs/error-details.js';

const ACCOUNT = '0x0000000000000000000000000000000000000001';
const SIGNER = '0x0000000000000000000000000000000000000002';
const SIGNER_KEY = `0x${'11'.repeat(32)}`;
const API = 'https://api.rise.trade';
const WS = 'wss://api.rise.trade/ws/';

test('RISEx transient network classification follows nested causes but rejects HTTP failures', () => {
  const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const fetchError = new TypeError('fetch failed', { cause: socketError });

  assert.equal(isTransientNetworkError(fetchError), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(isTransientNetworkError(new Error('RISEx GET /v1/auth/nonce 失败：HTTP 403。')), false);
  assert.equal(isTransientNetworkError(new Error('RISEx auth_v2 EIP-712 domain 名称或版本不匹配。')), false);
});

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    this.readyState = 0;
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  send(value) { this.sent.push(value); }

  emit(type, value = {}) {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const handler of this.listeners.get(type) || []) handler(value);
  }

  message(value) { this.emit('message', { data: JSON.stringify(value) }); }

  close() {
    if (this.readyState !== 3) this.emit('close', { code: 1000, reason: 'client stop' });
  }
}

function fakeResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'Error', json: async () => body };
}

function makeHarness(overrides = {}) {
  FakeSocket.instances = [];
  const requests = [];
  let nonce = 0;
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url).endsWith('/v1/auth/eip712-domain')) {
      return fakeResponse({ data: { name: 'RISEx', version: '1', chain_id: 4153, verifying_contract: '0x0000000000000000000000000000000000000003' } });
    }
    nonce += 1;
    return fakeResponse({ data: { nonce: `0x0${nonce}` } });
  };
  const signatures = [];
  const walletFactory = () => ({
    address: SIGNER,
    async signTypedData(domain, types, message) {
      signatures.push({ domain, types, message });
      return '0xsigned';
    },
  });
  const scheduled = [];
  const setTimer = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  const stream = new RisexPrivateStream({
    account: ACCOUNT, signerKey: SIGNER_KEY, apiUrl: API, wsUrl: WS,
    marketIds: [1, 2], fetchImpl, WebSocketImpl: FakeSocket, walletFactory,
    isSignerRegistered: async () => true,
    now: () => 1768464000000,
    setTimer,
    clearTimer: () => {},
    logger: { log() {}, error() {} },
    ...overrides,
  });
  return { stream, requests, signatures, scheduled };
}

async function openAndAuthenticate(harness) {
  const connecting = harness.stream.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.emit('open');
  await waitFor(() => socket.sent.length === 1);
  socket.message({ method: 'auth_v2', status: 'success' });
  await connecting;
  return socket;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('等待测试条件超时。');
}

test('auth_v2 signs official RegisterV2 and subscribes only after success', async () => {
  const harness = makeHarness();
  const connecting = harness.stream.connect();
  const socket = FakeSocket.instances[0];
  socket.emit('open');
  await waitFor(() => socket.sent.length === 1);

  assert.deepEqual(harness.requests, [
    `${API}/v1/auth/eip712-domain`,
    `${API}/v1/auth/nonce?account=${encodeURIComponent(ACCOUNT)}`,
  ]);
  assert.equal(socket.sent.length, 1);
  const auth = JSON.parse(socket.sent[0]);
  const expiration = Math.floor(1768464000000 / 1000) + 365 * 24 * 60 * 60;
  assert.deepEqual(auth, {
    method: 'auth_v2',
    params: {
      account: ACCOUNT, signer: SIGNER, message: 'sign in with RISEx',
      nonce: '0x01', expiration,
      signature: '0xsigned',
    },
  });
  assert.doesNotMatch(JSON.stringify(socket.sent), new RegExp(SIGNER_KEY.slice(2)));
  assert.deepEqual(harness.signatures[0].types, {
    RegisterV2: [
      { name: 'signer', type: 'address' },
      { name: 'message', type: 'string' },
      { name: 'nonce', type: 'uint256' },
    ],
  });
  assert.equal(socket.sent.length, 1);

  socket.message({ method: 'auth_v2', status: 'success' });
  await connecting;
  assert.deepEqual(socket.sent.slice(1).map(JSON.parse), [
    { method: 'subscribe', params: { channel: 'orders', market_ids: [1, 2], makers: [ACCOUNT] } },
    { method: 'subscribe', params: { channel: 'fills', market_ids: [1, 2] } },
  ]);
});

test('invalid mainnet domain fails before signing', async () => {
  const harness = makeHarness({
    fetchImpl: async (url) => String(url).endsWith('eip712-domain')
      ? fakeResponse({ data: { name: 'RISEx', version: '1', chain_id: 1, verifying_contract: '0x0000000000000000000000000000000000000003' } })
      : fakeResponse({ data: { nonce: '0x01' } }),
  });
  const connecting = harness.stream.connect();
  FakeSocket.instances[0].emit('open');
  await assert.rejects(connecting, /chain ID/);
  assert.equal(harness.signatures.length, 0);
});

test('orders and fills buffer until reconciliation release', async () => {
  const harness = makeHarness();
  harness.stream.beginBuffering();
  const socket = await openAndAuthenticate(harness);
  const emitted = [];
  harness.stream.on('order', (value) => emitted.push(['order', value]));
  harness.stream.on('fill', (value) => emitted.push(['fill', value]));

  socket.message({
    method: 'snapshot', channel: 'orders', type: 'snapshot', timestamp: '10',
    data: [{ id: 'o1', market_id: '1', side: 'BUY', size: '1', price: '100', filled_size: '0', avg_price: '0', status: 'ORDER_STATUS_OPEN', sender: ACCOUNT, block_number: '1', log_index: '0' }],
  });
  socket.message({
    channel: 'fills', type: 'update', block_number: 2, log_index: 0, timestamp: '20',
    data: { id: 'f1', order_id: 'o1', market_id: '1', side: 'BUY', price: '99', size: '0.25', fee: '0', time: '20' },
  });
  await harness.stream.waitForOrderSnapshot();
  assert.deepEqual(emitted, []);
  assert.deepEqual(harness.stream.drainBuffered().map((event) => event.kind), ['order', 'fill']);

  harness.stream.releaseBuffer();
  socket.message({
    channel: 'fills', type: 'update', block_number: 3, log_index: 0, timestamp: '30',
    data: { id: 'f2', order_id: 'o1', market_id: '1', side: 'BUY', price: '98', size: '0.25', fee: '0', time: '30' },
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'fill');
});

test('messages for another account or market are fatal', async () => {
  const harness = makeHarness();
  const socket = await openAndAuthenticate(harness);
  const fatal = new Promise((resolve) => harness.stream.once('fatal', resolve));
  socket.message({
    channel: 'orders', type: 'update', timestamp: '10',
    data: [{ id: 'o1', market_id: '9', side: 'BUY', size: '1', price: '100', filled_size: '0', avg_price: '0', status: 'ORDER_STATUS_OPEN', sender: '0x0000000000000000000000000000000000000009', block_number: '1', log_index: '0' }],
  });
  assert.match((await fatal).message, /账户|market/);
});

test('Orders parse diagnostics expose schema types without secrets', async () => {
  const harness = makeHarness();
  const socket = await openAndAuthenticate(harness);
  const fatal = new Promise((resolve) => harness.stream.once('fatal', resolve));
  socket.message({
    channel: 'orders', type: 'update', timestamp: '10',
    data: [{ id: 'o-invalid', market_id: '1', side: 'BUY', size: 0.001, price: '61000', filled_size: '0', avg_price: '0', status: 'ORDER_STATUS_OPEN', sender: ACCOUNT, block_number: '1', log_index: '0' }],
  });

  const error = await fatal;
  assert.match(error.message, /Orders 解析失败/);
  assert.match(error.message, /type=update/);
  assert.match(error.message, /order=o-invalid/);
  assert.match(error.message, /size:number,price:string/);
  assert.match(error.message, /cursor=timestamp:string,block_timestamp:undefined,created_at:undefined,time:undefined,block_number:string,log_index:string/);
  assert.doesNotMatch(error.message, /signature|permit|signerKey/i);
});

test('auth failures fetch fresh nonces and stop after three attempts', async () => {
  const harness = makeHarness({ setTimer: (fn) => { queueMicrotask(fn); return 1; } });
  const connecting = harness.stream.connect();
  const socket = FakeSocket.instances[0];
  socket.emit('open');
  await Promise.resolve(); await Promise.resolve();
  socket.message({ method: 'auth_v2', status: 'error' });
  await Promise.resolve(); await Promise.resolve();
  socket.message({ method: 'auth_v2', status: 'error' });
  await Promise.resolve(); await Promise.resolve();
  socket.message({ method: 'auth_v2', status: 'error' });
  await assert.rejects(connecting, /3 次/);
  assert.equal(harness.requests.filter((url) => url.includes('/nonce?')).length, 3);
});

test('disconnect emits state and schedules exponential reconnect unless stopped', async () => {
  const harness = makeHarness();
  const socket = await openAndAuthenticate(harness);
  const disconnected = new Promise((resolve) => harness.stream.once('disconnected', resolve));
  socket.emit('close', { code: 1006, reason: 'network' });
  await disconnected;
  assert.equal(harness.scheduled.at(-1).ms, 1000);

  harness.stream.stop();
  const before = harness.scheduled.length;
  socket.emit('close', { code: 1000, reason: 'again' });
  assert.equal(harness.scheduled.length, before);
});

test('runtime signer-check fetch failure reconnects without fatal and later authenticates', async () => {
  let failSignerCheck = false;
  const logs = [];
  const harness = makeHarness({
    isSignerRegistered: async () => {
      if (!failSignerCheck) return true;
      const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
      throw new TypeError('fetch failed', { cause: socketError });
    },
    logger: { log() {}, error(message) { logs.push(message); } },
  });
  let fatals = 0;
  harness.stream.on('fatal', () => { fatals += 1; });

  const firstSocket = await openAndAuthenticate(harness);
  firstSocket.emit('close', { code: 1006, reason: 'network' });
  failSignerCheck = true;

  const failedRetry = harness.scheduled.at(-1).fn();
  const failedConnect = harness.stream._connectPromise;
  const failedSocket = FakeSocket.instances.at(-1);
  failedSocket.emit('open');
  await assert.rejects(failedConnect, /fetch failed/);
  await failedRetry;
  await waitFor(() => harness.scheduled.length >= 2);

  assert.equal(fatals, 0);
  assert.equal(harness.stream.authenticated, false);
  assert.match(logs.join('\n'), /临时认证错误/);
  assert.match(logs.join('\n'), /UND_ERR_SOCKET/);

  failSignerCheck = false;
  const recoveredRetry = harness.scheduled.at(-1).fn();
  const recoveredSocket = FakeSocket.instances.at(-1);
  recoveredSocket.emit('open');
  await waitFor(() => recoveredSocket.sent.length === 1);
  recoveredSocket.message({ method: 'auth_v2', status: 'success' });
  await recoveredRetry;

  assert.equal(harness.stream.authenticated, true);
  assert.equal(fatals, 0);
});

test('private stream connect timeout rejects and closes the socket', async () => {
  const deadlines = [];
  const harness = makeHarness({
    connectTimeoutMs: 20,
    setDeadline: (fn, ms) => { deadlines.push({ fn, ms }); return deadlines.length; },
    clearDeadline() {},
  });
  let initialFatal = null;
  harness.stream.once('fatal', (error) => { initialFatal = error; });
  const connecting = harness.stream.connect();
  const deadline = deadlines.find((entry) => entry.ms === 20);
  assert.ok(deadline, 'connect deadline was not scheduled');
  deadline.fn();

  await assert.rejects(connecting, /认证 20ms 超时/);
  assert.match(initialFatal?.message || '', /认证 20ms 超时/);
  assert.equal(FakeSocket.instances[0].readyState, 3);
});

test('runtime authentication timeout reconnects while initial timeout remains fatal', async () => {
  const deadlines = [];
  const harness = makeHarness({
    connectTimeoutMs: 20,
    setDeadline: (fn, ms) => { deadlines.push({ fn, ms }); return deadlines.length; },
    clearDeadline() {},
  });
  let fatals = 0;
  harness.stream.on('fatal', () => { fatals += 1; });
  const firstSocket = await openAndAuthenticate(harness);
  firstSocket.emit('close', { code: 1006, reason: 'network' });

  const reconnecting = harness.scheduled.at(-1).fn();
  const runtimeConnect = harness.stream._connectPromise;
  const runtimeDeadline = deadlines.at(-1);
  runtimeDeadline.fn();
  await assert.rejects(runtimeConnect, /认证 20ms 超时/);
  await reconnecting;
  await waitFor(() => harness.scheduled.length >= 2);

  assert.equal(fatals, 0);
  assert.equal(harness.stream.authenticated, false);
});

test('private stream order snapshot timeout removes its waiter', async () => {
  const deadlines = [];
  const harness = makeHarness({
    snapshotTimeoutMs: 30,
    setDeadline: (fn, ms) => { deadlines.push({ fn, ms }); return deadlines.length; },
    clearDeadline() {},
  });
  await openAndAuthenticate(harness);
  const waiting = harness.stream.waitForOrderSnapshot();
  const deadline = deadlines.find((entry) => entry.ms === 30);
  assert.ok(deadline, 'snapshot deadline was not scheduled');
  deadline.fn();

  await assert.rejects(waiting, /Orders 快照 30ms 超时/);
  assert.equal(harness.stream._snapshotWaiters.length, 0);
});

test('private stream auth GET timeout aborts the request', async () => {
  const deadlines = [];
  let aborted = false;
  const harness = makeHarness({
    requestTimeoutMs: 40,
    setDeadline: (fn, ms) => { deadlines.push({ fn, ms }); return deadlines.length; },
    clearDeadline() {},
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      if (!init.signal) {
        reject(new Error('missing abort signal'));
        return;
      }
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
  });
  const connecting = harness.stream.connect();
  FakeSocket.instances[0].emit('open');
  await waitFor(() => deadlines.some((entry) => entry.ms === 40));
  deadlines.find((entry) => entry.ms === 40).fn();

  await assert.rejects(connecting, /GET .* 40ms 超时/);
  assert.equal(aborted, true);
});

test('private stream auth GET exposes a sanitized nested network cause', async () => {
  const socketError = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const harness = makeHarness({
    fetchImpl: async () => { throw new TypeError('fetch failed', { cause: socketError }); },
  });
  const connecting = harness.stream.connect();
  FakeSocket.instances[0].emit('open');

  await assert.rejects(
    connecting,
    (error) => {
      assert.match(error.message, /GET \/v1\/auth\/eip712-domain 失败/);
      assert.match(error.message, /UND_ERR_SOCKET/);
      assert.match(error.message, /other side closed/);
      assert.doesNotMatch(error.message, new RegExp(ACCOUNT, 'i'));
      assert.doesNotMatch(error.message, new RegExp(SIGNER_KEY.slice(2), 'i'));
      return true;
    },
  );
});
