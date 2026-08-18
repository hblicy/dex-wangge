# Decibel Cancel Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Decibel 因索引延迟导致的本地跟踪提前清除和同一订单重复撤单问题。

**Architecture:** Decibel 适配器只负责提交撤单并保留本地订单，GridBot 在需要清空市场时用连续有效快照确认远端订单消失。周期对账用独立的撤单中集合记录已提交的重复单撤单，直到连续快照确认消失，避免再次收费。

**Tech Stack:** Node.js 20、ES modules、`node:test`、`@decibeltrade/sdk`

---

### Task 1: 修正 Decibel 适配器撤单语义

**Files:**
- Modify: `src/exchange/de/decibel.js:353-417`
- Test: `test/exchange-adapters.test.js`

- [ ] **Step 1: 写入失败测试**

在 `test/exchange-adapters.test.js` 增加以下测试：

```js
test('Decibel keeps accepted cancellations tracked until explicitly forgotten', async () => {
  const exchange = new DecibelExchange({ apiKey: 'x', privateKey: '1' });
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD', addr: '0xbtc' });
  exchange._tracked.set('order-1', { marketId: 1 });
  exchange.write = { cancelOrder: async () => ({ hash: '0x1' }) };

  assert.equal(await exchange.cancelOrder(1, 'order-1'), true);
  assert.equal(exchange._tracked.has('order-1'), true);
  exchange.forgetOrder('order-1');
  assert.equal(exchange._tracked.has('order-1'), false);
});

test('Decibel cancelAll ignores tracked orders missing from one valid snapshot', async () => {
  const exchange = new DecibelExchange({ apiKey: 'x', privateKey: '1' });
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD', addr: '0xbtc' });
  exchange._tracked.set('order-1', { marketId: 1 });
  exchange._tracked.set('order-2', { marketId: 1 });
  exchange._openOrders = async () => [{ order_id: 'order-1', market: 'BTC-USD', is_tpsl: false }];
  const cancelled = [];
  exchange.write = { cancelOrder: async ({ orderId }) => { cancelled.push(orderId); } };

  assert.equal(await exchange.cancelAll(1), true);
  assert.deepEqual(cancelled, ['order-1']);
  assert.deepEqual([...exchange._tracked.keys()], ['order-1', 'order-2']);
});

test('Decibel cancelAll rejects a malformed open-order snapshot', async () => {
  const exchange = new DecibelExchange({ apiKey: 'x', privateKey: '1' });
  exchange.on('error', () => {});
  exchange.markets.set(1, { marketId: 1, name: 'BTC-USD', addr: '0xbtc' });
  exchange._openOrders = async () => null;
  let writes = 0;
  exchange.write = { cancelOrder: async () => { writes++; } };

  assert.equal(await exchange.cancelAll(1), false);
  assert.equal(writes, 0);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/exchange-adapters.test.js`

Expected: 新增测试因成功撤单后 `_tracked` 被立即删除、缺失本地订单导致 `cancelAll=false`、缺少 `forgetOrder` 而失败。

- [ ] **Step 3: 实现最小适配器修复**

将 Decibel 撤单代码调整为：

```js
async cancelOrder(marketId, orderId) {
  const m = this._market(marketId);
  await this.write.cancelOrder({
    orderId: String(orderId), marketName: m.name, subaccountAddr: this.subaccount,
  });
  return true;
}

async cancelAll(marketId) {
  const m = this._market(marketId);
  try {
    const open = await this._openOrders();
    if (!Array.isArray(open)) throw new Error('Decibel 挂单查询返回了无效响应。');
    const failures = [];
    for (const o of open) {
      if (String(o.market) !== m.addr && String(o.market) !== m.name) continue;
      if (o.is_tpsl) continue;
      try {
        await this.write.cancelOrder({
          orderId: String(o.order_id), marketName: m.name, subaccountAddr: this.subaccount,
        });
      } catch (error) {
        failures.push(error);
        this.emit('error', error);
      }
    }
    if (failures.length) return false;
    return true;
  } catch (error) {
    this.emit('error', error);
    return false;
  }
}

forgetOrder(orderId) { this._tracked.delete(String(orderId)); }
forgetOrders(marketId) {
  const target = Number(marketId);
  for (const [id, order] of this._tracked) {
    if (order.marketId === target) this._tracked.delete(id);
  }
}
```

同时让 `_openOrders()` 对未知结构返回 `null`，并让 `fetchOpenOrders()` 在非数组时抛出明确错误。

- [ ] **Step 4: 运行适配器测试并确认通过**

Run: `node --test test/exchange-adapters.test.js`

