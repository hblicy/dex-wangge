# PopDEX Stage 7 Stop Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `popdex:grid-probe` 的 `stop` 明确显示停止阶段、成功或失败结果，并拒绝并发控制命令。

**Architecture:** 只在 `grid-probe.js` 的会话控制层增加一个进程内命令锁和停止阶段日志。所有交易写入仍由现有 `GridBot`、`PopdexExchange`、operation journal 和严格对账器负责；日志层不改变任何成功判定、重试或恢复文件清理条件。

**Tech Stack:** Node.js ESM、`node:test`、现有 PopDEX Stage 7 CLI 和严格 `IExchange` 适配器。

---

### Task 1: 停止阶段日志和失败定位

**Files:**
- Modify: `test/popdex-grid-probe.test.js:242-297`
- Modify: `src/exchange/px/grid-probe.js:450-491`

- [ ] **Step 1: 写成功停止阶段日志的失败测试**

在现有 `mainnet probe handles one fill, offline resume, reconnect and verified stop` 测试中保存输出，并在停止后断言固定顺序：

```js
const output = [];
const common = {
  env: { POPDEX_AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}` },
  deps: {
    preflight: fakePreflight(),
    createLiveExchange: () => adapter,
    interactive: false,
    files,
    now: () => 1787119200000,
    output(message) { output.push(String(message)); },
  },
};

// ...保留现有成交、恢复和 reconnect 断言...

