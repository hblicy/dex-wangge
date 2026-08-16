# PopDEX Protocol Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fail-fast, read-only PopDEX protocol verifier that produces enough authoritative evidence to write the separate PopDEX adapter implementation plan without guessing Agent signing, order identity, account schemas, or market precision.

**Architecture:** Add a temporary `src/exchange/px/` discovery surface with strict public/account clients, RPC identity checks, official-web-artifact inspection, and a single verifier CLI. It performs no trading writes and never requires an Agent private key. Its committed validation report is the hard gate for the later adapter, Agent authorization UI, and Extended removal plan.

**Tech Stack:** Node.js 20 ESM, built-in `fetch`, `node:test`, `ethers` 6.x, PopDEX public/account REST, PopDEX Mainnet JSON-RPC, GitHub-tracked Markdown/JSON evidence.

---

## Scope boundary

This plan intentionally stops before implementing live writes. The approved design contains an unresolved protocol dependency: the reference repository contradicts itself about whether the Agent is the EVM sender, and it does not reliably map `txHash` to official `orderId`. Writing the full adapter plan before resolving those facts would encode an unverified trading protocol.

Completion of this plan must produce `docs/protocol/popdex-mainnet-validation.md` with one of two explicit conclusions:

- `VALIDATED`: every required protocol item has authoritative evidence and the full adapter plan may be written.
- `BLOCKED`: the missing item and required external evidence are named; no live adapter work begins.

No task in this plan broadcasts transactions, changes leverage, places orders, cancels orders, or closes positions.

## File map

Create:

- `src/exchange/px/constants.js` — fixed mainnet identity, two-market whitelist, endpoint paths and expected market metadata.
- `src/exchange/px/normalize.js` — strict address, decimal, integer ID, market, order, fill and position parsers used by verification.
- `src/exchange/px/public-client.js` — PopDEX public market/ticker/candle reads.
- `src/exchange/px/account-client.js` — wallet-scoped orders, fills, overview and position reads without browser-session assumptions.
- `src/exchange/px/rpc-client.js` — JSON-RPC identity and read-only call wrapper.
- `src/exchange/px/official-artifacts.js` — official app HTML/chunk discovery, SHA-256 hashing and protocol-token extraction.
- `src/exchange/px/verify.js` — public/private-read-only verification CLI.
- `test/popdex-normalize.test.js`
- `test/popdex-public-client.test.js`
- `test/popdex-account-client.test.js`
- `test/popdex-rpc-client.test.js`
- `test/popdex-official-artifacts.test.js`
- `test/popdex-verify.test.js`
- `docs/protocol/popdex-mainnet-validation.md` — observed evidence and final gate result.

Modify:

- `package.json` — add the read-only verifier and test files; do not register PopDEX as a runnable exchange yet.

Do not modify during this plan:

- `src/config.js`
- `src/server.js`
- `src/bot.js`
- `public/index.html`
- `src/exchange/ex/`

### Task 1: Lock the public protocol identity and strict primitive parsers

**Files:**
- Create: `src/exchange/px/constants.js`
- Create: `src/exchange/px/normalize.js`
- Create: `test/popdex-normalize.test.js`

- [ ] **Step 1: Write the failing normalization tests**

Create tests that assert the only accepted markets and exact current metadata:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeMarket,
  strictAddress,
  strictDecimalString,
  strictIntegerString,
} from '../src/exchange/px/normalize.js';

const BTC = {
  symbolId: '20000', symbol: 'BTCUSDT', category: 'Futures', status: 'Trading',
  tickSize: '1', lotSize: '0.0001', minQty: '0.0001', minNotional: '10',
  defaultLeverage: '20',
};

test('PopDEX accepts only the exact BTCUSDT and ETHUSDT mainnet identities', () => {
  assert.deepEqual(normalizeMarket(BTC), {
    marketId: 20000,
    name: 'BTCUSDT',
    displayName: 'BTCUSDT',
    symbol: 'BTC',
    stepPrice: 1,
    stepSize: 0.0001,
    minOrderSize: 0.0001,
    minNotional: 10,
    defaultLeverage: 20,
  });
  assert.throws(() => normalizeMarket({ ...BTC, symbol: 'SOLUSDT', symbolId: '20002' }), /不在白名单/);
  assert.throws(() => normalizeMarket({ ...BTC, tickSize: '0.5' }), /tickSize/);
});

