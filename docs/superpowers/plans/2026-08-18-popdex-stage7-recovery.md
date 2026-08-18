# PopDEX Stage 7 成交补单与恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PopDEX BTCUSDT 做多网格实现精确成交补单、重启接管、离线恢复、断线对账及独立的 3 格主网验收命令，同时不改变 Decibel、RISEx 和正式前端/API 路径。

**Architecture:** PopDEX 适配器使用原子所有权文件保存订单身份，用纯订单状态机合并 REST 开放订单、链上完成订单、REST fills 和链上持仓；GridBot 通过可选严格恢复钩子消费一次性成交事件，不再对 PopDEX 按价格猜层级。正确性来自完整轮询和持久化事实，实时流不参与终态判定。

**Tech Stack:** Node.js 20 ESM、`node:test`、`ethers` 6.13.5、现有 PopDEX REST/RPC/Agent 客户端、同步原子 JSON 持久化。

---

## 文件结构

- Create: `src/exchange/px/order-state.js` — 纯订单/成交归并、终态分类和稳定事件 ID。
- Create: `src/exchange/px/ownership-store.js` — 严格 schema、0600 原子持久化和事件阶段推进。
- Create: `src/exchange/px/reconciler.js` — 单飞完整对账、外部订单检测、离线事件队列和诊断指标。
- Create: `src/exchange/px/grid-probe.js` — 与正式服务器隔离的 BTC 做多 3 格验收进程。
- Modify: `src/exchange/px/rpc-client.js` — 完整收集 active/completed order pages。
- Modify: `src/exchange/px/account-client.js` — 完整订单历史/fill 分页及页诊断。
- Modify: `src/exchange/px/order-codec.js` — 确定性 client ID 和 reduce-only Limit/GTC/Net 编码。
- Modify: `src/exchange/px/operation-journal.js` — 保存网格意图元数据并在所有权落盘后清理。
- Modify: `src/exchange/px/popdex.js` — 接入所有权、对账、事件发布和严格恢复接口。
- Modify: `src/exchange/px/paper.js` — 返回完整元数据并支持严格恢复钩子的同形行为。
- Modify: `src/exchange/px/index.js` — 注入 Stage 7 文件路径和依赖。
- Modify: `src/bot.js` — 保存完整订单元数据、严格恢复、事件确认和 PopDEX 专用失败即停。
- Modify: `package.json` — 注册 Stage 7 测试和 `popdex:grid-probe`。
- Modify: `.gitignore` — 忽略独立验收状态、所有权和锁文件。
- Modify: `AGENTS.md` — 记录 PopDEX Stage 7 边界和 BTC-only/long-only 限制。
- Modify: `docs/protocol/popdex-mainnet-validation.md` — 记录自动测试边界和待执行主网步骤。
- Create tests: `test/popdex-order-state.test.js`, `test/popdex-ownership-store.test.js`, `test/popdex-reconciler.test.js`, `test/popdex-grid-probe.test.js`。
- Modify tests: `test/popdex-rpc-client.test.js`, `test/popdex-account-client.test.js`, `test/popdex-order-codec.test.js`, `test/popdex-operation-journal.test.js`, `test/popdex-adapter.test.js`, `test/popdex-paper.test.js`, `test/popdex-factory.test.js`, `test/bot.test.js`, `test/startup.test.js`。

## Task 1: 完整订单和成交分页读取

**Files:**
- Modify: `src/exchange/px/rpc-client.js:338-412`
- Modify: `src/exchange/px/account-client.js:130-230`
- Test: `test/popdex-rpc-client.test.js`
- Test: `test/popdex-account-client.test.js`

- [ ] **Step 1: 写链上订单完整分页失败测试**

在 `test/popdex-rpc-client.test.js` 增加：

```js
test('RPC client collects every active and completed order page exactly once', async () => {
  const rpc = rpcWithOrderPages({
    active: [page([chainOrder({ orderId: 11n })], true), page([chainOrder({ orderId: 12n })], false)],
    completed: [page([chainOrder({ orderId: 21n, remainingQty: 0n, filledQty: 2n })], false)],
  });
  assert.deepEqual((await rpc.getAllActiveOrders(ACCOUNT)).map((o) => o.orderId), ['11', '12']);
  assert.deepEqual((await rpc.getAllCompletedOrders(ACCOUNT)).map((o) => o.orderId), ['21']);
});

test('RPC client rejects empty hasMore page and bounded pagination overflow', async () => {
  await assert.rejects(() => rpcWithOrderPages({ active: [page([], true)] }).getAllActiveOrders(ACCOUNT), /hasMore=true/);
  await assert.rejects(() => rpcWithEndlessOrderPages().getAllCompletedOrders(ACCOUNT, { maxPages: 2 }), /maxPages=2/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/popdex-rpc-client.test.js`

Expected: FAIL，提示 `getAllActiveOrders` 或 `getAllCompletedOrders` 不存在。

- [ ] **Step 3: 实现统一 offset 分页收集器**

在 `PopdexRpcClient` 内增加：

