# PopDEX Temporary Agent Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-wallet PopDEX temporary Agent authorization, verification, save, and revoke flow without registering PopDEX as a trading exchange or changing Decibel/RISEx behavior.

**Architecture:** Keep all PopDEX Agent protocol logic under `src/exchange/px/`; the server exposes dedicated `/api/px/agent/*` endpoints that never enter the exchange/Bot router. Browser code generates the Agent key in memory, asks the main wallet to send prepared Account-precompile transactions, and sends the Agent key to the VPS only after an explicit save action and a successful on-chain readback.

**Tech Stack:** Node.js 20 ESM, ethers 6.13.5, built-in `fetch`, `node:test`, existing HTTP Basic Auth/Origin guard, static HTML/JavaScript dashboard.

---

## Scope and file map

Create:

- `src/exchange/px/agent.js` — strict key/address handling and official Account-precompile calldata.
- `src/exchange/px/agent-service.js` — readback, configuration persistence, and fail-fast lifecycle rules.
- `public/popdex-agent.js` — browser-only ephemeral key and wallet interaction flow.
- `test/popdex-agent.test.js` — ABI, time units, key derivation, approve/replace/revoke tests.
- `test/popdex-agent-service.test.js` — authorization and secure persistence tests.
- `test/popdex-agent-ui.test.js` — UI safety and no-trading-boundary tests.
- `test/popdex-agent-isolation.test.js` — guard against PopDEX Bot/runtime registration and Decibel/RISEx changes.

Modify:

- `src/exchange/px/rpc-client.js` — add read-only `getAgentInfo` and `getAgents` calls.
- `test/popdex-rpc-client.test.js` — exact official ABI decoding tests.
- `src/server.js` — instantiate the independent Agent service, add dedicated routes, and serve pinned browser ethers.
- `public/index.html` — add a standalone Agent tab and local scripts.
- `package.json` — include new tests in `npm test`.
- `.env.example` — document Agent settings without real values.
- `README.md` — document the authorization-only stage and VPS acceptance steps.
- `AGENTS.md` — record the current PopDEX migration gate as the source of truth.

Do not modify:

- `src/bot.js`
- `src/config.js`
- `src/persist.js`
- `src/startup.js`
- `src/recovery.js`
- `src/ai/`
- `src/exchange/de/`
- `src/exchange/rs/`
- any existing `.state.json` or `.env`

### Task 1: Lock the official Agent ABI and pure transaction preparation

**Files:**
- Create: `test/popdex-agent.test.js`
- Create: `src/exchange/px/agent.js`

- [ ] **Step 1: Write the failing Agent protocol tests**

Create tests with fixed `nowMs=1786939200123` that require:

```js
const prepared = prepareAgentAuthorization({
  agentAddress: AGENT,
  delegator: MAIN,
  hostname: 'ucloud4.tailed0493.ts.net',
  existingAgents: [],
  nowMs: 1786939200123,
});
assert.equal(prepared.action, 'approve');
assert.equal(prepared.to, POPDEX_ACCOUNT_PRECOMPILE);
assert.equal(prepared.chainId, '0x888');
assert.equal(prepared.type, '0x0');
assert.equal(prepared.gas, '0x0');
assert.equal(prepared.gasPrice, '0x0');
assert.deepEqual(decodeApprove(prepared.data), {
  agent: AGENT,
  delegator: MAIN,
  initialNonce: '1786939200',
  expiresAt: '1789531200123',
  isGlobal: false,
});
```