test('PopDEX primitive parsers reject unsafe or lossy values', () => {
  assert.equal(strictAddress('0x1111111111111111111111111111111111111111', 'account'), '0x1111111111111111111111111111111111111111');
  assert.equal(strictIntegerString('90071992547409931234', 'orderId'), '90071992547409931234');
  assert.equal(strictDecimalString('0.0001', 'qty'), '0.0001');
  assert.throws(() => strictIntegerString(9007199254740992, 'orderId'), /字符串/);
  assert.throws(() => strictDecimalString('1e-4', 'qty'), /十进制字符串/);
});
```

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run:

```powershell
node --test test/popdex-normalize.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/exchange/px/normalize.js`.

- [ ] **Step 3: Add exact mainnet constants and minimal strict parsers**

`constants.js` exports immutable values:

```js
export const POPDEX_CHAIN_ID = 2184n;
export const POPDEX_API_BASE = 'https://api.popdex.xyz';
export const POPDEX_WEB_BASE = 'https://app.popdex.xyz';
export const POPDEX_RPC_URL = 'https://app.popdex.xyz/api/v1/web3/rpc';
export const POPDEX_PUBLIC_WS = 'wss://ws.popdex.xyz/v1/ws/public';
export const POPDEX_ORDER_PRECOMPILE = '0x0000000000000000000000000000000000001000';
export const POPDEX_ACCOUNT_PRECOMPILE = '0x0000000000000000000000000000000000001008';
export const POPDEX_EXPECTED_MARKETS = Object.freeze({
  BTCUSDT: Object.freeze({ symbolId: '20000', tickSize: '1', lotSize: '0.0001', minQty: '0.0001', minNotional: '10' }),
  ETHUSDT: Object.freeze({ symbolId: '20001', tickSize: '0.1', lotSize: '0.001', minQty: '0.001', minNotional: '10' }),
});
```

`normalize.js` must:

- accept decimal strings matching `^(?:0|[1-9]\d*)(?:\.\d+)?$`;
- accept non-negative integer strings matching `^(?:0|[1-9]\d*)$`;
- validate EVM addresses with `ethers.isAddress` and reject the zero address;
- require category `Futures`, status `Trading`, exact symbol ID and exact precision for BTC/ETH;
- convert only bounded display values to `Number` after checking `Number.isFinite`.

- [ ] **Step 4: Run the focused tests**

Run:

```powershell
node --test test/popdex-normalize.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the identity contract**

```powershell
git add src/exchange/px/constants.js src/exchange/px/normalize.js test/popdex-normalize.test.js
git commit -m "验证：锁定PopDEX主网市场身份"
```

### Task 2: Implement fail-fast public market reads

**Files:**
- Create: `src/exchange/px/public-client.js`
- Create: `test/popdex-public-client.test.js`

- [ ] **Step 1: Write failing client tests with injected fetch**

Cover these behaviors:

```js
test('public client returns exactly BTCUSDT and ETHUSDT in stable order', async () => {
  const client = new PopdexPublicClient({ fetchImpl: fakePublicFetch });
  const markets = await client.getMarkets();
  assert.deepEqual(markets.map((m) => m.marketId), [20000, 20001]);
});

test('public client rejects a successful HTTP response with changed BTC precision', async () => {
  const client = new PopdexPublicClient({ fetchImpl: changedPrecisionFetch });
  await assert.rejects(client.getMarkets(), /BTCUSDT.*tickSize/);
});

test('ticker requires positive bid ask last index and mark prices', async () => {
  const client = new PopdexPublicClient({ fetchImpl: fakePublicFetch });
  assert.deepEqual(await client.getTicker('BTCUSDT'), {
    bid: 62978, ask: 62980, last: 62979, index: 63009, mark: 62981,
  });
});
```

The fake response must use the observed official envelope `{ code: '200', msg: 'success', data: [...] }` and verify the requested pathname/query.

- [ ] **Step 2: Run and verify failure**