```js
async #collectOrderPages(readPage, label, { maxPages = 10, pageSize = 100 } = {}) {
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0 || maxPages > 10) {
    throw new Error(`PopDEX ${label} maxPages 必须是 1-10 的安全整数。`);
  }
  const rows = [];
  let offset = 0;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await readPage(offset, pageSize);
    rows.push(...page.orders);
    if (!page.hasMore) return rows;
    if (page.orders.length === 0) throw new Error(`PopDEX ${label} hasMore=true 但当前页为空。`);
    offset += page.orders.length;
  }
  throw new Error(`PopDEX ${label} 分页超过 maxPages=${maxPages}。`);
}

getAllActiveOrders(account, options = {}) {
  return this.#collectOrderPages((offset, limit) => this.getActiveOrders(account, offset, limit), 'active orders', options);
}

getAllCompletedOrders(account, options = {}) {
  return this.#collectOrderPages((offset, limit) => this.getCompletedOrders(account, offset, limit), 'completed orders', options);
}
```

- [ ] **Step 4: 为 REST 分页增加诊断元数据测试**

在 `test/popdex-account-client.test.js` 断言 `getAllOpenOrders`、`getAllOrderHistory`、`getAllFills` 返回数组，同时具有不可枚举的 `pageInfo`：

```js
const rows = await client.getAllFills(ACCOUNT, 'BTCUSDT');
assert.deepEqual(rows.pageInfo, { pages: 2, cursors: ['100'], rows: 2 });
assert.equal(Object.keys(rows).includes('pageInfo'), false);
```

- [ ] **Step 5: 实现 REST 页诊断和完整订单历史入口**

修改 `#collectPages`，记录每页 cursor，返回前执行：

```js
Object.defineProperty(all, 'pageInfo', {
  value: Object.freeze({ pages: pageIndex + 1, cursors: [...seenCursors], rows: all.length }),
  enumerable: false,
});
```

新增：

```js
async getAllOrderHistory(account, symbol, options = {}) {
  const wallet = strictAddress(account, 'account');
  const target = targetSymbol(symbol);
  return this.#collectPages((cursor) => this.getOrderHistory(wallet, target, cursor), 'order history', options);
}
```

- [ ] **Step 6: 运行分页测试并提交**

Run: `node --test test/popdex-rpc-client.test.js test/popdex-account-client.test.js`

Expected: PASS。

```bash
git add src/exchange/px/rpc-client.js src/exchange/px/account-client.js test/popdex-rpc-client.test.js test/popdex-account-client.test.js
git commit -m "实现：完善PopDEX订单成交分页读取"
```

## Task 2: 实现确定性订单 ID 和 reduce-only 限价编码

**Files:**
- Modify: `src/exchange/px/order-codec.js:1-180`
- Test: `test/popdex-order-codec.test.js`

- [ ] **Step 1: 写确定性 ID 和订单参数失败测试**

```js
test('replacement intent creates one stable PopDEX client order ID', () => {
  const one = createGridClientOrderId({ symbol: 'BTCUSDT', side: 'sell', intentId: 'fill:123:456' });
  const two = createGridClientOrderId({ symbol: 'BTCUSDT', side: 'sell', intentId: 'fill:123:456' });
  assert.equal(one, two);
  assert.match(decodeBytes32String(one), /^dw-bs-[0-9a-f]{24}$/);
});

test('long replacement encodes Limit GTC ReduceOnly Net exactly', () => {
  const encoded = encodeOrderParams({ side: 'sell', reduceOnly: true, positionSide: '0' });
  const bytes = getBytes(encoded);
  assert.deepEqual([...bytes.slice(0, 10)], [2, 0, 1, 1, 0, 0, 1, 0, 0, 0]);
});

test('reduce-only live plan rejects buy, ETH and non-Net position side', () => {
  assert.throws(() => reduceOnlyPlan({ ...validPlan(), side: 'buy' }), /只允许 BTCUSDT sell/);
  assert.throws(() => reduceOnlyPlan({ ...validPlan(), symbol: 'ETHUSDT' }), /只允许 BTCUSDT sell/);
  assert.throws(() => reduceOnlyPlan({ ...validPlan(), positionSide: '1' }), /OneWay\/Net/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/popdex-order-codec.test.js`

Expected: FAIL，缺少新导出或旧 `encodeOrderParams` 不接受对象。

- [ ] **Step 3: 实现确定性 ID 和严格参数编码**

使用 `createHash` 派生 24 位小写十六进制标签；随机普通订单仍生成同格式 ID：

```js
export function createGridClientOrderId({ symbol, side, intentId }) {
  if (typeof intentId !== 'string' || intentId.length === 0) throw new Error('PopDEX intentId 不能为空。');
  const market = symbol === 'BTCUSDT' ? 'b' : symbol === 'ETHUSDT' ? 'e' : null;
  const sideCode = side === 'buy' ? 'b' : side === 'sell' ? 's' : null;
  if (market === null || sideCode === null) throw new Error('PopDEX clientOrderId 市场或方向无效。');
  const digest = createHash('sha256').update(intentId, 'utf8').digest('hex').slice(0, 24);
  return encodeBytes32String(`dw-${market}${sideCode}-${digest}`).toLowerCase();
}

export function encodeOrderParams({ side, reduceOnly = false, positionSide = '0' }) {
  if (positionSide !== '0') throw new Error('PopDEX 网格订单只允许 OneWay/Net positionSide=0。');
  const bytes = new Uint8Array(32);
  bytes[0] = 2;
  bytes[1] = 0;
  bytes[2] = exactSide(side) === 'buy' ? 0 : 1;
  bytes[3] = 1;
  bytes[6] = reduceOnly ? 1 : 0;
  bytes[7] = 0;
  return hexlify(bytes);
}
```

