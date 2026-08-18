# PopDEX 市价平仓回执价格修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PopDEX 只减仓市价单接受成功 `OrderCreate` 事件中的严格正执行参考价，同时保持所有限价单价格和订单身份的严格校验。

**Architecture:** 在通用回执解析器中增加调用方显式选择的价格规则，默认仍为限价单的 `exact`。只有 Stage 5 的实时平仓和只读恢复调用传入 `positive-execution`；最终完成仍由现有 REST 成交、零活动订单和链上空仓状态机确认。

**Tech Stack:** Node.js 20+、ES modules、`node:test`、ethers 6、PopDEX Order 预编译事件。

---

### Task 1: 为回执解析器增加显式价格规则

**Files:**
- Modify: `test/popdex-receipt-events.test.js`
- Modify: `src/exchange/px/receipt-events.js`

- [ ] **Step 1: 写入失败测试**

在 `test/popdex-receipt-events.test.js` 增加：

```js
test('OrderCreate market receipt accepts only an explicitly requested positive execution price', () => {
  const expected = {
    account: ACCOUNT,
    symbolId: '20000',
    clientOrderId: CLIENT_ORDER_ID,
    priceWad: '0',
    qtyWad: '200000000000000',
    priceRule: 'positive-execution',
  };
  const result = parseOrderCreateReceipt(receipt([
    createLog({ price: '62358000000000000000000' }),
  ]), expected);
  assert.equal(result.priceWad, '62358000000000000000000');

  assert.throws(
    () => parseOrderCreateReceipt(receipt([createLog({ price: '0' })]), expected),
    /priceWad.*正整数/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([createLog({ price: '-1' })]), expected),
    /priceWad.*非负整数字符串/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([
      createLog({ price: '62358000000000000000000' }),
    ]), { ...expected, priceRule: undefined }),
    /priceWad.*不匹配/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([
      createLog({ price: '62358000000000000000000' }),
    ]), { ...expected, priceWad: '1' }),
    /positive-execution.*priceWad=0/,
  );
  assert.throws(
    () => parseOrderCreateReceipt(receipt([
      createLog({ price: '62358000000000000000000' }),
    ]), { ...expected, priceRule: 'unknown' }),
    /priceRule.*无效/,
  );
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
node --test test/popdex-receipt-events.test.js
```

Expected: FAIL，首个新断言报告 `priceWad` 的 `expected=0` 与正执行价不匹配。

- [ ] **Step 3: 实现最小价格规则**

在 `src/exchange/px/receipt-events.js` 增加：

```js
const ORDER_CREATE_PRICE_RULES = new Set(['exact', 'positive-execution']);

function exactPriceRule(value) {
  const rule = value ?? 'exact';
  if (!ORDER_CREATE_PRICE_RULES.has(rule)) {
    throw new Error(`PopDEX OrderCreate expected.priceRule 无效：${String(rule)}。`);
  }
  return rule;
}
```

在 `parseOrderCreateReceipt` 中读取 `priceRule`，把价格从通用相等比较循环中移出，并在账户、市场、客户端订单 ID、数量严格相等后执行：

```js
const priceRule = exactPriceRule(expected.priceRule);

if (priceRule === 'exact') {
  if (priceWad !== actualPriceWad) {
    mismatch('OrderCreate', 'priceWad', priceWad, actualPriceWad);
  }
} else {
  if (priceWad !== '0') {
    throw new Error('PopDEX OrderCreate positive-execution 只允许提交 priceWad=0。');
  }
  const executionPriceWad = strictIntegerString(actualPriceWad, 'OrderCreate priceWad');
  if (BigInt(executionPriceWad) <= 0n) {
    throw new Error('PopDEX OrderCreate priceWad 必须是正整数。');
  }
}
```

- [ ] **Step 4: 运行回执单元测试**

Run:

```bash
node --test test/popdex-receipt-events.test.js
```

Expected: PASS，5 个测试全部通过；原限价错价测试继续通过。

- [ ] **Step 5: 提交解析器改动**

```bash
git add src/exchange/px/receipt-events.js test/popdex-receipt-events.test.js
git commit -m "修复：区分PopDEX限价与市价回执价格"
```

### Task 2: 接入实时平仓与只读恢复

**Files:**
- Modify: `test/popdex-fill-close-trading.test.js`
- Modify: `test/popdex-fill-close-probe.test.js`
- Modify: `src/exchange/px/trading-client.js`
- Modify: `src/exchange/px/fill-close-probe.js`

- [ ] **Step 1: 让实时平仓测试模拟主网正执行价**

在 `test/popdex-fill-close-trading.test.js` 的 `OrderCreate` 事件夹具中，把事件价格改为：

```js
overrides.price ?? (parsed.args.price === 0n
  ? 62358000000000000000000n
  : parsed.args.price),
```

- [ ] **Step 2: 增加成功回执恢复测试**