```powershell
node --test test/popdex-public-client.test.js
```

Expected: FAIL because `PopdexPublicClient` is not defined.

- [ ] **Step 3: Implement the minimal public client**

The constructor accepts `{ apiBase = POPDEX_API_BASE, fetchImpl = fetch, timeoutMs = 10000 }`.

Implement:

```js
async getMarkets()
async getTicker(symbol)
async getCandles(symbol, interval = '1H', limit = 200)
```

Every request must:

- use `AbortSignal.timeout(timeoutMs)`;
- require HTTP success and `code === '200'`;
- require `data` to be an array;
- include pathname, HTTP status and sanitized nested network cause in errors;
- never return a synthetic market or price.

- [ ] **Step 4: Run focused tests and syntax checks**

```powershell
node --check src/exchange/px/public-client.js
node --test test/popdex-public-client.test.js
```

Expected: exit code 0 and all tests PASS.

- [ ] **Step 5: Commit the public client**

```powershell
git add src/exchange/px/public-client.js test/popdex-public-client.test.js
git commit -m "验证：增加PopDEX公共只读客户端"
```

### Task 3: Verify wallet-scoped account endpoints without browser tokens

**Files:**
- Create: `src/exchange/px/account-client.js`
- Modify: `src/exchange/px/normalize.js`
- Create: `test/popdex-account-client.test.js`

- [ ] **Step 1: Write failing account client tests**

Use injected fixtures for these exact requests:

```text
GET https://api.popdex.xyz/api/v1/account/{wallet}/orders?limit=100&symbol=BTCUSDT
GET https://api.popdex.xyz/api/v1/account/{wallet}/trade/fills?limit=100&symbol=BTCUSDT
GET https://app.popdex.xyz/web/v1/account/{wallet}/overview
```

Tests must assert:

```js
test('account reads do not require or send a copied website bearer token', async () => {
  const seen = [];
  const client = new PopdexAccountClient({ fetchImpl: makeAccountFetch(seen) });
  await client.getOpenOrders(ACCOUNT, 'BTCUSDT');
  assert.equal(seen.some((headers) => headers.has('authorization') || headers.has('dy-token')), false);
});

test('order and fill IDs remain exact strings', async () => {
  const client = new PopdexAccountClient({ fetchImpl: makeAccountFetch() });
  const [order] = await client.getOpenOrders(ACCOUNT, 'BTCUSDT');
  assert.equal(order.orderId, '90071992547409931234');
  const [fill] = await client.getFills(ACCOUNT, 'BTCUSDT');
  assert.equal(fill.fillId, '90071992547409939999');
});

test('account response errors and malformed arrays fail instead of becoming empty state', async () => {
  const client = new PopdexAccountClient({ fetchImpl: malformedAccountFetch });
  await assert.rejects(client.getOpenOrders(ACCOUNT, 'BTCUSDT'), /orders.*数组/);
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test test/popdex-account-client.test.js
```

Expected: FAIL with missing account client module.

- [ ] **Step 3: Implement strict account reads**

Implement:

```js
async getOpenOrders(account, symbol)
async getOrderHistory(account, symbol, cursor = null)
async getFills(account, symbol, cursor = null)
async getOverview(account)
async getPositions(account)
```

Requirements:

- validate account and two-symbol whitelist before the request;
- use only documented web headers (`Accept`, `website`, `terminaltype`, `language`, `locale`, `enterPointSource`);
- do not accept an API token constructor option;
- treat `code='11100' Account does not exist` as an explicit account error, not an empty account;
- normalize list containers only from the explicitly observed keys `data`, `list`, `rows`, `orders`, `fills`, or `positions`;
- require every live order/fill to contain exact string identity fields;
- expose returned cursor without converting it to `Number`.

- [ ] **Step 4: Run focused tests**