`prepareLimitOrder` 接受 `reduceOnly=false`、`positionSide='0'`、`clientOrderId=null`、`intentId=null`。显式 ID 必须是规范 bytes32；`reduceOnly=true` 时只允许 BTCUSDT sell，并继续执行 tick、lot、minNotional 和非穿价校验。

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/popdex-order-codec.test.js test/popdex-fill-close-codec.test.js`

Expected: PASS，Stage 5 市价平仓编码测试保持不变。

```bash
git add src/exchange/px/order-codec.js test/popdex-order-codec.test.js
git commit -m "实现：增加PopDEX确定性补单与只减限价编码"
```

## Task 3: 实现纯订单状态机

**Files:**
- Create: `src/exchange/px/order-state.js`
- Create: `test/popdex-order-state.test.js`

- [ ] **Step 1: 写活动、部分成交和终态测试**

```js
test('partial fills stay active and duplicate fill IDs fail', () => {
  const owned = ownedOrder({ qtyWad: '300' });
  const active = officialActive({ filledQtyWad: '100', remainingQtyWad: '200' });
  assert.equal(reconcileOwnedOrder(owned, { active, completed: null, fills: [fill('1', '100')] }).state, 'PARTIAL');
  assert.throws(() => reconcileOwnedOrder(owned, {
    active, completed: null, fills: [fill('1', '50'), fill('1', '50')],
  }), /fillId 1 重复/);
});

test('full fill produces one stable pending event from exact fills', () => {
  const result = reconcileOwnedOrder(ownedOrder({ qtyWad: '200' }), {
    active: null,
    completed: officialCompleted({ filledQtyWad: '200', remainingQtyWad: '0', cancelledQtyWad: '0' }),
    fills: [fill('8', '80', '63000'), fill('9', '120', '63100')],
  });
  assert.equal(result.state, 'FILLED');
  assert.equal(result.event.filledQtyWad, '200');
  assert.equal(result.event.priceWad, '63060000000000000000000');
  assert.equal(result.event.suppressRequote, false);
});

test('partial fill then cancel emits actual quantity and bulk cancel suppresses requote', () => {
  const result = reconcileOwnedOrder(ownedOrder({ qtyWad: '200' }), {
    active: null,
    completed: officialCompleted({ filledQtyWad: '80', remainingQtyWad: '0', cancelledQtyWad: '120' }),
    fills: [fill('8', '80')],
    suppressRequote: true,
  });
  assert.equal(result.state, 'CANCELLED');
  assert.equal(result.event.filledQtyWad, '80');
  assert.equal(result.event.suppressRequote, true);
});

test('verified REST terminal names preserve rejected and expired states', () => {
  assert.equal(reconcileOwnedOrder(ownedOrder(), {
    active: null, completed: restTerminal({ status: 'Rejected' }), fills: [],
  }).state, 'REJECTED');
  assert.equal(reconcileOwnedOrder(ownedOrder(), {
    active: null, completed: restTerminal({ status: 'Expired' }), fills: [],
  }).state, 'EXPIRED');
});
```

- [ ] **Step 2: 写无法闭合和身份冲突测试**

覆盖：`orderId`、`clientOrderId`、side、WAD price/qty、reduce-only 冲突；fills 总量与官方 `filledQtyWad` 不一致返回 `SETTLING`；本地订单消失且无 completed/fills/cancel proof 返回 `UNKNOWN_TERMINAL`；成交超过委托量直接抛错。

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/popdex-order-state.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现纯函数接口**

导出以下固定接口：

```js
export function buildFillEventId({ orderId, clientOrderId, terminalState, fillIds, filledQtyWad }) {
  const canonical = JSON.stringify({ orderId, clientOrderId, terminalState, fillIds: [...fillIds].sort(), filledQtyWad });
  return `px-fill-${createHash('sha256').update(canonical).digest('hex')}`;
}

export function reconcileOwnedOrder(owned, {
  active = null,
  completed = null,
  fills = [],
  cancelProof = null,
  suppressRequote = false,
} = {}) {
  // 严格校验身份和 WAD 恒等式；活动单返回 OPEN/PARTIAL；
  // 完整成交返回 FILLED；部分成交后终止返回 CANCELLED；
  // 数据传播尚未一致返回 SETTLING；无任何终态证据返回 UNKNOWN_TERMINAL。
}
```

实现时只用 `BigInt` 累计数量和成交额，最后才用 `formatUnits` 生成事件展示值。REST 明确返回 `FullyFilled/Cancelled/PartiallyFilledCancelled/Rejected/Expired` 时保留其终态；链上记录若没有已验证的枚举名称，只能依据数量恒等式归为 `FILLED` 或 `CANCELLED`，不得猜测 rejected/expired。禁止把安全性判断建立在浮点数上。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/popdex-order-state.test.js`

Expected: PASS。

```bash
git add src/exchange/px/order-state.js test/popdex-order-state.test.js
git commit -m "实现：增加PopDEX订单成交状态机"
```

## Task 4: 实现原子所有权与补单事件存储

**Files:**
- Create: `src/exchange/px/ownership-store.js`
- Create: `test/popdex-ownership-store.test.js`
- Modify: `.gitignore`

- [ ] **Step 1: 写 schema、权限和阶段测试**

