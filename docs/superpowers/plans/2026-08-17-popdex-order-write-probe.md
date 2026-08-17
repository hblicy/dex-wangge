# PopDEX 单笔下单写入探针 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现默认只读、显式授权后才执行的 PopDEX Mainnet 单笔限价下单—链上订单确认—撤单—完成订单确认闭环。

**Architecture:** 保留现有 PopDEX 只读 RPC 和 Agent 授权边界，新增纯订单编码器、独立写 RPC 客户端、链上订单分页读取、安全恢复记录与 CLI 编排器。所有真实写入只从独立命令触发，不注册到 `GridBot`、服务器路由或网页；订单事实以 Order 预编译的活动/完成订单分页为准。

**Tech Stack:** Node.js 20+、ES modules、ethers 6.13.5、node:test、PopDEX Mainnet JSON-RPC/Order 预编译。

---

## 文件结构

- Create `src/exchange/px/order-codec.js`：订单参数校验、bytes32 标识、官方 ABI 和 calldata 编码。
- Create `src/exchange/px/write-rpc-client.js`：唯一允许 `eth_sendRawTransaction` 的窄写边界。
- Create `src/exchange/px/write-journal.js`：`.popdex-write-probe.json` 原子、0600 恢复记录。
- Create `src/exchange/px/trading-client.js`：Agent 预检、签名、回执、下单/撤单确认。
- Create `src/exchange/px/write-probe.js`：CLI 参数、dry-run、显式实盘与只读恢复编排。
- Modify `src/exchange/px/rpc-client.js`：链上活动/完成订单分页和严格解码。
- Modify `src/exchange/px/official-artifacts.js`：把订单查询函数纳入必须存在的官方协议证据。
- Modify `package.json`：增加独立脚本和新测试文件。
- Modify `README.md`、`.env.example`、`AGENTS.md`、`docs/protocol/popdex-mainnet-validation.md`：记录写入探针边界与操作顺序。
- Create `test/popdex-order-codec.test.js`、`test/popdex-write-rpc-client.test.js`、`test/popdex-write-journal.test.js`、`test/popdex-trading-client.test.js`、`test/popdex-write-probe.test.js`。
- Modify `test/popdex-rpc-client.test.js`、`test/popdex-official-artifacts.test.js`、`test/popdex-agent-isolation.test.js`。

### Task 1: 固定当前官方订单协议证据

**Files:**
- Modify: `src/exchange/px/official-artifacts.js`
- Modify: `test/popdex-official-artifacts.test.js`
- Modify: `docs/protocol/popdex-mainnet-validation.md`

- [ ] **Step 1: 先写失败测试，要求官方证据包含活动/完成订单查询**

在 `test/popdex-official-artifacts.test.js` 的协议 token 断言中加入：

```js
for (const token of [
  'getActiveOrdersByAccount',
  'getCompletedOrdersByAccount',
  'placeOrder',
  'cancelOrder',
]) {
  assert.ok(POPDEX_REQUIRED_PROTOCOL_TOKENS.includes(token), token);
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/popdex-official-artifacts.test.js`

Expected: FAIL，指出 `getActiveOrdersByAccount` 尚未包含在必须 token 中。

- [ ] **Step 3: 将两个查询函数加入硬门槛**

修改 `POPDEX_REQUIRED_PROTOCOL_TOKENS`：

```js
export const POPDEX_REQUIRED_PROTOCOL_TOKENS = Object.freeze([
  'approveAgent',
  'revokeAgent',
  'placeOrder',
  'cancelOrder',
  'getActiveOrdersByAccount',
  'getCompletedOrdersByAccount',
  'updateLeverage',
  'placeReverseOrder',
  'clientOrderId',
  POPDEX_ORDER_PRECOMPILE,
  POPDEX_ACCOUNT_PRECOMPILE,
]);
```

使用常量前从 `constants.js` 导入两个预编译地址，避免文档和扫描器重复硬编码。