```powershell
node --check src/exchange/px/account-client.js
node --test test/popdex-normalize.test.js test/popdex-account-client.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the account client**

```powershell
git add src/exchange/px/account-client.js src/exchange/px/normalize.js test/popdex-account-client.test.js
git commit -m "验证：增加PopDEX账户只读客户端"
```

### Task 4: Capture official app artifacts and extract protocol evidence

**Files:**
- Create: `src/exchange/px/official-artifacts.js`
- Create: `test/popdex-official-artifacts.test.js`

- [ ] **Step 1: Write failing deterministic artifact tests**

Use a fake HTML document with three script tags and fake chunk contents. Assert:

```js
test('artifact scanner resolves same-origin scripts and hashes exact bytes', async () => {
  const result = await inspectOfficialArtifacts({ fetchImpl: fakeArtifactFetch });
  assert.deepEqual(result.scripts.map((x) => x.path), ['/runtime.js', '/trade.js', '/web3.js']);
  assert.match(result.scripts[1].sha256, /^[0-9a-f]{64}$/);
});

test('artifact scanner records protocol tokens with bounded context', async () => {
  const result = await inspectOfficialArtifacts({ fetchImpl: fakeArtifactFetch });
  assert.ok(result.matches.some((x) => x.token === 'approveAgent'));
  assert.ok(result.matches.some((x) => x.token === 'placeOrder'));
  assert.ok(result.matches.some((x) => x.token === 'cancelOrder'));
  assert.ok(result.matches.every((x) => x.context.length <= 1200));
});