```js
test('ownership store persists exact order and pending event atomically', () => {
  const store = new PopdexOwnershipStore({ file: FILE, mainAccount: ACCOUNT, fsImpl, now: () => 1 });
  store.upsertOrder(ownedOrder());
  store.applyResult('123', terminalResult());
  const loaded = store.load();
  assert.equal(loaded.orders[0].terminalEvent.stage, 'EVENT_PENDING');
  assert.equal(fsImpl.lastWrite.options.mode, 0o600);
  assert.equal(fsImpl.lastRename.to, FILE);
});

test('event transitions are monotonic and completed events cannot replay', () => {
  const store = preparedStore();
  store.markReplacementConfirmed(EVENT_ID, '456');
  store.completeEvent(EVENT_ID);
  assert.deepEqual(store.pendingEvents(), []);
  assert.throws(() => store.markReplacementConfirmed(EVENT_ID, '789'), /已完成/);
});
```

同时覆盖：未知字段、重复 `orderId/clientOrderId/fillEventId`、账户或市场不符、坏 JSON、Linux 非 0600、临时写失败、重命名失败、状态回退。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/popdex-ownership-store.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现严格 schema 和 API**

文件根结构固定为：

```js
{
  version: 1,
  mainAccount,
  symbol: 'BTCUSDT',
  symbolId: '20000',
  orders: [{
    orderId, clientOrderId, marketId: 20000, levelIndex, side,
    priceWad, qtyWad, opening, reduceOnly, parentFillEventId,
    state, filledQtyWad, fillIds,
    terminalEvent: null || {
      fillEventId, stage, terminalState, filledQtyWad, priceWad,
      suppressRequote, replacementOrderId,
    },
  }],
  updatedAt,
}
```

类公开方法固定为：

```js
load()
listOrders()
upsertOrder(order)
applyResult(orderId, result)
pendingEvents()
markReplacementConfirmed(fillEventId, replacementOrderId)
completeSuppressedEvent(fillEventId)
completeEvent(fillEventId)
removeSettled(orderId)
```

每个修改方法都先 clone、完整校验，再写 `${file}.tmp` 并原子重命名；写失败不得改变内存快照。

- [ ] **Step 4: 忽略运行文件并运行测试**

在 `.gitignore` 增加：

```gitignore
.popdex-ownership.json
.popdex-grid-probe.json
.popdex-grid-probe-ownership.json
.popdex-grid-probe-operation.json
.popdex-grid-probe.lock
```

Run: `node --test test/popdex-ownership-store.test.js test/security.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add .gitignore src/exchange/px/ownership-store.js test/popdex-ownership-store.test.js
git commit -m "实现：增加PopDEX订单所有权持久化"
```

## Task 5: 实现完整单飞对账器

**Files:**
- Create: `src/exchange/px/reconciler.js`
- Create: `test/popdex-reconciler.test.js`

- [ ] **Step 1: 写正常接管和离线成交测试**

```js
test('reconciler adopts exact active orders and queues one offline fill', async () => {
  const reconciler = fixture({
    owned: [ownedOrder({ orderId: '1' }), ownedOrder({ orderId: '2' })],
    restOpen: [restOrder({ orderId: '1' })],
    completed: [chainCompleted({ orderId: '2', filledQtyWad: QTY })],
    fills: [fill({ orderId: '2', fillId: '9', execQty: '0.0002' })],
  });
  const result = await reconciler.reconcile({ reason: 'startup' });
  assert.deepEqual(result.activeOrders.map((o) => o.orderId), ['1']);
  assert.equal(result.pendingEvents.length, 1);
  assert.equal(result.pendingEvents[0].orderId, '2');
});
```

- [ ] **Step 2: 写故障状态测试**

覆盖并断言明确错误码：

```js
await assert.rejects(() => externalOrderFixture().reconcile({ reason: 'startup' }), /POPDEX_EXTERNAL_ORDER/);
await assert.rejects(() => duplicateClientIdFixture().reconcile({ reason: 'refresh' }), /POPDEX_IDENTITY_CONFLICT/);
await assert.rejects(() => missingTerminalFixture({ elapsedMs: 31_000 }).reconcile({ reason: 'refresh' }), /POPDEX_UNKNOWN_TERMINAL/);
```

再覆盖：首次短暂不一致保持 `RECONCILING`；分页读取失败保留 cause；持仓为空但未处理的开仓成交、出现空仓、持仓量小于未闭合做多成交量均失败；并发调用只执行一轮底层读取。

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/popdex-reconciler.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现对账器固定接口**

```js
export class PopdexReconciler {
  constructor({ mainAccount, accountClient, readRpc, ownershipStore, logger = console, now = () => Date.now(), settleMs = 30000 }) {}

  reconcile(options) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#run(options).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}
```

`#run` 一轮并行读取：REST BTC open、REST BTC order history、REST BTC fills、链上 active、链上 completed、链上 positions。REST 开放订单用于活动事实；链上 completed、fills、已持久化撤单证明用于终态。链上 active 只用于交叉检查，不允许用其空结果覆盖 REST 活动订单。

所有外部 BTC 订单都触发 `POPDEX_EXTERNAL_ORDER`。每个 owned order 调用 `reconcileOwnedOrder`，结果一次性写入 ownership store；返回：

