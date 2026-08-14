# Live Trading Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复所有已确认的实盘阻断缺陷，让交易状态、交易所真实订单和本地持久化在失败时保持一致并可观测。

**Architecture:** 在 `GridBot` 建立失败即停止的订单生命周期边界，在交易所适配器统一成功返回契约，并把恢复、状态存储和密钥文件操作拆成可独立测试的小模块。RISEx live 在工厂入口禁用，paper 行为不变。

**Tech Stack:** Node.js 20+、ES modules、`node:test`、现有交易所 SDK、内置 `node:crypto`/`node:fs`。

---

仓库策略禁止 Subagent，因此本计划只能使用 `superpowers:executing-plans` 在当前隔离 worktree 串行执行。所有测试使用假适配器或纯函数，不连接真实交易所。

### Task 1: 建立交易状态机回归测试和失败即停止契约

**Files:**
- Create: `test/helpers/fake-exchange.js`
- Create: `test/bot.test.js`
- Modify: `src/bot.js:76-77, 110-150, 194-224, 257-317, 326-375, 410-445, 647-690`

- [ ] **Step 1: 创建可重复的假交易所**

```js
// test/helpers/fake-exchange.js
import { EventEmitter } from 'node:events';

export class FakeExchange extends EventEmitter {
  constructor(overrides = {}) {
    super();
    this.equity = 100_000;
    this.feeRate = 0.0001;
    this.price = 100;
    this.orders = new Map();
    this.position = null;
    this.cancelResult = true;
    this.nextId = 0;
    Object.assign(this, overrides);
  }
  async getMarkets() {
    return [{ marketId: 1, displayName: 'TEST-USD', maxLeverage: 10, minOrderSize: 0.001, stepSize: 0.001, stepPrice: 0.1 }];
  }
  async setLeverage() { return true; }
  async getPrice() { return this.price; }
  async placeLimitOrder(order) {
    const orderId = String(++this.nextId);
    this.orders.set(orderId, order);
    return { orderId };
  }
  async cancelAll() {
    if (this.cancelResult === true) this.orders.clear();
    return this.cancelResult;
  }
  async cancelOrder(_marketId, orderId) {
    return this.orders.delete(String(orderId));
  }
  async fetchOpenOrders() {
    return [...this.orders].map(([orderId, o]) => ({ orderId, price: o.price, side: o.side }));
  }
  getPosition() { return this.position; }
  async closePosition() { this.position = null; return true; }
  start() {}
}
```

- [ ] **Step 2: 写撤单、区间、参数、挂单和平仓失败测试**

```js
// test/bot.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { GridBot } from '../src/bot.js';
import { FakeExchange } from './helpers/fake-exchange.js';

const config = { marketId: 1, mode: 'neutral', lower: 90, upper: 110, gridCount: 4, sizeBase: 1, leverage: 2, outOfRangeAction: 'close' };

test('adjustRange keeps tracking and does not reseed when cancelAll fails', async () => {
  const ex = new FakeExchange();
  const bot = new GridBot(ex);
  await bot.start(config);
  ex.cancelResult = false;
  await assert.rejects(bot.adjustRange({ lower: 88, upper: 112 }), /撤单失败/);
  assert.equal(ex.orders.size, 4);
  assert.equal(bot.active.size, 4);
  assert.deepEqual([bot.config.lower, bot.config.upper], [90, 110]);
});

test('stop stays running and keeps tracking when cancelAll fails', async () => {
  const ex = new FakeExchange();
  const bot = new GridBot(ex);
  await bot.start(config);
  ex.cancelResult = false;
  await assert.rejects(bot.stop({ closePosition: false }), /撤单失败/);
  assert.equal(bot.running, true);
  assert.equal(bot.active.size, 4);
});

test('start rejects a price outside the grid before placing orders', async () => {
  const ex = new FakeExchange({ price: 80 });
  const bot = new GridBot(ex);
  await assert.rejects(bot.start(config), /网格区间之外/);
  assert.equal(ex.orders.size, 0);
  assert.equal(bot.running, false);
});

for (const patch of [{ gridCount: 2.5 }, { sizeBase: Number.NaN }, { leverage: Number.NaN }]) {
  test(`start rejects invalid config ${JSON.stringify(patch)}`, async () => {
    const bot = new GridBot(new FakeExchange());
    await assert.rejects(bot.start({ ...config, ...patch }), /参数/);
  });
}

test('start aborts and cancels accepted seed orders after a placement failure', async () => {
  const ex = new FakeExchange();
  const original = ex.placeLimitOrder.bind(ex);
  ex.placeLimitOrder = async (order) => ex.nextId === 1 ? Promise.reject(new Error('rejected')) : original(order);
  const bot = new GridBot(ex);
  await assert.rejects(bot.start(config), /初始挂单失败/);
  assert.equal(ex.orders.size, 0);
  assert.equal(bot.running, false);
});

test('close confirmation reports failure when closePosition throws', async () => {
  const ex = new FakeExchange({ position: { sizeBase: 1 } });
  ex.closePosition = async () => { throw new Error('close rejected'); };
  const bot = new GridBot(ex);
  assert.equal(await bot._closeWithConfirm(1, { attempts: 1, waitMs: 0 }), false);
});
```

