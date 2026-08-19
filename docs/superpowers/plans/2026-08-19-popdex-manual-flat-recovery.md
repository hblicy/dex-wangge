# PopDEX Manual Flat Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PopDEX 三格验收增加显式、只读的人工平仓恢复命令，在官方空挂单空仓且成交事实完全匹配时归档遗留恢复文件。

**Architecture:** 继续复用 `grid-probe.js` 现有参数解析、官方预检、进程锁、ownership 严格加载和原子归档模式。新入口只读取本地事实与官方快照，不创建交易客户端；任何身份、成交或仓位差异都保留原文件并失败。

**Tech Stack:** Node.js ESM、`node:test`、ethers v6 `parseUnits`、现有 PopDEX REST/RPC 客户端与 `PopdexOwnershipStore`。

---

### Task 1: 人工平仓参数边界

**Files:**
- Modify: `test/popdex-grid-probe.test.js`
- Modify: `src/exchange/px/grid-probe.js:20-96`

- [ ] **Step 1: 写参数解析失败测试**

```js
test('grid probe parses exact manual-flat order and rejects conflicting flags', () => {
  const orderId = '245591159265558528';
  assert.equal(
    parseGridProbeArgs(['--confirm-manual-flat-order', orderId]).manualFlatOrderId,
    orderId,
  );
  assert.throws(
    () => parseGridProbeArgs(['--resume', '--confirm-manual-flat-order', orderId]),
    /confirm-manual-flat-order.*互斥/,
  );
  assert.throws(
    () => parseGridProbeArgs(['--confirm-manual-flat-order', '0']),
    /必须大于 0/,
  );
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/popdex-grid-probe.test.js`

Expected: FAIL，错误包含“不支持参数 --confirm-manual-flat-order”。

- [ ] **Step 3: 实现最小参数解析**

在 `grid-probe.js` 增加：

```js
const MANUAL_FLAT_FLAG = '--confirm-manual-flat-order';
```

解析该参数为规范正整数字符串 `manualFlatOrderId`，并与 `--resume`、`--confirm-mainnet-grid`、`MANUAL_CANCEL_FLAG` 和所有 `VALUE_FLAGS` 互斥。返回对象中增加 `manualFlatOrderId`。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `node --test test/popdex-grid-probe.test.js`

Expected: 当前文件全部 PASS。

- [ ] **Step 5: 提交参数边界**

```bash
git add test/popdex-grid-probe.test.js src/exchange/px/grid-probe.js
git commit -m "测试：定义PopDEX人工平仓恢复参数"
```

### Task 2: 严格事实校验与原子归档

**Files:**
- Modify: `test/popdex-grid-probe.test.js`
- Modify: `src/exchange/px/grid-probe.js:206-390`

- [ ] **Step 1: 添加真实事故形态测试数据**

在测试文件增加 `writeManualFlatIncident(files, orderId)`，写入：

```js
snapshot: { running: true, active: [], processedFillEventIds: [] }
```

ownership 中唯一订单必须为：

```js
{
  orderId,
  side: 'buy',
  qtyWad: '200000000000000',
  opening: true,
  reduceOnly: false,
  state: 'FILLED',
  filledQtyWad: '200000000000000',
  fillIds: ['245614705081581571'],
  terminalEvent: {
    fillEventId: `px-fill-${'15'.repeat(32)}`,
    stage: 'EVENT_PENDING',
    terminalState: 'FILLED',
    filledQtyWad: '200000000000000',
    priceWad: '64302000000000000000000',
    fillIds: ['245614705081581571'],
    suppressRequote: false,
    replacementOrderId: null,
  },
}
```

- [ ] **Step 2: 写成功恢复失败测试**

```js
test('manual-flat recovery archives exact filled incident without writes', async (t) => {
  const files = temporaryFiles(t);
  const orderId = '245591159265558528';
  writeManualFlatIncident(files, orderId);
  const result = await runGridProbe({
    argv: ['--confirm-manual-flat-order', orderId],
    deps: {
      files,
      preflight: fakePreflight({
        fills: [{
          fillId: '245614705081581571',
          orderId,
          symbol: 'BTCUSDT',
          side: 'Buy',
          execQty: '0.0002',
          execPrice: '64302',
        }],
      }),
      now: () => Date.parse('2026-08-19T08:00:00.000Z'),
      processKill: () => { const error = new Error('dead'); error.code = 'ESRCH'; throw error; },
    },
  });
  assert.equal(result.mode, 'manual-flat-recovered');
  assert.equal(result.orderId, orderId);
  assert.equal(result.writes, 0);
  assert.equal(fs.existsSync(files.state), false);
  assert.equal(fs.existsSync(files.ownership), false);
  assert.equal(result.archivedFiles.length, 2);
});
```