```js
{
  activeOrders,
  pendingEvents,
  positions,
  diagnostics: { reason, elapsedMs, owned, restOpen, chainActive, completed, fills, pending },
}
```

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/popdex-order-state.test.js test/popdex-ownership-store.test.js test/popdex-reconciler.test.js`

Expected: PASS。

```bash
git add src/exchange/px/reconciler.js test/popdex-reconciler.test.js
git commit -m "实现：增加PopDEX完整订单对账器"
```

## Task 6: 将所有权和对账接入 PopDEX 实盘适配器

**Files:**
- Modify: `src/exchange/px/operation-journal.js`
- Modify: `src/exchange/px/popdex.js`
- Modify: `src/exchange/px/index.js`
- Test: `test/popdex-operation-journal.test.js`
- Test: `test/popdex-adapter.test.js`
- Test: `test/popdex-factory.test.js`

- [ ] **Step 1: 写完整下单元数据和确定性恢复测试**

```js
test('placeLimitOrder persists ownership before clearing confirmed journal', async () => {
  const exchange = liveFixture();
  const result = await exchange.placeLimitOrder({
    marketId: 20000, side: 'buy', price: 60000, sizeBase: 0.0002,
    reduceOnly: false, levelIndex: 0, opening: true, intentId: 'seed-0',
  });
  assert.deepEqual(result, {
    orderId: '123', clientOrderId: CLIENT_ID, marketId: 20000,
    side: 'buy', price: 60000, sizeBase: 0.0002,
    reduceOnly: false, levelIndex: 0, opening: true,
  });
  assert.deepEqual(exchange.ownershipStore.listOrders().map((o) => o.orderId), ['123']);
  assert.equal(exchange.journal.load(), null);
});

test('crash after receipt recovers the same order and never rebroadcasts', async () => {
  const exchange = fixtureWithBroadcastJournalAndReceipt();
  await exchange.init();
  assert.equal(exchange.tradingClient.placeCalls, 0);
  assert.equal(exchange.ownershipStore.listOrders()[0].clientOrderId, CLIENT_ID);
});
```

- [ ] **Step 2: 扩展操作日志字段**

`place` 记录增加并严格校验：

```js
intentId: string
levelIndex: nonNegativeSafeInteger
opening: boolean
reduceOnly: boolean
parentFillEventId: string | null
```

旧的 leverage/cancel/close 记录这些字段必须为 `null`。版本升为 2，并提供仅从当前 Stage 6 version=1 无网格 place 记录读取的显式迁移；出现未知组合直接失败。

- [ ] **Step 3: 修改适配器下单和恢复顺序**

`placeLimitOrder` 必须：

1. 校验 BTC-only、long-only 语义；
2. reduce-only sell 前读取已验证多仓且 `qty <= holdSizeWad`；
3. 用 `intentId` 生成确定性 ID；
4. 广播并确认回执；
5. 写入 ownership store；
6. 刷新官方快照；
7. 清理 CONFIRMED journal；
8. 返回完整元数据。

若同一 `intentId` 已存在完全一致的 owned order，返回该订单且不广播；字段冲突则 `HALTED`。

`cancelAll` 必须先把本轮目标订单标记为 suppression，逐单保存精确撤单证明，再进行完整 post-cancel 对账；对账中发现的部分成交仍生成统计事件，但 `suppressRequote=true`。任何目标订单未获得终态时不得返回成功或删除所有权。

- [ ] **Step 4: 写严格恢复和事件确认测试**

```js
test('recoverOwnedOrders returns exact active metadata and queues terminal events', async () => {
  const result = await exchange.recoverOwnedOrders({ marketId: 20000, reason: 'startup' });
  assert.equal(result.activeOrders[0].clientOrderId, CLIENT_ID);
  assert.equal(result.pendingEvents[0].fillEventId, EVENT_ID);
});

test('acknowledgeFillEvent requires the confirmed replacement identity', () => {
  assert.throws(() => exchange.acknowledgeFillEvent(EVENT_ID, 'wrong'), /补单身份不匹配/);
  exchange.acknowledgeFillEvent(EVENT_ID, REPLACEMENT_ORDER_ID);
  assert.deepEqual(exchange.pendingFillEvents(), []);
});

