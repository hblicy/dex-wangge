import test from 'node:test';
import assert from 'node:assert/strict';
import { RisexPrivateStream } from '../src/exchange/rs/private-stream.js';

const ACCOUNT = '0x0000000000000000000000000000000000000001';
const SIGNER = '0x0000000000000000000000000000000000000002';
const SIGNER_KEY = `0x${'11'.repeat(32)}`;
const API = 'https://api.rise.trade';
const WS = 'wss://api.rise.trade/ws/';

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
      return fakeResponse({ data: { name: 'RISEx Auth', version: '1', chain_id: 11155931, verifying_contract: '0x0000000000000000000000000000000000000003' } });
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
      ? fakeResponse({ data: { name: 'RISEx Auth', version: '1', chain_id: 1, verifying_contract: '0x0000000000000000000000000000000000000003' } })
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
    data: [{ id: 'o1', market_id: '1', side: 'BUY', size: '1000000000000000000', price: '100000000000000000000', filled_size: '0', avg_price: '0', status: 'ORDER_STATUS_OPEN', sender: ACCOUNT, block_number: '1', log_index: '0' }],
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
    data: [{ id: 'o1', market_id: '9', side: 'BUY', size: '1000000000000000000', price: '100000000000000000000', filled_size: '0', avg_price: '0', status: 'ORDER_STATUS_OPEN', sender: '0x0000000000000000000000000000000000000009', block_number: '1', log_index: '0' }],
  });
  assert.match((await fatal).message, /账户|market/);
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
