# PopDEX 第 5 阶段成交与平仓闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个默认只读、显式授权写入、可中断恢复的 BTCUSDT 1x 最小开多并立即整仓平仓探针。

**Architecture:** 探针与 `GridBot`、网页和 exchange registry 完全隔离。协议编码、状态判定、恢复日志和命令编排拆成独立模块；复用现有 Agent 交易发送器，并用链上账户配置、交易回执、REST 订单/成交及完整链上仓位分页共同证明业务事实。

**Tech Stack:** Node.js 20+、ES modules、ethers 6.13.5、内置 `node:test`、PopDEX JSON-RPC 与公开账户 REST。

---

## 文件结构

- Modify: `src/exchange/px/constants.js` — 增加 UserConfig 预编译地址常量。
- Modify: `src/exchange/px/rpc-client.js` — 严格读取账户配置并提供完整仓位分页。
- Modify: `src/exchange/px/account-client.js` — 提供有界的完整活动订单和成交分页。
- Create: `src/exchange/px/fill-close-codec.js` — 固定 BTCUSDT 1x 计划、ABI 编码、模拟结果及杠杆事件解析。
- Create: `src/exchange/px/fill-close-state.js` — 初始空仓检查、订单/成交/仓位一致性和终态判定。
- Create: `src/exchange/px/fill-close-journal.js` — 独立、原子、严格阶段化的恢复记录。
- Modify: `src/exchange/px/trading-client.js` — 支持受限目标预编译及第 5 阶段四个单次写操作。
- Create: `src/exchange/px/fill-close-probe.js` — CLI、dry-run、完整闭环和只读恢复编排。
- Modify: `.gitignore` — 忽略第 5 阶段恢复文件。
- Modify: `package.json` — 注册命令和测试。
- Modify: `docs/protocol/popdex-mainnet-validation.md` — 记录 UserConfig 地址、杠杆 ABI 和阶段状态。
- Create: `test/popdex-fill-close-codec.test.js`
- Create: `test/popdex-fill-close-state.test.js`
- Create: `test/popdex-fill-close-journal.test.js`
- Create: `test/popdex-fill-close-trading.test.js`
- Create: `test/popdex-fill-close-probe.test.js`
- Modify: `test/popdex-rpc-client.test.js`
- Modify: `test/popdex-account-client.test.js`
- Modify: `test/popdex-trading-client.test.js`

## Task 1: 固定 UserConfig 地址和只读账户事实

**Files:**
- Modify: `src/exchange/px/constants.js`
- Create: `src/exchange/px/fill-close-codec.js`
- Modify: `src/exchange/px/rpc-client.js`
- Modify: `src/exchange/px/account-client.js`
- Modify: `test/popdex-rpc-client.test.js`
- Modify: `test/popdex-account-client.test.js`

- [ ] **Step 1: 写失败测试：账户配置必须从 0x1009 解码**

在 `test/popdex-rpc-client.test.js` 增加固定 ABI 测试：

```js
const USER_CONFIG_PRECOMPILE = '0x0000000000000000000000000000000000001009';
const USER_CONFIG_ABI = [
  'function getAccountConfig(address account) view returns ((uint8 status,uint8 vipLevel,uint8 positionMode,uint64 bizPermissionCode,tuple(uint16 symbolId,uint8 leverage)[] symbolLeverages,tuple(address tokenAddress,uint8 leverage)[] tokenLeverages) config)',
];

test('RPC client reads exact UserConfig leverage without number coercion', async () => {
  const iface = new Interface(USER_CONFIG_ABI);
  const client = new PopdexRpcClient({ fetchImpl: async (_input, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.params[0].to, USER_CONFIG_PRECOMPILE);
    return rpcResponse({
      jsonrpc: '2.0', id: request.id,
      result: iface.encodeFunctionResult('getAccountConfig', [[0, 0, 0, 0, [[20000, 20]], []]]),
    });
  }});
  assert.deepEqual(await client.getAccountConfig(ACCOUNT), {
    status: '0', vipLevel: '0', positionMode: '0', bizPermissionCode: '0',
    symbolLeverages: [{ symbolId: '20000', leverage: '20' }], tokenLeverages: [],
  });
});
```

再增加重复 `symbolId`、uint16 边界值保持字符串、非 `OneWay=0` 不在 RPC 层改写的测试，以及 `getAllOpenPositions` 在 `hasMore=true` 空页和超过 10 页时失败的测试。账户可能保存其他市场的杠杆，RPC 解析层不得把非 BTC/ETH 记录静默删除；交易白名单由上层严格执行。

- [ ] **Step 2: 写失败测试：REST 分页必须完整且有界**

在 `test/popdex-account-client.test.js` 增加：

```js
function accountClientFromPages(pages) {
  return new PopdexAccountClient({
    fetchImpl: async (input) => {
      const cursor = new URL(input).searchParams.get('cursor');
      const page = pages.get(cursor);
      if (!page) throw new Error(`unexpected cursor ${String(cursor)}`);
      return new Response(JSON.stringify({ code: '200', data: page.data, cursor: page.cursor }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('account client collects all fills and rejects a repeated cursor', async () => {
  const pages = new Map([
    [null, { data: [{ fillId: '1', orderId: '9', symbol: 'BTCUSDT', side: 'Buy', execPrice: '63000', execQty: '0.0001' }], cursor: '7' }],
    ['7', { data: [{ fillId: '2', orderId: '9', symbol: 'BTCUSDT', side: 'Buy', execPrice: '63001', execQty: '0.0001' }], cursor: '' }],
  ]);
  const client = accountClientFromPages(pages);
  assert.equal((await client.getAllFills(ACCOUNT, 'BTCUSDT')).length, 2);
  const repeated = accountClientFromPages(new Map([
    [null, { data: [], cursor: '7' }],
    ['7', { data: [], cursor: '7' }],
  ]));
  await assert.rejects(repeated.getAllFills(ACCOUNT, 'BTCUSDT'), /cursor.*重复/);
});
```

