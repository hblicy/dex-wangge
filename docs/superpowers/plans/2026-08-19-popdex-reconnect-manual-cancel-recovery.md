# PopDEX 重连失败清理与运行中零成交人工撤单恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PopDEX grid-probe 在重连失败后可靠退出，并安全归档“运行中唯一零成交订单已在网页人工撤销”的精确恢复现场。

**Architecture:** 保留现有严格 reconciler，不改变 REST/RPC 信任边界。`createSession()` 新增唯一、幂等的控制命令失败关闭原语；人工撤单验证器增加第二种严格状态形态，并在官方挂单、持仓和成交全部为零时原子归档本地事实。

**Tech Stack:** Node.js ESM、`node:test`、`node:assert/strict`、现有 `GridBot`、`PopdexOwnershipStore`、原子 JSON/文件归档工具。

---

## 文件结构

- 修改：`src/exchange/px/grid-probe.js`
  - 统一控制命令失败后的会话资源清理。
  - 扩展人工撤单恢复形态和错误信息。
  - 输出人工撤单恢复形态。
- 修改：`test/popdex-grid-probe.test.js`
  - 复现重连失败进程不退出。
  - 复现 VPS 的 `running=true + active=1 + ownership OPEN` 零成交现场。
  - 覆盖严格拒绝、原子回滚和缺失状态错误。
- 参考：`docs/superpowers/specs/2026-08-19-popdex-reconnect-manual-cancel-recovery-design.md`
  - 本计划的安全边界和验收来源。

不新增依赖，不拆分现有文件，不修改通用 `GridBot`、reconciler、Decibel 或 RISEx。

### Task 1: 统一控制命令失败后的会话关闭

**Files:**
- Modify: `test/popdex-grid-probe.test.js:38-120,699-790`
- Modify: `src/exchange/px/grid-probe.js:533-708,758-784`

- [ ] **Step 1: 扩展 FakeStrictAdapter 以注入重连失败**

在 `FakeStrictAdapter` 构造函数中加入：

```js
this.reconnectFailure = null;
```

把 `reconnect()` 改为：

```js
async reconnect() {
  if (this.reconnectFailure !== null) throw this.reconnectFailure;
  this.reconcileFailure = null;
  return this.reconcileOwnedOrders();
}
```

- [ ] **Step 2: 写重连失败后资源必须释放的失败测试**

在 `test/popdex-grid-probe.test.js` 增加：

```js
test('reconnect failure closes refresh releases lock and preserves recovery facts', async (t) => {
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
      output(message) { output.push(String(message)); },
    },
  });
  adapter.reconnectFailure = new Error(
    'PopDEX POPDEX_UNKNOWN_TERMINAL：orderId=246940766838980608 对账超过 30000ms 仍无法闭合。',
  );

  await assert.rejects(
    started.session.executeCommand('reconnect'),
    /POPDEX_UNKNOWN_TERMINAL/,
  );
  assert.equal(adapter.stopCalls, 1);
  assert.equal(fs.existsSync(files.lock), false);
  assert.equal(fs.existsSync(files.state), true);
  assert.equal(fs.existsSync(files.ownership), true);
  await assert.rejects(started.session.executeCommand('status'), /会话已结束/);
  assert.ok(output.includes(
    '[PopDEX reconnect] 失败后已关闭交易所刷新并释放进程锁；恢复事实已保留。',
  ));
});
```

- [ ] **Step 3: 运行测试确认 RED**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: FAIL；`adapter.stopCalls` 为 `0`，证明现有重连错误没有调用会话清理。

- [ ] **Step 4: 在 createSession 中实现幂等失败关闭原语**

在 `let closed = false` 后定义：

```js
const closeAfterControlFailure = (command, error) => {
  if (closed) return error;
  const cleanupErrors = [];
  try {
    exchange.stop();
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  try {
    releaseLock();
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  closed = true;
  if (cleanupErrors.length === 0) {
    output(
      `[PopDEX ${command}] 失败后已关闭交易所刷新并释放进程锁；恢复事实已保留。`,
    );
    return error;
  }
  return new AggregateError(
    [error, ...cleanupErrors],
    `PopDEX 控制命令 ${command} 失败，且会话资源清理失败。`,
  );
};
```