Expected: 所有测试通过。

- [ ] **Step 5: 提交适配器修复**

```bash
git add src/exchange/de/decibel.js test/exchange-adapters.test.js
git commit -m "修复：保留 Decibel 已提交撤单的本地跟踪"
```

### Task 2: 为 Decibel 批量撤单增加连续快照确认

**Files:**
- Modify: `src/exchange/de/decibel.js`
- Modify: `src/bot.js:13-70,285-295`
- Modify: `test/helpers/fake-exchange.js`
- Test: `test/bot.test.js`

- [ ] **Step 1: 写入失败测试**

在 `test/bot.test.js` 增加一个启用 `requiresCancelConfirmation` 的 FakeExchange，覆盖：

```js
test('Decibel cancellation requires two consecutive valid empty snapshots', async () => {
  const live = [{ orderId: '1', price: 95, side: 'buy' }];
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  exchange.cancelAll = async () => true;
  const snapshots = [[], live, [], []];
  exchange.fetchOpenOrders = async () => snapshots.shift();
  let forgot = 0;
  exchange.forgetOrders = () => { forgot++; };
  const bot = new GridBot(exchange, {
    cancelVerifyAttempts: 4, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2,
  });

  await bot._requireCancelAll(1, '测试');
  assert.equal(snapshots.length, 0);
  assert.equal(forgot, 1);
});

test('Decibel cancellation keeps state when snapshots are malformed', async () => {
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  exchange.cancelAll = async () => true;
  exchange.fetchOpenOrders = async () => null;
  const bot = new GridBot(exchange, {
    cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2,
  });

  await assert.rejects(bot._requireCancelAll(1, '测试'), /无法从交易所读取挂单快照/);
});
```

再增加待决下单和失败后禁止平仓测试：

```js
test('Decibel cancellation waits for pending placements before cancelAll', async () => {
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  let cancelCalls = 0;
  exchange.cancelAll = async () => { cancelCalls++; exchange.orders.clear(); return true; };
  const bot = new GridBot(exchange, {
    cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2,
  });
  let release;
  const placement = new Promise((resolve) => { release = resolve; });
  bot._pendingLevels.set(2, placement);
  const cancelling = bot._requireCancelAll(1, '测试');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 0);
  bot._pendingLevels.delete(2);
  release();
  await cancelling;
  assert.equal(cancelCalls, 1);
});

test('Decibel stop never closes a position when cancellation confirmation fails', async () => {
  const live = [{ orderId: '1', price: 95, side: 'buy' }];
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  exchange.cancelAll = async () => true;
  exchange.fetchOpenOrders = async () => live;
  let closeCalls = 0;
  exchange.closePosition = async () => { closeCalls++; return true; };
  const bot = new GridBot(exchange, {
    cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2,
  });
  bot.running = true;
  bot.config = { ...config };
  bot.active.set('1', { levelIndex: 1, side: 'buy', price: 95, placedAt: 1 });

  await assert.rejects(bot.stop({ closePosition: true }), /撤单未完成确认/);
  assert.equal(bot.running, true);
  assert.equal(bot.active.size, 1);
  assert.equal(closeCalls, 0);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/bot.test.js`

Expected: `_requireCancelAll` 只接受一次 `cancelAll=true`，没有连续快照确认和待决下单等待，因此新增断言失败。

- [ ] **Step 3: 实现连续确认和等待逻辑**

在构造器保存可注入的有界确认参数：

```js
this._cancelVerifyAttempts = opts.cancelVerifyAttempts ?? 12;
this._cancelVerifyDelayMs = opts.cancelVerifyDelayMs ?? 750;
this._cancelVerifyStableReads = opts.cancelVerifyStableReads ?? 2;
this._pendingCancelOrders = new Map();
```

新增 `_waitForPendingPlacements()` 和 `_confirmOrdersGone()`。后者只接受数组快照，
目标订单连续消失达到 `_cancelVerifyStableReads` 才返回；查询异常或非数组会重置
连续计数，最终抛出包含最后错误或剩余订单数的错误。

将 `_requireCancelAll()` 调整为：等待恢复下单和 `_pendingLevels`；调用
`cancelAll()`；只在 `ex.requiresCancelConfirmation === true` 时执行连续快照确认；
确认后调用 `forgetOrders(marketId)` 并清理该市场的 `_pendingCancelOrders`。其他交易所
维持原有 `cancelAll` 合约，不改变 RISEx 和 PopDEX 行为。

在 `DecibelExchange` 构造器设置：

```js
this.requiresCancelConfirmation = true;
```

- [ ] **Step 4: 运行 Bot 和适配器测试并确认通过**