- [ ] **Step 3: 写关键拒绝路径失败测试**

分别覆盖并断言原文件仍存在：

```js
await assert.rejects(run({ positions: [{ symbolId: '20000', holdSizeWad: '200000000000000' }] }), /仍有持仓/);
await assert.rejects(run({ openOrders: [{ orderId: '9' }] }), /仍有活动挂单/);
await assert.rejects(run({ fills: [] }), /官方成交.*不匹配/);
```

另外直接改写 fixture，覆盖 operation journal 存在、订单号冲突、部分成交、事件已 suppression、replacementOrderId 非空、fill ID 冲突及成交数量冲突。

再注入一个 `fsImpl`，使第二次 `renameSync` 抛出 `EIO`，断言恢复失败后 state 与 ownership 原文件均仍存在，且没有遗留 `.manual-flat-*.bak`，证明归档回滚完整。

- [ ] **Step 4: 运行测试并确认 RED**

Run: `node --test test/popdex-grid-probe.test.js`

Expected: 新成功路径因没有恢复分派或校验函数而 FAIL；既有测试继续通过。

- [ ] **Step 5: 实现严格校验**

在 `grid-probe.js` 引入 `parseUnits`，增加 `validateManualFlatState`：

```js
const official = preflight.fills.filter((fill) => String(fill?.orderId) === orderId);
const officialFillIds = official.map((fill) => strictIntegerString(fill.fillId, '人工平仓 fillId')).sort();
const officialQtyWad = official.reduce(
  (total, fill) => total + parseUnits(String(fill.execQty), 18),
  0n,
).toString();
```

按设计逐项校验 state、operation、唯一 ownership 订单、完整开仓成交事件、REST/链上活动订单为 0、BTC 持仓为 0，并要求 `officialFillIds` 与本地排序后集合、`officialQtyWad` 与 `filledQtyWad` 完全相等。

- [ ] **Step 6: 实现原子归档与恢复分派**

把现有归档函数参数化为 `archiveRecoveryFiles(files, fsImpl, now, reason)`，分别生成 `.manual-cancel-...bak` 与 `.manual-flat-...bak`。增加 `recoverManualFlat`，获取进程锁、校验、归档并在 `finally` 释放锁；在 `runGridProbe` 中优先于普通 facts 检查分派该模式。

- [ ] **Step 7: 运行测试并确认 GREEN**

Run: `node --test test/popdex-grid-probe.test.js`

Expected: 文件全部 PASS，成功路径 `writes=0`，拒绝路径不归档。

- [ ] **Step 8: 提交恢复实现**

```bash
git add test/popdex-grid-probe.test.js src/exchange/px/grid-probe.js
git commit -m "修复：支持PopDEX人工平仓恢复"
```

### Task 3: CLI 输出与完整回归验证

**Files:**
- Modify: `test/popdex-grid-probe.test.js`
- Modify: `src/exchange/px/grid-probe.js:624-638`

- [ ] **Step 1: 写 CLI 结果测试**

为返回结果断言固定字段：

```js
assert.deepEqual(
  { mode: result.mode, orderId: result.orderId, writes: result.writes },
  { mode: 'manual-flat-recovered', orderId, writes: 0 },
);
```

- [ ] **Step 2: 实现成功输出**

在 CLI `then` 分支增加：

```js
} else if (result?.mode === 'manual-flat-recovered') {
  console.log(`PopDEX 人工平仓恢复完成：orderId=${result.orderId}，链上写入=0。`);
  for (const file of result.archivedFiles) console.log(`已归档：${file}`);
}
```

- [ ] **Step 3: 运行定向与全量验证**

Run: `node --test test/popdex-grid-probe.test.js`

Expected: 全部 PASS。

Run: `npm test`

Expected: 全部测试 PASS、0 fail。

Run: `git diff --check`

Expected: 无输出、退出码 0。

- [ ] **Step 4: 提交最终结果**

```bash
git add test/popdex-grid-probe.test.js src/exchange/px/grid-probe.js
git commit -m "完善：输出PopDEX人工平仓恢复结果"
```