对 `getAllOpenOrders` 添加相同的 10 页上限、游标重复和缺失数组字段测试。

- [ ] **Step 3: 运行测试，确认因接口缺失而失败**

Run:

```bash
node --test test/popdex-rpc-client.test.js test/popdex-account-client.test.js
```

Expected: FAIL，提示 `getAccountConfig`、`getAllOpenPositions`、`getAllFills` 或 `getAllOpenOrders` 未定义。

- [ ] **Step 4: 实现最小只读接口**

在 `constants.js` 增加：

```js
export const POPDEX_USER_CONFIG_PRECOMPILE = '0x0000000000000000000000000000000000001009';
```

在 `fill-close-codec.js` 增加并导出唯一的 UserConfig ABI；`rpc-client.js` 必须导入它，禁止复制第二份 ABI：

```js
export const POPDEX_USER_CONFIG_INTERFACE = new Interface([
  'function getAccountConfig(address account) view returns ((uint8 status,uint8 vipLevel,uint8 positionMode,uint64 bizPermissionCode,tuple(uint16 symbolId,uint8 leverage)[] symbolLeverages,tuple(address tokenAddress,uint8 leverage)[] tokenLeverages) config)',
  'function updateLeverage(address account,(uint8 newLeverage,uint16 symbolId,address tokenAddress,uint8 category) request) returns (bool success)',
  'event LeverageUpdated(address indexed account,uint8 category,uint16 symbolId,address tokenAddress,uint8 newLeverage,bool succeeded,uint32 code)',
]);
```

在 `rpc-client.js` 实现：

```js
async getAccountConfig(account) {
  const wallet = strictAddress(account, 'account');
  const data = USER_CONFIG_INTERFACE.encodeFunctionData('getAccountConfig', [wallet]);
  const raw = await this.call('eth_call', [
    { to: POPDEX_USER_CONFIG_PRECOMPILE, data }, 'latest',
  ]);
  let config;
  try {
    [config] = USER_CONFIG_INTERFACE.decodeFunctionResult('getAccountConfig', raw);
  } catch (cause) {
    throw new Error(`PopDEX RPC getAccountConfig 解码失败：${sanitizedCause(cause)}`, { cause });
  }
  const symbolLeverages = config.symbolLeverages.map((item) => ({
    symbolId: item.symbolId.toString(), leverage: item.leverage.toString(),
  }));
  if (new Set(symbolLeverages.map((item) => item.symbolId)).size !== symbolLeverages.length) {
    throw new Error('PopDEX RPC getAccountConfig symbolLeverages 存在重复 symbolId。');
  }
  return {
    status: config.status.toString(), vipLevel: config.vipLevel.toString(),
    positionMode: config.positionMode.toString(),
    bizPermissionCode: config.bizPermissionCode.toString(), symbolLeverages,
    tokenLeverages: config.tokenLeverages.map((item) => ({
      tokenAddress: addressAllowZero(item.tokenAddress, 'tokenLeverage.tokenAddress'),
      leverage: item.leverage.toString(),
    })),
  };
}

async getAllOpenPositions(account, { maxPages = 10, pageSize = 100 } = {}) {
  const positions = [];
  let offset = 0;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await this.getOpenPositions(account, offset, pageSize);
    positions.push(...page.positions);
    if (!page.hasMore) return positions;
    if (page.positions.length === 0) throw new Error('PopDEX positions hasMore=true 但当前页为空。');
    offset += page.positions.length;
  }
  throw new Error(`PopDEX positions 分页超过 maxPages=${maxPages}。`);
}
```

在 `account-client.js` 用私有通用游标循环实现 `getAllOpenOrders` 和 `getAllFills`；每次检测重复游标，最多 10 页，不能把异常转换为空数组。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
node --test test/popdex-rpc-client.test.js test/popdex-account-client.test.js
```

Expected: PASS。

Commit:

```bash
git add src/exchange/px/constants.js src/exchange/px/fill-close-codec.js src/exchange/px/rpc-client.js src/exchange/px/account-client.js test/popdex-rpc-client.test.js test/popdex-account-client.test.js
git commit -m "实现：补充PopDEX账户配置与完整分页读取"
```

## Task 2: 实现固定 BTCUSDT 计划、ABI 和杠杆事件

**Files:**
- Modify: `src/exchange/px/fill-close-codec.js`
- Create: `test/popdex-fill-close-codec.test.js`

- [ ] **Step 1: 写失败测试：固定计划和 ABI 向量**

测试必须断言：BTCUSDT、Buy、1x、Long=1、OneWay=0 不可覆盖；ask=`63000` 时数量为 `0.0002`，价格为 `63189`；非 BTC 参数和无效盘口直接失败。

```js
test('fill-close plan is fixed to BTCUSDT 1x minimum long with 0.3 percent cap', () => {
  const plan = prepareFillClosePlan({
    mainAccount: ACCOUNT, ask: '63000',
    randomBytesImpl: () => Uint8Array.from({ length: 16 }, (_, i) => i + 1),
  });
  assert.equal(plan.symbol, 'BTCUSDT');
  assert.equal(plan.symbolId, '20000');
  assert.equal(plan.side, 'buy');
  assert.equal(plan.leverage, '1');
  assert.equal(plan.positionSide, '1');
  assert.equal(plan.price, '63189');
  assert.equal(plan.qty, '0.0002');
  assert.equal(decodeBytes32String(plan.clientOrderId), 'dw-bb-0102030405060708090a0b0c');
});
```

同时解码并断言：

```js
updateLeverage(ACCOUNT, [1, 20000, ZeroAddress, 2]);
placeReverseOrder(ACCOUNT, 20000, 1);
```

杠杆事件测试必须断言 `category=Futures(2)`，并拒绝错误地址、账户、category、symbolId、杠杆、`succeeded=false`、非零 `code` 和多条目标事件。禁止把订单类别 `Regular=0` 当成合约品类。

- [ ] **Step 2: 运行测试，确认模块不存在**

Run: `node --test test/popdex-fill-close-codec.test.js`

Expected: FAIL，提示 `prepareFillClosePlan`、`POPDEX_REVERSE_INTERFACE` 或事件解析函数尚未导出。

- [ ] **Step 3: 实现纯协议模块**

核心接口和固定常量：

```js
export const POPDEX_REVERSE_INTERFACE = new Interface([
  'function placeReverseOrder(address account,uint16 symbolId,uint8 positionSide) returns (bool success)',
]);

