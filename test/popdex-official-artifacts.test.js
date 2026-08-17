import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectOfficialArtifacts,
  POPDEX_REQUIRED_PROTOCOL_TOKENS,
} from '../src/exchange/px/official-artifacts.js';

const HTML = `<!doctype html><html><body>
  <script src="/runtime.js"></script>
  <script src="https://app.popdex.xyz/trade.js"></script>
  <script src="/web3.js"></script>
</body></html>`;

const CHUNKS = new Map([
  ['/runtime.js', 'globalThis.__webpack_runtime__ = true;'],
  ['/trade.js', 'function placeOrder(){} function cancelOrder(){} const clientOrderId="grid";'],
  ['/web3.js', 'function approveAgent(){} function revokeAgent(){} function updateLeverage(){} function placeReverseOrder(){}'],
]);

function textResponse(text, status = 200, contentType = 'text/javascript') {
  return new Response(text, {
    status,
    headers: { 'content-type': contentType },
  });
}

async function fakeArtifactFetch(input) {
  const url = new URL(input);
  if (url.pathname === '/') return textResponse(HTML, 200, 'text/html');
  if (CHUNKS.has(url.pathname)) return textResponse(CHUNKS.get(url.pathname));
  throw new Error(`unexpected URL ${url}`);
}

test('artifact scanner resolves same-origin scripts and hashes exact bytes', async () => {
  const result = await inspectOfficialArtifacts({ fetchImpl: fakeArtifactFetch });
  assert.deepEqual(result.scripts.map((entry) => entry.path), [
    '/runtime.js',
    '/trade.js',
    '/web3.js',
  ]);
  assert.match(result.scripts[1].sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.scripts[1].bytes, Buffer.byteLength(CHUNKS.get('/trade.js')));
});

test('artifact scanner records protocol tokens with bounded context', async () => {
  const result = await inspectOfficialArtifacts({ fetchImpl: fakeArtifactFetch });
  assert.ok(result.matches.some((entry) => entry.token === 'approveAgent'));
  assert.ok(result.matches.some((entry) => entry.token === 'placeOrder'));
  assert.ok(result.matches.some((entry) => entry.token === 'cancelOrder'));
  assert.ok(result.matches.every((entry) => entry.context.length <= 1200));
});

test('required protocol evidence includes on-chain active and completed order queries', () => {
  for (const token of [
    'getActiveOrdersByAccount',
    'getCompletedOrdersByAccount',
    'placeOrder',
    'cancelOrder',
  ]) {
    assert.ok(POPDEX_REQUIRED_PROTOCOL_TOKENS.includes(token), token);
  }
});

test('artifact scanner rejects cross-origin scripts and HTML without application chunks', async () => {
  const hostileArtifactFetch = async () => textResponse(
    '<script src="https://evil.example/steal.js"></script>',
    200,
    'text/html',
  );
  await assert.rejects(
    inspectOfficialArtifacts({ fetchImpl: hostileArtifactFetch }),
    /同源/,
  );

  const emptyArtifactFetch = async () => textResponse('<main>no scripts</main>', 200, 'text/html');
  await assert.rejects(
    inspectOfficialArtifacts({ fetchImpl: emptyArtifactFetch }),
    /application chunks|脚本/,
  );
});

test('artifact scanner deduplicates scripts and never evaluates downloaded JavaScript', async () => {
  delete globalThis.__popdexArtifactExecuted;
  const html = '<script src="/x.js"></script><script src="/x.js"></script>';
  const fetchImpl = async (input) => {
    const url = new URL(input);
    return url.pathname === '/'
      ? textResponse(html, 200, 'text/html')
      : textResponse('globalThis.__popdexArtifactExecuted = true; function placeOrder(){}');
  };
  const result = await inspectOfficialArtifacts({ fetchImpl, tokens: ['placeOrder'] });
  assert.equal(result.scripts.length, 1);
  assert.equal(globalThis.__popdexArtifactExecuted, undefined);
});