保留并复用同一个 `output`，不得删除 state、ownership 或 operation。

- [ ] **Step 5: 让命令串行包装器统一调用关闭原语**

把命令包装器改为：

```js
session.executeCommand = async (command) => {
  if (activeCommand !== null) {
    throw new Error(`PopDEX 控制命令 ${activeCommand} 正在执行，请等待完成。`);
  }
  activeCommand = command;
  try {
    return await executeCommandUnlocked(command);
  } catch (error) {
    throw closeAfterControlFailure(command, error);
  } finally {
    activeCommand = null;
  }
};
```

并把 `stop` 内部重复的 `exchange.stop()`、`releaseLock()`、`closed=true` 失败清理收敛到 `closeAfterControlFailure('stop', error)`。成功 stop 仍清理恢复文件；失败 stop 仍保留恢复文件。

并发命令检查必须保持在 `try` 之外，避免第二个并发命令错误关闭正在执行的 stop。

- [ ] **Step 6: 增加清理自身失败测试**

使用会抛错的 `adapter.stop` 和会在 unlink lock 时抛错的 fs mock，断言：

```js
await assert.rejects(
  started.session.executeCommand('reconnect'),
  (error) => error instanceof AggregateError
    && error.errors.some((item) => /POPDEX_UNKNOWN_TERMINAL/.test(item.message))
    && error.errors.some((item) => /cleanup failed/.test(item.message)),
);
```

Expected: 原始重连错误与所有清理错误都存在，不被覆盖。

- [ ] **Step 7: 运行聚焦测试确认 GREEN**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: 全部通过；现有 stop 失败、并发命令和交互退出测试继续通过。

- [ ] **Step 8: 提交会话生命周期修复**

```powershell
git add src/exchange/px/grid-probe.js test/popdex-grid-probe.test.js
git commit -m "修复：重连失败后关闭PopDEX验收会话"
```

### Task 2: 支持运行中零成交订单的精确人工撤单恢复

**Files:**
- Modify: `test/popdex-grid-probe.test.js:151-186,350-430`
- Modify: `src/exchange/px/grid-probe.js:346-416,793-805`

- [ ] **Step 1: 写入与 VPS 完全同形的测试夹具**

在旧 `writeManualCancelIncident` 旁增加：

```js
function writeRunningManualCancelIncident(
  files,
  orderId = '246940766838980608',
  state = 'OPEN',
) {
  const mainAccount = '0x1111111111111111111111111111111111111111';
  const clientOrderId = `0x${'24'.repeat(32)}`;
  fs.writeFileSync(files.state, JSON.stringify({
    version: 1,
    mainAccount,
    snapshot: {
      running: true,
      active: [[orderId, {
        levelIndex: 0,
        side: 'buy',
        price: 64435,
        sizeBase: 0.0002,
        clientOrderId,
        reduceOnly: false,
        opening: true,
        recovery: false,
        parentFillEventId: null,
        placedAt: 1787143463083,
      }]],
      processedFillEventIds: [],
    },
    updatedAt: '2026-08-19T12:44:23.083Z',
  }), { mode: 0o600 });
  fs.writeFileSync(files.ownership, JSON.stringify({
    version: 1,
    mainAccount,
    symbol: 'BTCUSDT',
    symbolId: '20000',
    orders: [{
      orderId,
      clientOrderId,
      marketId: 20000,
      levelIndex: 0,
      side: 'buy',
      priceWad: '64435000000000000000000',
      qtyWad: '200000000000000',
      opening: true,
      reduceOnly: false,
      parentFillEventId: null,
      state,
      filledQtyWad: '0',
      fillIds: [],
      terminalEvent: null,
      cancelProof: null,
    }],
    updatedAt: '2026-08-19T12:44:23.083Z',
  }), { mode: 0o600 });
}
```