const stopped = await resumed.session.executeCommand('stop');
assert.deepEqual(stopped, { status: 'stopped-flat' });
assert.deepEqual(output.slice(-7), [
  '[PopDEX stop] 开始：活动挂单=1，持仓=有。',
  '[PopDEX stop] 正在撤销挂单并确认终态/平仓。',
  '[PopDEX stop] 撤单与持仓处理完成。',
  '[PopDEX stop] 正在执行最终订单/仓位对账。',
  '[PopDEX stop] 最终对账完成：活动挂单=0，pending=0，持仓=无。',
  '[PopDEX stop] 正在清理本地恢复文件。',
  '[PopDEX stop] 已安全停止：本地恢复文件已清理，耗时=0ms。',
]);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test test/popdex-grid-probe.test.js
```

Expected: FAIL；`output.slice(-7)` 为空或不包含 `[PopDEX stop]` 阶段日志。

- [ ] **Step 3: 写最终对账失败的测试**

新增测试，先启动会话，再让最终对账返回 `RECONCILING`：

```js
test('stop reports its failing stage and retains recovery files', async (t) => {
  const files = temporaryFiles(t);
  const adapter = new FakeStrictAdapter();
  const output = [];
  const started = await runGridProbe({
    argv: ['--confirm-mainnet-grid'],
    env: { POPDEX_AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}` },
    deps: {
      preflight: fakePreflight(),
      createLiveExchange: () => adapter,
      interactive: false,
      files,
      now: () => 1787119200000,
      output(message) { output.push(String(message)); },
    },
  });
  adapter.reconcileStatus = 'RECONCILING';

  await assert.rejects(
    started.session.executeCommand('stop'),
    /stop 后订单终态仍为 RECONCILING/,
  );
  assert.ok(output.includes('[PopDEX stop] 失败：阶段=最终对账，耗时=0ms。'));
  assert.equal(output.some((line) => line.includes('已安全停止')), false);
  assert.equal(fs.existsSync(files.state), true);
});
```

- [ ] **Step 4: 运行测试并确认第二个 RED**

Run:

```bash
node --test test/popdex-grid-probe.test.js
```

Expected: FAIL；缺少 `失败：阶段=最终对账` 日志。

- [ ] **Step 5: 实现最小停止阶段日志**

在 `createSession` 中复用现有 `output`，将 `stop` 分支改为带阶段和耗时的原逻辑包装：

```js
if (command === 'stop') {
  const stopStartedAt = now();
  let stopStage = '撤单与持仓处理';
  const elapsed = () => Math.max(0, now() - stopStartedAt);
  output(
    `[PopDEX stop] 开始：活动挂单=${exchange.getOpenOrders(20000).length}，`
    + `持仓=${exchange.getPosition(20000) === null ? '无' : '有'}。`,
  );
  try {
    output('[PopDEX stop] 正在撤销挂单并确认终态/平仓。');
    await bot.stop({ closePosition: exchange.getPosition(20000) !== null });
    output('[PopDEX stop] 撤单与持仓处理完成。');

    stopStage = '最终对账';
    output('[PopDEX stop] 正在执行最终订单/仓位对账。');
    const reconciled = await exchange.reconcileOwnedOrders({
      marketId: 20000,
      reason: 'probe-stop-final',
      suppressRequote: true,
    });
    if (reconciled.status !== 'READY') {
      throw new Error(`PopDEX grid-probe stop 后订单终态仍为 ${String(reconciled.status)}。`);
    }
    const pending = exchange.pendingFillEvents();
    const position = exchange.getPosition(20000);
    output(
      `[PopDEX stop] 最终对账完成：活动挂单=${reconciled.activeOrders.length}，`
      + `pending=${pending.length}，持仓=${position === null ? '无' : '有'}。`,
    );
    if (reconciled.activeOrders.length !== 0 || pending.length !== 0 || position !== null) {
      throw new Error('PopDEX grid-probe stop 后未确认 0 挂单、0 pending event、0 持仓。');
    }

    stopStage = '本地清理';
    output('[PopDEX stop] 正在清理本地恢复文件。');
    exchange.stop();
    removeCompletedFiles(files, fsImpl);
    releaseLock();
    closed = true;
    output(`[PopDEX stop] 已安全停止：本地恢复文件已清理，耗时=${elapsed()}ms。`);
    return { status: 'stopped-flat' };
  } catch (error) {
    output(`[PopDEX stop] 失败：阶段=${stopStage}，耗时=${elapsed()}ms。`);
    throw error;
  }
}
```

- [ ] **Step 6: 运行 Stage 7 测试并确认 GREEN**

Run:

```bash
node --test test/popdex-grid-probe.test.js
```

Expected: PASS；停止成功和最终对账失败测试均通过。

- [ ] **Step 7: 提交停止阶段日志**

```bash
git add src/exchange/px/grid-probe.js test/popdex-grid-probe.test.js
git commit -m "改进：显示PopDEX停止阶段"
```

### Task 2: 控制命令串行化和交互式成功输出

**Files:**
- Modify: `test/popdex-grid-probe.test.js`
- Modify: `src/exchange/px/grid-probe.js:450-509`

- [ ] **Step 1: 写并发控制命令的失败测试**

新增可控的撤单闸门，并确认第二条命令立即失败且不会重复撤单：

```js
test('a running stop rejects concurrent control commands without another cancel', async (t) => {
  const files = temporaryFiles(t);
  const adapter = new FakeStrictAdapter();
  let releaseCancel;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  const originalCancelAll = adapter.cancelAll.bind(adapter);
  adapter.cancelAll = async () => {
    await cancelGate;
    return originalCancelAll();
  };
  const started = await runGridProbe({
    argv: ['--confirm-mainnet-grid'],
    env: { POPDEX_AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}` },
    deps: {
      preflight: fakePreflight(),
      createLiveExchange: () => adapter,
      interactive: false,
      files,
      output() {},
    },
  });

  const stopping = started.session.executeCommand('stop');
  await assert.rejects(
    started.session.executeCommand('status'),
    /控制命令 stop 正在执行/,
  );
  releaseCancel();
  await stopping;
  assert.equal(adapter.cancelCalls, 1);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test test/popdex-grid-probe.test.js
```

Expected: FAIL；当前 `status` 会与 `stop` 并发执行，而不是被拒绝。

- [ ] **Step 3: 实现会话级命令锁**

保留 Task 1 已验证的 `session.executeCommand` 原实现，在 `session` 对象创建后、`return session` 前，用唯一入口包装它。这样不会复制或改写命令分支，只负责拒绝并发命令：

```js
let activeCommand = null;
const executeCommandUnlocked = session.executeCommand.bind(session);
session.executeCommand = async (command) => {
  if (activeCommand !== null) {
    throw new Error(`PopDEX 控制命令 ${activeCommand} 正在执行，请等待完成。`);
  }
  activeCommand = command;
  try {
    return await executeCommandUnlocked(command);
  } finally {
    activeCommand = null;
  }
};
```

`closed` 检查、`status`、`reconnect`、`stop`、未知命令和 `signalExit` 的现有实现保持不变；包装器只增加进程内互斥，不排队、不重试、不触发第二次交易写入。

- [ ] **Step 4: 写交互式停止输出的失败测试**

在测试顶部加入 `PassThrough`，新增交互测试：

```js
import { PassThrough } from 'node:stream';

test('interactive probe prints the final safe-stop result and exits', async (t) => {
  const files = temporaryFiles(t);
  const adapter = new FakeStrictAdapter();
  const stdin = new PassThrough();
  const output = [];
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const running = runGridProbe({
    argv: ['--confirm-mainnet-grid'],
    env: { POPDEX_AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}` },
    deps: {
      preflight: fakePreflight(),
      createLiveExchange: () => adapter,
      files,
      stdin,
      now: () => 1787119200000,
      output(message) {
        const line = String(message);
        output.push(line);
        if (line.includes('控制命令')) ready();
      },
    },
  });
  await started;
  stdin.write('stop\n');

  const result = await running;
  assert.equal(result.mode, 'stopped');
  assert.ok(output.includes(
    '[PopDEX stop] 已安全停止：本地恢复文件已清理，耗时=0ms。',
  ));
});
```

- [ ] **Step 5: 运行测试并确认行为**

Run:

```bash
node --test test/popdex-grid-probe.test.js
```

Expected: 并发命令测试和交互式成功输出测试 PASS。

- [ ] **Step 6: 提交控制命令串行化**

```bash
git add src/exchange/px/grid-probe.js test/popdex-grid-probe.test.js
git commit -m "修复：串行执行PopDEX控制命令"
```

### Task 3: 文档同步和全量回归

**Files:**
- Modify: `AGENTS.md:9-15`
- Modify: `docs/protocol/popdex-mainnet-validation.md:136-170`

- [ ] **Step 1: 更新单一事实来源**

在 `AGENTS.md` 的 Stage 7 约束中追加：

```markdown
- PopDEX Stage 7 交互控制命令必须串行执行；`stop` 必须输出撤单/平仓、最终对账和本地清理阶段，只有确认 `READY`、零活动订单、零 pending 成交事件、BTCUSDT 空仓且恢复文件清理成功后才能输出安全停止。失败日志必须标明阶段并保留原错误和恢复事实。
```

在 `docs/protocol/popdex-mainnet-validation.md` 的 Stage 7 章节说明相同的操作员可见阶段、并发命令拒绝和最终成功条件。

- [ ] **Step 2: 运行格式检查和定向测试**

Run:

```bash
git diff --check
node --test test/popdex-grid-probe.test.js
```

Expected: `git diff --check` 无输出；Stage 7 测试全部 PASS。

- [ ] **Step 3: 运行全量回归**

Run:

```bash
npm test
```

Expected: 所有测试 PASS，fail=0；Decibel、RISEx、PopDEX 和安全测试无回归。

- [ ] **Step 4: 提交文档和验证结果对应改动**

```bash
git add AGENTS.md docs/protocol/popdex-mainnet-validation.md
git commit -m "文档：记录PopDEX停止可观测性"
```

- [ ] **Step 5: 最终核对提交范围**

Run:

```bash
git status -sb
git log --oneline --decorate -4
```

Expected: 工作树干净；只有设计、停止可观测性、命令串行化和对应文档提交。