- [ ] **Step 4: 运行本地测试和官方只读扫描**

Run: `node --test test/popdex-official-artifacts.test.js test/popdex-verify.test.js`

Expected: PASS。

Run: `npm run popdex:verify -- --artifacts-json`

Expected: 退出码 0，报告中同时找到 `placeOrder`、`cancelOrder`、`getActiveOrdersByAccount`、`getCompletedOrdersByAccount`，且 `writeMethodsCalled=0`。

- [ ] **Step 5: 更新协议证据文档**

在 `docs/protocol/popdex-mainnet-validation.md` 增加本次扫描时间、官方 chunk SHA-256，以及以下事实：

```text
getActiveOrdersByAccount(address,uint32,uint32) -> OrdersPage
getCompletedOrdersByAccount(address,uint32,uint32) -> OrdersPage
OrdersPage.orders contains walletId/orderId/clientOrderId/symbolId/side/status/
price/qty/filledQty/remainingQty/cancelledQty and hasMore.
```

如果官方扫描缺少任一函数，停止本计划，不实现写入。

- [ ] **Step 6: 提交协议证据**

```bash
git add src/exchange/px/official-artifacts.js test/popdex-official-artifacts.test.js docs/protocol/popdex-mainnet-validation.md
git commit -m "验证：固定PopDEX链上订单查询证据"
```

### Task 2: 实现严格订单编码器

**Files:**
- Create: `src/exchange/px/order-codec.js`
- Create: `test/popdex-order-codec.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写订单输入和固定 ABI 向量失败测试**

测试使用真实 ABI 解码 calldata，并要求：

```js
const plan = prepareProbeOrder({
  mainAccount: '0x1111111111111111111111111111111111111111',
  symbol: 'BTCUSDT',
  side: 'buy',
  price: '60000',
  qty: '0.0002',
  bid: '62900',
  ask: '62901',
  randomBytesImpl: () => Uint8Array.from({ length: 16 }, (_, i) => i + 1),
  nowMs: 1786946400000,
});
assert.equal(plan.symbolId, 20000);
assert.equal(plan.priceWad, parseUnits('60000', 18).toString());
assert.equal(plan.qtyWad, parseUnits('0.0002', 18).toString());
assert.match(plan.clientOrderId, /^0x[0-9a-f]{64}$/);

const decoded = POPDEX_ORDER_INTERFACE.decodeFunctionData('placeOrder', plan.data);
assert.equal(decoded.account, plan.mainAccount);
assert.equal(decoded.clientOrderId, plan.clientOrderId);
assert.equal(decoded.symbolId, 20000n);
assert.equal(decoded.orderParams, '0x0200000100000000000000000000000000000000000000000000000000000000');
```

另写表驱动拒绝测试：非白名单市场、非 buy/sell、未对齐 tick/lot、低于 `minQty`、低于 10 USDT、buy 不低于 bid、sell 不高于 ask、NaN/科学计数/负数/多余小数。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/popdex-order-codec.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 写最小纯编码实现**

`order-codec.js` 导出：

```js
export const POPDEX_ORDER_INTERFACE = new Interface([
  'function placeOrder(address account,bytes32 clientOrderId,uint16 symbolId,bytes32 orderParams,uint256 price,uint256 qty,uint256 slippage,address builder,uint256 builderFeeRate) returns (bool)',
  'function cancelOrder(address account,uint128 orderId,bytes32 clientOrderId) returns (bool)',
]);