test('artifact scanner rejects cross-origin scripts and HTML without application chunks', async () => {
  await assert.rejects(inspectOfficialArtifacts({ fetchImpl: hostileArtifactFetch }), /同源/);
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test test/popdex-official-artifacts.test.js
```

Expected: FAIL with missing artifact scanner module.

- [ ] **Step 3: Implement read-only artifact inspection**

Export:

```js
export async function inspectOfficialArtifacts({
  appUrl = 'https://app.popdex.xyz/',
  fetchImpl = fetch,
  tokens = [
    'approveAgent', 'revokeAgent', 'placeOrder', 'cancelOrder',
    'updateLeverage', 'closePosition', 'clientOrderId',
    '0x0000000000000000000000000000000000001000',
    '0x0000000000000000000000000000000000001008',
  ],
} = {})
```

The result contains:

```js
{
  fetchedAt,
  appUrl,
  scripts: [{ path, sha256, bytes }],
  matches: [{ path, token, offset, context }],
}
```

Use `crypto.createHash('sha256')`. Resolve only `https://app.popdex.xyz` script URLs, deduplicate them, cap each response at 20 MB, and cap every context at 1200 characters. Never execute downloaded JavaScript.

- [ ] **Step 4: Run focused tests**

```powershell
node --check src/exchange/px/official-artifacts.js
node --test test/popdex-official-artifacts.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the scanner**

```powershell
git add src/exchange/px/official-artifacts.js test/popdex-official-artifacts.test.js
git commit -m "验证：增加PopDEX官方前端协议扫描"
```

### Task 5: Add a read-only Mainnet RPC identity client

**Files:**
- Create: `src/exchange/px/rpc-client.js`
- Create: `test/popdex-rpc-client.test.js`

- [ ] **Step 1: Write failing RPC tests**

```js
test('RPC client requires chainId 2184', async () => {
  const client = new PopdexRpcClient({ fetchImpl: rpcFetch('0x888') });
  assert.equal(await client.verifyChain(), 2184n);
});

test('RPC client rejects another chain before any protocol call', async () => {
  const client = new PopdexRpcClient({ fetchImpl: rpcFetch('0x1') });
  await assert.rejects(client.verifyChain(), /2184/);
});

test('RPC client preserves JSON-RPC error code data and nested network cause', async () => {
  const client = new PopdexRpcClient({ fetchImpl: failingRpcFetch });
  await assert.rejects(client.call('eth_getTransactionByHash', ['0x' + '11'.repeat(32)]), /-32602.*invalid params/);
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test test/popdex-rpc-client.test.js
```

Expected: FAIL with missing RPC client module.

- [ ] **Step 3: Implement the read-only RPC boundary**

Implement only:

```js
async call(method, params = [])
async verifyChain()
async getTransaction(txHash)
async getReceipt(txHash)
async getTransactionFailure(txHash)
```

The generic `call` method must reject write methods including `eth_sendRawTransaction`, `eth_sendTransaction`, `personal_sendTransaction` and `wallet_sendTransaction`. The client does not accept a private key.

- [ ] **Step 4: Run focused tests**

```powershell
node --check src/exchange/px/rpc-client.js
node --test test/popdex-rpc-client.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the RPC client**

```powershell
git add src/exchange/px/rpc-client.js test/popdex-rpc-client.test.js
git commit -m "验证：增加PopDEX主网RPC身份检查"
```

### Task 6: Compose the public/private-read-only verifier CLI

**Files:**
- Create: `src/exchange/px/verify.js`
- Create: `test/popdex-verify.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing verifier tests**

Inject all clients. Cover public success, wallet read success, changed market metadata, wrong chain, missing wallet, and artifact tokens not found:

```js
test('public verification checks chain markets tickers candles and official artifacts', async () => {
  const result = await verifyPopdexPublic(CONFIG, fakeDeps);
  assert.equal(result.chainId, '2184');
  assert.deepEqual(result.markets.map((m) => m.name), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(result.writeMethodsCalled, 0);
});

test('account verification reads exact orders fills overview and positions without Agent key', async () => {
  const result = await verifyPopdexAccount({ ...CONFIG, account: ACCOUNT }, fakeDeps);
  assert.equal(result.account, ACCOUNT);
  assert.equal(result.agentKeyRequired, false);
  assert.equal(result.writeMethodsCalled, 0);
});

test('verification fails when official artifacts do not expose the required protocol evidence', async () => {
  await assert.rejects(verifyPopdexPublic(CONFIG, missingTokenDeps), /approveAgent.*未找到/);
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
node --test test/popdex-verify.test.js
```

Expected: FAIL with missing verifier module.

- [ ] **Step 3: Implement verifier functions and CLI**

Export:

```js
export async function verifyPopdexPublic(config = {}, deps = {})
export async function verifyPopdexAccount(config = {}, deps = {})
export async function main(argv = process.argv.slice(2), deps = {})
```

CLI behavior:

```text
npm run popdex:verify
npm run popdex:verify -- --account-env POPDEX_MAIN_ACCOUNT
npm run popdex:verify -- --artifacts-json
```

`--account-env` must accept only the literal name `POPDEX_MAIN_ACCOUNT`, require the variable to contain a valid non-zero EVM address, and never print its full value. The CLI must reject `--agent-key`, `--private-key`, `--place`, `--cancel`, `--leverage` and `--close`. Human-readable output masks the account to first 6/last 4 characters. `--artifacts-json` may print public chunk paths, hashes and bounded contexts, but no environment variables.

Add package scripts and tests:

```json
{
  "scripts": {
    "popdex:verify": "node src/exchange/px/verify.js"
  }
}
```

Append the six new PopDEX test files to the existing `npm test` Node test command.

- [ ] **Step 4: Run focused and full tests**

```powershell
node --test test/popdex-normalize.test.js test/popdex-public-client.test.js test/popdex-account-client.test.js test/popdex-rpc-client.test.js test/popdex-official-artifacts.test.js test/popdex-verify.test.js
npm test
```

Expected: all PopDEX tests PASS and the existing suite reports zero failures.

- [ ] **Step 5: Commit the verifier**

```powershell
git add package.json src/exchange/px/verify.js test/popdex-verify.test.js
git commit -m "验证：增加PopDEX只读协议检查命令"
```

### Task 7: Run live read-only validation and write the evidence report

**Files:**
- Create: `docs/protocol/popdex-mainnet-validation.md`

- [ ] **Step 1: Run public verification against current Mainnet**

```powershell
npm run popdex:verify
```

Expected output includes:

```text
PopDEX 公共只读验证通过
chainId=2184
BTCUSDT symbolId=20000 tick=1 lot=0.0001 minNotional=10
ETHUSDT symbolId=20001 tick=0.1 lot=0.001 minNotional=10
writeMethodsCalled=0
```

If any value differs, record the exact official response and set the report conclusion to `BLOCKED`; do not loosen validation.

- [ ] **Step 2: Run wallet-scoped read-only validation**

Read the user's public PopDEX main account address from the existing `POPDEX_MAIN_ACCOUNT` environment variable; do not request any private key:

```powershell
npm run popdex:verify -- --account-env POPDEX_MAIN_ACCOUNT
```

Expected: explicit successful reads for BTC/ETH open orders, fills, overview and positions, with `writeMethodsCalled=0`. A response requiring a website token sets the report to `BLOCKED` because copied browser tokens are not an acceptable production dependency.

- [ ] **Step 3: Capture official app artifact evidence**

```powershell
npm run popdex:verify -- --artifacts-json
```

Record:

- official app URL and fetch time;
- every inspected chunk path and SHA-256;
- bounded contexts for Agent approval, order placement, cancellation, leverage and position mode;
- exact precompile addresses and function signatures found;
- whether the official app sends transactions from the Agent or invokes a delegated execution wrapper;
- whether and how `clientOrderId` is mapped to official `orderId`.

Do not copy full minified bundles into the repository.

- [ ] **Step 4: Write the validation report with an explicit gate**

Use this exact structure:

```markdown
# PopDEX Mainnet Protocol Validation

Validated at: copy the verifier's exact ISO-8601 `fetchedAt` value
Official app artifact hashes: add one table row per inspected path with its exact SHA-256

## Public identity
Record the exact chain ID and BTCUSDT/ETHUSDT market values printed by the verifier.

## Account read model
Record each observed endpoint, its authentication requirement, pagination fields and exact ID fields.

## Agent authorization
Record the official artifact path/hash and exact precompile, ABI, nonce type, expiry and authorization readback evidence.

## Trading execution
Record the official artifact path/hash and exact sender, signer, calldata wrapper, nonce, gas and receipt semantics.

## Order identity
Record the official evidence connecting txHash, clientOrderId and orderId without numeric conversion.

## Required write probes
List the exact minimum BTC order/cancel and fill/close probes that need separate user approval.

## Conclusion
VALIDATED
```

Replace every instruction sentence in the report template with observed evidence. If any required section lacks evidence, write `BLOCKED` and state the missing fact and the single next action needed to obtain it.

- [ ] **Step 5: Review the report against the approved design**

Confirm the report answers all eight items in the design's “协议验证门槛” section. Search for unfinished-marker words, template angle brackets, empty headings and contradictory sender/signer statements; the search must return no matches.

- [ ] **Step 6: Commit the report**

```powershell
git add docs/protocol/popdex-mainnet-validation.md
git commit -m "验证：记录PopDEX主网协议证据"
```

### Task 8: Verification gate and next-plan handoff

**Files:**
- Read: `docs/protocol/popdex-mainnet-validation.md`
- Read: `docs/superpowers/specs/2026-08-16-popdex-replaces-extended-design.md`

- [ ] **Step 1: Run the complete project verification**

```powershell
node --check src/exchange/px/constants.js
node --check src/exchange/px/normalize.js
node --check src/exchange/px/public-client.js
node --check src/exchange/px/account-client.js
node --check src/exchange/px/rpc-client.js
node --check src/exchange/px/official-artifacts.js
node --check src/exchange/px/verify.js
npm test
git diff --check origin/main...HEAD
git status --short
```

Expected: every syntax check exits 0, the complete test suite has zero failures, diff check has no errors, and the working tree is clean.

- [ ] **Step 2: Enforce the conclusion gate**

If the report conclusion is `BLOCKED`, stop and present the evidence gap to the user. Do not create adapter files, Agent UI, write clients, server routes or config migration.

If the report conclusion is `VALIDATED`, write a new plan named:

```text
docs/superpowers/plans/2026-08-16-popdex-adapter-and-extended-removal.md
```

That second plan must use the exact verified ABIs, sender/signer model, response schemas and order identity mapping from the report. It will cover the live write client, order state machine, `IExchange`, Agent authorization UI, `ex` to `px` migration, Extended deletion, full automated tests and separately approved minimum-value Mainnet probes.

- [ ] **Step 3: Commit only a generated second plan if the gate is VALIDATED**

```powershell
git add docs/superpowers/plans/2026-08-16-popdex-adapter-and-extended-removal.md
git commit -m "计划：实施PopDEX适配器并移除Extended"
```

If the gate is `BLOCKED`, no second-plan commit is made.