Run: `node --test test/bot.test.js test/exchange-adapters.test.js`

Expected: 所有测试通过，Decibel 走连续确认，FakeExchange 默认路径和其他适配器不变。

- [ ] **Step 5: 提交批量撤单确认修复**

```bash
git add src/exchange/de/decibel.js src/bot.js test/bot.test.js test/helpers/fake-exchange.js
git commit -m "修复：确认 Decibel 挂单消失后再清理状态"
```

### Task 3: 阻止周期对账重复发送同一撤单

**Files:**
- Modify: `src/bot.js:973-1069`
- Test: `test/bot.test.js`

- [ ] **Step 1: 写入失败测试**

构造同一格两笔真实订单，模拟 Decibel 接受撤单后索引仍连续返回旧订单：

```js
test('reconcile does not resend an accepted duplicate cancellation', async () => {
  const exchange = new FakeExchange();
  exchange.requiresCancelConfirmation = true;
  exchange.orders = new Map([
    ['survivor', { price: 95, side: 'buy' }],
    ['duplicate', { price: 95, side: 'buy' }],
  ]);
  let cancelCalls = 0;
  exchange.cancelOrder = async () => { cancelCalls++; return true; };
  const forgotten = [];
  exchange.forgetOrder = (id) => forgotten.push(String(id));
  const bot = new GridBot(exchange);
  bot.running = true;
  bot.config = { ...config };
  bot.grid = { levels: [90, 95, 100, 105], spacing: 5, count: 4 };

  await bot.reconcileOpenOrders();
  await bot.reconcileOpenOrders();
  assert.equal(cancelCalls, 1);

  exchange.orders.delete('duplicate');
  await bot.reconcileOpenOrders();
  await bot.reconcileOpenOrders();
  assert.deepEqual(forgotten, ['duplicate']);
  assert.equal(bot._pendingCancelOrders.size, 0);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/bot.test.js --test-name-pattern="reconcile does not resend"`

Expected: 当前每轮对账都调用 `cancelOrder`，`cancelCalls` 为 2。

- [ ] **Step 3: 实现撤单中状态机**

在 `reconcileOpenOrders()` 取得 `realIds` 后，先更新 `_pendingCancelOrders`：目标仍在
快照中时把 `goneRecon` 归零；目标缺失时累加；连续两次缺失后调用
`ex.forgetOrder(id)`，删除 `active` 和撤单中记录。

遍历真实订单时先跳过 `_pendingCancelOrders` 中的订单，确保它不会成为该价格层的
保留单，也不会再次调用 `cancelOrder()`。新发现的重复单撤单被接受后写入：

```js
this._pendingCancelOrders.set(id, {
  marketId: this.config.marketId,
  requestedAt: now,
  goneRecon: 0,
});
```

不再在 `cancelOrder() === true` 后立即 `active.delete(id)`。通过 `_alert()` 记录撤单
请求已接受和连续快照确认完成；失败继续交给 `_handleExError()`，且不创建撤单中记录。

- [ ] **Step 4: 运行定向测试并确认通过**

Run: `node --test test/bot.test.js test/exchange-adapters.test.js`

Expected: 所有测试通过；索引延迟期间同一订单只发一笔撤单。

- [ ] **Step 5: 提交对账去重修复**

```bash
git add src/bot.js test/bot.test.js
git commit -m "修复：避免 Decibel 对账重复发送撤单"
```

### Task 4: 完整回归与变更审查

**Files:**
- Review: `src/exchange/de/decibel.js`
- Review: `src/bot.js`
- Review: `test/exchange-adapters.test.js`
- Review: `test/bot.test.js`

- [ ] **Step 1: 运行 Decibel 与 Bot 定向测试**

Run: `node --test test/exchange-adapters.test.js test/bot.test.js`

Expected: 全部通过，无未处理 Promise 或 EventEmitter 错误。

- [ ] **Step 2: 运行项目完整测试**

Run: `npm test`

Expected: 完整测试退出码 0，RISEx 和 PopDEX 专项测试保持通过。

- [ ] **Step 3: 检查改动范围**

Run: `git diff origin/main...HEAD -- src/exchange/de/decibel.js src/bot.js test/exchange-adapters.test.js test/bot.test.js docs/superpowers`

Expected: 只有设计、计划、Decibel 撤单语义、Bot 撤单确认及对应测试变化；没有密钥、`.env` 或无关文件。

- [ ] **Step 4: 检查工作区**

Run: `git status --short --branch`

Expected: 工作区干净，分支为 `codex/fix-decibel-cancel-confirmation`。