- [ ] **Step 2: 写新形态成功恢复的失败测试**

```js
test('manual cancel recovery archives an aborted running zero-fill OPEN order', async (t) => {
  const files = temporaryFiles(t);
  const orderId = '246940766838980608';
  writeRunningManualCancelIncident(files, orderId, 'OPEN');

  const result = await runGridProbe({
    argv: ['--confirm-manual-cancel-order', orderId],
    deps: {
      preflight: fakePreflight(),
      files,
      now: () => Date.parse('2026-08-19T13:00:00.000Z'),
      processKill() { const error = new Error('missing'); error.code = 'ESRCH'; throw error; },
    },
  });

  assert.equal(result.mode, 'manual-cancel-recovered');
  assert.equal(result.recoveryShape, 'aborted-running-zero-fill-open');
  assert.equal(result.writes, 0);
  assert.equal(fs.existsSync(files.state), false);
  assert.equal(fs.existsSync(files.ownership), false);
  assert.equal(result.archivedFiles.length, 2);
});
```

再用 `state='UNKNOWN_TERMINAL'` 重复同一测试，预期 recovery shape 相同。

- [ ] **Step 3: 运行测试确认 RED**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: FAIL，错误匹配现有“只允许 stopped、0 active”限制。

- [ ] **Step 4: 重构 validateManualCancelState 判定两种形态**

读取 record 后先区分缺失与账户错误：

```js
if (record === null) {
  throw new Error('PopDEX grid-probe 没有可恢复的人工撤单状态。');
}
if (record.version !== 1
    || record.mainAccount?.toLowerCase() !== preflight.mainAccount.toLowerCase()) {
  throw new Error('PopDEX grid-probe 人工撤单恢复的状态文件版本或账户不匹配。');
}
```

加载唯一 owned order 后，用明确分支选择形态：

```js
const processed = record.snapshot?.processedFillEventIds;
const active = record.snapshot?.active;
let recoveryShape;
if (record.snapshot?.running === false
    && Array.isArray(active) && active.length === 0
    && Array.isArray(processed) && processed.length === 0
    && owned.state === 'UNKNOWN_TERMINAL') {
  recoveryShape = 'stopped-unknown-terminal';
} else if (record.snapshot?.running === true
    && Array.isArray(active) && active.length === 1
    && Array.isArray(processed) && processed.length === 0
    && ['OPEN', 'UNKNOWN_TERMINAL'].includes(owned.state)) {
  recoveryShape = 'aborted-running-zero-fill-open';
  validateRunningManualCancelActive(active[0], owned, orderId);
} else {
  throw new Error('PopDEX grid-probe 人工撤单恢复状态形态不受支持。');
}
```

增加局部验证函数，逐字段比较：

```js
function validateRunningManualCancelActive(activeEntry, owned, orderId) {
  if (!Array.isArray(activeEntry) || activeEntry.length !== 2) {
    throw new Error('PopDEX grid-probe 运行中人工撤单 active 条目格式无效。');
  }
  const [activeOrderId, metadata] = activeEntry;
  const priceWad = parseUnits(String(metadata?.price), 18).toString();
  const qtyWad = parseUnits(String(metadata?.sizeBase), 18).toString();
  if (String(activeOrderId) !== orderId
      || metadata?.clientOrderId?.toLowerCase() !== owned.clientOrderId
      || metadata?.levelIndex !== owned.levelIndex
      || metadata?.side !== owned.side
      || priceWad !== owned.priceWad
      || qtyWad !== owned.qtyWad
      || metadata?.opening !== owned.opening
      || metadata?.reduceOnly !== owned.reduceOnly
      || metadata?.recovery !== false
      || metadata?.parentFillEventId !== owned.parentFillEventId) {
    throw new Error('PopDEX grid-probe 运行中人工撤单活动订单身份与 ownership 不匹配。');
  }
}
```

共享零成交约束必须同时检查：