- [ ] **Step 3: 运行测试确认 RED**

Run: `node --test test/bot.test.js`

Expected: 撤单、区间外、参数、初始挂单和平仓测试失败，证明旧实现仍会吞错或继续运行。

- [ ] **Step 4: 在 GridBot 实现最小失败边界**

```js
_validateStartConfig(cfg, market) {
  const lower = Number(cfg.lower), upper = Number(cfg.upper);
  const gridCount = Number(cfg.gridCount), rawSize = Number(cfg.sizeBase), rawLeverage = Number(cfg.leverage ?? 3);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !(lower > 0) || !(upper > lower)) throw new Error('启动参数错误：价格区间无效');
  if (!Number.isInteger(gridCount) || gridCount < 2) throw new Error('启动参数错误：网格数必须是至少 2 的整数');
  if (!Number.isFinite(rawSize) || !(rawSize > 0)) throw new Error('启动参数错误：每格数量必须是正数');
  if (!Number.isFinite(rawLeverage) || !(rawLeverage > 0)) throw new Error('启动参数错误：杠杆必须是正数');
  return { lower, upper, gridCount, sizeBase: Math.max(rawSize, market.minOrderSize || 0), leverage: Math.min(rawLeverage, market.maxLeverage || 50) };
}

async _requireCancelAll(marketId, action) {
  let ok;
  try { ok = await this.ex.cancelAll(marketId); }
  catch (cause) { throw new Error(`${action}前撤单失败：${cause?.message || cause}`, { cause }); }
  if (ok !== true) throw new Error(`${action}前撤单失败：交易所未确认全部撤单成功`);
}
```

将所有破坏性路径改成先 `await this._requireCancelAll(...)`，成功后才清空 `active` 或改变 `running/config`。启动顺序改成：校验参数 → 设置杠杆且要求 `true` → 撤单成功 → 获取现价且要求位于区间内 → 注册监听器 → 逐单挂初始网格。让 `_place` 返回布尔值；任一初始挂单失败时要求撤单成功并抛出 `初始挂单失败`。删除 `_changed()` 中吞掉持久化异常的 `try/catch`。

将 `_closeWithConfirm` 增加可测试参数并只在成功发出平仓且观察到空仓后返回 `true`：

```js
async _closeWithConfirm(marketId, { attempts = 3, waitMs = 8000 } = {}) {
  const mId = Number(marketId);
  if (typeof this.ex.closePosition !== 'function') return false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let sent = false;
    try { await this.ex.closePosition(mId); sent = true; }
    catch (e) { this._alert('平仓指令发送失败: ' + (e?.message || e)); }
    if (!sent) continue;
    const deadline = Date.now() + waitMs;
    do {
      const pos = this.ex.getPosition?.(mId);
      if (!pos || !pos.sizeBase) return true;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
    } while (true);
  }
  return false;
}
```

- [ ] **Step 5: 确认 GREEN**

运行：`node --test test/bot.test.js`。完整 `npm test` 命令在所有测试文件创建完成后的 Task 7 一次性更新，保证每个中间提交都可执行。

Expected: Task 1 全部测试通过。

- [ ] **Step 6: 提交 Task 1**