export function encodeOrderParams(side) {
  const bytes = new Uint8Array(32);
  bytes[0] = 2; // Futures
  bytes[1] = 0; // Limit
  bytes[2] = side === 'buy' ? 0 : 1;
  bytes[3] = 1; // GTC
  return hexlify(bytes);
}
```

精度校验全部使用 `parseUnits(value, 18)` 后的 `bigint` 取模，不用浮点数：

```js
if (priceWad % parseUnits(expected.tickSize, 18) !== 0n) throw new Error(...);
if (qtyWad % parseUnits(expected.lotSize, 18) !== 0n) throw new Error(...);
if ((priceWad * qtyWad) / 10n ** 18n < parseUnits(expected.minNotional, 18)) throw new Error(...);
```

`clientOrderId` 使用固定输入哈希生成：

```js
const entropy = randomBytesImpl(16);
const clientOrderId = keccak256(concat([
  toUtf8Bytes(`dex-wangge:${symbol}:${side}:${nowMs}:`),
  entropy,
]));
```

取消编码只接受非零 `uint128` 十进制字符串和精确 bytes32。

- [ ] **Step 4: 运行编码测试并确认 GREEN**

Run: `node --test test/popdex-order-codec.test.js`

Expected: PASS。

- [ ] **Step 5: 将测试加入全量脚本并提交**

在 `package.json` 的 `test` 命令加入 `test/popdex-order-codec.test.js`。

```bash
git add src/exchange/px/order-codec.js test/popdex-order-codec.test.js package.json
git commit -m "功能：实现PopDEX限价单严格编码"
```

### Task 3: 增加链上活动/完成订单读取

**Files:**
- Modify: `src/exchange/px/rpc-client.js`
- Modify: `test/popdex-rpc-client.test.js`

- [ ] **Step 1: 写链上订单解码和分页失败测试**

用 ethers `Interface.encodeFunctionResult` 构造一个大于安全整数的订单：

```js
const order = {
  walletId: ACCOUNT,
  category: 2,
  source: 0,
  orderId: 90071992547409931234n,
  clientOrderId: `0x${'12'.repeat(32)}`,
  symbolId: 20000,
  side: 0,
  isReduceOnly: false,
  orderType: 0,
  timeInForce: 1,
  stpMode: 0,
  stpKey: ZeroAddress,
  status: 1,
  price: parseUnits('60000', 18),
  quantities: {
    qty: parseUnits('0.0002', 18), filledQty: 0n,
    remainingQty: parseUnits('0.0002', 18), cancelledQty: 0n,
    quoteQty: 0n, filledQuoteQty: 0n, remainingQuoteQty: 0n, cancelledQuoteQty: 0n,
  },
  averagePrice: 0n,
  nonce: 1786946400000n,
  createdAt: 1786946400000n,
  updatedAt: 1786946400000n,
  makerFeeRate: 0n,
  takerFeeRate: 0n,
};
```

断言 `getActiveOrders(account, 0, 100)` 返回所有整数为字符串、`hasMore` 为布尔值；测试 `findUniqueOrderByClientId` 遍历两页并拒绝零个、重复和字段冲突。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/popdex-rpc-client.test.js`

Expected: FAIL，`getActiveOrders` 不存在。

- [ ] **Step 3: 增加官方完整 OrdersPage ABI 和严格标准化**

在 `rpc-client.js` 增加 `ORDER_READ_INTERFACE`，包含：

```js
function getActiveOrdersByAccount(address account,uint32 offset,uint32 limit)
  view returns ((tuple(address walletId,uint8 category,uint8 source,uint128 orderId,
  bytes32 clientOrderId,uint16 symbolId,uint8 side,bool isReduceOnly,uint8 orderType,
  uint8 timeInForce,uint8 stpMode,address stpKey,uint8 status,uint256 price,
  tuple(uint256 qty,uint256 filledQty,uint256 remainingQty,uint256 cancelledQty,
  uint256 quoteQty,uint256 filledQuoteQty,uint256 remainingQuoteQty,
  uint256 cancelledQuoteQty) quantities,uint256 averagePrice,uint64 nonce,
  uint64 createdAt,uint64 updatedAt,uint256 makerFeeRate,uint256 takerFeeRate)[] orders,
  bool hasMore) page)
```