```js
if (owned.filledQtyWad !== '0'
    || owned.fillIds.length !== 0
    || owned.terminalEvent !== null
    || owned.cancelProof !== null) {
  throw new Error('PopDEX grid-probe 本地订单不是可人工确认的零成交状态。');
}
```

原有官方 0 open、0 chain active、0 position、目标订单无 fills 检查保持不变。函数返回 `{ owned, recoveryShape }`。

- [ ] **Step 5: 返回并输出 recoveryShape**

`recoverManualCancel` 保存验证结果：

```js
const validated = validateManualCancelState({
  files,
  fsImpl,
  preflight,
  orderId: args.manualCancelOrderId,
});
```

结果中加入：

```js
recoveryShape: validated.recoveryShape,
```

CLI 在成功行后输出：

```js
console.log(`恢复形态：${result.recoveryShape}。`);
```

- [ ] **Step 6: 运行聚焦测试确认 GREEN**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: 新旧人工撤单恢复测试全部通过。

- [ ] **Step 7: 提交新恢复形态**

```powershell
git add src/exchange/px/grid-probe.js test/popdex-grid-probe.test.js
git commit -m "修复：恢复PopDEX运行中人工撤单事实"
```

### Task 3: 补齐严格拒绝、回滚与准确错误

**Files:**
- Modify: `test/popdex-grid-probe.test.js:300-630`
- Modify: `src/exchange/px/grid-probe.js:346-531`

- [ ] **Step 1: 写身份冲突和风险事实的参数化失败测试**

基于 `writeRunningManualCancelIncident`，逐项修改并断言拒绝：

```js
for (const [label, mutate, expected] of [
  ['active order id', (state) => { state.snapshot.active[0][0] = '246940766838980609'; }, /身份.*不匹配/],
  ['client order id', (state) => { state.snapshot.active[0][1].clientOrderId = `0x${'99'.repeat(32)}`; }, /身份.*不匹配/],
  ['price', (state) => { state.snapshot.active[0][1].price = 64436; }, /身份.*不匹配/],
  ['quantity', (state) => { state.snapshot.active[0][1].sizeBase = 0.0001; }, /身份.*不匹配/],
  ['side', (state) => { state.snapshot.active[0][1].side = 'sell'; }, /身份.*不匹配/],
  ['processed fill', (state) => { state.snapshot.processedFillEventIds = [`px-fill-${'11'.repeat(32)}`]; }, /形态不受支持/],
]) {
  await t.test(label, async (t2) => {
    const files = temporaryFiles(t2);
    writeRunningManualCancelIncident(files);
    const state = JSON.parse(fs.readFileSync(files.state, 'utf8'));
    mutate(state);
    fs.writeFileSync(files.state, JSON.stringify(state), { mode: 0o600 });
    await assert.rejects(runGridProbe({
      argv: ['--confirm-manual-cancel-order', '246940766838980608'],
      deps: { preflight: fakePreflight(), files },
    }), expected);
    assert.equal(fs.existsSync(files.state), true);
    assert.equal(fs.existsSync(files.ownership), true);
  });
}
```

另写 ownership 参数表覆盖 `PARTIAL`、非零 `filledQtyWad`、非空 fill IDs、terminal event、cancel proof；官方参数表覆盖 REST open、chain active、position 和目标订单 fill；operation 文件存在时继续拒绝。

- [ ] **Step 2: 写缺少恢复状态时的准确错误测试**

```js
await assert.rejects(runGridProbe({
  argv: ['--confirm-manual-cancel-order', '246940766838980608'],
  deps: { preflight: fakePreflight(), files: temporaryFiles(t) },
}), /没有可恢复的人工撤单状态/);

await assert.rejects(runGridProbe({
  argv: ['--confirm-manual-flat-order', '246022657449918464'],
  deps: { preflight: fakePreflight(), files: temporaryFiles(t) },
}), /没有可恢复的人工平仓状态/);
```

- [ ] **Step 3: 运行测试确认 RED**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: 缺少状态仍报告版本/账户不匹配；尚未实现的身份冲突检查至少一项错误通过旧路径或错误消息不匹配。