```bash
git add src/bot.js test/helpers/fake-exchange.js test/bot.test.js
git commit -m "修复：交易状态机失败时停止并保留订单跟踪"
```

### Task 2: 修复所有适配器撤单成功契约及 Extended 标识

**Files:**
- Create: `test/exchange-adapters.test.js`
- Modify: `src/exchange/de/decibel.js:341-360, 543-580`
- Modify: `src/exchange/ex/extended.js:14-20, 204-280, 286-307, 405-430`

- [ ] **Step 1: 写 Extended nonce、externalId 和撤单契约失败测试**

```js
// test/exchange-adapters.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtendedExchange, generateOrderNonce, externalOrderId } from '../src/exchange/ex/extended.js';
import { DecibelExchange, confirmedDecibelFillSize } from '../src/exchange/de/decibel.js';

test('Extended nonce is always in the documented inclusive range', () => {
  for (let i = 0; i < 10_000; i++) {
    const nonce = generateOrderNonce();
    assert.ok(Number.isInteger(nonce));
    assert.ok(nonce >= 1 && nonce <= 2 ** 31);
  }
});

test('Extended uses the full-precision externalId instead of numeric id', () => {
  assert.equal(externalOrderId({ id: 1784963886257016800, externalId: '1784963886257016832' }), '1784963886257016832');
  assert.equal(externalOrderId({ id: 1784963886257016800 }), null);
});

test('Decibel partial fill returns only executed quantity', () => {
  assert.equal(confirmedDecibelFillSize({ orig_size: '1', remaining_size: '0.75', status: 'CANCELLED' }, 1), 0.25);
  assert.equal(confirmedDecibelFillSize({ orig_size: '1', remaining_size: '0', status: 'FILLED' }, 1), 1);
});

test('Extended keeps tracking when individual cancellation fails', async () => {
  const id = '1784963886257016832';
  const exchange = new ExtendedExchange({ apiKey: 'x', vault: '1', privateKey: '1', apiUrl: 'https://invalid.local' });
  exchange._tracked.set(id, { marketId: 1 });
  exchange._req = async () => { throw new Error('cancel rejected'); };
  await assert.rejects(exchange.cancelOrder(1, id), /cancel rejected/);
  assert.equal(exchange._tracked.has(id), true);
});

test('Decibel cancelAll reports failure and retains failed order tracking', async () => {
  const exchange = new DecibelExchange({ apiKey: 'x', privateKey: '1' });
  exchange.on('error', () => {});
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD', addr: '0xbtc' });
  exchange._tracked.set('order-1', { marketId: 1 });
  exchange._openOrders = async () => [{ order_id: 'order-1', market: 'BTC-USD', is_tpsl: false }];
  exchange.write = { cancelOrder: async () => { throw new Error('cancel rejected'); } };
  assert.equal(await exchange.cancelAll(1), false);
  assert.equal(exchange._tracked.has('order-1'), true);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/exchange-adapters.test.js`

Expected: 因三个纯辅助函数尚不存在而失败。

- [ ] **Step 3: 实现 Extended 安全标识和 nonce**

```js
import { randomInt } from 'node:crypto';

export function generateOrderNonce() { return randomInt(1, 2 ** 31 + 1); }
export function externalOrderId(order) {
  const value = order?.externalId;
  return typeof value === 'string' && value.length ? value : null;
}
```

`_submitOrder` 使用 `generateOrderNonce()`，返回 `{ orderId: payload.id, externalId: payload.id }`。`placeLimitOrder` 以该字符串跟踪；`cancelOrder` 成功后再删除 `_tracked`。`fetchOpenOrders` 只返回存在字符串 `externalId` 的记录。`cancelAll` 在 massCancel 成功后删除对应市场跟踪并返回 `true`，失败返回 `false` 且不删除跟踪。

- [ ] **Step 4: 修复 Decibel 撤单与部分成交数量**

```js
export function confirmedDecibelFillSize(order, fallbackSize) {
  const original = Number(order?.orig_size);
  const remaining = Number(order?.remaining_size);
  const filled = original - remaining;
  if (Number.isFinite(filled) && filled > 0) return filled;
  return /filled/i.test(String(order?.status || '')) ? Number(fallbackSize) : null;
}
```