`getCompletedOrdersByAccount` 使用完全相同的返回结构。标准化函数必须核对 `walletId`、白名单 `symbolId`、bytes32 和数量恒等式：

```js
qty === filledQty + remainingQty + cancelledQty
```

标准化后的单个订单字段固定为：

```js
{
  walletId, category, source, orderId, clientOrderId, symbolId, side,
  isReduceOnly, orderType, timeInForce, stpMode, stpKey, status,
  priceWad, qtyWad, filledQtyWad, remainingQtyWad, cancelledQtyWad,
  quoteQtyWad, filledQuoteQtyWad, remainingQuoteQtyWad, cancelledQuoteQtyWad,
  averagePriceWad, nonce, createdAt, updatedAt, makerFeeRateWad, takerFeeRateWad,
}
```

地址和 bytes32 统一为小写十六进制；布尔值保持布尔值；其他链上整数全部使用十进制字符串，禁止转成 `number`。

新增：

```js
getActiveOrders(account, offset = 0, limit = 100)
getCompletedOrders(account, offset = 0, limit = 100)
findUniqueOrderByClientId(account, clientOrderId, { completed = false, maxPages = 10 })
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `node --test test/popdex-rpc-client.test.js test/popdex-verify.test.js`

Expected: PASS，且只读验证依然不调用写方法。

- [ ] **Step 5: 提交链上读取**

```bash
git add src/exchange/px/rpc-client.js test/popdex-rpc-client.test.js
git commit -m "功能：读取PopDEX链上活动与完成订单"
```

### Task 4: 建立独立写 RPC 边界

**Files:**
- Create: `src/exchange/px/write-rpc-client.js`
- Create: `test/popdex-write-rpc-client.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写模拟、广播和回执失败测试**

测试真实 JSON-RPC 信封，要求：

```js
await client.simulate({ from: AGENT, to: ORDER_PRECOMPILE, data: '0x1234', value: '0x0' });
assert.equal(request.method, 'eth_call');

const hash = await client.broadcast(`0x${'01'.repeat(120)}`);
assert.equal(request.method, 'eth_sendRawTransaction');
assert.equal(hash, `0x${'ab'.repeat(32)}`);
```

覆盖非官方 HTTPS 地址、非法原始交易、RPC error data、明确失败回执、超时和 `core_getTransactionFailure`。断言错误消息不包含 raw transaction。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/popdex-write-rpc-client.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现窄方法客户端**

只公开：

```js
verifyChain()
simulate(transaction)
broadcast(serializedTransaction)
getReceipt(txHash)
getTransactionFailure(txHash)
waitForReceipt(txHash, { timeoutMs = 30000, pollMs = 1000 })
```

内部私有 `#request` 只接受集合：

```js
new Set(['eth_chainId', 'eth_call', 'eth_sendRawTransaction',
  'eth_getTransactionReceipt', 'core_getTransactionFailure'])
```

`waitForReceipt` 仅接受 `status=0x1`；`0x0` 时读取失败原因并抛错，超时保留 txHash。任何路径不自动重新广播。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `node --test test/popdex-write-rpc-client.test.js test/popdex-rpc-client.test.js`

Expected: PASS。

- [ ] **Step 5: 加入全量测试并提交**

```bash
git add src/exchange/px/write-rpc-client.js test/popdex-write-rpc-client.test.js package.json
git commit -m "功能：增加PopDEX独立写RPC边界"
```

### Task 5: 实现安全恢复记录

**Files:**
- Create: `src/exchange/px/write-journal.js`
- Create: `test/popdex-write-journal.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写阶段、原子性和权限失败测试**

测试允许阶段：

```js
const STAGES = ['PREPARED', 'BROADCAST', 'OPEN_CONFIRMED',
  'CANCEL_BROADCAST', 'CANCEL_CONFIRMED'];