test('suppressed bulk-cancel fill completes without a replacement order', () => {
  exchange.acknowledgeFillEvent(SUPPRESSED_EVENT_ID, null);
  assert.deepEqual(exchange.pendingFillEvents(), []);
});
```

- [ ] **Step 5: 接入对账状态与事件发布**

适配器新增：

```js
this.strictOrderRecovery = true;
this.requiresDurableFillAck = true;
async recoverOwnedOrders({ marketId, reason, suppressRequote = false })
async reconcileOwnedOrders({ marketId, reason, suppressRequote = false })
pendingFillEvents()
releaseRecoveredEvents()
acknowledgeFillEvent(fillEventId, replacementOrderId)
haltFromBot(error)
```

`releaseRecoveredEvents` 只发布 `EVENT_PENDING`，事件携带 `fillEventId`、精确 order metadata、实际成交数量/均价和 `suppressRequote`。重复调用不得重复发布同一内存事件；未收到 durable ack 时进程重启仍需回放。

对账网络错误转 `RECONCILING`；结构、身份和超时未知终态转 `HALTED`。保留首个根因，日志输出 diagnostics 但不输出私钥。

- [ ] **Step 6: 更新 factory 注入**

`createLiveExchange` 新增必填：

```js
ownershipFile: requiredText(cfg.ownershipFile, 'ownershipFile')
```

默认构造 `PopdexOwnershipStore` 和 `PopdexReconciler`；测试可通过 deps 注入。Stage 8 之前不得修改正式 exchange registry。

- [ ] **Step 7: 运行适配器测试并提交**

Run: `node --test test/popdex-operation-journal.test.js test/popdex-adapter.test.js test/popdex-factory.test.js`

Expected: PASS。

```bash
git add src/exchange/px/operation-journal.js src/exchange/px/popdex.js src/exchange/px/index.js test/popdex-operation-journal.test.js test/popdex-adapter.test.js test/popdex-factory.test.js
git commit -m "实现：接入PopDEX持久化对账与成交事件"
```

## Task 7: 将严格恢复和一次性补单接入 GridBot

**Files:**
- Modify: `src/bot.js:38-52,103-176,592-741,1042-1160`
- Modify: `src/startup.js:33-35`
- Test: `test/bot.test.js`
- Test: `test/startup.test.js`

- [ ] **Step 1: 写完整订单元数据持久化测试**

```js
test('bot stores every adapter order identity needed by strict recovery', async () => {
  exchange.placeLimitOrder = async () => fullOrderResult();
  await bot.start(longConfig());
  const [, active] = bot.snapshot().active[0];
  assert.equal(active.clientOrderId, CLIENT_ID);
  assert.equal(active.reduceOnly, false);
  assert.equal(active.opening, true);
});
```

- [ ] **Step 2: 修改 `_place` 保存返回元数据和 intentId**

严格适配器启动新网格时生成并持久化唯一 `gridRunId`；恢复时沿用快照中的原值，缺失或冲突直接失败。发送参数增加：

```js
intentId: o.intentId ?? `grid:${this.config.gridRunId}:${this.config.marketId}:${lvl}:${o.side}:${opening ? 'open' : 'close'}`,
opening,
```

新启动生成 `gridRunId=randomUUID()`，并在第一笔写操作前通过 `_changed()` 持久化。非严格适配器不新增该要求。

成功后以适配器返回字段为准保存：

```js
const active = {
  levelIndex: r.levelIndex ?? lvl,
  side: r.side ?? o.side,
  price: r.price ?? o.price,
  sizeBase: r.sizeBase ?? sizeBase,
  clientOrderId: r.clientOrderId ?? null,
  reduceOnly: r.reduceOnly ?? reduceOnly,
  opening: r.opening ?? opening,
  recovery: !!o.recovery,
  parentFillEventId: o.parentFillEventId ?? null,
  placedAt: Date.now(),
};
```

非严格适配器允许 `clientOrderId=null`；`strictOrderRecovery=true` 时缺少完整字段直接抛错并停止。

- [ ] **Step 3: 写严格重启接管测试**

```js
test('strict recovery replaces stale snapshot active orders without price guessing', async () => {
  exchange.strictOrderRecovery = true;
  exchange.recoverOwnedOrders = async () => ({ activeOrders: [fullOwnedOrder()], pendingEvents: [] });
  await bot.resume(staleSnapshot());
  assert.deepEqual([...bot.active.keys()], ['123']);
  assert.equal(exchange.adoptCalls, 0);
});

test('strict recovery binds listeners before releasing offline fills', async () => {
  await bot.resume(snapshot());
  assert.deepEqual(exchange.calls, ['recoverOwnedOrders', 'start', 'releaseRecoveredEvents']);
});
```

- [ ] **Step 4: 实现严格恢复分支**

`resume` 中：

```js
if (this.ex.strictOrderRecovery === true) {
  const recovered = await this.ex.recoverOwnedOrders({ marketId: this.config.marketId, reason: 'startup' });
  this.active = new Map(recovered.activeOrders.map((order) => [String(order.orderId), toActive(order)]));
} else {
  // 保留现有 adoptOrder 循环，行为不变。
}
```

随后绑定 listeners、启动 adapter、设置 `running=true`、执行一次严格对账，最后调用 `releaseRecoveredEvents()`。任一步失败执行现有 rollback，不自动 cancel。

- [ ] **Step 5: 写成交补单 durable ack 测试**

```js
test('PopDEX terminal fill persists replacement before durable event ack', async () => {
  exchange.strictOrderRecovery = true;
  exchange.requiresDurableFillAck = true;
  exchange.emit('fill', terminalFill({ fillEventId: EVENT_ID }));
  await bot._fillQueue;
  assert.deepEqual(callOrder, ['placeLimitOrder', 'persistSnapshot', 'acknowledgeFillEvent']);
});

test('PopDEX replacement failure halts without generic retry', async () => {
  exchange.placeLimitOrder = async () => { throw new Error('write failed'); };
  exchange.emit('fill', terminalFill({ fillEventId: EVENT_ID }));
  await bot._fillQueue;
  assert.equal(bot._retryQueue.length, 0);
  assert.match(exchange.haltReason, /write failed/);
});