`_resolveGone` 将辅助函数结果保存为 `fillSize` 并在事件中使用。`cancelOrder` 和 `cancelAll` 只在对应远端撤单成功后删除 `_tracked`；任一订单撤销失败时保留失败订单跟踪并最终返回 `false`。

- [ ] **Step 5: 运行适配器测试和 Task 1 测试**

Run: `node --test test/exchange-adapters.test.js test/bot.test.js`

Expected: 全部通过。

- [ ] **Step 6: 提交 Task 2**

```bash
git add src/exchange/de/decibel.js src/exchange/ex/extended.js test/exchange-adapters.test.js
git commit -m "修复：校验撤单结果并保留完整订单标识"
```

### Task 3: 禁用 RISEx live 并让实盘初始化失败阻止启动

**Files:**
- Create: `src/startup.js`
- Create: `test/startup.test.js`
- Modify: `src/exchange/rs/index.js:1-17`
- Modify: `src/exchange/rs/risex.js:50-65`
- Modify: `src/server.js:20-50, 489-514`

- [ ] **Step 1: 写 RISEx 和初始化行为测试**

```js
// test/startup.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExchange as createRsExchange } from '../src/exchange/rs/index.js';
import { RisexExchange } from '../src/exchange/rs/risex.js';
import { initializeExchange } from '../src/startup.js';

test('RISEx live is rejected before a signer key reaches the unofficial SDK', () => {
  assert.throws(() => createRsExchange({ mode: 'live', account: '0x1', signerKey: 'secret' }), /RISEx 实盘已禁用/);
});

test('RISEx paper remains available', () => {
  assert.equal(createRsExchange({ mode: 'paper', startBalance: 1000 }).mode, 'paper');
});

test('direct RISEx live adapter initialization is also blocked', async () => {
  const exchange = new RisexExchange({ account: '0x1', signerKey: 'secret' });
  await assert.rejects(exchange.init(), /RISEx 实盘已禁用/);
});

test('live initialization failure propagates', async () => {
  const exchange = { init: async () => { throw new Error('offline'); } };
  await assert.rejects(initializeExchange(exchange, 'Extended', { mode: 'live' }, console), /Extended 实盘初始化失败/);
});

test('paper initialization failure returns false and is logged', async () => {
  const messages = [];
  const logger = { log() {}, error: (message) => messages.push(message) };
  const exchange = { init: async () => { throw new Error('offline'); } };
  assert.equal(await initializeExchange(exchange, 'Paper', { mode: 'paper' }, logger), false);
  assert.match(messages.join('\n'), /offline/);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/startup.test.js`

Expected: `src/startup.js` 不存在，RISEx live 仍会创建适配器。

- [ ] **Step 3: 实现工厂禁用和初始化边界**

```js
// src/startup.js
export async function initializeExchange(exchange, name, config, logger = console) {
  try {
    await exchange.init();
    logger.log(`[${name}] 连接成功 [${config.mode.toUpperCase()} 模式]`);
    return true;
  } catch (cause) {
    logger.error(`[${name}] 初始化失败: ${cause?.message || cause}`);
    if (config.mode === 'live') throw new Error(`${name} 实盘初始化失败，服务已停止`, { cause });
    return false;
  }
}
```

`src/exchange/rs/index.js` 不再导入 `RisexExchange`；`cfg.mode === 'live'` 立即抛出 `RISEx 实盘已禁用：当前 risex-client 未达到生产可用标准，请改用 RS_MODE=paper`。`RisexExchange.init()` 使用同一错误直接拒绝，防止直接导入绕过工厂。`server.js` 导入并使用 `initializeExchange`，删除吞掉 live 初始化错误的本地函数和 RISEx live 缺密钥提示。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/startup.test.js`

Expected: 5 项通过。

- [ ] **Step 5: 提交 Task 3**

```bash
git add src/startup.js src/exchange/rs/index.js src/exchange/rs/risex.js src/server.js test/startup.test.js
git commit -m "安全：禁用未达生产标准的 RISEx 实盘"
```

### Task 4: 修复按市场名称恢复和等待对账

**Files:**
- Create: `src/recovery.js`
- Modify: `test/startup.test.js`
- Modify: `src/server.js:90-120, 516-565`
- Modify: `src/bot.js:110-187, 194-198`

- [ ] **Step 1: 写旧 marketId 重映射和恢复失败测试**

```js
// append to test/startup.test.js
import { remapSnapshotMarket, resumeRunningSnapshot } from '../src/recovery.js';