export function verifyStage5Simulation(raw, iface, functionName) {
  if (raw === '0x') return 'empty';
  let decoded;
  try { decoded = iface.decodeFunctionResult(functionName, raw); }
  catch (cause) { throw new Error(`PopDEX ${functionName} 模拟结果无效。`, { cause }); }
  if (decoded.length !== 1 || decoded[0] !== true) {
    throw new Error(`PopDEX ${functionName} 模拟未返回 true。`);
  }
  return 'bool-true';
}
```

`prepareFillClosePlan` 全程使用 WAD `BigInt`：

```js
const requiredQty = (minNotionalWad * WAD + askWad - 1n) / askWad;
const qtyWad = ((requiredQty > minQtyWad ? requiredQty : minQtyWad) + lotWad - 1n) / lotWad * lotWad;
const rawCap = (askWad * 1003n + 999n) / 1000n;
const priceWad = (rawCap + tickWad - 1n) / tickWad * tickWad;
const wadToDecimal = (value) => {
  const text = formatUnits(value, 18);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
};
```

生成与现有 Mainnet 已接受格式相同的 `dw-bb-` 加 24 个小写十六进制字符的 ID；订单参数固定 Limit/GTC/Buy/非 reduce-only/Net。返回 leverage、entry 和 close 三段 calldata。

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/popdex-fill-close-codec.test.js`

Expected: PASS。

Commit:

```bash
git add src/exchange/px/fill-close-codec.js test/popdex-fill-close-codec.test.js
git commit -m "实现：增加PopDEX成交平仓协议编码"
```

## Task 3: 实现订单、成交和仓位一致性判定

**Files:**
- Create: `src/exchange/px/fill-close-state.js`
- Create: `test/popdex-fill-close-state.test.js`

- [ ] **Step 1: 写失败测试：初始状态必须完全干净**

```js
test('initial state rejects any BTC order or nonzero position', () => {
  assert.throws(() => assertInitialFlat({
    openOrders: [{ symbol: 'BTCUSDT', orderId: '9' }], positions: [],
  }), /活动订单/);
  assert.throws(() => assertInitialFlat({
    openOrders: [], positions: [{ symbolId: '20000', side: '1', holdSizeWad: '1' }],
  }), /持仓/);
});
```

- [ ] **Step 2: 写失败测试：成交分类和最终空仓证明**

覆盖：全成、部分成交、零成交、同一 fillId 重复、其他订单成交、REST `filledQty` 与成交和短暂不一致时返回 `settling`、不一致持续到超时后失败、精确 `OrderCancel` 后 REST 删除订单但成交分页仍能证明实际成交量、持仓方向不是 `Long=1`、持仓量不等于本单成交量、平仓后残余多仓或反向空仓。

```js
function order(overrides = {}) {
  return {
    walletId: ACCOUNT, orderId: ORDER_ID, clientOid: 'dw-bb-0123456789abcdef01234567',
    symbolId: '20000', symbol: 'BTCUSDT', side: 'Buy', status: 'PartiallyFilled',
    price: '63189', qty: '0.0002', filledQty: '0.0001',
    remainingQty: '0.0001', cancelledQty: '0', reduceOnly: false,
    ...overrides,
  };
}
function fill(overrides = {}) {
  return {
    fillId: '1', orderId: ORDER_ID, symbol: 'BTCUSDT', side: 'Buy',
    execPrice: '63000', execQty: '0.0001', ...overrides,
  };
}
function position(overrides = {}) {
  return {
    walletId: ACCOUNT, positionId: '77', symbolId: '20000', side: '1',
    holdSizeWad: parseUnits('0.0001', 18).toString(), avgOpenPriceWad: parseUnits('63000', 18).toString(),
    closeSizeWad: '0', lockedSizeWad: '0', realizedPnlWad: '0',
    createdTime: '1', updatedTime: '2', ...overrides,
  };
}

assert.deepEqual(classifyEntry(plan, {
  orderId: ORDER_ID, order: order(), fills: [fill()], positions: [position()],
  openOrders: [order()], cancelConfirmed: false,
}), {
  kind: 'partial-fill', filledQtyWad: parseUnits('0.0001', 18).toString(),
  remainingQtyWad: parseUnits('0.0001', 18).toString(), orderId: ORDER_ID,
});
```

- [ ] **Step 3: 运行测试，确认模块不存在**

Run: `node --test test/popdex-fill-close-state.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 4: 实现纯状态函数**

导出以下完整行为；辅助函数 `decimalWad` 必须先调用 `strictDecimalString`，`integerWad` 必须先调用 `strictIntegerString`：

```js
const WAD_DECIMALS = 18;
function decimalWad(value, field) {
  return parseUnits(strictDecimalString(value, field), WAD_DECIMALS);
}
function integerWad(value, field) {
  return BigInt(strictIntegerString(value, field));
}