Also require the same-name branch to encode `replaceAgent(oldAgent,newAgent,expiresAt,initialNonce)`, `prepareAgentRevocation` to encode only `revokeAgent(agent)`, `deriveAgentAddress` to reject malformed keys without echoing them, and the hostname label to be deterministic and at most 31 UTF-8 bytes.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/popdex-agent.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/exchange/px/agent.js`.

- [ ] **Step 3: Implement the minimal pure Agent module**

Use one ethers `Interface` containing:

```js
const ACCOUNT_INTERFACE = new Interface([
  'function approveAgent(address agent,address delegator,bytes32 name,uint64 expiresAt,uint64 initialNonce,bool isGlobal)',
  'function replaceAgent(address oldAgent,address newAgent,uint64 expiresAt,uint64 initialNonce)',
  'function revokeAgent(address agent)',
  'function getAgentInfo(address agent) view returns (bool exists,uint64 expiresAt,bool isExpired,address delegator,bytes32 name,bool isGlobal)',
  'function getAgents(address delegator) view returns (address[] agents,uint64[] expiresAts,bool[] isExpireds,bytes32[] names,bool[] isGlobals)',
]);
```

The implementation must:

- derive addresses only from a `0x` plus 64-hex-character private key;
- never include the submitted key in an error;
- compute official time units exactly;
- create `UI_<hostname>` bytes32 with bounded ASCII hostname normalization;
- require nonzero, valid and distinct main/Agent addresses;
- return fixed `to/value/chainId/type/gas/gasPrice` transaction fields;
- choose replace only when `existingAgents` contains the exact bytes32 name.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run `node --test test/popdex-agent.test.js`.

Expected: all Agent protocol tests PASS.

- [ ] **Step 5: Commit the pure protocol boundary**

```powershell
git add src/exchange/px/agent.js test/popdex-agent.test.js
git commit -m "功能：实现PopDEX Agent授权编码"
```

### Task 2: Add strict read-only Agent RPC methods

**Files:**
- Modify: `src/exchange/px/rpc-client.js`
- Modify: `test/popdex-rpc-client.test.js`

- [ ] **Step 1: Write failing RPC decode tests**

Inject an RPC response encoded with the official ABI and require:

```js
assert.deepEqual(await client.getAgentInfo(AGENT), {
  exists: true,
  expiresAt: '1789531200123',
  isExpired: false,
  delegator: MAIN,
  name: NAME_BYTES32,
  isGlobal: false,
});
```

Add a `getAgents(MAIN)` case that preserves every `uint64` as a string and rejects unequal output-array lengths, invalid addresses, and malformed return data.

- [ ] **Step 2: Run the focused test and verify RED**

Run `node --test test/popdex-rpc-client.test.js`.

Expected: FAIL because `getAgentInfo` and `getAgents` do not exist.

- [ ] **Step 3: Implement only read-only `eth_call` methods**

Reuse the exported Account interface from `agent.js`. Both methods must call `eth_call` against `POPDEX_ACCOUNT_PRECOMPILE`, decode exact official output shapes, validate array consistency, preserve integer strings, and retain the existing `READ_ONLY_METHODS` boundary unchanged.

- [ ] **Step 4: Run RPC and existing PopDEX tests**

```powershell
node --test test/popdex-rpc-client.test.js test/popdex-verify.test.js
```

Expected: all tests PASS and `eth_sendTransaction` remains rejected by the RPC client.

- [ ] **Step 5: Commit Agent readback support**

```powershell
git add src/exchange/px/rpc-client.js test/popdex-rpc-client.test.js
git commit -m "功能：增加PopDEX Agent只读回验"
```

### Task 3: Implement the authorization lifecycle service and secure `.env` persistence

**Files:**
- Create: `test/popdex-agent-service.test.js`
- Create: `src/exchange/px/agent-service.js`

- [ ] **Step 1: Write failing service tests**

Use an injected in-memory filesystem and fake RPC client. Cover one behavior per test:

```js
await assert.rejects(
  service.save({ mainAccount: MAIN, agentPrivateKey: PRIVATE_KEY }),
  /尚未获得有效授权/,
);
```

Then cover:

- valid authorization writes only `POPDEX_MAIN_ACCOUNT` and `POPDEX_AGENT_PRIVATE_KEY`;
- POSIX write uses mode `0600` and only updates `processEnv` after the write succeeds;
- `status()` exposes `configured/mainAccount/agentAddress/authorized/expiresAt` but serialized output never contains the key;
- expired, global, wrong-delegator or missing authorization fails;
- `prepareApproval()` obtains current Agents and chooses approve/replace;
- `clear()` refuses while authorization is still active and removes only the Agent key after revocation is confirmed;
- all thrown messages omit the supplied private key.

- [ ] **Step 2: Run the focused test and verify RED**

Run `node --test test/popdex-agent-service.test.js`.

Expected: FAIL with missing `agent-service.js`.

- [ ] **Step 3: Implement `PopdexAgentService` minimally**

Constructor dependencies:

```js
new PopdexAgentService({
  rpcClient,
  envFile,
  processEnv,
  fsImpl,
  platform,
  now: () => Date.now(),
});
```

Public methods:

```js
status()
prepareApproval({ agentAddress, delegator, hostname })
verifyAuthorization({ mainAccount, agentAddress })
save({ mainAccount, agentPrivateKey })
prepareRevoke({ mainAccount, agentAddress })
clear()
```

Use `writeEnvFile` for owner-only persistence. Keep `POPDEX_MAIN_ACCOUNT` when clearing and render the Agent key line as commented/empty. Never log request objects or return the private key.

- [ ] **Step 4: Run service and env security tests**

```powershell
node --test test/popdex-agent-service.test.js test/security.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the lifecycle service**

