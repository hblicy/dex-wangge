# 网格成交补单持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目禁止未经批准使用 Subagent，本计划必须在当前会话内执行。

**Goal:** 让 RISEx 的确定成交与 Decibel 一样在替代单确认后形成完整、可持久化的网格状态，不再因慢下单或同层并发静默掉单。

**Architecture:** 保持 `GridBot` 为唯一补单策略源，不在 RISEx 适配器复制网格算法。成交事件进入单一 Promise 队列，删除成交单、等待相邻层替代单、记录结果并持久化为一个有序流程；同层在途请求等待后重新判断，冲突必须可见。

**Tech Stack:** Node.js 20、ES modules、`node:test`、EventEmitter、现有 GridBot/IExchange 接口。

---

### Task 1: 复现慢补单持久化缺口

**Files:**
- Modify: `test/bot.test.js`

- [ ] **Step 1: 写失败测试**

新增测试：启动四格网格后暂停一次替代单的 `placeLimitOrder()`，发出确定成交；在放行前，最后持久化快照仍应是成交前的 4 单，放行后应保存包含新订单的 4 单快照。

```js
test('fill persistence waits for the confirmed replacement order', async () => {
  const snapshots = [];
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange, { onChange: (snapshot) => snapshots.push(snapshot) });
  await bot.start(config);
  const [orderId, order] = [...bot.active].find(([, item]) => item.levelIndex > 0);
  exchange.orders.delete(orderId);
  const original = exchange.placeLimitOrder.bind(exchange);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  exchange.placeLimitOrder = async (next) => { await gate; return original(next); };

  exchange.emit('fill', { orderId, marketId: 1, side: order.side, price: order.price,
    sizeBase: order.sizeBase, levelIndex: order.levelIndex });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshots.at(-1).active.length, 4);

  release();
  await bot._fillQueue;
  assert.equal(snapshots.at(-1).active.length, 4);
  bot._stopReconcileTimer();
});
```

- [ ] **Step 2: 运行测试并确认旧实现失败**

Run: `node --test --test-name-pattern="fill persistence waits" test/bot.test.js`

Expected: FAIL，因为旧实现会立即持久化 3 单，且不存在 `waitForFillProcessing()`。

### Task 2: 串行等待成交补单

**Files:**
- Modify: `src/bot.js:12-54`
- Modify: `src/bot.js:507-611`
- Test: `test/bot.test.js`

- [ ] **Step 1: 实现成交 Promise 队列**

构造函数增加 `_fillQueue = Promise.resolve()`；事件监听器只负责追加任务并捕获错误：

```js
this._fillQueue = Promise.resolve();
this._onFill = (fill) => {
  this._fillQueue = this._fillQueue
    .then(() => this._handleFill(fill))
    .catch((error) => this._handleExError(error));
};
```

- [ ] **Step 2: 让成交处理等待替代单**

把 `_handleFill` 改为 `async`，对替代单使用 `await this._place(repl)`，最后再 `_changed()`。记录不含敏感字段的处理日志：

```js
const startedAt = Date.now();
const result = await this._place(repl);
console.log(`[网格补单] order=${id} level=${levelIndex} -> level=${repl.levelIndex} result=${result.status} elapsed=${Date.now() - startedAt}ms`);
```

- [ ] **Step 3: 运行目标测试**

Run: `node --test --test-name-pattern="fill persistence waits" test/bot.test.js`

Expected: PASS。

### Task 3: 消除同层在途静默丢单

**Files:**
- Modify: `src/bot.js:31`
- Modify: `src/bot.js:507-546`
- Modify: `test/bot.test.js`

- [ ] **Step 1: 写同层等待失败测试**

新增测试：两个等价 `_place()` 同时请求同一层，第一个被交易所门闩暂停；第二个不得立即返回失败，放行后应返回 `covered`，交易所只能收到一次下单。

```js
test('same-level placement waits for the in-flight equivalent order', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  bot.config = { ...config };
  bot.running = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = exchange.placeLimitOrder.bind(exchange);
  exchange.placeLimitOrder = async (order) => { await gate; return original(order); };
  const intent = { levelIndex: 2, side: 'sell', price: 100, sizeBase: 1, opening: false };

  const first = bot._place(intent);
  const second = bot._place(intent);
  let secondDone = false;
  second.then(() => { secondDone = true; });
  await Promise.resolve();
  assert.equal(secondDone, false);
  release();

  assert.equal((await first).status, 'placed');
  assert.equal((await second).status, 'covered');
  assert.equal(exchange.orders.size, 1);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --test --test-name-pattern="same-level placement waits" test/bot.test.js`

Expected: FAIL，因为旧 `_pendingLevels` 是 `Set`，第二次请求会立即返回 `false`。

- [ ] **Step 3: 用在途 Promise 和结构化结果实现最小修复**

把 `_pendingLevels` 改为 `Map<levelIndex, Promise>`。存在在途请求时等待完成，再检查 `active`：

```js
const pending = this._pendingLevels.get(lvl);
if (pending) await pending;
const occupied = [...this.active.values()].find((item) => item.levelIndex === lvl);
if (occupied) {
  const equivalent = occupied.side === o.side
    && occupied.price === o.price
    && (occupied.sizeBase ?? this.config.sizeBase) === sizeBase
    && occupied.opening === opening;
  return equivalent
    ? { status: 'covered' }
    : { status: 'blocked', reason: `level ${lvl} 被不等价订单占用` };
}
```

新请求返回 `{ status: 'placed', orderId }` 或 `{ status: 'failed', reason }`；所有旧调用方只把 `status === 'placed'` 计为新下单成功。

- [ ] **Step 4: 运行两个目标测试**

Run: `node --test --test-name-pattern="fill persistence waits|same-level placement waits" test/bot.test.js`

Expected: 2 PASS。

### Task 4: 验证撤单语义和完整回归

**Files:**
- Modify: `test/bot.test.js`
- Modify: `AGENTS.md`（仅补充成交补单不按目标数量盲目重建的约束）

- [ ] **Step 1: 保留批量撤单不补单回归**

现有 `bulk-cancel fill is accounted but never re-quoted` 必须继续通过；测试中等待 `bot._fillQueue`，确保断言覆盖异步队列完成后的最终状态，不增加仅供测试使用的生产接口。

- [ ] **Step 2: 更新项目事实文档**

在 `AGENTS.md` 记录：网格补单只允许由确定终态成交产生的替代意图驱动；对账不得按配置数量盲目开仓；成交队列完成后才持久化最终活动订单。

- [ ] **Step 3: 运行 bot 测试**

Run: `node --test test/bot.test.js`

Expected: 全部 PASS，0 FAIL。

- [ ] **Step 4: 运行完整测试**

Run: `npm test`

Expected: 全部 PASS，0 FAIL。

- [ ] **Step 5: 运行构建/语法检查**

Run: `node --check src/bot.js`

Expected: exit 0。

- [ ] **Step 6: 检查差异**

Run: `git diff --check` 与 `git status --short`

Expected: 无空白错误，只有本计划范围内文件发生变化。