export function assertInitialFlat({ openOrders, positions }) {
  if (!Array.isArray(openOrders) || !Array.isArray(positions)) throw new Error('PopDEX 初始快照格式无效。');
  const btcOrders = openOrders.filter((item) => item?.symbol === 'BTCUSDT' || String(item?.symbolId) === '20000');
  const btcPositions = positions.filter((item) => String(item?.symbolId) === '20000'
    && integerWad(item.holdSizeWad, 'position.holdSizeWad') > 0n);
  if (btcOrders.length !== 0) throw new Error(`PopDEX BTCUSDT 仍有 ${btcOrders.length} 个活动订单。`);
  if (btcPositions.length !== 0) throw new Error(`PopDEX BTCUSDT 仍有 ${btcPositions.length} 个持仓。`);
}

export function exactBtcLeverage(config) {
  if (!config || config.positionMode !== '0' || !Array.isArray(config.symbolLeverages)) {
    throw new Error('PopDEX 账户必须是 OneWay positionMode=0。');
  }
  const matches = config.symbolLeverages.filter((item) => item.symbolId === '20000');
  if (matches.length !== 1) throw new Error(`PopDEX BTCUSDT 杠杆记录必须唯一，实际 ${matches.length}。`);
  const leverage = integerWad(matches[0].leverage, 'BTC leverage');
  if (leverage < 1n || leverage > 255n) throw new Error('PopDEX BTCUSDT leverage 必须是 1-255。');
  return leverage.toString();
}

export function classifyEntry(plan, {
  orderId, order = null, fills, openOrders, cancelConfirmed = false,
}) {
  if (!Array.isArray(fills) || !Array.isArray(openOrders) || typeof cancelConfirmed !== 'boolean') {
    throw new Error('PopDEX 入场快照格式无效。');
  }
  const exactOrderId = strictIntegerString(orderId, 'entry.orderId');
  const expectedClientOid = decodeBytes32String(plan.clientOrderId);
  const btcOpen = openOrders.filter((item) => item?.symbol === 'BTCUSDT' || String(item?.symbolId) === '20000');
  if (btcOpen.some((item) => String(item.orderId) !== exactOrderId || item.clientOid !== expectedClientOid)) {
    throw new Error('PopDEX 出现不属于本探针的 BTCUSDT 活动订单。');
  }
  if (btcOpen.length > 1) throw new Error('PopDEX 入场活动订单重复。');
  const candidate = order ?? btcOpen[0] ?? null;
  const allowedStatuses = new Set([
    'PendingNew', 'NewAccept', 'PendingCancel', 'PartiallyFilled', 'FullyFilled',
    'PartiallyFilledCancelled', 'Cancelled',
  ]);
  if (candidate && (String(candidate.orderId) !== exactOrderId
      || candidate.symbol !== 'BTCUSDT' || candidate.side !== 'Buy'
      || candidate.clientOid !== expectedClientOid
      || !allowedStatuses.has(candidate.status)
      || decimalWad(candidate.price, 'order.price') !== integerWad(plan.priceWad, 'plan.priceWad')
      || decimalWad(candidate.qty, 'order.qty') !== integerWad(plan.qtyWad, 'plan.qtyWad'))) {
    throw new Error('PopDEX 入场订单身份不匹配。');
  }
  const seen = new Set();
  let fillWad = 0n;
  for (const item of fills.filter((value) => String(value.orderId) === String(order.orderId))) {
    if (seen.has(item.fillId)) throw new Error(`PopDEX fillId ${item.fillId} 重复。`);
    seen.add(item.fillId);
    if (item.symbol !== 'BTCUSDT' || item.side !== 'Buy') throw new Error('PopDEX 成交身份不匹配。');
    const execQtyWad = decimalWad(item.execQty, 'fill.execQty');
    if (execQtyWad <= 0n) throw new Error('PopDEX fill.execQty 必须大于 0。');
    fillWad += execQtyWad;
  }
  const qty = integerWad(plan.qtyWad, 'plan.qtyWad');
  if (fillWad > qty) throw new Error('PopDEX 本单成交量超过委托量。');
  if (candidate) {
    const filled = decimalWad(candidate.filledQty, 'order.filledQty');
    const remaining = decimalWad(candidate.remainingQty, 'order.remainingQty');
    const cancelled = decimalWad(candidate.cancelledQty, 'order.cancelledQty');
    if (qty !== filled + remaining + cancelled) throw new Error('PopDEX 入场订单数量恒等式不成立。');
    if (filled !== fillWad) {
      return {
        kind: 'settling', orderId: exactOrderId,
        orderFilledQtyWad: filled.toString(), fillSumQtyWad: fillWad.toString(),
        remainingQtyWad: remaining.toString(),
      };
    }
  }
  if (cancelConfirmed && btcOpen.length === 0) {
    return {
      kind: fillWad > 0n ? 'partial-fill' : 'zero-fill', orderId: exactOrderId,
      filledQtyWad: fillWad.toString(), remainingQtyWad: '0',
    };
  }
  if (fillWad === qty) {
    return { kind: 'full-fill', orderId: exactOrderId, filledQtyWad: fillWad.toString(), remainingQtyWad: '0' };
  }
  if (btcOpen.length === 1) {
    const remaining = decimalWad(btcOpen[0].remainingQty, 'active.remainingQty');
    return {
      kind: fillWad > 0n ? 'partial-fill' : 'zero-fill-active', orderId: exactOrderId,
      filledQtyWad: fillWad.toString(), remainingQtyWad: remaining.toString(),
    };
  }
  if (candidate && decimalWad(candidate.remainingQty, 'order.remainingQty') === 0n) {
    return {
      kind: fillWad > 0n ? 'partial-fill' : 'zero-fill', orderId: exactOrderId,
      filledQtyWad: fillWad.toString(), remainingQtyWad: '0',
    };
  }
  return { kind: 'settling', orderId: exactOrderId, fillSumQtyWad: fillWad.toString() };
}