```

断言 POSIX 写入顺序为临时文件 `0600`、`renameSync`、最终 `chmodSync(0o600)`；非法字段、私钥字段、阶段回退和现有未完成记录均被拒绝。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/popdex-write-journal.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现固定 schema 和单向阶段转换**

导出：

```js
export class PopdexWriteJournal {
  constructor({ file, fsImpl = fs, platform = process.platform, now = () => Date.now() })
  load()
  create(orderPlan)
  advance(expectedStage, nextStage, fields = {})
  clearCompleted()
}
```

只保存设计文档允许的字段；用 `JSON.stringify(record, null, 2)` 写临时文件后原子重命名。`clearCompleted()` 只允许当前阶段为 `CANCEL_CONFIRMED`，其他阶段不能删除。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `node --test test/popdex-write-journal.test.js test/persist.test.js test/security.test.js`

Expected: PASS。

- [ ] **Step 5: 加入全量测试并提交**

```bash
git add src/exchange/px/write-journal.js test/popdex-write-journal.test.js package.json
git commit -m "功能：持久化PopDEX写入恢复记录"
```

### Task 6: 实现 Agent 下单和撤单确认客户端

**Files:**
- Create: `src/exchange/px/trading-client.js`
- Create: `test/popdex-trading-client.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写预检、签名和闭环失败测试**

使用固定测试私钥和注入的 fake RPC，覆盖：

```js
const result = await client.placeAndConfirm(plan);
assert.equal(result.orderId, '90071992547409931234');
assert.equal(result.clientOrderId, plan.clientOrderId);

const cancelled = await client.cancelAndConfirm(result);
assert.equal(cancelled.filledQtyWad, '0');
assert.equal(cancelled.cancelledQtyWad, plan.qtyWad);
assert.equal(cancelled.remainingQtyWad, '0');
```

用 `Transaction.from(serialized)` 断言签名交易：`from=Agent`、`to=OrderPrecompile`、`chainId=2184`、legacy、`nonce=nowMs`、`gasLimit=1000000`、`gasPrice=0`。覆盖授权不存在/过期/global/delegator 冲突、模拟失败、回执失败、订单零个/重复/字段冲突、取消后仍活动、完成订单有成交。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/popdex-trading-client.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现预检和单次签名广播**

构造函数：

```js
new PopdexTradingClient({
  mainAccount,
  agentPrivateKey,
  readRpc,
  writeRpc,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})
```

`preflight()` 必须依次验证 chain、Agent 地址、`getAgentInfo`、delegator、过期时间和 `isGlobal=false`。

签名交易固定为：

```js
await wallet.signTransaction({
  to: POPDEX_ORDER_PRECOMPILE,
  data,
  value: 0n,
  chainId: 2184,
  type: 0,
  nonce: nowMs,
  gasLimit: 1_000_000n,
  gasPrice: 0n,
});
```

每次写入顺序固定为 `simulate -> sign -> 计算本地 txHash -> journal.advance -> broadcast -> waitForReceipt -> on-chain unique match`。`journal.advance` 必须在广播前把确定性的 txHash 和目标阶段（下单为 `BROADCAST`，撤单为 `CANCEL_BROADCAST`）原子落盘；即使进程在广播调用期间崩溃，恢复流程也只能按 txHash 和链上订单事实查询，不得调用第二次 `broadcast`。RPC 返回的 txHash 必须与本地 `keccak256(serializedTransaction)` 完全相同，否则保留恢复记录并失败。

- [ ] **Step 4: 实现链上订单核对**

活动订单必须满足：

```js
walletId === mainAccount
symbolId === String(plan.symbolId)
side === (plan.side === 'buy' ? '0' : '1')
priceWad === plan.priceWad
qtyWad === plan.qtyWad
filledQtyWad === '0'
```

完成订单撤单确认必须满足 `filledQty=0`、`remainingQty=0`、`cancelledQty=qty`。任一不符抛出包含阶段和订单 ID 的错误。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `node --test test/popdex-trading-client.test.js test/popdex-agent-service.test.js test/popdex-rpc-client.test.js`