```powershell
git add src/exchange/px/agent-service.js test/popdex-agent-service.test.js
git commit -m "功能：实现PopDEX Agent安全保存与撤销"
```

### Task 4: Expose isolated Agent APIs and pinned browser ethers

**Files:**
- Modify: `src/server.js`
- Modify: `test/security.test.js`
- Create: `test/popdex-agent-isolation.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing server-boundary tests**

Require source-level integration invariants already used by this project:

```js
assert.match(server, /new PopdexAgentService/);
for (const route of ['status','prepare-approval','verify','save','prepare-revoke','clear']) {
  assert.match(server, new RegExp(`/api/px/agent/${route}`));
}
assert.match(server, /p === '\/vendor\/ethers\.js'/);
assert.doesNotMatch(server, /createPxExchange|new GridBot\([^)]*px|saveSnapshot\('px'/);
```

The isolation test must also assert that `src/bot.js`, `src/config.js`, `src/persist.js`, `src/exchange/de/` and `src/exchange/rs/` are not imported by the new Agent modules, and that existing `deHandler`/`rsHandler` routes remain present.

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test test/security.test.js test/popdex-agent-isolation.test.js
```

Expected: FAIL because routes and the pinned ethers vendor route are absent.

- [ ] **Step 3: Add the service and dedicated routes**

Instantiate one `PopdexAgentService` with the existing read-only `PopdexRpcClient` and `path.join(ROOT,'.env')`. Route handlers must use `readJsonBody(request, 4096)`, return sanitized messages, and never print bodies.

Serve exactly `node_modules/ethers/dist/ethers.min.js` at `/vendor/ethers.js`; do not expose a general `node_modules` path or add a CDN.

Do not insert PopDEX into `makeExchangeHandler`, overview, Bot, snapshots, SSE, AI service, startup, recovery, proxy or exchange initialization.

- [ ] **Step 4: Add tests to the package script and run boundary tests**

Append the four new test files explicitly to the existing `npm test` command. Run:

```powershell
node --test test/security.test.js test/popdex-agent-isolation.test.js test/popdex-agent-service.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit isolated server integration**

```powershell
git add src/server.js test/security.test.js test/popdex-agent-isolation.test.js package.json
git commit -m "功能：开放PopDEX Agent独立安全接口"
```

### Task 5: Add the browser-only Agent page

**Files:**
- Create: `test/popdex-agent-ui.test.js`
- Create: `public/popdex-agent.js`
- Modify: `public/index.html`

- [ ] **Step 1: Write failing UI safety tests**

Require:

- one standalone `PopDEX Agent` tab and no replacement of Extended yet;
- local `/vendor/ethers.js` and `/popdex-agent.js`, with no CDN;
- `ethers.Wallet.createRandom()` in the browser module;
- wallet requests only `eth_requestAccounts`, `wallet_switchEthereumChain`, `eth_sendTransaction`, and receipt reads;
- no `localStorage`, `sessionStorage`, cookies, IndexedDB or URL query key storage;
- no `innerHTML`, no PopDEX order/start/leverage/close endpoint, and all `/api/` requests use the existing `apiFetch` helper;
- the UI clears its private-key text and in-memory variable after a successful save.

- [ ] **Step 2: Run the UI test and verify RED**

Run `node --test test/popdex-agent-ui.test.js`.

Expected: FAIL because the page and script do not exist.

- [ ] **Step 3: Add the minimal Agent tab and state machine**

UI states:

```text
UNCONFIGURED -> GENERATED -> WALLET_CONNECTED -> TX_PENDING
-> AUTHORIZED_NOT_SAVED -> CONFIGURED_AUTHORIZED
-> REVOKE_PENDING -> REVOKED_NOT_CLEARED -> UNCONFIGURED
```

The browser must:

- keep the generated key only in a module variable and a one-time text block;
- require the connected account to equal the main account used for approval/revocation;
- switch to `0x888`; on wallet error 4902, instruct the user to add PopDEX Mainnet through the official site rather than guessing chain metadata;
- call prepare API, send the returned transaction through the wallet, wait for one successful receipt, and call verify API;
- enable save only after verification;
- clear the visible and in-memory key after save;
- require confirmation before revoke, wait for receipt, verify revoked state, then call clear;
- show failures through `textContent` without hiding partial completion states.

- [ ] **Step 4: Run syntax, UI and security tests**

```powershell
node --check public/popdex-agent.js
node --test test/popdex-agent-ui.test.js test/security.test.js
```

Expected: all checks PASS.

- [ ] **Step 5: Commit the Agent page**

```powershell
git add public/index.html public/popdex-agent.js test/popdex-agent-ui.test.js
git commit -m "功能：增加PopDEX临时Agent授权页面"
```

### Task 6: Update configuration and living documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write failing documentation assertions**

Extend the Agent UI/security tests to require:

```text
POPDEX_MAIN_ACCOUNT=
POPDEX_AGENT_PRIVATE_KEY=
```

and documentation statements that Agent authorization does not enable PopDEX trading, main-wallet keys are forbidden, `.env` must be `0600`, and Decibel/RISEx remain untouched.

- [ ] **Step 2: Run tests and verify RED**

Run `node --test test/popdex-agent-ui.test.js test/security.test.js`.

Expected: FAIL because the Agent key and stage boundary are not documented.

- [ ] **Step 3: Update the source-of-truth documents**

Add empty example values only; never add a real address or key. Document the browser authorization workflow, revoke procedure, VPS restart/readback procedure, and the explicit prohibition on PopDEX order testing until the next approved stage.

Record in `AGENTS.md` that the repository is in the Agent-authorization migration stage: PopDEX is not a runnable exchange and Extended remains until write-path acceptance is complete.

- [ ] **Step 4: Run documentation and focused tests**

```powershell
node --test test/popdex-agent-ui.test.js test/security.test.js test/popdex-verify.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit documentation**

```powershell
git add .env.example README.md AGENTS.md test/popdex-agent-ui.test.js test/security.test.js
git commit -m "文档：补充PopDEX Agent授权验收说明"
```

### Task 7: Full regression and security verification

**Files:**
- Verify only; fix only failures caused by this branch through a new RED/GREEN cycle.

- [ ] **Step 1: Confirm the forbidden runtime files have no branch diff**

Run:

```powershell
git diff 3666a13 -- src/bot.js src/config.js src/persist.js src/startup.js src/recovery.js src/ai src/exchange/de src/exchange/rs
```

Expected: no output.

- [ ] **Step 2: Run syntax checks**

```powershell
node --check src/exchange/px/agent.js
node --check src/exchange/px/agent-service.js
node --check public/popdex-agent.js
node --check src/server.js
```

Expected: exit code 0 for every file.

- [ ] **Step 3: Run the full automated suite**

Run `npm test`.

Expected: all existing 195 baseline tests plus every new Agent test PASS with zero failures.

- [ ] **Step 4: Run package and diff checks**

```powershell
npm audit --omit=dev
git diff --check
git status -sb
```

Expected: zero known package vulnerabilities, no whitespace errors, and only intentional committed files.

- [ ] **Step 5: Record implementation evidence**

Update this plan's checkboxes as tasks complete and add the final test count to the handoff. Do not execute any wallet transaction or PopDEX write from the development environment; mainnet Agent authorization remains a user-confirmed VPS browser acceptance step.