test('equivalent level is covered only by the same parent fill intent', async () => {
  bot.active.set('other', { ...replacementOrder(), parentFillEventId: 'another-event' });
  const result = await bot._place({ ...replacementRequest(), parentFillEventId: EVENT_ID });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /补单意图冲突/);
});
```

- [ ] **Step 6: 实现事件确认和确定性补单意图**

`_handleFill` 给补单增加：

```js
repl.intentId = `replacement:${f.fillEventId}`;
repl.parentFillEventId = f.fillEventId;
```

严格成交事件先计算统计增量，但在补单获得 `placed`/同一 `parentFillEventId` 的 `covered` 之前不得修改 Bot 统计或成交列表。补单确认后一次性应用统计增量，调用 `_changed()`；只有持久化成功后才调用：

```js
this.ex.acknowledgeFillEvent?.(f.fillEventId, result.orderId);
```

`suppressRequote=true` 时不下单，应用统计并持久化后使用 `replacementOrderId=null` 完成事件。严格适配器的 placement 失败调用 `haltFromBot(error)`，不得应用统计、不得确认事件、不得进入现有 closing retry queue。Decibel、RISEx 继续使用原重试行为。

- [ ] **Step 7: 绕过 PopDEX 通用价格猜测对账**

`reconcileOpenOrders()` 开头增加严格分支，调用 `reconcileOwnedOrders` 并用精确返回值更新 active；不得执行后续按价格推导 `levelIndex` 的通用代码。对账完成后再释放待回放事件。

- [ ] **Step 8: 运行 Bot/启动回归并提交**

Run: `node --test test/bot.test.js test/startup.test.js test/risex-adapter.test.js test/exchange-adapters.test.js`

Expected: PASS，Decibel、RISEx 测试结果不变。

```bash
git add src/bot.js src/startup.js test/bot.test.js test/startup.test.js
git commit -m "实现：接入PopDEX严格恢复与一次性补单"
```

## Task 8: 补齐 Paper 同形行为和故障注入

**Files:**
- Modify: `src/exchange/px/paper.js`
- Modify: `test/popdex-paper.test.js`
- Modify: `test/popdex-adapter.test.js`
- Modify: `test/bot.test.js`

- [ ] **Step 1: 写 Paper 完整返回和恢复测试**

```js
test('paper placement returns full durable order metadata', async () => {
  const order = await exchange.placeLimitOrder(fullInput());
  assert.deepEqual(Object.keys(order).sort(), [
    'clientOrderId', 'levelIndex', 'marketId', 'opening', 'orderId',
    'price', 'reduceOnly', 'side', 'sizeBase',
  ]);
});

test('paper strict recovery replays one terminal event only once per process', async () => {
  const recovered = await exchange.recoverOwnedOrders({ marketId: 20000, reason: 'startup' });
  assert.equal(recovered.pendingEvents.length, 1);
  exchange.releaseRecoveredEvents();
  exchange.releaseRecoveredEvents();
  assert.equal(received.length, 1);
});
```

- [ ] **Step 2: 实现 Paper 同形 API**

Paper 不写磁盘，但必须返回完整元数据，支持 `strictOrderRecovery`、`recoverOwnedOrders`、`reconcileOwnedOrders`、`releaseRecoveredEvents` 和 `acknowledgeFillEvent`。所有接口使用内存 Map；不得导入 live 私钥或写客户端。

- [ ] **Step 3: 增加崩溃点故障注入测试**

在 adapter/Bot 测试依次注入：PREPARED 后、BROADCAST 后、CONFIRMED 后、ownership temp 写失败、ownership rename 失败、事件持久化后、补单回执后、Bot snapshot 写失败。每个测试断言：写广播次数最多一次、ownership/journal 保留可恢复事实、event 未错误完成、状态为 `HALTED` 或 `RECONCILING`。

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/popdex-paper.test.js test/popdex-adapter.test.js test/bot.test.js`

Expected: PASS。

```bash
git add src/exchange/px/paper.js test/popdex-paper.test.js test/popdex-adapter.test.js test/bot.test.js
git commit -m "测试：覆盖PopDEX补单恢复故障边界"
```

## Task 9: 实现独立 BTC 做多 3 格验收命令

**Files:**
- Create: `src/exchange/px/grid-probe.js`
- Create: `test/popdex-grid-probe.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写 CLI 参数和只读默认测试**

```js
test('grid probe defaults to read-only preflight', async () => {
  const result = await runGridProbe({ argv: [], deps: fakeDeps() });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.writes, 0);
});