在 `test/popdex-fill-close-probe.test.js` 导入 `POPDEX_ORDER_PRECOMPILE` 和 `POPDEX_ORDER_EVENT_INTERFACE`，增加：

```js
function recoveryCloseReceiptLog() {
  const record = recoveryRecord('CLOSE_BROADCAST');
  const event = POPDEX_ORDER_EVENT_INTERFACE.encodeEventLog(
    POPDEX_ORDER_EVENT_INTERFACE.getEvent('OrderCreate'),
    [
      MAIN_ACCOUNT,
      20000,
      10,
      record.closeClientOrderId,
      '62358000000000000000000',
      record.closeQtyWad,
      0,
      2,
      true,
      0,
    ],
  );
  return { address: POPDEX_ORDER_PRECOMPILE, ...event };
}

test('plain recovery accepts a successful market-close receipt with a positive execution price', async () => {
  const scenario = recoveryDependencies('CLOSE_BROADCAST', {
    receiptStatus: '0x1',
    receiptLogs: [recoveryCloseReceiptLog()],
    fills: [recoveryCloseFill('0.0001')],
    openOrders: [],
    positions: [],
  });
  const result = await runProbe({ mode: 'resume' }, scenario.deps);
  assert.equal(result.status, 'completed-flat');
  assert.equal(scenario.closeCalls, 0);
  assert.equal(scenario.journal.load(), null);
});
```

- [ ] **Step 3: 运行集成测试并确认失败位置正确**

Run:

```bash
node --test test/popdex-fill-close-trading.test.js test/popdex-fill-close-probe.test.js
```

Expected: FAIL，实时平仓和恢复路径均报告 `expected=0 actual=62358000000000000000000`。

- [ ] **Step 4: 只在两个市价平仓调用点显式选择规则**

在 `src/exchange/px/trading-client.js` 的 `closeFillCloseLong` 回执期望中增加：

```js
priceRule: 'positive-execution',
```

在 `src/exchange/px/fill-close-probe.js` 的 `CLOSE_BROADCAST` 恢复回执期望中增加相同字段。入场、普通限价探针和撤单路径不修改。

- [ ] **Step 5: 运行集成测试**

Run:

```bash
node --test test/popdex-fill-close-trading.test.js test/popdex-fill-close-probe.test.js
```

Expected: PASS，实时平仓和普通 `--resume` 均接受正执行参考价，且恢复路径没有广播。

- [ ] **Step 6: 提交调用方改动**

```bash
git add src/exchange/px/trading-client.js src/exchange/px/fill-close-probe.js test/popdex-fill-close-trading.test.js test/popdex-fill-close-probe.test.js
git commit -m "修复：确认PopDEX市价平仓成功回执"
```

### Task 3: 同步协议事实并完成回归验证

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新项目协议事实**

在 `AGENTS.md` 的 PopDEX `OrderCreate` 规则中补充：

```text
只减仓市价单的 calldata price 固定为 0，但成功 OrderCreate 事件的 price 是严格正的执行参考价；只有该平仓调用方可显式使用 positive-execution 规则。普通限价回执仍必须与提交价完全一致，任何路径仍须结合精确订单身份、成交、零活动订单和链上空仓确认完成。
```

- [ ] **Step 2: 运行 PopDEX 定向回归**

Run:

```bash
node --test test/popdex-receipt-events.test.js test/popdex-fill-close-trading.test.js test/popdex-fill-close-probe.test.js test/popdex-write-probe.test.js test/popdex-trading-client.test.js
```

Expected: PASS，全部测试通过且无 warning/error。

- [ ] **Step 3: 运行项目完整测试**

Run:

```bash
npm test
```

Expected: PASS，网格测试和 Node 测试均为 0 failure；Decibel、RISEx 回归保持通过。

- [ ] **Step 4: 检查改动边界**

Run:

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

Expected: 无空白错误；只包含本计划列出的 PopDEX 文件、`AGENTS.md`、设计与计划文档。

- [ ] **Step 5: 提交协议文档**

```bash
git add AGENTS.md
git commit -m "文档：记录PopDEX市价平仓回执事实"
```

### Task 4: VPS 只读恢复验收

**Files:**
- No repository changes.

- [ ] **Step 1: 更新 VPS 后只运行普通恢复**

```bash
cd ~/dex-wangge
npm run popdex:fill-close-probe -- --resume
```

Expected: `status=completed-flat`，不创建写客户端、不广播交易，并自动清除活动恢复文件。

- [ ] **Step 2: 验证最终账户事实**

```bash
npm run popdex:verify -- --account-env POPDEX_MAIN_ACCOUNT
test ! -f .popdex-fill-close-probe.json && echo journal-cleared
```

Expected: `BTCUSDT open=0`、`positions=0`、`writeMethodsCalled=0`、`journal-cleared`。