export function assertConfirmedLong(_plan, { positions, openOrders }, filledQtyWad) {
  if (openOrders.some((item) => item.symbol === 'BTCUSDT' || String(item.symbolId) === '20000')) {
    throw new Error('PopDEX 确认持仓前仍有 BTCUSDT 活动订单。');
  }
  const nonzero = positions.filter((item) => String(item.symbolId) === '20000'
    && integerWad(item.holdSizeWad, 'position.holdSizeWad') > 0n);
  if (nonzero.length !== 1 || nonzero[0].side !== '1') throw new Error('PopDEX 必须只有一个 BTCUSDT Long=1 持仓。');
  if (integerWad(nonzero[0].holdSizeWad, 'position.holdSizeWad') !== integerWad(filledQtyWad, 'filledQtyWad')) {
    throw new Error('PopDEX BTCUSDT 持仓量与本单成交量不一致。');
  }
  return nonzero[0];
}

export function assertCompletedFlat({ positions, openOrders }) {
  assertInitialFlat({ positions, openOrders });
  return true;
}
```

实现中所有数量先用 `strictDecimalString` 或 `strictIntegerString` 验证，再转 `BigInt`；不得使用 `Number`。`classifyEntry` 必须验证 `filled + remaining + cancelled = qty`，并要求所有匹配成交的 `orderId`、symbol、side 一致。REST 成交量和成交分页短暂不一致只能返回带双方观测值的 `settling`，由有界轮询继续观察；超过截止时间必须连同观测值报错，不能采用任一来源猜测终态。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/popdex-fill-close-state.test.js`

Expected: PASS。

Commit:

```bash
git add src/exchange/px/fill-close-state.js test/popdex-fill-close-state.test.js
git commit -m "实现：校验PopDEX成交与仓位一致性"
```

## Task 4: 实现独立恢复日志状态机

**Files:**
- Create: `src/exchange/px/fill-close-journal.js`
- Create: `test/popdex-fill-close-journal.test.js`
- Modify: `.gitignore`

- [ ] **Step 1: 写失败测试：阶段、字段和权限**

测试以下合法路径：

```text
PREPARED -> LEVERAGE_CONFIRMED -> ENTRY_BROADCAST -> ENTRY_SETTLING
ENTRY_SETTLING -> POSITION_CONFIRMED -> CLOSE_BROADCAST -> COMPLETED(completed-flat)
ENTRY_SETTLING -> REMAINDER_CANCEL_BROADCAST -> COMPLETED(zero-fill-cleared)
PREPARED -> LEVERAGE_BROADCAST -> LEVERAGE_CONFIRMED
PREPARED/LEVERAGE_BROADCAST/LEVERAGE_CONFIRMED -> COMPLETED(safe-no-exposure)
ENTRY_BROADCAST(精确失败回执) -> COMPLETED(safe-no-exposure)
```

非法跳级、缺少对应 txHash/orderId、`COMPLETED` 缺少合法 outcome、未知字段、私钥字段、非 `0600`、损坏 JSON 都必须失败。

- [ ] **Step 2: 运行测试，确认模块不存在**

Run: `node --test test/popdex-fill-close-journal.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现严格状态机**

固定阶段和分支：

```js
const NEXT = Object.freeze({
  PREPARED: new Set(['LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED', 'COMPLETED']),
  LEVERAGE_BROADCAST: new Set(['LEVERAGE_CONFIRMED', 'COMPLETED']),
  LEVERAGE_CONFIRMED: new Set(['ENTRY_BROADCAST', 'COMPLETED']),
  ENTRY_BROADCAST: new Set(['ENTRY_SETTLING', 'COMPLETED']),
  ENTRY_SETTLING: new Set(['REMAINDER_CANCEL_BROADCAST', 'POSITION_CONFIRMED', 'COMPLETED']),
  REMAINDER_CANCEL_BROADCAST: new Set(['POSITION_CONFIRMED', 'COMPLETED']),
  POSITION_CONFIRMED: new Set(['CLOSE_BROADCAST']),
  CLOSE_BROADCAST: new Set(['COMPLETED']),
});
```

记录 version=1，并严格白名单化：账户、Agent、symbol、symbolId、positionMode、leverage、price/qty WAD、client/order/position ID、四个 txHash、filled/remaining/position WAD、outcome、lastError 和 updatedAt。实现 `create`、`load`、`advance`、`recordError`、`clearCompleted`；只允许清除 `COMPLETED`。`outcome` 只允许 `completed-flat`、`zero-fill-cleared`、`safe-no-exposure`；其中 `safe-no-exposure` 只允许从未广播入场或入场回执精确失败的阶段写入。

在 `.gitignore` 增加：

```gitignore
.popdex-write-probe.json
.popdex-fill-close-probe.json
```

- [ ] **Step 4: 运行测试并提交**

Run: `node --test test/popdex-fill-close-journal.test.js`

Expected: PASS。

Commit:

```bash
git add .gitignore src/exchange/px/fill-close-journal.js test/popdex-fill-close-journal.test.js
git commit -m "实现：增加PopDEX成交平仓恢复状态机"
```

## Task 5: 扩展 Agent 写入器但保持旧探针行为

**Files:**
- Modify: `src/exchange/px/trading-client.js`
- Modify: `test/popdex-trading-client.test.js`
- Create: `test/popdex-fill-close-trading.test.js`

- [ ] **Step 1: 写失败测试：目标地址白名单及旧行为不变**

保留现有全部交易客户端测试，并增加：

```js
test('stage5 leverage writes once to UserConfig and confirms event plus readback', async () => {
  const result = await client.setBtcLeverageOne(plan, journal);
  assert.equal(Transaction.from(serialized[0]).to, POPDEX_USER_CONFIG_PRECOMPILE);
  assert.equal(serialized.length, 1);
  assert.equal(result.leverage, '1');
  assert.deepEqual(journal.advances.map((x) => x.next), ['LEVERAGE_BROADCAST', 'LEVERAGE_CONFIRMED']);
});
```

再覆盖：模拟 `0x`、ABI true、ABI false、错误 LeverageUpdated、事件成功但回读不是 1x、入场只广播一次、部分成交撤单只广播一次、Long=1 平仓只广播一次、未知目标地址广播前拒绝。

- [ ] **Step 2: 运行测试，确认新方法缺失**

Run:

```bash
node --test test/popdex-trading-client.test.js test/popdex-fill-close-trading.test.js
```

Expected: 新测试 FAIL，旧测试仍 PASS。

- [ ] **Step 3: 最小化泛化签名和提交路径**

把私有签名方法改为显式目标地址，并限制为两个预编译：

```js
#allowedTarget(to) {
  const target = strictAddress(to, 'write target');
  if (![POPDEX_ORDER_PRECOMPILE, POPDEX_USER_CONFIG_PRECOMPILE]
    .some((allowed) => sameAddress(allowed, target))) {
    throw new Error(`PopDEX 写入目标 ${target} 不在允许列表。`);
  }
  return target;
}