- [ ] **Step 4: 实现缺少人工平仓状态的独立错误**

在 `validateManualFlatState` 开头加入：

```js
const record = readJson(files.state, fsImpl);
if (record === null) {
  throw new Error('PopDEX grid-probe 没有可恢复的人工平仓状态。');
}
```

之后保留版本和账户精确校验。

- [ ] **Step 5: 确认人工撤单归档失败完整回滚新形态**

复制现有人工平仓归档失败的 fs mock，使用 `writeRunningManualCancelIncident`，让第二次 `.manual-cancel-` rename 抛 `EIO`，断言：

```js
await assert.rejects(runGridProbe(...), /归档人工撤单事实失败/);
assert.equal(fs.existsSync(files.state), true);
assert.equal(fs.existsSync(files.ownership), true);
assert.equal(
  fs.readdirSync(path.dirname(files.state)).some((name) => name.includes('.manual-cancel-')),
  false,
);
```

生产归档函数已有回滚能力，不为新形态增加第二套文件移动实现。

- [ ] **Step 6: 运行聚焦测试确认 GREEN**

Run:

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: 所有 grid-probe 测试通过；失败用例全部保留原文件且 writes 为 0。

- [ ] **Step 7: 提交严格拒绝和可观测性**

```powershell
git add src/exchange/px/grid-probe.js test/popdex-grid-probe.test.js
git commit -m "完善：校验PopDEX人工撤单恢复边界"
```

### Task 4: 聚焦回归、全量回归和改动范围审计

**Files:**
- Verify: `src/exchange/px/grid-probe.js`
- Verify: `test/popdex-grid-probe.test.js`
- Verify: `docs/superpowers/specs/2026-08-19-popdex-reconnect-manual-cancel-recovery-design.md`
- Verify: `docs/superpowers/plans/2026-08-19-popdex-reconnect-manual-cancel-recovery.md`

- [ ] **Step 1: 运行 grid-probe 聚焦测试**

```powershell
node --test test/popdex-grid-probe.test.js
```

Expected: 0 failed。

- [ ] **Step 2: 运行 PopDEX 相关组合回归**

```powershell
node --test test/popdex-operation-journal.test.js test/popdex-ownership-store.test.js test/popdex-reconciler.test.js test/popdex-adapter.test.js test/popdex-grid-probe.test.js
```

Expected: 0 failed。

- [ ] **Step 3: 运行完整测试**

```powershell
npm test
```

Expected: 所有测试通过；基线为 557 项，新增测试后总数应大于 557，fail 为 0。

- [ ] **Step 4: 检查格式、敏感文件和改动范围**

```powershell
git diff --check origin/main...HEAD
git status --short --branch
git diff --name-status origin/main...HEAD
```

Expected:

- 无 whitespace error；
- 工作区干净；
- 仅包含设计、计划、`src/exchange/px/grid-probe.js` 和 `test/popdex-grid-probe.test.js`；
- 不包含 `.env`、`.popdex-*`、私钥、状态、ownership 或 operation 实例文件。

- [ ] **Step 5: 对照设计逐项审查**

确认：

- reconciler 未改动；
- 非 `READY` 写入保护未放宽；
- reconnect/stop 失败均停止刷新并释放锁；
- 失败路径保留恢复事实；
- 新人工撤单形态只接受唯一零成交订单；
- 官方 0 挂单、0 持仓、无目标订单成交才归档；
- 所有恢复结果明确显示 recovery shape 与 writes=0。

- [ ] **Step 6: 提交最终文档一致性修订（仅在确有差异时）**

```powershell
git add docs/superpowers/specs/2026-08-19-popdex-reconnect-manual-cancel-recovery-design.md docs/superpowers/plans/2026-08-19-popdex-reconnect-manual-cancel-recovery.md
git commit -m "文档：同步PopDEX重连恢复实现"
```

如果实现与文档完全一致，不创建空提交。