test('running snapshot is remapped by displayName before resume', async () => {
  const snapshot = { running: true, config: { marketId: 99, displayName: 'BTC-USD' } };
  const exchange = { dataSource: 'real', getMarkets: async () => [{ marketId: 7, displayName: 'BTC-USD' }] };
  const mapped = await remapSnapshotMarket(exchange, snapshot);
  assert.equal(mapped.config.marketId, 7);
  assert.equal(snapshot.config.marketId, 99);
});

test('resume receives remapped id and propagates reconciliation failure', async () => {
  let received;
  const bot = { resume: async (snapshot) => { received = snapshot; throw new Error('reconcile failed'); } };
  const exchange = { dataSource: 'real', getMarkets: async () => [{ marketId: 7, displayName: 'BTC-USD' }] };
  await assert.rejects(resumeRunningSnapshot(bot, exchange, { running: true, config: { marketId: 99, displayName: 'BTC-USD' } }), /reconcile failed/);
  assert.equal(received.config.marketId, 7);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/startup.test.js`

Expected: `src/recovery.js` 不存在。

- [ ] **Step 3: 实现恢复模块并改造服务启动顺序**

```js
// src/recovery.js
const normalizeMarket = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function remapSnapshotMarket(exchange, snapshot) {
  if (!snapshot?.config?.displayName) throw new Error('恢复快照缺少市场名称');
  const wanted = normalizeMarket(snapshot.config.displayName);
  const markets = await exchange.getMarkets();
  const market = markets.find((item) => [item.displayName, item.name, item.symbol].some((value) => normalizeMarket(value) === wanted));
  if (!market) throw new Error(`恢复失败：找不到市场 ${snapshot.config.displayName}`);
  return { ...snapshot, config: { ...snapshot.config, marketId: market.marketId } };
}

export async function resumeRunningSnapshot(bot, exchange, snapshot) {
  if (!(snapshot?.running && snapshot?.config)) return false;
  if (exchange.dataSource == null) throw new Error('恢复失败：交易所未连接');
  await bot.resume(await remapSnapshotMarket(exchange, snapshot));
  return true;
}
```

`server.js` 在 `bot.resume` 前调用 `resumeRunningSnapshot`。`GridBot.resume` 将 `this.reconcileOpenOrders().catch(() => {})` 改成 `await this.reconcileOpenOrders()`；失败时停止定时器、注销监听器、恢复 `running=false` 后重新抛出。`recoverStrayOrders` 使用 `_requireCancelAll`，服务端不再吞掉清理失败。

- [ ] **Step 4: 运行恢复和 bot 测试**

Run: `node --test test/startup.test.js test/bot.test.js`

Expected: 全部通过。

- [ ] **Step 5: 提交 Task 4**

```bash
git add src/recovery.js src/server.js src/bot.js test/startup.test.js
git commit -m "修复：恢复前按市场名称解析并等待对账"
```

### Task 5: 让持久化损坏和写入失败可见

**Files:**
- Create: `test/persist.test.js`
- Modify: `src/persist.js:13-53`
- Modify: `src/server.js:10-20, 567-end`

- [ ] **Step 1: 写状态缺失、损坏、原子写和失败传播测试**

```js
// test/persist.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateStore } from '../src/persist.js';

test('missing state starts empty', () => {
  const fs = { readFileSync() { const e = new Error('missing'); e.code = 'ENOENT'; throw e; } };
  assert.deepEqual(createStateStore('state.json', fs).loadState(), {});
});

test('corrupt state is not silently converted to empty', () => {
  const fs = { readFileSync: () => '{broken' };
  assert.throws(() => createStateStore('state.json', fs).loadState(), /状态文件读取失败/);
});

test('save writes a temp file and atomically renames it', () => {
  const calls = [];
  const fs = {
    readFileSync() { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
    writeFileSync: (...args) => calls.push(['write', ...args]),
    renameSync: (...args) => calls.push(['rename', ...args]),
  };
  createStateStore('state.json', fs).saveSnapshot('de', { running: true });
  assert.equal(calls[0][1], 'state.json.tmp');
  assert.deepEqual(calls[1], ['rename', 'state.json.tmp', 'state.json']);
});

test('write failure propagates to caller', () => {
  const fs = {
    readFileSync() { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
    writeFileSync() { throw new Error('disk full'); },
  };
  const store = createStateStore('state.json', fs);
  assert.throws(() => store.saveSnapshot('de', {}), /状态文件写入失败.*disk full/);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/persist.test.js`

Expected: `createStateStore` 尚未导出，损坏和写入错误仍被吞掉。

- [ ] **Step 3: 实现同步原子状态存储**

```js
export function createStateStore(stateFile, fsImpl = fs) {
  let cache = null;
  const persist = () => {
    try {
      const tmp = stateFile + '.tmp';
      fsImpl.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
      fsImpl.renameSync(tmp, stateFile);
    } catch (cause) {
      throw new Error(`状态文件写入失败 (${stateFile}): ${cause?.message || cause}`, { cause });
    }
  };
  const loadState = () => {
    if (cache) return cache;
    try { cache = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8')) || {}; }
    catch (cause) {
      if (cause?.code === 'ENOENT') return (cache = {});
      throw new Error(`状态文件读取失败 (${stateFile}): ${cause?.message || cause}`, { cause });
    }
    return cache;
  };
  return {
    loadState,
    loadSnapshot: (key) => loadState()[key] || null,
    saveSnapshot(key, snapshot) { const state = loadState(); state[key] = snapshot; cache = state; persist(); },
    flushState() { if (cache) persist(); },
  };
}
```

模块底部创建默认 store 并导出兼容的 `loadState/loadSnapshot/saveSnapshot/flushState`。`server.js` 在 `SIGINT`/`SIGTERM` 中停止 HTTP server、调用 `flushState()`，失败时记录错误并以非零退出码结束。

- [ ] **Step 4: 运行持久化和 bot 测试**

Run: `node --test test/persist.test.js test/bot.test.js`

Expected: 全部通过，写错误能够到达 `GridBot._changed` 调用方。

- [ ] **Step 5: 提交 Task 5**

```bash
git add src/persist.js src/server.js test/persist.test.js
git commit -m "修复：持久化失败时中止并记录原因"
```

### Task 6: 强制 Linux 密钥文件使用 0600

**Files:**
- Create: `src/envfile.js`
- Modify: `test/security.test.js`
- Modify: `src/config.js:1-30`
- Modify: `src/server.js:370-390`
- Modify: `README.md:120-150`

- [ ] **Step 1: 写权限创建、现有文件修正和不安全模式测试**

```js
// append to test/security.test.js
import { writeEnvFile, assertEnvFileSecure } from '../src/envfile.js';

test('env writer uses and enforces owner-only mode on POSIX', () => {
  const calls = [];
  const fs = {
    existsSync: () => true,
    chmodSync: (...args) => calls.push(['chmod', ...args]),
    writeFileSync: (...args) => calls.push(['write', ...args]),
  };
  writeEnvFile('/app/.env', 'TOKEN=x\n', { fsImpl: fs, platform: 'linux' });
  assert.deepEqual(calls[0], ['chmod', '/app/.env', 0o600]);
  assert.equal(calls[1][3].mode, 0o600);
  assert.deepEqual(calls[2], ['chmod', '/app/.env', 0o600]);
});

test('live startup rejects group-readable env file', () => {
  const fs = { existsSync: () => true, statSync: () => ({ mode: 0o100644 }) };
  assert.throws(() => assertEnvFileSecure('/app/.env', { fsImpl: fs, platform: 'linux' }), /chmod 600/);
});

test('owner-only env file is accepted', () => {
  const fs = { existsSync: () => true, statSync: () => ({ mode: 0o100600 }) };
  assert.doesNotThrow(() => assertEnvFileSecure('/app/.env', { fsImpl: fs, platform: 'linux' }));
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/security.test.js`

Expected: `src/envfile.js` 不存在。

- [ ] **Step 3: 实现文件权限边界**

```js
// src/envfile.js
import fs from 'node:fs';

export function assertEnvFileSecure(envFile, { fsImpl = fs, platform = process.platform } = {}) {
  if (platform === 'win32' || !fsImpl.existsSync(envFile)) return;
  const mode = fsImpl.statSync(envFile).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`密钥文件权限不安全 (${mode.toString(8)})，请执行 chmod 600 ${envFile}`);
}

export function writeEnvFile(envFile, content, { fsImpl = fs, platform = process.platform } = {}) {
  if (platform !== 'win32' && fsImpl.existsSync(envFile)) fsImpl.chmodSync(envFile, 0o600);
  fsImpl.writeFileSync(envFile, content, { encoding: 'utf8', mode: 0o600 });
  if (platform !== 'win32') fsImpl.chmodSync(envFile, 0o600);
}
```

`config.loadEnv()` 在读取前调用 `assertEnvFileSecure(file)`；`server.js` 的 `/api/env` 使用 `writeEnvFile`。README Linux 命令增加：

```bash
umask 077
cp .env.example .env
chmod 600 .env
```

并要求使用 dedicated service user。

- [ ] **Step 4: 运行安全测试确认 GREEN**

Run: `node --test test/security.test.js`

Expected: 原15项和新增3项全部通过。

- [ ] **Step 5: 提交 Task 6**

```bash
git add src/envfile.js src/config.js src/server.js README.md test/security.test.js
git commit -m "安全：强制密钥文件使用所有者权限"
```

### Task 7: 同步文档、测试入口和实盘限制

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新单一事实来源**

在 `.env.example` 的 RISEx 配置旁写明 `RS_MODE` 只能为 `paper`。README 的交易所表格标记 RISEx live 已禁用，解释重新开放需要官方私有订单/成交通道和测试网验证。README 增加“实盘启动检查清单”：`.env=0600`、Tailscale only、测试通过、从最小仓位开始。

在 `AGENTS.md` 增加当前实盘架构事实：Decibel/Extended 支持 live，RISEx 仅 paper；关键订单动作要求交易所明确确认成功；恢复以市场名称为主键。

- [ ] **Step 2: 固定完整测试命令**

```json
"test": "node test/grid.test.js && node --test test/security.test.js test/bot.test.js test/exchange-adapters.test.js test/startup.test.js test/persist.test.js"
```

- [ ] **Step 3: 运行文档静态断言**

Run: `rg -n "RISEx.*(禁用|paper)|chmod 600|Tailscale" README.md .env.example AGENTS.md`

Expected: 三个文件都出现对应限制或部署要求。

- [ ] **Step 4: 提交 Task 7**

```bash
git add .env.example README.md package.json AGENTS.md
git commit -m "文档：同步实盘安全边界和部署要求"
```

### Task 8: 完整验证和原问题复现回归

**Files:**
- Modify only if a verification failure proves a defect in Task 1-7 files.

- [ ] **Step 1: 运行完整测试**

Run: `npm test`

Expected: 全部测试通过，0失败。

- [ ] **Step 2: 运行全量语法检查**

Run: `Get-ChildItem -Path src,test -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }`

Expected: exit 0，无语法错误。

- [ ] **Step 3: 运行生产依赖审计**

Run: `npm audit --omit=dev --json`

Expected: `metadata.vulnerabilities.total` 为 `0`。

- [ ] **Step 4: 重跑撤单失败原始复现**

Run: `node --test --test-name-pattern="cancelAll fails" test/bot.test.js`

Expected: 测试通过；撤单失败后交易所订单数、本地跟踪数和旧配置保持不变，不会从4单增长到8单。

- [ ] **Step 5: 验证未触碰密钥和工作区差异**

Run separately: `git status --short`, `git diff --check`, `git diff --stat main...HEAD`

Expected: 没有 `.env`、密钥或未计划文件；`git diff --check` exit 0。

- [ ] **Step 6: 按完成分支规范交付**

调用 `superpowers:verification-before-completion` 核实全部证据，再调用 `superpowers:finishing-a-development-branch` 提供合并、PR或保留分支选项。不得在验证失败时宣称可上实盘。