async #sign(to, data) {
  return this.wallet.signTransaction({
    to: this.#allowedTarget(to), data, value: 0n, chainId: POPDEX_CHAIN_ID,
    type: 0, nonce: this.#nextNonce(), gasLimit: LEGACY_GAS_LIMIT, gasPrice: LEGACY_GAS_PRICE,
  });
}
```

现有 `placeAndConfirm` 和 `cancelAndConfirm` 继续要求模拟精确返回 `0x`。只给新方法传入 `verifyStage5Simulation`，避免改变已验收协议。

- [ ] **Step 4: 增加四个第 5 阶段写方法**

导出的方法固定为：

```js
await client.setBtcLeverageOne(plan, journal);
await client.placeFillCloseEntry(plan, journal);
await client.cancelFillCloseRemainder(plan, order, journal);
await client.closeFillCloseLong(plan, journal);
```

每个方法都先 `preflight()`，模拟一次，签名后在广播前写入本地 txHash，只广播一次并核对远端 hash。杠杆方法解析唯一 `LeverageUpdated` 并回读 1x；入场解析唯一 `OrderCreate` 并保存官方 orderId；撤单解析唯一 `OrderCancel`；平仓只接受成功回执，业务成功留给仓位终态判定。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
node --test test/popdex-trading-client.test.js test/popdex-fill-close-trading.test.js
```

Expected: PASS，且旧 place/cancel 的目标地址、nonce、模拟空返回和恢复阶段断言不变。

Commit:

```bash
git add src/exchange/px/trading-client.js test/popdex-trading-client.test.js test/popdex-fill-close-trading.test.js
git commit -m "实现：增加PopDEX杠杆入场撤单和平仓写入"
```

## Task 6: 实现 CLI 参数和默认 dry-run

**Files:**
- Create: `src/exchange/px/fill-close-probe.js`
- Create: `test/popdex-fill-close-probe.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试：参数组合必须严格**

```js
assert.deepEqual(parseArgs([]), { mode: 'dry-run' });
assert.deepEqual(parseArgs(['--confirm-mainnet-fill-close']), { mode: 'fill-close' });
assert.deepEqual(parseArgs(['--resume']), { mode: 'resume' });
assert.deepEqual(parseArgs(['--resume', '--confirm-mainnet-cancel']), { mode: 'resume-cancel' });
assert.deepEqual(parseArgs(['--resume', '--confirm-mainnet-close']), { mode: 'resume-close' });
assert.throws(() => parseArgs(['--confirm-mainnet-write']), /不支持参数/);
assert.throws(() => parseArgs(['--resume', '--confirm-mainnet-fill-close']), /互斥/);
assert.throws(() => parseArgs(['--confirm-mainnet-close']), /必须与 --resume/);
```

- [ ] **Step 2: 写失败测试：dry-run 不签名、不广播、不写 journal**

模拟依赖返回：chain 2184、有效 Agent、positionMode 0、BTC leverage 20、活动订单 0、仓位 0、ask 63000、保证金 799。断言结果包含 `targetLeverage=1`、`price=63189`、`qty=0.0002` 和三个 calldata hash，并断言没有 `broadcast`、`journal.create` 或私钥输出。

- [ ] **Step 3: 运行测试，确认模块不存在**

Run: `node --test test/popdex-fill-close-probe.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 4: 实现 CLI 和只读预检**

`runProbe` 的 dry-run 顺序固定：读写 chain 校验、Agent 授权、BTC 市场身份、盘口、账户配置、完整活动订单、完整仓位、overview 保证金、纯计划计算、三段模拟。要求 `positionMode==='0'`，初始无订单/仓位，保证金不低于 1x 名义价值。

在 `package.json` 增加：

```json
"popdex:fill-close-probe": "node src/exchange/px/fill-close-probe.js"
```