test('mainnet start is fixed to BTC long three grids one leverage', async () => {
  await assert.rejects(() => runGridProbe({ argv: ['--mode', 'neutral', '--confirm-mainnet-grid'], deps }), /只允许做多/);
  await assert.rejects(() => runGridProbe({ argv: ['--grids', '4', '--confirm-mainnet-grid'], deps }), /固定为 3/);
  await assert.rejects(() => runGridProbe({ argv: ['--leverage', '2', '--confirm-mainnet-grid'], deps }), /固定为 1x/);
});
```

- [ ] **Step 2: 写启动前账户隔离和金额测试**

覆盖：BTC 有任何外部订单/持仓拒绝启动；每单名义金额必须在 10–15 USDT；上下界必须包住当前价且 tick 对齐；状态/所有权文件已有未完成事实时只允许 `--resume`。

- [ ] **Step 3: 实现命令解析和独立文件**

公开可测接口：

```js
export function parseGridProbeArgs(argv) {}
export function buildBtcLongThreeGridPlan({ mark, lower, upper, sizeBase }) {}
export async function runGridProbe({ argv = process.argv.slice(2), env = process.env, deps = {} } = {}) {}
```

运行文件固定为：

```text
.popdex-grid-probe.json
.popdex-grid-probe-ownership.json
.popdex-grid-probe-operation.json
.popdex-grid-probe.lock
```

锁文件包含 PID、主账户和规范启动时间；发现活 PID 时拒绝第二实例，僵尸锁只有在官方只读对账成功后才允许移除。

- [ ] **Step 4: 实现交互控制和安全退出**

主网确认启动后保持前台运行，通过 stdin 接受严格命令：

```text
status
reconnect
stop
```

`status` 只读打印健康状态、订单、成交、持仓和 pending event；`reconnect` 调用完整对账；`stop` 先设置批量撤单 suppression，再撤销全部自有订单、确认无开放订单、使用已验证多仓 close、确认空仓并清理 probe state。SIGINT/SIGTERM 只持久化并退出，不自动写交易，日志明确提示必须 `--resume`。

- [ ] **Step 5: 写成交补单、重启和断网编排测试**

使用 fake adapter 驱动：初始 1 个 buy seed、部分成交不补单、终态成交生成 1 个 reduce-only sell、kill 后 `--resume` 接管、读取失败进入 `RECONCILING`、恢复完整对账后 `READY`、离线成交只补一次、`stop` 最终 0 orders/0 positions。

- [ ] **Step 6: 注册脚本并运行测试**

`package.json` 增加：

```json
"popdex:grid-probe": "node src/exchange/px/grid-probe.js"
```

并将四个 Stage 7 测试文件加入 `npm test`。

Run: `node --test test/popdex-grid-probe.test.js`

Expected: PASS，且 fake write 计数符合每个场景断言。

- [ ] **Step 7: 提交**

```bash
git add package.json src/exchange/px/grid-probe.js test/popdex-grid-probe.test.js
git commit -m "实现：增加PopDEX三格主网验收命令"
```

## Task 10: 更新边界文档并执行全量回归

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/protocol/popdex-mainnet-validation.md`
- Modify: `docs/superpowers/specs/2026-08-18-popdex-stage7-recovery-design.md`

- [ ] **Step 1: 更新项目事实源**

在 `AGENTS.md` 记录：

```text
- PopDEX Stage 7 仅开放 BTCUSDT 做多、1x、3 格验收；中性、做空、ETH live 仍禁止。
- PopDEX 做多成交后的卖单必须是 Limit + GTC + ReduceOnly + OneWay/Net。
- PopDEX 订单恢复只允许 orderId + clientOrderId 精确所有权，不允许价格猜测。
- 正式前端/API/config 迁移仍属于 Stage 8。
```

在协议文档记录新增自动测试能力，但明确“自动测试通过不等于主网验收通过”。列出下一步 VPS 命令，不写入任何密钥值。

- [ ] **Step 2: 运行定向 Stage 7 测试**

Run:

```bash
node --test test/popdex-order-state.test.js test/popdex-ownership-store.test.js test/popdex-reconciler.test.js test/popdex-adapter.test.js test/popdex-paper.test.js test/popdex-grid-probe.test.js test/bot.test.js test/startup.test.js
```

Expected: 全部 PASS，0 fail、0 skipped。

- [ ] **Step 3: 运行完整项目测试**

Run: `npm test`

Expected: `test/grid.test.js` PASS，Node test 汇总 0 fail；Decibel、RISEx 和全部 PopDEX Stage 1–7 测试通过。

- [ ] **Step 4: 检查敏感信息和改动范围**

Run:

```bash
git diff --check
git status --short
git diff --stat codex/popdex-stage6-adapter-paper...HEAD
git grep -nE '(0x[0-9a-fA-F]{64}|PRIVATE_KEY=0x|agentPrivateKey: .+)' -- ':!package-lock.json' ':!docs/protocol/popdex-mainnet-validation.md'
```

Expected: 无空白错误；没有 `.env`、运行状态文件或真实私钥进入提交；差异只属于 Stage 7。

- [ ] **Step 5: 提交文档**

```bash
git add AGENTS.md docs/protocol/popdex-mainnet-validation.md docs/superpowers/specs/2026-08-18-popdex-stage7-recovery-design.md
git commit -m "文档：记录PopDEX第七阶段安全边界"
```

## Task 11: 完成前代码审查与主网交接

**Files:**
- Review only: all Stage 7 changed files

- [ ] **Step 1: 按设计逐项自查**

逐项核对：精确订单身份、fill 去重、终态一次事件、partial/cancel race、外部订单 HALTED、完整分页、单飞对账、首因日志、确定性补单、重启/离线恢复、bulk cancel suppression、long-only、reduce-only Limit、Decibel/RISEx 隔离。

- [ ] **Step 2: 检查分支提交历史**

Run:

```bash
git status --short --branch
git log --oneline --decorate codex/popdex-stage6-adapter-paper..HEAD
git diff --stat codex/popdex-stage6-adapter-paper...HEAD
```

Expected: 工作树干净，提交均为 Stage 7，未修改正式前端/API/config。

- [ ] **Step 3: 交付 VPS dry-run 命令**

只提供 dry-run 和只读 status 命令。不得由开发会话执行 `--confirm-mainnet-grid`；主网启动必须由用户在 VPS 明确运行，并先确认 PopDEX 网页 BTC 挂单 0、持仓 0。

- [ ] **Step 4: 用户完成 BTC 小网格验收后记录证据**

证据必须包括：初始订单数和身份、一次成交与唯一反向 reduce-only 限价单、正常重启接管、断网 `RECONCILING`、恢复 `READY`、离线成交只补一次、停止后挂单 0 和持仓 0。任何一步失败均停止验收并保留日志，不进入 Stage 8。