Expected: PASS。

- [ ] **Step 6: 加入全量测试并提交**

```bash
git add src/exchange/px/trading-client.js test/popdex-trading-client.test.js package.json
git commit -m "功能：实现PopDEX Agent下单撤单闭环"
```

### Task 7: 实现默认 dry-run 的命令行探针

**Files:**
- Create: `src/exchange/px/write-probe.js`
- Create: `test/popdex-write-probe.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写参数和默认不写入失败测试**

测试：

```js
const result = await main([
  '--symbol', 'BTCUSDT', '--side', 'buy',
  '--price', '60000', '--qty', '0.0002',
], fakeDependencies());
assert.equal(result.mode, 'dry-run');
assert.equal(fake.writeMethodsCalled, 0);
```

覆盖缺参数、重复参数、未知参数、`--confirm-mainnet-write`、`--resume` 与下单参数互斥、环境变量缺失、未完成 journal 阻止新写入、输出脱敏和进程退出码。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/popdex-write-probe.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现参数解析和依赖注入入口**

导出：

```js
export function parseArgs(argv) { ... }
export async function runProbe(options, dependencies = {}) { ... }
export async function main(argv = process.argv.slice(2), dependencies = {}) { ... }
```

默认依赖使用 `loadEnv`、`PopdexPublicClient`、`PopdexRpcClient`、`PopdexWriteRpcClient`、`PopdexTradingClient` 和 `PopdexWriteJournal`。只有 `options.confirmMainnetWrite === true` 才构造写 RPC 客户端。

dry-run 输出：symbol、side、price、qty、bid/ask、symbolId、Agent/主账户掩码、授权有效期、`clientOrderId` 和 calldata 哈希；不输出私钥、完整签名或原始交易。

- [ ] **Step 4: 实现实盘和只读恢复编排**

实盘流程：

```js
const open = await trading.placeAndConfirm(plan, journal);
const cancelled = await trading.cancelAndConfirm(open, journal);
journal.clearCompleted();
return { mode: 'mainnet-write', open, cancelled };
```

`--resume` 只读取 journal，并查询活动/完成订单：

- 找到活动订单：打印官方 `orderId`，要求用户到 PopDEX 人工撤单；不自动写。
- 找到完成且零成交订单：按允许的单向转换依次补齐 `OPEN_CONFIRMED -> CANCEL_BROADCAST -> CANCEL_CONFIRMED`（已有阶段跳过），每一步都记录同一条链上完成订单证据，然后允许清理；禁止直接绕过阶段校验。
- 找到任何成交：打印成交量并要求人工处理仓位。
- 两处都找不到：报告事实不完整并保留 journal。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run: `node --test test/popdex-write-probe.test.js`

Expected: PASS，dry-run 的 fake `writeMethodsCalled=0`。

- [ ] **Step 6: 增加 npm 脚本并提交**

```json
"popdex:write-probe": "node src/exchange/px/write-probe.js"
```

```bash
git add src/exchange/px/write-probe.js test/popdex-write-probe.test.js package.json
git commit -m "功能：增加PopDEX显式实盘写入探针"
```

### Task 8: 更新产品边界、操作文档和隔离测试

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Modify: `test/popdex-agent-isolation.test.js`
- Modify: `test/popdex-verify.test.js`

- [ ] **Step 1: 写文档和隔离失败测试**

断言：

```js
assert.match(readme, /popdex:write-probe/);
assert.match(readme, /--confirm-mainnet-write/);
assert.match(readme, /尚未.*PopDEX.*网格/s);
assert.match(agents, /单笔.*下单.*撤单.*探针/s);
assert.doesNotMatch(server, /createPxExchange|new GridBot\([^\n]*px|\/api\/px\/(?:start|stop|orders)/i);
```

只读验证器继续拒绝 `--place`、`--cancel`、`--private-key`，写入只能使用独立命令。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/popdex-agent-isolation.test.js test/popdex-verify.test.js`

Expected: FAIL，README/AGENTS 尚未记录新边界。

- [ ] **Step 3: 更新文档**

README 必须给出顺序：

```bash
npm run popdex:verify
npm run popdex:verify -- --account-env POPDEX_MAIN_ACCOUNT
npm run popdex:write-probe -- --symbol BTCUSDT --side buy --price <盘口外价格> --qty <满足10 USDT的数量>
npm run popdex:write-probe -- --symbol BTCUSDT --side buy --price <同一价格> --qty <同一数量> --confirm-mainnet-write
```

明确：最后一条会发送真实订单并自动尝试撤单；运行前网页不得有不明挂单/持仓；失败时使用 `--resume` 只读检查；本阶段仍未开放 PopDEX 网格。

`.env.example` 只补充命令说明，不新增主钱包私钥或 Token。AGENTS 将产品边界改为“只读 + Agent 授权 + 显式单笔写入探针；未注册交易所、未开放自动网格”。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `node --test test/popdex-agent-isolation.test.js test/popdex-verify.test.js test/security.test.js`

Expected: PASS。

- [ ] **Step 5: 提交文档边界**

```bash
git add README.md .env.example AGENTS.md test/popdex-agent-isolation.test.js test/popdex-verify.test.js
git commit -m "文档：说明PopDEX单笔写入验收边界"
```

### Task 9: 全量验证与交付

**Files:**
- Verify only; no production edits unless a test exposes a root cause.

- [ ] **Step 1: 运行全部自动测试**

Run: `npm test`

Expected: grid tests 和全部 Node tests PASS，0 failed；测试不得访问主网或调用 `eth_sendRawTransaction`。

- [ ] **Step 2: 运行格式和工作树检查**

```bash
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: 无空白错误，只有计划内提交，工作树干净。

- [ ] **Step 3: 运行真实公开/账户只读验证**

```bash
npm run popdex:verify
npm run popdex:verify -- --account-env POPDEX_MAIN_ACCOUNT
```

Expected: 公共和账户只读验证通过，`writeMethodsCalled=0`。不得在开发机或自动测试中运行 `--confirm-mainnet-write`。

- [ ] **Step 4: 进行安全差异自查**

检查 `origin/main...HEAD`：

- 没有 `.env`、私钥、Token、原始签名或用户账户数据。
- Decibel/RISEx 文件没有非测试性改动。
- `src/server.js` 没有 PopDEX 交易路由或启动入口。
- 只有 `write-rpc-client.js` 能调用 `eth_sendRawTransaction`。
- dry-run 和只读验证路径无法构造写客户端。

- [ ] **Step 5: 提交计划执行记录（仅文档确有变化时）**

如协议验证时间或主网只读结果需要同步：

```bash
git add docs/protocol/popdex-mainnet-validation.md
git commit -m "验证：更新PopDEX主网只读验收记录"
```

- [ ] **Step 6: 推送并创建 Draft PR**

```bash
git push -u origin codex/popdex-order-write-probe
gh pr create --draft --base main --head codex/popdex-order-write-probe --title "功能：增加 PopDEX 单笔下单写入探针" --body-file <UTF-8正文文件>
```

PR 必须注明：自动测试没有广播真实交易；合并前需要用户在 VPS 依次完成 dry-run、BTC 最小订单闭环和 ETH 最小订单闭环。

---

## 实盘验收门槛

代码完成不等于 PopDEX 网格可用。只有用户在 VPS 明确运行 `--confirm-mainnet-write`，并且 BTCUSDT、ETHUSDT 都完成“活动订单可见—官方 orderId 确认—零成交撤单—完成订单确认”，才能进入下一份“成交/仓位/平仓/网格适配器”设计和计划。