并把 `test/popdex-fill-close-*.test.js` 逐个加入 `npm test` 的 `node --test` 参数。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
node --test test/popdex-fill-close-probe.test.js
npm run popdex:fill-close-probe
```

Expected: 单测 PASS；本地缺少真实环境时命令明确报缺少配置，且不创建 `.popdex-fill-close-probe.json`。

Commit:

```bash
git add package.json src/exchange/px/fill-close-probe.js test/popdex-fill-close-probe.test.js
git commit -m "实现：增加PopDEX成交平仓只读探针"
```

## Task 7: 实现模拟依赖下的完整写入闭环

**Files:**
- Modify: `src/exchange/px/fill-close-probe.js`
- Modify: `test/popdex-fill-close-probe.test.js`

- [ ] **Step 1: 写失败测试：杠杆已为 1x 的全成平仓路径**

用 fake clients 构造阶段序列并断言：

```js
assert.deepEqual(calls, [
  'journal:create', 'journal:LEVERAGE_CONFIRMED',
  'trading:entry', 'state:full-fill', 'journal:POSITION_CONFIRMED',
  'trading:close', 'state:completed-flat', 'journal:COMPLETED', 'journal:clear',
]);
assert.equal(result.status, 'completed-flat');
```

另测初始 20x 必须先完成 `setBtcLeverageOne`，且回读 1x 后才允许 entry。

- [ ] **Step 2: 写失败测试：部分成交先撤余单，零成交安全退出**

部分成交期望：entry → `partial-fill` → cancel remainder → 无活动订单 → 唯一多仓 → reverse close → flat。零成交期望：entry → cancel remainder → `COMPLETED(zero-fill-cleared)` → clear，且从未调用 close，也不视为验收成功。

- [ ] **Step 3: 写失败测试：任何冲突保留 journal 且不重试**

覆盖：杠杆回读失败、入场广播不确定、订单事实无法唯一映射、撤单后仍有剩余、仓位量与成交量不符、close 回执成功但仍有持仓、出现反向空仓。每个测试断言写方法调用次数最多一次、journal 保留在最后已广播阶段。

- [ ] **Step 4: 实现完整编排**

核心分支：

```js
async function readFacts({ accountClient, readRpc, mainAccount, plan, orderId, cancelConfirmed = false }) {
  let order = null;
  try {
    order = await accountClient.findUniqueOrderByClientId(mainAccount, plan.symbol, plan.clientOrderId);
  } catch (error) {
    if (error?.code !== 'POPDEX_ORDER_NOT_FOUND') throw error;
  }
  const [fills, openOrders, positions] = await Promise.all([
    accountClient.getAllFills(mainAccount, plan.symbol),
    accountClient.getAllOpenOrders(mainAccount, plan.symbol),
    readRpc.getAllOpenPositions(mainAccount),
  ]);
  return {
    orderId, order, fills: fills.filter((item) => String(item.orderId) === String(orderId)),
    openOrders, positions, cancelConfirmed,
  };
}

async function pollUntil({ read, done, now, sleep, timeoutMs = 30000, pollMs = 1000, label }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (now() >= deadline) throw new Error(`PopDEX ${label} 超过 ${timeoutMs}ms。`);
    await sleep(pollMs);
  }
}

if (currentLeverage === '1') journal.advance('PREPARED', 'LEVERAGE_CONFIRMED');
else await trading.setBtcLeverageOne(plan, journal);

const orderId = await trading.placeFillCloseEntry(plan, journal);
const entryFacts = await pollUntil({
  read: () => readFacts({ accountClient, readRpc, mainAccount, plan, orderId }),
  done: (facts) => classifyEntry(plan, facts).kind !== 'settling',
  now, sleep, label: '入场成交确认',
});
const entry = classifyEntry(plan, entryFacts);
if (entry.remainingQtyWad !== '0') {
  await trading.cancelFillCloseRemainder(plan, entryFacts.order, journal);
}
const settledFacts = await pollUntil({
  read: () => readFacts({
    accountClient, readRpc, mainAccount, plan, orderId,
    cancelConfirmed: journal.load().stage === 'REMAINDER_CANCEL_BROADCAST',
  }),
  done: (facts) => {
    const state = classifyEntry(plan, facts);
    return state.remainingQtyWad === '0'
      && !facts.openOrders.some((item) => String(item.orderId) === String(orderId));
  },
  now, sleep, label: '入场终态确认',
});
const settled = classifyEntry(plan, settledFacts);
if (settled.filledQtyWad === '0') {
  journal.advance(journal.load().stage, 'COMPLETED', { outcome: 'zero-fill-cleared' });
  journal.clearCompleted();
  return { status: 'zero-fill-cleared' };
}
const position = assertConfirmedLong(plan, settledFacts, settled.filledQtyWad);
journal.advance(journal.load().stage, 'POSITION_CONFIRMED', {
  filledQtyWad: settled.filledQtyWad,
  remainingQtyWad: settled.remainingQtyWad,
  positionId: position.positionId,
  positionSide: position.side,
  positionQtyWad: position.holdSizeWad,
});
await trading.closeFillCloseLong(plan, journal);
const flat = await pollUntil({
  read: async () => ({
    openOrders: await accountClient.getAllOpenOrders(mainAccount, plan.symbol),
    positions: await readRpc.getAllOpenPositions(mainAccount),
  }),
  done: (facts) => facts.openOrders.length === 0
    && facts.positions.every((item) => String(item.symbolId) !== '20000' || BigInt(item.holdSizeWad) === 0n),
  now, sleep, label: '平仓终态确认',
});
assertCompletedFlat(flat);
journal.advance('CLOSE_BROADCAST', 'COMPLETED', { outcome: 'completed-flat' });
journal.clearCompleted();
return { status: 'completed-flat' };
```

轮询必须使用注入的 `sleep` 和单调截止时间，默认 30 秒、1 秒间隔；超时只记录错误，不发第二笔交易。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/popdex-fill-close-probe.test.js`

Expected: PASS。

Commit:

```bash
git add src/exchange/px/fill-close-probe.js test/popdex-fill-close-probe.test.js
git commit -m "实现：完成PopDEX最小成交与平仓编排"
```

## Task 8: 实现只读恢复及独立恢复写授权

**Files:**
- Modify: `src/exchange/px/fill-close-probe.js`
- Modify: `test/popdex-fill-close-probe.test.js`

- [ ] **Step 1: 写失败测试：普通 resume 永远不写**

为 `LEVERAGE_BROADCAST`、`ENTRY_BROADCAST`、`ENTRY_SETTLING`、`REMAINDER_CANCEL_BROADCAST`、`POSITION_CONFIRMED`、`CLOSE_BROADCAST` 各写一个测试。`--resume` 只读取已保存 txHash 的回执和最新事实，断言 write client 未构造、journal 不倒退、无 broadcast。若尚未广播入场，或入场回执精确失败，并且完整查询证明 BTC 订单/成交/持仓均为零，则记录 `safe-no-exposure` 后清理；结果不得是 `completed-flat`。

- [ ] **Step 2: 写失败测试：恢复撤单必须满足精确前置条件**

只有存在活动的原订单、`remainingQtyWad>0`、orderId/clientOrderId/账户/市场/方向全部匹配且未有 cancelTxHash 时，`--resume --confirm-mainnet-cancel` 才能广播一次。已有 cancelTxHash 必须提示继续普通 `--resume`，禁止二次撤单。

- [ ] **Step 3: 写失败测试：恢复平仓必须满足精确前置条件**

只有 `POSITION_CONFIRMED`、无活动订单、唯一 BTC Long=1、持仓量等于 journal.positionQtyWad 且没有 closeTxHash 时，`--resume --confirm-mainnet-close` 才能广播一次。已有 closeTxHash、残余活动订单、空仓或反向仓位均拒绝。

- [ ] **Step 4: 实现恢复分派**

```js
if (options.mode === 'resume') return inspectRecovery(record, readDeps);
if (options.mode === 'resume-cancel') {
  const facts = await inspectRecovery(record, readDeps);
  assertRecoverableCancel(record, facts);
  return recoverCancelOnce(record, facts, writeDeps);
}
if (options.mode === 'resume-close') {
  const facts = await inspectRecovery(record, readDeps);
  assertRecoverableClose(record, facts);
  return recoverCloseOnce(record, facts, writeDeps);
}
```

恢复成功后仍必须通过相同终态证明再清理 journal。失败或超时保留 txHash 和阶段。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/popdex-fill-close-probe.test.js`

Expected: PASS，所有普通 resume 测试的 broadcast 次数为 0。

Commit:

```bash
git add src/exchange/px/fill-close-probe.js test/popdex-fill-close-probe.test.js
git commit -m "实现：增加PopDEX成交平仓安全恢复"
```

## Task 9: 更新协议文档并做全量回归

**Files:**
- Modify: `docs/protocol/popdex-mainnet-validation.md`
- Modify: `AGENTS.md`（仅当其中仍把 Extended 视为目标交易所或缺少阶段边界时）

- [ ] **Step 1: 更新协议事实和阶段状态**

在协议文档明确：

```text
UserConfig precompile = 0x0000000000000000000000000000000000001009
getAccountConfig / updateLeverage / LeverageUpdated 属于 UserConfig
updateLeverage category = Futures(2)，不得使用 OrderCategory.Regular(0)
Order precompile 0x1000 提供 placeOrder / cancelOrder / placeReverseOrder / positions
自动测试只完成离线闭环；Mainnet fill/close 仍待用户单独批准
```

不得把未执行的 Mainnet 测试写成已验证。

- [ ] **Step 2: 运行第 5 阶段定向测试**

Run:

```bash
node --test test/popdex-rpc-client.test.js test/popdex-account-client.test.js test/popdex-order-codec.test.js test/popdex-trading-client.test.js test/popdex-fill-close-codec.test.js test/popdex-fill-close-state.test.js test/popdex-fill-close-journal.test.js test/popdex-fill-close-trading.test.js test/popdex-fill-close-probe.test.js
```

Expected: PASS，0 failures。

- [ ] **Step 3: 运行完整测试**

Run:

```bash
npm test
```

Expected: grid tests 与全部 Node tests PASS，0 failures；Decibel、RISEx 和既有 PopDEX 测试无回归。

- [ ] **Step 4: 做静态安全检查**

Run:

```bash
git diff --check
rg -n "POPDEX_AGENT_PRIVATE_KEY|serializedTransaction|rawTransaction" .popdex-fill-close-probe.json src/exchange/px/fill-close-*.js test/popdex-fill-close-*.test.js
```

Expected: `git diff --check` 无输出；运行时恢复文件不存在，或存在时不包含私钥、签名和原始交易；源码只允许读取环境变量及测试中的假密钥，不允许日志/持久化写入。

- [ ] **Step 5: 验证默认命令不会写主网**

在没有 `--confirm-mainnet-fill-close` 的测试环境运行：

```bash
npm run popdex:fill-close-probe
```

Expected: 只输出 dry-run 计划；测试依赖下 writeMethodsCalled/broadcast 为 0。不得在开发机使用真实 Agent 环境执行任何确认参数。

- [ ] **Step 6: 提交文档与最终回归改动**

```bash
git add docs/protocol/popdex-mainnet-validation.md AGENTS.md package.json
git commit -m "文档：记录PopDEX成交平仓探针边界"
```

如果 `AGENTS.md` 和 `package.json` 在本任务没有最终差异，只添加实际改动文件，禁止空提交。

## Task 10: 实施完成后的审查与主网验收交接

**Files:**
- Read only: all files changed by Tasks 1-9

- [ ] **Step 1: 对照设计逐项审查**

确认：市场只能 BTCUSDT、杠杆只能 1x、方向只能 Buy/Long、价格保护为 ask+0.3%、部分成交先撤余单、零成交不重试、平仓使用 `placeReverseOrder(Long=1)`、恢复默认只读、最终必须无订单无多仓无空仓。

- [ ] **Step 2: 检查分支和提交范围**

Run:

```bash
git status --short --branch
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
```

Expected: 工作区干净；差异只涉及本计划列出的 PopDEX 文件、测试和文档。

- [ ] **Step 3: 停在实盘授权门前**

向用户提供 VPS dry-run 命令和预期字段，但不得执行：

```bash
npm run popdex:verify -- --account-env POPDEX_MAIN_ACCOUNT
npm run popdex:fill-close-probe
```

只有用户查看 dry-run 后再次明确批准，才允许在后续单独会话提供并执行：

```bash
npm run popdex:fill-close-probe -- --confirm-mainnet-fill-close
```

本实施计划完成条件是代码、测试、文档和 dry-run 就绪，不包含真实资金交易结果。
