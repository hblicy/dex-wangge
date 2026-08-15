# RISEx Mainnet Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `dex-wangge` 中启用只支持 RISEx mainnet `BTC-PERP` / `ETH-PERP` 的实盘适配器，并用官方 Orders/Fills WebSocket 与 REST 对账确定成交、撤单、平仓和重启恢复结果。

**Architecture:** `RisexExchange` 继续遵守现有 `IExchange` 契约，`risex-client@0.1.11` 仅负责 EIP-712 permit 写请求和已审计的 REST 客户端；新增 `RisexPrivateStream` 直接实现官方 `auth_v2` 与私有 Orders/Fills 订阅；新增纯逻辑 `RisexOrderState` 合并、去重并验证订单状态。任何私有流断开或状态不确定都会从 `READY` 切到 `RECONCILING`/`HALTED` 并阻止新增风险，绝不使用“订单从开放列表消失即成交”。

**Tech Stack:** Node.js 20 ESM、`node:test`、`risex-client@0.1.11`、`ethers@6.13.5`、`undici` WebSocket、现有 EventEmitter/GridBot/HTTP 服务。

---

## 实施约束

- 目标分支固定为 `codex/risex-mainnet-adapter`，不在 `main` 上直接开发。
- 官方协议以 [WebSocket auth_v2](https://developer.rise.trade/reference/javascripttypescript)、[Orders Channel](https://developer.rise.trade/reference/orders-channel) 和 [Fills Channel](https://developer.rise.trade/reference/fills-channel) 为准。
- 自动化阶段不得读取用户真实密钥，也不得发真实下单、撤单、调杠杆或平仓请求。
- `npm run risex:verify -- --private` 只能由用户在 VPS 上执行；实现者只运行公共只读验证。
- 所有订单 ID、fill ID、resting order ID、client order ID 都保持字符串，禁止先转成 JavaScript `Number`。
- 每完成一个任务先跑任务级测试，再提交中文 commit；失败必须保留原始原因和可定位日志。

## Task 1: 固定依赖、mainnet 配置和 live 工厂入口

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config.js`
- Modify: `src/exchange/rs/index.js`
- Modify: `test/startup.test.js`

- [ ] **Step 1: 记录基线并确认分支**

Run:

```bash
git status --short --branch
npm test
```

Expected: 当前分支为 `codex/risex-mainnet-adapter`，工作区干净；现有 77 个测试全部通过。

- [ ] **Step 2: 把禁用实盘的启动测试改为安全入口测试**

在 `test/startup.test.js` 删除三个“RISEx live 已禁用/依赖不存在”测试，新增：

```js
test('RISEx live requires mainnet account and signer credentials', () => {
  assert.throws(
    () => createRsExchange({ mode: 'live', network: 'mainnet' }),
    /RISEX_ACCOUNT.*RISEX_SIGNER_KEY/,
  );
});

test('RISEx live rejects non-mainnet network and non-official endpoints', () => {
  const base = {
    mode: 'live', network: 'mainnet',
    account: '0x0000000000000000000000000000000000000001', signerKey: `0x${'11'.repeat(32)}`,
    apiUrl: 'https://api.rise.trade', wsUrl: 'wss://api.rise.trade/ws/',
  };
  assert.throws(() => createRsExchange({ ...base, network: 'testnet' }), /只支持 mainnet/);
  assert.throws(() => createRsExchange({ ...base, apiUrl: 'https://proxy.invalid' }), /RISEX_API_URL/);
  assert.throws(() => createRsExchange({ ...base, wsUrl: 'wss://proxy.invalid/ws/' }), /RISEX_WS_URL/);
});

test('RISEx paper remains available without live credentials', () => {
  assert.equal(createRsExchange({ mode: 'paper', startBalance: 1000 }).mode, 'paper');
});
```

- [ ] **Step 3: 运行测试确认其因 live 仍被禁用而失败**

Run:

```bash
node --test test/startup.test.js
```

Expected: 新的 live 构造测试失败，错误仍为“RISEx 实盘已禁用”。

- [ ] **Step 4: 精确安装并锁定依赖**

Run:

```bash
npm install --save-exact risex-client@0.1.11 ethers@6.13.5
```

Expected: `package.json` 中两个版本没有 `^`/`~`；`package-lock.json` 根依赖和包节点都是精确版本。

- [ ] **Step 5: 更新配置默认值和变量名**

在 `src/config.js` 将 RISEx 配置替换为：

```js
const rsNet = (process.env.RS_NETWORK || 'mainnet').toLowerCase();
if (rsNet !== 'mainnet') throw new Error('RISEx 只支持 mainnet，RS_NETWORK 必须为 mainnet。');

const rs = {
  mode: (process.env.RS_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
  network: rsNet,
  account: process.env.RISEX_ACCOUNT || '',
  signerKey: process.env.RISEX_SIGNER_KEY || '',
  apiUrl: process.env.RISEX_API_URL || 'https://api.rise.trade',
  wsUrl: process.env.RISEX_WS_URL || 'wss://api.rise.trade/ws/',
  startBalance: Number(process.env.PAPER_BALANCE || 10000),
  proxy: process.env.RISEX_PROXY || globalProxy,
};
```

不保留 `ACCOUNT_ADDRESS` / `SIGNER_PRIVATE_KEY` 隐式别名，避免 VPS 实际读取了错误凭据却不易察觉。

- [ ] **Step 6: 实现 live 工厂的显式校验**

在 `src/exchange/rs/index.js` 导入 `RisexExchange` 并导出配置校验器：

```js
import { PaperExchange } from './paper.js';
import { RisexExchange } from './risex.js';

export const RISEX_MAINNET_API = 'https://api.rise.trade';
export const RISEX_MAINNET_WS = 'wss://api.rise.trade/ws/';

export function assertRisexLiveConfig(cfg) {
  if (cfg.network !== 'mainnet') throw new Error('RISEx 实盘只支持 mainnet。');
  if (!cfg.account || !cfg.signerKey) {
    throw new Error('RISEx LIVE 模式需要 RISEX_ACCOUNT 和 RISEX_SIGNER_KEY。');
  }
  if (cfg.apiUrl !== RISEX_MAINNET_API) throw new Error(`RISEX_API_URL 必须为 ${RISEX_MAINNET_API}`);
  if (cfg.wsUrl !== RISEX_MAINNET_WS) throw new Error(`RISEX_WS_URL 必须为 ${RISEX_MAINNET_WS}`);
}

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    assertRisexLiveConfig(cfg);
    return new RisexExchange(cfg);
  }
  return new PaperExchange({ apiUrl: cfg.apiUrl, startBalance: cfg.startBalance });
}
```

- [ ] **Step 7: 运行启动测试与完整回归**

Run:

```bash
node --test test/startup.test.js
npm test
```

Expected: 启动测试和当前完整测试通过；此时 `RisexExchange.init()` 仍可在后续任务前明确失败，不能假装 READY。

- [ ] **Step 8: 提交**

```bash
git add package.json package-lock.json src/config.js src/exchange/rs/index.js test/startup.test.js
git commit -m "配置：启用受限的RISEx主网入口"
```

## Task 2: 严格解析官方市场、Orders 和 Fills 消息

**Files:**
- Create: `src/exchange/rs/normalize.js`
- Create: `test/risex-normalize.test.js`

- [ ] **Step 1: 写 WAD、市场和消息解析失败测试**

新建 `test/risex-normalize.test.js`，覆盖以下输入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRisexMarkets, parseOrderEnvelope, parseFillEnvelope, wadToNumber,
  normalizeRestOpenOrder, normalizeRestOrderHistory, normalizeRestFill, normalizeRestPosition,
} from '../src/exchange/rs/normalize.js';

test('wadToNumber parses signed 18-decimal integer strings only', () => {
  assert.equal(wadToNumber('61788900000000000000000', 'price'), 61788.9);
  assert.equal(wadToNumber('2600000000000000', 'size'), 0.0026);
  assert.throws(() => wadToNumber('0.0026', 'size'), /18 位 WAD 整数字符串/);
});

test('market normalization exposes exactly BTC-PERP and ETH-PERP', () => {
  const markets = normalizeRisexMarkets([
    { market_id: '1', display_name: 'BTC-USD', base_asset_symbol: 'BTC', last_price: '60000', config: { step_size: '0.0001', step_price: '0.1', min_order_size: '0.001', max_leverage: '50' } },
    { market_id: '2', display_name: 'ETH-USD', base_asset_symbol: 'ETH', last_price: '3000', config: { step_size: '0.001', step_price: '0.01', min_order_size: '0.01', max_leverage: '50' } },
    { market_id: '3', display_name: 'SOL-USD', base_asset_symbol: 'SOL', last_price: '100', config: { step_size: '0.1', step_price: '0.01', min_order_size: '1', max_leverage: '20' } },
  ]);
  assert.deepEqual(markets.map((m) => m.displayName), ['BTC-PERP', 'ETH-PERP']);
});

test('market normalization rejects missing, duplicate, unsafe or invalid targets', () => {
  const btc = { market_id: '1', display_name: 'BTC-USD', base_asset_symbol: 'BTC', last_price: '60000', config: { step_size: '0.0001', step_price: '0.1', min_order_size: '0.001', max_leverage: '50' } };
  const eth = { market_id: '2', display_name: 'ETH-USD', base_asset_symbol: 'ETH', last_price: '3000', config: { step_size: '0.001', step_price: '0.01', min_order_size: '0.01', max_leverage: '50' } };
  assert.throws(() => normalizeRisexMarkets([btc]), /缺少 ETH-PERP/);
  assert.throws(() => normalizeRisexMarkets([btc, { ...btc, market_id: '9' }, eth]), /BTC-PERP.*重复/);
  assert.throws(() => normalizeRisexMarkets([{ ...btc, market_id: String(Number.MAX_SAFE_INTEGER + 1) }, eth]), /market_id/);
  assert.throws(() => normalizeRisexMarkets([btc, { ...eth, config: { ...eth.config, step_size: '0' } }]), /step_size/);
});

test('orders parser preserves string IDs, WAD values and cursor', () => {
  const [order] = parseOrderEnvelope({
    channel: 'orders', type: 'update', block_number: 12, log_index: 3, timestamp: '99',
    data: [{ id: '90071992547409931234', market_id: '1', side: 'BUY', size: '1000000000000000000', price: '60000000000000000000000', filled_size: '250000000000000000', avg_price: '59900000000000000000000', status: 'ORDER_STATUS_OPEN', sender: '0xabc', block_number: '12', log_index: '3' }],
  });
  assert.equal(order.orderId, '90071992547409931234');
  assert.equal(order.status, 'PARTIAL');
  assert.equal(order.filledSize, 0.25);
  assert.deepEqual(order.cursor, { block: 12n, log: 3n, timestamp: 99n });
});

test('parsers reject unknown status, malformed IDs, impossible amounts and missing fill identity', () => {
  const raw = {
    id: 'o1', market_id: '1', side: 'BUY', size: '1000000000000000000',
    price: '100000000000000000000', filled_size: '0', avg_price: '0',
    status: 'ORDER_STATUS_OPEN', sender: '0xabc', block_number: '1', log_index: '0',
  };
  const envelope = (order) => ({ channel: 'orders', type: 'update', timestamp: '1', data: [order] });
  assert.throws(() => parseOrderEnvelope(envelope({ ...raw, status: 'ORDER_STATUS_NONE' })), /ORDER_STATUS_NONE/);
  assert.throws(() => parseOrderEnvelope(envelope({ ...raw, id: '' })), /订单 ID/);
  assert.throws(() => parseOrderEnvelope(envelope({ ...raw, filled_size: '2000000000000000000' })), /超过订单总量/);
  assert.throws(() => parseFillEnvelope({
    channel: 'fills', type: 'update', data: [{ order_id: 'o1', market_id: '1', side: 'BUY', size: '100000000000000000', price: '100000000000000000000' }],
  }), /fill_id.*cursor/);
});

test('REST normalizers preserve IDs and convert ticks, steps and decimal amounts explicitly', () => {
  const market = { marketId: 1, stepPrice: 0.1, stepSize: 0.001 };
  const open = normalizeRestOpenOrder({
    order_id: '90071992547409931234', resting_order_id: '77', market_id: 1,
    side: 0, price_ticks: 600001, size_steps: 3, reduce_only: false,
  }, market);
  assert.deepEqual({ ...open, price: 60000.1, sizeBase: 0.003 }, {
    orderId: '90071992547409931234', restingOrderId: '77', marketId: 1,
    side: 'buy', price: 60000.1, sizeBase: 0.003, reduceOnly: false,
  });
  assert.ok(Math.abs(open.price - 60000.1) < 1e-9);
  assert.ok(Math.abs(open.sizeBase - 0.003) < 1e-12);
  assert.equal(normalizeRestOrderHistory({ order_id: 'o1', market_id: '1', side: 0, size: '1', price: '100', filled_size: '0.25', status: 'CANCELLED', timestamp: '10' }).filledSize, 0.25);
  assert.equal(normalizeRestFill({ fill_id: 'f1', order_id: 'o1', market_id: '1', side: 0, size: '0.25', price: '99', timestamp: '11' }).fillId, 'f1');
  assert.equal(normalizeRestPosition({ market_id: '1', side: 1, size: '0.5', entry_price: '100', unrealized_pnl: '2', leverage: '3' }).sizeBase, -0.5);
});

test('REST normalizers reject missing resting IDs, unknown status and incomplete nonzero positions', () => {
  const market = { marketId: 1, stepPrice: 0.1, stepSize: 0.001 };
  assert.throws(() => normalizeRestOpenOrder({ order_id: 'o1', market_id: 1, side: 0, price_ticks: 1, size_steps: 1 }, market), /resting_order_id/);
  assert.throws(() => normalizeRestOrderHistory({ order_id: 'o1', market_id: '1', side: 0, size: '1', price: '100', filled_size: '0', status: 'MYSTERY', timestamp: '10' }), /MYSTERY/);
  assert.throws(() => normalizeRestPosition({ market_id: '1', side: 0, size: '1', entry_price: '' }), /entry_price/);
});
```

- [ ] **Step 2: 运行测试确认模块不存在**

Run:

```bash
node --test test/risex-normalize.test.js
```

Expected: `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现严格解析模块**

`src/exchange/rs/normalize.js` 导出 `wadToNumber(raw, field)`、`normalizeRisexMarkets(rawMarkets)`、`parseOrderEnvelope(message)`、`parseFillEnvelope(message)`、`compareRisexCursor(left, right)`，以及 `normalizeRestOpenOrder(raw, market)`、`normalizeRestOrderHistory(raw)`、`normalizeRestFill(raw)`、`normalizeRestPosition(raw)`。前五个负责严格 WAD/市场/WS/cursor 解析，后四个负责 `risex-client` REST 返回结构。REST 的 `price_ticks`/`size_steps` 只通过已验证市场元数据换算；历史/成交的十进制字符串只用严格 `Number` 校验转换；任何必填字段缺失都抛错。内部校验 helper 不导出。

标准化订单结构固定为：

```js
{
  orderId: String(raw.id),
  marketId: Number(raw.market_id),
  side: raw.side === 'BUY' ? 'buy' : 'sell',
  sizeBase: wadToNumber(raw.size, 'size'),
  price: wadToNumber(raw.price, 'price'),
  filledSize: wadToNumber(raw.filled_size, 'filled_size'),
  avgPrice: wadToNumber(raw.avg_price, 'avg_price'),
  status, // OPEN / PARTIAL / FILLED / CANCELLED
  sender: raw.sender.toLowerCase(),
  cursor: {
    block: BigInt(raw.block_number ?? message.block_number),
    log: BigInt(raw.log_index ?? message.log_index),
    timestamp: BigInt(message.timestamp ?? message.block_timestamp),
  },
}
```

`ORDER_STATUS_OPEN` 且 `filledSize > 0` 归一为 `PARTIAL`；`ORDER_STATUS_FILLED` 和 `ORDER_STATUS_CANCELLED` 保持终态；其他值直接抛错。fill ID 优先使用官方 `fill_id`，没有时只允许用完整的 `orderId:block:log:timestamp` 生成稳定键。所有 envelope 必须校验 `channel`、`type`、`data` 数组、目标 market ID 和 sender/account 由调用方再次比对。

- [ ] **Step 4: 运行测试并检查没有宽松兜底**

Run:

```bash
node --test test/risex-normalize.test.js
```

Expected: 全部通过；非法数据抛错而不是返回 `[]`、`0` 或猜测字段。

- [ ] **Step 5: 提交**

```bash
git add src/exchange/rs/normalize.js test/risex-normalize.test.js
git commit -m "测试：固定RISEx官方消息解析边界"
```

## Task 3: 实现纯订单状态机和终态一次性成交

**Files:**
- Create: `src/exchange/rs/order-state.js`
- Create: `test/risex-order-state.test.js`

- [ ] **Step 1: 写完整状态矩阵测试**

在 `test/risex-order-state.test.js` 使用固定 helper `order(status, filledSize, cursor)` 和 `fill(fillId, sizeBase, price, cursor)`，分别测试：

1. `OPEN -> FILLED` 返回一次 `terminalFill`，重复终态返回 `null`。
2. `OPEN -> CANCELLED(0)` 终止但没有成交。
3. `OPEN -> PARTIAL -> FILLED` 只在 FILLED 返回总实际数量。
4. `OPEN -> PARTIAL -> CANCELLED` 返回部分成交数量。
5. 重复 fill ID 不累计，两个不同 fill ID 正确累计加权价。
6. 较旧 cursor 的 Orders/Fills 被忽略；相同 cursor 内容冲突抛错。
7. 累计成交倒退、超过原始数量、市场/方向/总量变更、未知状态均抛错。
8. fill 先于 `track()` 时先缓存，track 后合并；未知订单超过启动屏障后必须由调用方视为未知，不能自动认领。

核心断言示例：

```js
const state = new RisexOrderState();
state.track({ orderId: 'o1', marketId: 1, side: 'buy', sizeBase: 1, price: 100, levelIndex: 2 });
state.applyOrder(order('OPEN', 0, [1, 0, 1]));
state.applyFill(fill('f1', 0.25, 99, [2, 0, 2]));
state.applyOrder(order('OPEN', 0.25, [2, 1, 3]));
const result = state.applyOrder(order('CANCELLED', 0.25, [3, 0, 4]));
assert.deepEqual(result.terminalFill, {
  orderId: 'o1', marketId: 1, side: 'buy', price: 99,
  sizeBase: 0.25, levelIndex: 2, clientOrderId: undefined,
});
assert.equal(state.applyOrder(order('CANCELLED', 0.25, [3, 0, 4])), null);
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/risex-order-state.test.js
```

Expected: `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现状态机公共接口**

`src/exchange/rs/order-state.js` 只导出 `RisexOrderState`。公共方法固定为 `track(meta)`、`adopt(meta)`、`applyOrder(update)`、`applyFill(update)`、`seedOpen(order, meta = null)`、`get(orderId)`、`getOpen(marketId)`、`forget(orderId)` 和 `unknownOrderIds()`；所有 Map、cursor 和去重集合保持私有，不暴露可变引用。

内部每个订单保存：`meta`、`status`、`reportedFilled`、`fillSum`、`fillValue`、`seenFillIds`、`lastOrderCursor`、`terminalEmitted`。实现终态时使用如下规则，不允许用 open-list disappearance：

```js
if (update.status === 'FILLED' || update.status === 'CANCELLED') {
  record.status = update.status;
  record.terminalEmitted = true;
  const sizeBase = update.filledSize;
  const exactFillPrice = update.avgPrice > 0
    ? update.avgPrice
    : (record.fillSum === sizeBase && record.fillSum > 0 ? record.fillValue / record.fillSum : null);
  if (sizeBase > 0 && !(exactFillPrice > 0)) {
    throw new Error(`订单 ${record.orderId} 已终态但缺少可确认的实际成交均价。`);
  }
  return {
    terminal: true,
    terminalFill: sizeBase > 0 ? {
      orderId: record.orderId,
      marketId: record.marketId,
      side: record.side,
      sizeBase,
      levelIndex: record.meta?.levelIndex,
      clientOrderId: record.meta?.clientOrderId,
      price: exactFillPrice,
    } : null,
  };
}
```

使用与 `stepSize` 相匹配的绝对容差（默认 `1e-12`，track 时可传 `sizeTolerance`）比较数量；任何倒退/超量必须抛出带 order ID、旧值、新值和 cursor 的错误。

- [ ] **Step 4: 跑矩阵测试**

```bash
node --test test/risex-order-state.test.js
```

Expected: 所有转换、去重和非法状态用例通过，终态只返回一次。

- [ ] **Step 5: 提交**

```bash
git add src/exchange/rs/order-state.js test/risex-order-state.test.js
git commit -m "功能：实现RISEx订单终态状态机"
```

## Task 4: 实现官方 auth_v2 私有 WebSocket

**Files:**
- Create: `src/exchange/rs/private-stream.js`
- Create: `test/risex-private-stream.test.js`

- [ ] **Step 1: 写 fake socket/fetch 的协议测试**

测试必须覆盖：

- GET 顺序为 `/v1/auth/eip712-domain`、`/v1/auth/nonce?account=...`。
- chain ID 不是官方主网当前值 `4153`、domain 名称不是 `RISEx`、字段缺失或 verifying contract 非地址时拒绝认证。
- 签名 primary type 为 `RegisterV2`，字段类型是 address/string/uint256。
- 首帧为 `auth_v2`，收到 `{method:'auth_v2',status:'success'}` 后才发送 orders/fills subscribe。
- orders subscribe 包含 BTC/ETH market IDs 和当前 account maker；fills 由认证会话自动限定账户。
- 认证失败最多重试 3 次，每次重新取 nonce；session signer 无效时立即停止。
- 收到 Orders/Fills 前调用 Task 2 解析器；非法消息触发 `fatal`，不得静默丢弃。
- `beginBuffering()` 后消息不 emit；`drainBuffered()` 按 cursor 顺序返回；`releaseBuffer()` 后才实时 emit。
- socket close 发出 `disconnected`，指数退避延时为 1s/2s/4s/8s，最大 30s；显式 `stop()` 不重连。

断言认证帧时必须确认输出对象不包含 signer 私钥：

```js
assert.deepEqual(JSON.parse(socket.sent[0]), {
  method: 'auth_v2',
  params: {
    account: ACCOUNT,
    signer: SIGNER_ADDRESS,
    message: 'sign in with RISEx',
    nonce: '0x01',
    expiration: 1800000000,
    signature: '0xsigned',
  },
});
assert.doesNotMatch(JSON.stringify(socket.sent), new RegExp(SIGNER_KEY.slice(2)));
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/risex-private-stream.test.js
```

Expected: `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现可注入依赖的私有流**

`RisexPrivateStream` 继承 `EventEmitter`。构造参数固定包含 `account`、`signerKey`、`apiUrl`、`wsUrl`、`marketIds`，并允许注入 `fetchImpl`、`WebSocketImpl`、`walletFactory`、`isSignerRegistered`、`now`、`setTimer`、`clearTimer`。公共方法固定为异步 `connect()`、`waitForOrderSnapshot()`，同步 `beginBuffering()`、`drainBuffered()`、`releaseBuffer()`、`stop()`；事件固定为 `authenticated`、`order`、`fill`、`disconnected`、`fatal`。

生产默认 `WebSocket` 必须来自 `undici`，默认 wallet 是 `new ethers.Wallet(signerKey)`。认证代码按官方协议实现：

```js
const domainBody = await getJson(`${apiUrl}/v1/auth/eip712-domain`);
const nonceBody = await getJson(`${apiUrl}/v1/auth/nonce?account=${encodeURIComponent(account)}`);
const domain = {
  name: domainBody.data.name,
  version: domainBody.data.version,
  chainId: BigInt(domainBody.data.chain_id),
  verifyingContract: domainBody.data.verifying_contract,
};
assertMainnetDomain(domain);
const nonce = `0x${String(nonceBody.data.nonce).replace(/^0x/, '')}`;
const message = { signer: wallet.address, message: 'sign in with RISEx', nonce };
const signature = await wallet.signTypedData(domain, {
  RegisterV2: [
    { name: 'signer', type: 'address' },
    { name: 'message', type: 'string' },
    { name: 'nonce', type: 'uint256' },
  ],
}, message);
socket.send(JSON.stringify({
  method: 'auth_v2',
  params: { account, signer: wallet.address, message: message.message, nonce,
    expiration: Math.floor(now() / 1000) + 365 * 24 * 60 * 60, signature },
}));
```

每条日志只记录连接状态、channel、market IDs、重试号、耗时和错误；不得打印 `signerKey`、完整 signature 或完整 auth frame。

- [ ] **Step 4: 运行私有流测试**

```bash
node --test test/risex-private-stream.test.js
```

Expected: 协议顺序、认证重试、缓存、重连和敏感信息检查全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/exchange/rs/private-stream.js test/risex-private-stream.test.js
git commit -m "功能：接入RISEx官方私有订单流"
```

## Task 5: 重写适配器初始化、市场白名单和启动同步屏障

**Files:**
- Rewrite: `src/exchange/rs/risex.js`
- Create: `test/risex-adapter.test.js`
- Modify: `src/server.js`
- Modify: `test/startup.test.js`

- [ ] **Step 1: 写初始化与遗留状态测试**

使用 fake `InfoClient`、fake `ExchangeClient`、fake private stream 注入 `RisexExchange`，覆盖：

- 依赖版本不是 `0.1.11` 时 init 失败。
- `ExchangeClient.init()` 后 `isSignerRegistered()` 不是 true 时失败。
- 只返回两个目标市场，缺一个、重复一个或字段非法时失败。
- private stream 未认证/没有 Orders snapshot 时失败。
- REST 开放订单、订单历史、成交历史、仓位、余额全部完成并与缓存 WS 合并后才 `READY`。
- 没有运行快照但 BTC/ETH 存在挂单或非零仓位时 `HALTED`。
- 有运行快照时只允许快照内 ID；额外人工订单、另一个目标市场订单、无法在开放/历史中确认的快照 ID 都 `HALTED`。
- 停机期间已经终态的快照订单暂存为待派发成交，不在 init 阶段直接 emit。

生产类构造注入面固定为：

```js
new RisexExchange(config, {
  infoFactory,
  clientFactory,
  streamFactory,
  packageVersion = '0.1.11',
  now,
  sleep,
  defer,
});
```

- [ ] **Step 2: 运行测试确认旧轮询实现不符合要求**

```bash
node --test test/risex-adapter.test.js
```

Expected: 初始化测试失败；旧代码仍抛“实盘已禁用”或缺少注入接口。

- [ ] **Step 3: 删除旧的 disappearance 轮询并建立状态骨架**

`src/exchange/rs/risex.js` 不保留 `_graceMs`、`goneAttempts`、`neverReached` 或“从 open 列表消失判成交”代码。骨架字段至少包括：

```js
this.mode = 'live';
this.dataSource = null;
this.connectionState = 'RECONCILING';
this.haltReason = null;
this.markets = new Map();
this.orderState = new RisexOrderState();
this._positions = new Map();
this._prices = new Map();
this._writeQueue = Promise.resolve();
this._bulkCancel = false;
this._expectedSnapshot = null;
this._pendingRecoveryTerminals = new Map();
this.lastOkAt = 0;
this.lastRestAt = 0;
this.lastOrderAt = 0;
```

生产构造路径使用 `createRequire(import.meta.url).resolve('risex-client')` 找到实际入口，向父目录查找最近的 `package.json`，读取实际 `version` 并要求严格等于 `0.1.11`；只有测试注入路径允许用 `packageVersion` 覆盖。找不到包元数据、JSON 无效或版本不匹配都在初始化第一步抛错。

实现 `_setState(next, reason)`，每次状态迁移记录旧状态、新状态、原因和时间；`HALTED` 不得自动回到 READY。

- [ ] **Step 4: 给 server 提前传入恢复上下文**

在 `src/server.js` 只加载一次三个 snapshot，并在初始化之前调用：

```js
const snapshots = {
  de: loadSnapshot('de'),
  ex: loadSnapshot('ex'),
  rs: loadSnapshot('rs'),
};
rsExchange.setRecoverySnapshot?.(snapshots.rs);
deBot.restore(snapshots.de);
exBot.restore(snapshots.ex);
rsBot.restore(snapshots.rs);
```

`setRecoverySnapshot(snapshot)` 只提取 `running`、目标 `displayName`、`marketId` 和 `active` 中的字符串订单 ID/网格元数据；不要把整个对象长期保留，也不要把任何配置凭据写进状态。

- [ ] **Step 5: 实现 init 同步屏障**

init 顺序必须写成显式步骤并分别记录耗时：

```js
await this._assertDependencyVersion();
await this._client.init();
if (await this._client.isSignerRegistered() !== true) throw new Error('RISEx session signer 未注册或已失效。');
await this._loadMarkets();
this._stream.beginBuffering();
await this._stream.connect();
await this._stream.waitForOrderSnapshot();
const snapshot = await this._readRestSnapshot();
this._seedRestSnapshot(snapshot);
for (const event of this._stream.drainBuffered()) this._applyPrivateEvent(event);
this._validateRecoveryOwnership(snapshot);
this._stream.releaseBuffer();
this.dataSource = 'real';
this.lastOkAt = this._now();
this._setState('READY', '私有流认证和 REST/WS 对账完成');
```

`_readRestSnapshot()` 必须对两个允许市场调用开放订单、近期订单历史、近期成交历史，并调用全账户仓位、余额；任一请求失败都中止 init。开放订单缺失只能通过明确终态历史解释，否则 HALT。

- [ ] **Step 6: 运行初始化测试和启动回归**

```bash
node --test test/risex-adapter.test.js test/startup.test.js
```

Expected: 初始化屏障、市场限制、signer 与遗留状态测试全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/exchange/rs/risex.js src/server.js test/risex-adapter.test.js test/startup.test.js
git commit -m "功能：实现RISEx实盘启动同步屏障"
```

## Task 6: 实现确定性下单和终态成交派发

**Files:**
- Modify: `src/exchange/rs/risex.js`
- Modify: `test/risex-adapter.test.js`

- [ ] **Step 1: 写下单和立即成交竞态测试**

覆盖：

- 非 `READY`、批量撤单屏障中、非 BTC/ETH market ID 时拒绝下单。
- 价格/数量不能整除 tick/step 时按最近合法档位取整，结果仍必须大于零和不小于 min size。
- client order ID 用 `crypto.randomBytes(8)` 生成无符号 uint64 十进制字符串，禁止 `Math.random()`。
- 两个并发 `placeLimitOrder()` 的 fake client 最大并发数恒为 1。
- `setLeverage()` 也走同一写队列；SDK 请求失败、空响应或现有仓位回读的 leverage 不一致时返回失败/抛错，不能向 GridBot 返回 true。
- 响应缺少非空字符串 `order_id` 立即 `HALTED`。
- Orders 事件先于 `placeLimitOrder()` Promise 返回时先缓存，下一 microtask 才派发，调用方已有 active tracking。
- OPEN/PARTIAL 不 emit fill；FILLED 或部分成交后 CANCELLED 只 emit 一次真实总量。
- 确认超时后只查 REST 订单历史；仍未知则 `HALTED`，绝不根据 open 缺失推测。

- [ ] **Step 2: 运行目标测试确认失败**

```bash
node --test --test-name-pattern="RISEx place|RISEx terminal|RISEx partial" test/risex-adapter.test.js
```

Expected: 新增用例失败。

- [ ] **Step 3: 实现统一写队列和 READY 门禁**

```js
_assertWritable(action, marketId) {
  if (this.connectionState !== 'READY') throw new Error(`RISEx ${action} 已拒绝：${this.connectionState} ${this.haltReason || ''}`.trim());
  if (this._bulkCancel) throw new Error(`RISEx ${action} 已拒绝：正在批量撤单。`);
  if (!this.markets.has(Number(marketId))) throw new Error(`RISEx ${action} 已拒绝：只允许 BTC-PERP/ETH-PERP。`);
}

_serialWrite(label, fn) {
  const run = this._writeQueue.then(() => this._timedWrite(label, fn));
  this._writeQueue = run.catch(() => undefined);
  return run;
}
```

队列尾部只为继续串行而吞掉 Promise rejection；原始 `run` 必须原样 reject 给调用方并由 `_timedWrite` 记录错误，不得返回成功兜底。

- [ ] **Step 4: 实现 placeLimitOrder**

写请求固定字段：Limit、GTC、`post_only: false`（保持现有行为）、调用方 `reduceOnly`、STP ExpireTaker、无 TTL。收到响应后先 `orderState.track(meta)`，再合并同 ID 的早到 WS 事件，最后返回 `{orderId}`。确认等待固定为 10 秒；超时后查 `getOrderHistory(account, marketId, 100)`，未找到时 `_halt()` 并抛错。

- [ ] **Step 5: 连接状态机终态到统一 fill 事件**

```js
_applyOrder(update) {
  this.lastOrderAt = this._now();
  const result = this.orderState.applyOrder(update);
  if (!result?.terminal) return;
  if (result.terminalFill) {
    const suppressRequote = this._bulkCancel;
    this._defer(() => this.emit('fill', {
      ...result.terminalFill,
      suppressRequote,
    }));
  }
}
```

`_applyFill` 只交给状态机累计/验证，不直接向 GridBot emit；补反向单只能由 Orders 终态触发。

- [ ] **Step 6: 跑下单/成交测试**

```bash
node --test test/risex-order-state.test.js test/risex-adapter.test.js
```

Expected: 串行、立即成交、部分成交和确认超时测试全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/exchange/rs/risex.js test/risex-adapter.test.js
git commit -m "功能：实现RISEx确定性下单与成交确认"
```

## Task 7: 实现撤单、批量撤单、平仓确认和补单抑制

**Files:**
- Modify: `src/exchange/rs/risex.js`
- Modify: `src/exchange/rs/types.js`
- Modify: `src/bot.js`
- Modify: `test/risex-adapter.test.js`
- Modify: `test/bot.test.js`

- [ ] **Step 1: 写适配器写屏障测试**

覆盖：

- `cancelOrder` 从 REST open order 取字符串 `resting_order_id`，请求失败或终态未知时保留 tracking。
- 撤单竞态若变为 FILLED，返回已终态并正常 emit 真实 fill。
- `cancelAll` 期间 place 立即拒绝；取消响应后反复读取目标市场 open orders，只有归零才 true。
- `cancelAll` 期间终态成交的 fill 带 `suppressRequote: true`。
- open orders 在有界重试后不为零时进入 HALTED 并抛错，tracking 保留。
- `closePosition` 先调用已确认的 cancelAll，再按仓位反方向调用 SDK `placeOrder`，且对 long/short 两种方向都明确传 `reduce_only: true`；只有 REST 仓位连续两次为零才 true。
- close 返回但仓位仍非零或 REST 失败时 HALTED/抛错。

- [ ] **Step 2: 写 GridBot 不补单测试**

在 `test/bot.test.js` 新增：

```js
test('bulk-cancel fill is accounted but never re-quoted', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start(config);
  const [orderId, order] = [...bot.active.entries()][0];
  const beforePlacements = exchange.nextId;
  exchange.emit('fill', {
    orderId, marketId: config.marketId, side: order.side,
    price: order.price, sizeBase: 0.25, levelIndex: order.levelIndex,
    suppressRequote: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exchange.nextId, beforePlacements);
  assert.equal(bot.fills[0].size, 0.25);
});
```

- [ ] **Step 3: 确认测试先失败**

```bash
node --test --test-name-pattern="cancel|bulk|close|never re-quoted" test/risex-adapter.test.js test/bot.test.js
```

Expected: 新用例失败。

- [ ] **Step 4: 实现确认式撤单**

`cancelOrder()` 不得预删 tracking。写客户端返回 `success === true` 后，等待 Orders 终态；超时查订单历史。明确 `CANCELLED` 或 `FILLED` 才返回 true，其他结果抛错并保留状态。

`cancelAll()` 使用 `try/finally` 管理 `_bulkCancel`，但若确认失败必须先 `_halt(reason)`；在确认期间每次 REST 结果记录剩余 ID，不打印账户或签名。只检查调用的目标 market ID，不调用无 market 参数的全账户 cancel-all。

- [ ] **Step 5: 实现平仓确认**

`closePosition(marketId)` 先 `await cancelAll(marketId)` 并读取当前仓位，按 `stepSize` 计算绝对 `size_steps`，再走统一写队列调用 SDK `placeOrder()`。long 发 SELL、short 发 BUY，字段固定为 Market、IOC、`price_ticks: 0`、`post_only: false`、`reduce_only: true`、STP ExpireTaker、无 TTL。以 `InfoClient.getPosition(marketId, account)` 回读，数量为零或 null 连续两次才返回 true；禁止调用 SDK convenience `closePosition()`，因为其 BUY 分支没有显式传入 reduce-only，也禁止只根据 SDK 响应宣称成功。

- [ ] **Step 6: 扩展 Fill 契约并抑制补单**

在 `src/exchange/rs/types.js` 将 Fill 文档改为：

```js
// Fill { orderId, marketId, side, price, sizeBase, levelIndex, clientOrderId,
//        suppressRequote? }
```

在 `GridBot._handleFill()` 只改补单判断：

```js
if (!isRecovery && !f.suppressRequote && this.grid) {
  const repl = replacementFor({ side: f.side, levelIndex }, this.grid.levels, this.config.mode);
  if (repl && !this.outOfRange && this.running) {
    repl.opening = closing;
    if (fillSize > 0) repl.sizeBase = fillSize;
    this._place(repl);
  }
}
```

统计、成交记录和真实成交数量盈亏仍照常更新。

- [ ] **Step 7: 运行目标测试和 bot 回归**

```bash
node --test test/risex-adapter.test.js test/bot.test.js
```

Expected: 撤单、批量屏障、平仓确认和补单抑制全部通过，原有 bot 测试无回归。

- [ ] **Step 8: 提交**

```bash
git add src/exchange/rs/risex.js src/exchange/rs/types.js src/bot.js test/risex-adapter.test.js test/bot.test.js
git commit -m "安全：确认RISEx撤单平仓并阻止竞态补单"
```

## Task 8: 实现断线重连、REST 对账和可观测健康状态

**Files:**
- Modify: `src/exchange/rs/risex.js`
- Modify: `src/bot.js`
- Modify: `test/risex-adapter.test.js`
- Modify: `test/bot.test.js`

- [ ] **Step 1: 写连接状态测试**

覆盖：

- stream `disconnected` 立即进入 RECONCILING，并使 place/setLeverage/cancel 写请求拒绝。
- stream 重新认证后先 buffer，再做完整 REST snapshot merge，完成前不 READY。
- REST/WS 对同 ID、filled size、cursor 矛盾时 HALTED；一致后恢复 READY。
- 私有订单消息和 REST 成功时间超过 30 秒时健康状态 error/warn 并阻止新增风险。
- HALTED 后即使 socket 恢复也不自动 READY。
- `reconnect()` 重建客户端和流但不撤挂单、不平仓，成功前仍 RECONCILING。
- 日志包含状态迁移、订单 ID、cursor、REST/WS 计数、耗时；不包含 signer key/signature。

- [ ] **Step 2: 写 GridBot 健康透传测试**

fake exchange 增加：

```js
getHealth() {
  return {
    status: 'error', reason: 'RISEx 私有流断开', privateStream: 'disconnected',
    reconciling: true, unknownOrders: 1, lastOrderAgeMs: 31000, lastRestAgeMs: 1000,
  };
}
```

断言 `bot.getState().health` 原样包含 RISEx 扩展字段，且通用 `placeFails` / `exchangeOpenOrders` 仍存在。

- [ ] **Step 3: 实现 adapter health 与重连协调**

`getHealth()` 返回：

```js
{
  status, reason,
  privateStream: this._stream?.authenticated ? 'authenticated' : 'disconnected',
  reconciling: this.connectionState === 'RECONCILING',
  halted: this.connectionState === 'HALTED',
  unknownOrders: this.orderState.unknownOrderIds().length,
  lastOrderAgeMs: age(this.lastOrderAt),
  lastRestAgeMs: age(this.lastRestAt),
}
```

`_health()` 若 exchange 有 `getHealth()`，优先采用其 `status/reason` 和扩展字段，再合并通用字段；其他交易所行为保持原样。

- [ ] **Step 4: 实现 start/stop/reconnect 和只读刷新**

`start()` 只启动价格、仓位、余额定时读取；`stop()` 关闭 timer 和 socket，不触发任何写操作。定时任务失败必须更新 health 和 emit error，不得用 `catch {}` 静默保留旧值。重连完成的 REST merge 使用 Task 5 相同函数，不能另写宽松路径。

- [ ] **Step 5: 运行测试**

```bash
node --test test/risex-private-stream.test.js test/risex-adapter.test.js test/bot.test.js
```

Expected: 重连、熔断、健康透传和敏感日志测试全部通过。

- [ ] **Step 6: 提交**

```bash
git add src/exchange/rs/risex.js src/bot.js test/risex-adapter.test.js test/bot.test.js
git commit -m "功能：增加RISEx重连熔断与健康状态"
```

## Task 9: 完成重启接管和停机期间成交恢复

**Files:**
- Modify: `src/exchange/rs/risex.js`
- Modify: `src/recovery.js`
- Modify: `test/risex-adapter.test.js`
- Modify: `test/startup.test.js`

- [ ] **Step 1: 写恢复契约测试**

覆盖：

- 快照 ID 仍 OPEN：`adoptOrder()` 补入 level/client 元数据，`fetchOpenOrders()` 返回该订单。
- 快照 ID 停机期间 FILLED：`adoptOrder()` 后用 `queueMicrotask` 派发一次真实成交数量和平均价；GridBot listener 和 active map 已就绪。
- 快照 ID 停机期间部分成交后 CANCELLED：派发一次部分数量。
- 明确 CANCELLED(0)：移除，不 emit fill。
- open/history/fills 都找不到：HALTED，不调用 cancelAll。
- 官方存在快照外订单：HALTED，不自动 adopt 或 cancel。
- `resumeRunningSnapshot()` 在 adapter 为 HALTED 时直接拒绝，保留交易所状态供人工处理。

- [ ] **Step 2: 运行恢复测试确认失败**

```bash
node --test --test-name-pattern="recover|resume|downtime|adopt" test/risex-adapter.test.js test/startup.test.js
```

Expected: 新用例失败。

- [ ] **Step 3: 实现恢复终态延迟派发**

`adoptOrder(meta)` 必须匹配 Task 5 已准备的官方记录：

```js
adoptOrder(meta) {
  const id = String(meta.orderId);
  this.orderState.adopt({ ...meta, orderId: id });
  const terminal = this._pendingRecoveryTerminals.get(id);
  if (!terminal) return;
  this._pendingRecoveryTerminals.delete(id);
  this._defer(() => {
    if (terminal.terminalFill) this.emit('fill', terminal.terminalFill);
  });
}
```

`fetchOpenOrders()` 必须来自最近成功的官方 REST/WS 状态；如处于 RECONCILING/HALTED 或数据过期则抛错，不能返回旧数组让 GridBot 误判对账成功。

- [ ] **Step 4: 在通用恢复入口增加健康门禁**

在 `src/recovery.js` 的 `resumeRunningSnapshot()` 中，在调用 `bot.resume()` 前检查：

```js
const health = exchange.getHealth?.();
if (health?.halted) throw new Error(`恢复失败：${health.reason || '交易所处于 HALTED'}`);
```

不在失败分支自动撤单；是否清理由现有 server 上层处理，但 RISEx HALTED 的 cancelAll 自身会拒绝未知状态，避免误清人工订单。

- [ ] **Step 5: 跑恢复和完整 adapter 测试**

```bash
node --test test/risex-adapter.test.js test/startup.test.js test/bot.test.js
```

Expected: 停机成交只派发一次，未知状态不被清理或认领。

- [ ] **Step 6: 提交**

```bash
git add src/exchange/rs/risex.js src/recovery.js test/risex-adapter.test.js test/startup.test.js
git commit -m "安全：完成RISEx重启接管与停机成交恢复"
```

## Task 10: 增加公共/私有只读验证命令

**Files:**
- Create: `src/exchange/rs/verify.js`
- Create: `test/risex-verify.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写验证命令无写操作测试**

fake InfoClient/stream 记录方法名，覆盖：

- 公共模式检查 dependency version、EIP-712 domain/chain、两个市场、两个 orderbook 和公共 WS 首条消息。
- 公共模式不读取 `RISEX_ACCOUNT`/`RISEX_SIGNER_KEY`，也不构造 ExchangeClient。
- `--private` 必须有 account/signer，校验 signer status、私有 WS auth、余额、BTC/ETH open orders/positions/trade history。
- 私有模式也不构造 ExchangeClient，不存在 place/cancel/leverage/close 方法调用。
- 输出只显示 signer address 后 6 位掩码、订单计数和仓位摘要，不显示 signer key/signature/auth frame。
- 任一检查失败进程 exit code 为 1，成功为 0。

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/risex-verify.test.js
```

Expected: `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现可测试的验证函数与 CLI**

模块只导出三个异步函数：`verifyRisexPublic(deps = {})`、`verifyRisexPrivate(config, deps = {})`、`main(argv = process.argv.slice(2))`。前两个返回结构化检查结果供测试和 CLI 渲染，`main` 根据是否包含 `--private` 选择路径并设置 `process.exitCode`。

私有验证直接使用 `InfoClient`、`ethers.Wallet` 和 `RisexPrivateStream`，不创建 `ExchangeClient`，从结构上保证只读。`main()` 仅在 `import.meta.url === pathToFileURL(process.argv[1]).href` 时执行，便于单元测试导入。

- [ ] **Step 4: 注册脚本和默认测试**

`package.json`：

```json
"scripts": {
  "start": "node src/server.js",
  "test": "node test/grid.test.js && node --test test/security.test.js test/bot.test.js test/exchange-adapters.test.js test/startup.test.js test/persist.test.js test/risex-normalize.test.js test/risex-order-state.test.js test/risex-private-stream.test.js test/risex-adapter.test.js test/risex-verify.test.js",
  "risex:verify": "node src/exchange/rs/verify.js"
}
```

- [ ] **Step 5: 跑验证命令测试；只运行公共 mainnet 验证**

```bash
node --test test/risex-verify.test.js
npm test
npm run risex:verify
```

Expected: 单元/回归测试通过；公共验证显示 chain ID、BTC/ETH market ID、orderbook 和公共 WS 成功。不要运行 `--private`。

- [ ] **Step 6: 提交**

```bash
git add src/exchange/rs/verify.js test/risex-verify.test.js package.json
git commit -m "工具：增加RISEx主网只读验证命令"
```

## Task 11: 更新环境模板、启动预检和上线文档

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `src/server.js`
- Modify: `src/startup.js`
- Modify: `AGENTS.md`
- Modify: `test/startup.test.js`

- [ ] **Step 1: 写启动预检测试或提取可测试 helper**

把 server 的三交易所凭据收集提取到 `src/startup.js` 的纯函数 `collectMissingLiveCredentials(cfg)`，由 `src/server.js` 导入使用；测试 RS live 缺 account/signer 会列出 `RISEX_ACCOUNT`、`RISEX_SIGNER_KEY`，paper 不要求。

- [ ] **Step 2: 更新 `.env.example`**

RISEx 段固定为：

```dotenv
# RISEx 仅支持 mainnet 实盘；实盘只开放 BTC-PERP / ETH-PERP
RS_MODE=paper
RS_NETWORK=mainnet

# RS_MODE=live 时必填：独立 RISEx 账户与已注册 session signer
RISEX_ACCOUNT=
RISEX_SIGNER_KEY=

# live 模式必须保持官方地址，不支持自定义代理域名
RISEX_API_URL=https://api.rise.trade
RISEX_WS_URL=wss://api.rise.trade/ws/
```

- [ ] **Step 3: 更新 README 所有过时边界**

逐项修改现有“RISEx 仅 paper/禁止 live”描述：

- 功能表改为三所均支持 paper/live，但 RISEx live 只支持 mainnet BTC/ETH。
- 第七节增加独立账户、session signer、官方 endpoint、`npm run risex:verify` 和用户执行 `--private` 步骤。
- 配置表加入新变量，删除旧的“只能 paper”。
- 恢复章节说明 REST/WS 屏障、HALTED 和不自动猜测/撤销未知订单。
- 安全清单说明独立小资金账户、不能与人工/其他机器人共享、日志保存位置和人工验收七步。
- 目录树把 `rs/` 改为 `live + paper + private WS/order state`。
- 明确停止 Node 进程不会自动撤掉交易所挂单；正常停止应先在面板执行停止/一键撤单并确认。

- [ ] **Step 4: 更新 package 描述、server 提示和 AGENTS 产品边界**

`package.json.description` 不再声称 RISEx 仅模拟盘。server 凭据错误提示三种 mode 都给出正确回退方式。`AGENTS.md` 增加一个简短“当前产品边界”段：RISEx live 只允许 mainnet BTC/ETH、私有 Orders/Fills+REST 是事实来源、禁止 disappearance 推测和自动运行真实写验证。

- [ ] **Step 5: 搜索过时说法并跑文档相关测试**

Run:

```bash
git grep -n -E "RISEx.*仅.*paper|RISEx.*仅.*模拟|RISEx 实盘已禁用|RS_MODE.*必须保持.*paper|risex\.trade|ACCOUNT_ADDRESS|SIGNER_PRIVATE_KEY"
node --test test/startup.test.js test/security.test.js
```

Expected: grep 无过时产品文案/旧变量/旧域名（历史设计文档引用除外，应逐条人工确认）；测试通过。

- [ ] **Step 6: 提交**

```bash
git add .env.example README.md package.json src/server.js src/startup.js AGENTS.md test/startup.test.js
git commit -m "文档：补充RISEx主网上线与安全边界"
```

## Task 12: 全量验证、安全差异审查和交付

**Files:**
- Review: 所有本分支改动
- Update if findings require: 对应实现/测试/文档文件

- [ ] **Step 1: 格式和测试验证**

Run:

```bash
git diff --check main...HEAD
npm test
```

Expected: 无空白错误，所有测试通过。记录实际测试数量和耗时供交付说明使用。

- [ ] **Step 2: 公共 mainnet 只读验证**

Run:

```bash
npm run risex:verify
```

Expected: 官方 mainnet chain/domain、BTC/ETH markets、orderbook、公共 WS 全部成功；无任何账户或写请求。若 VPS/沙箱无网络，只报告网络限制，不伪造结果。

- [ ] **Step 3: 依赖审计和锁定检查**

Run:

```bash
npm audit --omit=dev
npm ls risex-client ethers undici
node -e "const p=require('./package.json'); if(p.dependencies['risex-client']!=='0.1.11'||p.dependencies.ethers!=='6.13.5') process.exit(1)"
```

Expected: 版本精确匹配；审计无未处理的 high/critical。若 `risex-client` 依赖树有风险，不使用 `--force`，先评估并在交付中阻断实盘。

- [ ] **Step 4: 使用 `codex-security:security-diff-scan` 审查 `main...HEAD`**

重点检查：

- signer key / signature 是否可能进入日志、SSE、`.state.json` 或错误响应；
- endpoint allowlist 是否可被 URL 规范化、userinfo、尾斜杠或重定向绕过；
- 订单 ID 是否有 Number 精度损失；
- WS/REST 消息是否可能伪造 fill、重复补单或跨账户/跨市场接管；
- RECONCILING/HALTED 是否存在继续 place、retry queue 或恢复补单路径；
- cancelAll/close 是否在未确认时错误返回 true；
- 验证 CLI 是否从结构上完全只读。

发现有效问题时，先补失败测试，再修根因，重复 Steps 1-4。不要在此任务顺手重构无关代码。

- [ ] **Step 5: 检查最终差异和 commit 范围**

Run:

```bash
git status --short
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Expected: 工作区干净；只有 RISEx 适配器、必要 GridBot/启动集成、测试和文档改动。

- [ ] **Step 6: 最终提交（仅当审查修复产生未提交改动）**

```bash
git add package.json package-lock.json .env.example README.md AGENTS.md src/config.js src/server.js src/startup.js src/recovery.js src/bot.js src/exchange/rs/index.js src/exchange/rs/types.js src/exchange/rs/risex.js src/exchange/rs/normalize.js src/exchange/rs/order-state.js src/exchange/rs/private-stream.js src/exchange/rs/verify.js test/startup.test.js test/bot.test.js test/risex-normalize.test.js test/risex-order-state.test.js test/risex-private-stream.test.js test/risex-adapter.test.js test/risex-verify.test.js
git commit -m "安全：完成RISEx主网适配器复查"
```

- [ ] **Step 7: 交付用户手动验收步骤，不代替用户执行**

交付说明必须明确：

1. 在独立小资金 RISEx 账户确认 BTC/ETH 无遗留挂单和仓位。
2. VPS 设置 `.env` 权限 `chmod 600 .env`。
3. 用户运行 `npm run risex:verify -- --private`，保存脱敏输出。
4. 用户在官网核对最小网格的方向、价格、数量和订单数。
5. 用户验证一次真实成交、一次终态补单、停止撤单、平仓和进程重启接管。
6. 任一步不一致立即停止，不继续扩大仓位，并提供 RISEx 状态迁移/订单 ID/cursor 日志。

实现者不得在自动验收中替用户执行第 3-5 步，也不得声称“实盘已验证”除非用户回传了对应证据。

## Task 13: 对齐 RISEx 当前主网 REST 数据结构

**Files:**
- Modify: `src/exchange/rs/normalize.js:31-263`
- Modify: `src/exchange/rs/verify.js:7,134-147,217`
- Modify: `test/risex-normalize.test.js:140-174`
- Modify: `test/risex-verify.test.js:31-67,100-122`

- [ ] **Step 1: 把旧 REST 测试夹具替换为当前主网结构**

在 `test/risex-normalize.test.js` 增加并使用以下精确样例：

```js
const WAD = 10n ** 18n;
const wad = (value) => (BigInt(value) * WAD).toString();

test('REST normalizers parse current RISEx order, fill and position schemas', () => {
  const history = normalizeRestOrderHistory({
    id: '0xorder1', market_id: '1', side: 'BUY', size: wad(1), price: wad(100),
    filled_size: (WAD / 4n).toString(), avg_price: wad(99),
    status: 'ORDER_STATUS_CANCELLED', created_at: '20', block_number: '7', log_index: '2',
  });
  assert.deepEqual(
    { orderId: history.orderId, side: history.side, sizeBase: history.sizeBase,
      filledSize: history.filledSize, avgPrice: history.avgPrice, cursor: history.cursor },
    { orderId: '0xorder1', side: 'buy', sizeBase: 1, filledSize: 0.25,
      avgPrice: 99, cursor: { block: 7n, log: 2n, timestamp: 20n } },
  );

  const fill = normalizeRestFill({
    id: 'fill1', order_id: '0xorder1', market_id: '1', side: 'BUY',
    size: '0.25', price: '99', fee: '0.1', time: '21',
    blockchain_data: { block_number: '7', log_index: '3' },
  });
  assert.deepEqual(fill.cursor, { block: 7n, log: 3n, timestamp: 21n });

  const position = normalizeRestPosition({
    market_id: '1', side: 'SELL', size: (WAD / 2n).toString(),
    avg_entry_price: wad(100), unrealized_pnl: wad(2), leverage: wad(3),
  });
  assert.deepEqual(position, {
    marketId: 1, sizeBase: -0.5, entryPrice: 100, unrealizedPnl: 2, leverage: 3,
  });

  assert.equal(normalizeRestPosition({
    market_id: '1', side: 0, size: (WAD / 2n).toString(),
    avg_entry_price: wad(100), unrealized_pnl: wad(2), leverage: wad(3),
  }).sizeBase, 0.5);
});
```

在 `test/risex-verify.test.js` 的 `getPosition()` fixture 同样改为 `avg_entry_price` 和 WAD 值，保留断言 `sizeBase === 0.01`，证明私有验证不再维护第二套旧解析逻辑。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test test/risex-normalize.test.js test/risex-verify.test.js
```

Expected: FAIL，错误分别包含“历史订单 ID”“未知值 BUY/SELL”或 `entry_price`，证明旧解析器无法处理当前结构。

- [ ] **Step 3: 实现严格的当前 REST 解析器**

在 `src/exchange/rs/normalize.js` 保留开放订单的数字方向解析，同时增加当前 API 方向和游标解析：

```js
function apiSide(value) {
  if (value === 'BUY') return 'buy';
  if (value === 'SELL') return 'sell';
  fail('side', `包含未知值 ${String(value)}。`);
}

function positionSide(value) {
  if (value === 'BUY' || value === 'SELL') return apiSide(value);
  return restSide(value);
}

function restCursor(item) {
  const timestamp = cursorPart(item.created_at ?? item.timestamp ?? item.time, 'timestamp');
  const blockValue = item.block_number ?? item.blockchain_data?.block_number;
  const logValue = item.log_index ?? item.blockchain_data?.log_index;
  return {
    block: blockValue == null ? 0n : cursorPart(blockValue, 'block_number'),
    log: logValue == null ? 0n : cursorPart(logValue, 'log_index'),
    timestamp,
  };
}
```

`normalizeRestOrderHistory()` 和 `normalizeRestFill()` 替换为：

```js
export function normalizeRestOrderHistory(raw) {
  const orderId = stringId(raw?.id, 'REST 历史订单 ID');
  const sizeBase = wadToNumber(raw.size, `REST 历史订单 ${orderId} size`);
  const filledSize = wadToNumber(raw.filled_size, `REST 历史订单 ${orderId} filled_size`);
  const price = wadToNumber(raw.price, `REST 历史订单 ${orderId} price`);
  const avgPrice = wadToNumber(raw.avg_price, `REST 历史订单 ${orderId} avg_price`);
  if (!(sizeBase > 0)) fail(`REST 历史订单 ${orderId}`, '总量必须大于零。');
  if (price < 0 || filledSize < 0 || avgPrice < 0) {
    fail(`REST 历史订单 ${orderId}`, '包含负数价格或数量。');
  }
  if (filledSize > sizeBase + 1e-12) {
    fail(`REST 历史订单 ${orderId}`, '累计成交量超过订单总量。');
  }
  return {
    orderId,
    marketId: safeInteger(raw.market_id, `REST 历史订单 ${orderId} market_id`, { min: 1 }),
    side: apiSide(raw.side),
    sizeBase,
    price,
    filledSize,
    avgPrice,
    status: normalizeStatus(raw.status, filledSize),
    cursor: restCursor(raw),
  };
}

export function normalizeRestFill(raw) {
  const fillId = stringId(raw?.id, 'REST fill ID');
  const orderId = stringId(raw.order_id, `REST fill ${fillId} order ID`);
  return {
    fillId,
    orderId,
    marketId: safeInteger(raw.market_id, `REST fill ${fillId} market_id`, { min: 1 }),
    side: apiSide(raw.side),
    sizeBase: decimal(raw.size, `REST fill ${fillId} size`, { min: 0, allowZero: false }),
    price: decimal(raw.price, `REST fill ${fillId} price`, { min: 0, allowZero: false }),
    fee: raw.fee == null || raw.fee === '' ? 0 : decimal(raw.fee, `REST fill ${fillId} fee`),
    cursor: restCursor(raw),
  };
}
```

`normalizeRestPosition()` 使用以下字段和精度：

```js
export function normalizeRestPosition(raw) {
  if (raw == null) return null;
  const marketId = safeInteger(raw.market_id, 'REST position market_id', { min: 1 });
  const absoluteSize = Math.abs(wadToNumber(raw.size, `REST position ${marketId} size`));
  if (absoluteSize === 0) {
    return { marketId, sizeBase: 0, entryPrice: 0, unrealizedPnl: 0, leverage: null };
  }
  const side = positionSide(raw.side);
  const entryPrice = wadToNumber(raw.avg_entry_price, `REST position ${marketId} avg_entry_price`);
  if (!(entryPrice > 0)) fail(`REST position ${marketId} avg_entry_price`, '必须大于零。');
  let unrealizedPnl;
  if (raw.unrealized_pnl != null && raw.unrealized_pnl !== '') {
    unrealizedPnl = wadToNumber(raw.unrealized_pnl, `REST position ${marketId} unrealized_pnl`);
  } else if (raw.mark_price != null && raw.mark_price !== '') {
    const markPrice = wadToNumber(raw.mark_price, `REST position ${marketId} mark_price`);
    const signedSize = side === 'buy' ? absoluteSize : -absoluteSize;
    unrealizedPnl = signedSize * (markPrice - entryPrice);
  } else {
    fail(`REST position ${marketId}`, '缺少 unrealized_pnl 或 mark_price。');
  }
  const leverage = raw.leverage == null || raw.leverage === ''
    ? null
    : wadToNumber(raw.leverage, `REST position ${marketId} leverage`);
  if (leverage != null && !(leverage > 0)) fail(`REST position ${marketId} leverage`, '必须大于零。');
  return {
    marketId,
    sizeBase: side === 'buy' ? absoluteSize : -absoluteSize,
    entryPrice,
    unrealizedPnl,
    leverage,
  };
}
```

不要保留 `order_id || id`、`entry_price || avg_entry_price` 之类的静默字段兜底；不同接口只接受规格第 18.1 节列出的结构。

- [ ] **Step 4: 让私有验证复用生产仓位解析器**

在 `src/exchange/rs/verify.js` 导入 `normalizeRestFill`、`normalizeRestOpenOrder`、`normalizeRestPosition`，删除 `summarizePosition()`。取得三个私有 REST 返回后先执行：

```js
const normalizedOpen = open.map((row) => normalizeRestOpenOrder(row, market));
const normalizedTrades = trades.map(normalizeRestFill);
const normalized = normalizeRestPosition(position);
```

`test/risex-verify.test.js` 中 BTC fixture 使用以下完整内容，证明验证命令实际解析内容而非只统计数组长度：

```js
async getOpenOrders(account, marketId) {
  calls.push(`getOpenOrders:${account}:${marketId}`);
  return marketId === 1 ? [{
    order_id: 'hidden-order', resting_order_id: 'hidden-resting', market_id: '1',
    side: 0, price_ticks: 600000, size_steps: 10, reduce_only: false,
  }] : [];
},
async getAccountTradeHistory(account, marketId) {
  calls.push(`getAccountTradeHistory:${account}:${marketId}`);
  return marketId === 1 ? [{
    id: 'hidden-fill', order_id: 'hidden-order', market_id: '1', side: 'BUY',
    size: '0.001', price: '60000', fee: '0', time: '20',
    blockchain_data: { block_number: '2', log_index: '0' },
  }] : [];
},
```

市场摘要改为：

```js
const normalized = normalizeRestPosition(position);
if (normalized && normalized.marketId !== market.marketId) {
  throw new Error(`RISEx market ${market.marketId} 仓位市场不匹配。`);
}
return {
  marketId: market.marketId,
  name: market.displayName,
  openOrders: normalizedOpen.length,
  trades: normalizedTrades.length,
  position: normalized && normalized.sizeBase !== 0 ? {
    sizeBase: normalized.sizeBase,
    entryPrice: normalized.entryPrice,
    leverage: normalized.leverage,
  } : null,
};
```

- [ ] **Step 5: 运行定向测试并确认 GREEN**

Run:

```bash
node --test test/risex-normalize.test.js test/risex-verify.test.js
```

Expected: 所有 normalize/verify 测试通过，当前结构的订单、成交、两种仓位方向均被精确解析。

- [ ] **Step 6: 提交**

```bash
git add src/exchange/rs/normalize.js src/exchange/rs/verify.js test/risex-normalize.test.js test/risex-verify.test.js
git commit -m "修复：对齐RISEx当前只读接口结构"
```

## Task 14: 使用单笔订单接口完成精确终态确认

**Files:**
- Modify: `src/exchange/rs/mainnet-client.js:1-89`
- Modify: `src/exchange/rs/risex.js:951-960`
- Modify: `test/risex-mainnet-client.test.js:15-91`
- Modify: `test/risex-adapter.test.js:95-178`

- [ ] **Step 1: 写精确查询和字符串 ID 回归测试**

在 `test/risex-mainnet-client.test.js` 给 fake HTTP 增加 `get()`，并增加：

```js
test('RISEx mainnet fetches one order by the exact string ID', async () => {
  const { client, calls } = makeClient();
  const id = '0x1234567890abcdef1234567890abcdef1234567890abcdef';
  client.info.http.get = async (path) => {
    calls.push({ path });
    return { order: { id, market_id: '1' } };
  };
  assert.deepEqual(await client.getOrderById(id, 1), { id, market_id: '1' });
  assert.equal(calls.at(-1).path, `/v1/orders/by-id/${encodeURIComponent(id)}?market_id=1`);
});
```

在 `test/risex-adapter.test.js` 的 harness 增加 `orderByIdImpl` 参数和 `client.getOrderById(orderId, marketId)`，再断言 place/cancel 超时确认调用 `read:order:<完整ID>:<marketId>`，而不是 `rest:history:<marketId>`。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test test/risex-mainnet-client.test.js test/risex-adapter.test.js
```

Expected: FAIL，`getOrderById is not a function`，并且适配器仍调用最近 100 条历史。

- [ ] **Step 3: 在主网客户端实现精确 GET**

在 `RisexMainnetClient` 增加：

```js
async getOrderById(orderId, marketId) {
  if (typeof orderId !== 'string' || !orderId) {
    throw new Error('RISEx 单笔订单查询 orderId 必须是非空字符串。');
  }
  if (!Number.isSafeInteger(marketId) || marketId <= 0) {
    throw new Error('RISEx 单笔订单查询 marketId 必须是安全正整数。');
  }
  const path = `/v1/orders/by-id/${encodeURIComponent(orderId)}?market_id=${marketId}`;
  try {
    const data = await this.info.http.get(path);
    const order = data?.order ?? data;
    if (!order || typeof order !== 'object' || Array.isArray(order)) {
      throw new Error(`RISEx 订单 ${orderId} 单笔查询响应格式非法。`);
    }
    return order;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}
```

- [ ] **Step 4: 适配器只用精确接口确认单笔订单**

把 `_confirmOrderFromRest()` 改为：

```js
async _confirmOrderFromRest(orderId, marketId) {
  const raw = await this._client.getOrderById(orderId, marketId);
  this.lastRestAt = this._now();
  if (raw == null) return false;
  const confirmed = normalizeRestOrderHistory(raw);
  if (confirmed.orderId !== orderId || confirmed.marketId !== marketId) {
    throw new Error(`RISEx 订单 ${orderId} 单笔确认身份不匹配。`);
  }
  const result = this.orderState.applyOrder(confirmed);
  this._handleOrderResult(result, confirmed);
  this._syncOfficialOrder(orderId);
  return true;
}
```

历史列表仍只用于启动/重连恢复快照，不再用于 place/cancel 的单笔确认。

- [ ] **Step 5: 运行定向测试并提交**

Run:

```bash
node --test test/risex-mainnet-client.test.js test/risex-adapter.test.js
```

Expected: 全部通过，精确路径保留完整字符串 ID，404 返回未确认，其他错误原样抛出。

```bash
git add src/exchange/rs/mainnet-client.js src/exchange/rs/risex.js test/risex-mainnet-client.test.js test/risex-adapter.test.js
git commit -m "修复：校正RISEx签名并精确确认订单"
```

## Task 15: 让批量撤单等待终态并永久抑制该周期补单

**Files:**
- Modify: `src/exchange/rs/risex.js:83-116,400-424,898-904`
- Modify: `test/risex-adapter.test.js:527-590`
- Verify: `test/bot.test.js:1-80`

- [ ] **Step 1: 写延迟终态和内部状态回归测试**

在 `test/risex-adapter.test.js` 增加两个测试：

```js
test('RISEx bulk cancel waits for every affected order terminal after open REST is empty', async () => {
  let openReads = 0;
  let exactReads = 0;
  const { exchange } = makeHarness({
    streamEvents: [wsOpen('o-late')],
    openOrdersImpl: () => (openReads++ === 0 ? [rawOpen('o-late')] : []),
    orderByIdImpl: () => (++exactReads < 3 ? null
      : rawHistory('o-late', 'ORDER_STATUS_CANCELLED', '0')),
  });
  setOwnedOpenSnapshot(exchange, 'o-late');
  await exchange.init();
  assert.equal(await exchange.cancelAll(1), true);
  assert.ok(exactReads >= 3);
  assert.equal(exchange.orderState.get('o-late').status, 'CANCELLED');
});

test('RISEx terminal fill confirmed after open REST is empty never re-quotes', async () => {
  let openReads = 0;
  const { exchange } = makeHarness({
    streamEvents: [wsOpen('o-late-fill')],
    openOrdersImpl: () => (openReads++ === 0 ? [rawOpen('o-late-fill')] : []),
    orderByIdImpl: () => rawHistory(
      'o-late-fill', 'ORDER_STATUS_CANCELLED',
      '1000000000000000', '59999000000000000000000',
    ),
  });
  setOwnedOpenSnapshot(exchange, 'o-late-fill');
  await exchange.init();
  const fills = [];
  exchange.on('fill', (fill) => fills.push(fill));
  await exchange.cancelAll(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].suppressRequote, true);
});
```

把 `rawHistory()` fixture 明确定义为当前 WAD 结构：

```js
function rawHistory(orderId, status, filledSize, avgPrice = '0') {
  return {
    id: orderId,
    market_id: '1',
    side: 'BUY',
    size: '1000000000000000',
    price: '60000000000000000000000',
    filled_size: String(filledSize),
    avg_price: String(avgPrice),
    status,
    created_at: '20',
    block_number: '2',
    log_index: '0',
  };
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test test/risex-adapter.test.js test/bot.test.js
```

Expected: 第一项显示 `cancelAll()` 在订单仍为 OPEN 时提前返回；第二项显示 `suppressRequote` 为 false。

- [ ] **Step 3: 分离写屏障和按订单补单抑制**

构造器增加：

```js
this._suppressRequoteOrderIds = new Set();
```

批量撤单开始时捕获受影响订单，并在 REST 开放订单归零后逐个确认：

```js
const affectedOrderIds = this.orderState.getOpen(id).map((order) => order.orderId);
for (const orderId of affectedOrderIds) this._suppressRequoteOrderIds.add(orderId);

// 每次 REST 轮询后执行；未终态订单用单笔接口确认。
const unresolved = [];
for (const orderId of affectedOrderIds) {
  let record = this.orderState.get(orderId);
  if (record?.status !== 'FILLED' && record?.status !== 'CANCELLED') {
    await this._confirmOrderFromRest(orderId, id);
    record = this.orderState.get(orderId);
  }
  if (record?.status !== 'FILLED' && record?.status !== 'CANCELLED') unresolved.push(orderId);
}
if (remaining.length === 0 && unresolved.length === 0) return true;
```

五次有界轮询后，错误同时列出剩余开放订单和未确认终态订单，并调用 `_haltAndThrow()`。不能因为 `remaining.length === 0` 单独返回成功。

- [ ] **Step 4: 终态按订单 ID 消费抑制标记**

把 `_handleOrderResult()` 改为：

```js
_handleOrderResult(result, context) {
  if (!result?.terminal) return;
  const orderId = String(context.orderId);
  this._officialOpen.get(Number(context.marketId))?.delete(orderId);
  const suppressRequote = this._suppressRequoteOrderIds.delete(orderId);
  if (!result.terminalFill) return;
  this._defer(() => this.emit('fill', { ...result.terminalFill, suppressRequote }));
}
```

`_bulkCancel` 继续只控制写队列门禁，不能再参与 `suppressRequote` 的计算。无法确认而 HALTED 的订单保留在集合中，防止晚到终态扩大风险。

- [ ] **Step 5: 运行适配器和 GridBot 回归并提交**

Run:

```bash
node --test test/risex-adapter.test.js test/bot.test.js
```

Expected: 批量撤单必须等到状态机终态；成交只记账一次且 `suppressRequote=true`；既有“撤单失败保留跟踪”测试继续通过。

```bash
git add src/exchange/rs/risex.js test/risex-adapter.test.js test/bot.test.js
git commit -m "修复：阻止RISEx批量撤单延迟补单"
```

## Task 16: 为私有连接、快照和认证 GET 增加有界超时

**Files:**
- Modify: `src/exchange/rs/private-stream.js:17-112,198-204,286-350`
- Modify: `test/risex-private-stream.test.js:14-190`

- [ ] **Step 1: 写三个资源清理超时测试**

扩展 `makeHarness()`，通过 `setDeadline` 收集边界计时器，并增加：

```js
test('private stream connect timeout rejects and closes the socket', async () => {
  const deadlines = [];
  const harness = makeHarness({
    connectTimeoutMs: 20,
    setDeadline: (fn, ms) => { deadlines.push({ fn, ms }); return deadlines.length; },
    clearDeadline() {},
  });
  const connecting = harness.stream.connect();
  deadlines.find((entry) => entry.ms === 20).fn();
  await assert.rejects(connecting, /认证 20ms 超时/);
  assert.equal(FakeSocket.instances[0].readyState, 3);
});

test('private stream order snapshot timeout removes its waiter', async () => {
  const deadlines = [];
  const harness = makeHarness({
    snapshotTimeoutMs: 30,
    setDeadline: (fn, ms) => { deadlines.push({ fn, ms }); return deadlines.length; },
    clearDeadline() {},
  });
  await openAndAuthenticate(harness);
  const waiting = harness.stream.waitForOrderSnapshot();
  deadlines.find((entry) => entry.ms === 30).fn();
  await assert.rejects(waiting, /Orders 快照 30ms 超时/);
  assert.equal(harness.stream._snapshotWaiters.length, 0);
});

test('private stream auth GET timeout aborts the request', async () => {
  const deadlines = [];
  let aborted = false;
  const harness = makeHarness({
    requestTimeoutMs: 40,
    setDeadline: (fn, ms) => { deadlines.push({ fn, ms }); return deadlines.length; },
    clearDeadline() {},
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
  });
  const connecting = harness.stream.connect();
  FakeSocket.instances[0].emit('open');
  await waitFor(() => deadlines.some((entry) => entry.ms === 40));
  deadlines.find((entry) => entry.ms === 40).fn();
  await assert.rejects(connecting, /GET .* 40ms 超时/);
  assert.equal(aborted, true);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test test/risex-private-stream.test.js
```

Expected: FAIL；当前 connect/snapshot promise 不会被新 deadline 拒绝，fetch 也没有 `signal`。

- [ ] **Step 3: 增加独立 deadline 依赖和超时配置**

构造参数增加：

```js
connectTimeoutMs = 15_000,
snapshotTimeoutMs = 15_000,
requestTimeoutMs = 15_000,
setDeadline = setTimeout,
clearDeadline = clearTimeout,
```

三个 timeout 必须是安全正整数。保存 `_setDeadline/_clearDeadline`，并增加 `_connectDeadline = null`。`connect()` 建立 promise 后启动认证 deadline；`_resolveConnect()`、`_rejectConnect()` 和 `stop()` 必须清理它。

```js
_startConnectDeadline() {
  this._clearConnectDeadline();
  this._connectDeadline = this._setDeadline(() => {
    this._connectDeadline = null;
    this._fatal(new Error(`RISEx 私有 WebSocket 认证 ${this._connectTimeoutMs}ms 超时。`));
  }, this._connectTimeoutMs);
}

_clearConnectDeadline() {
  if (this._connectDeadline == null) return;
  this._clearDeadline(this._connectDeadline);
  this._connectDeadline = null;
}
```

- [ ] **Step 4: 给 snapshot waiter 和 GET 增加可清理超时**

`waitForOrderSnapshot()` 为每个 waiter 保存 deadline；成功、stop、close 和 fatal 都必须清理。`_getJson()` 使用：

```js
async _getJson(url) {
  const controller = new AbortController();
  const pathname = new URL(url).pathname;
  const deadline = this._setDeadline(() => controller.abort(), this._requestTimeoutMs);
  try {
    const response = await this._fetch(url, {
      method: 'GET', redirect: 'error', signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`RISEx GET ${pathname} 失败：HTTP ${response?.status ?? 'unknown'}。`);
    }
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`RISEx GET ${pathname} ${this._requestTimeoutMs}ms 超时。`, { cause: error });
    }
    throw error;
  } finally {
    this._clearDeadline(deadline);
  }
}
```

- [ ] **Step 5: 运行私有流测试并提交**

Run:

```bash
node --test test/risex-private-stream.test.js
```

Expected: 所有认证、缓冲、重试、重连和三个超时测试通过，无悬挂 promise。

```bash
git add src/exchange/rs/private-stream.js test/risex-private-stream.test.js
git commit -m "修复：限制RISEx私有连接等待时间"
```

## Task 17: 完整回归和只读主网验收

**Files:**
- Review: `src/exchange/rs/*.js`
- Review: `test/risex-*.test.js`
- Review: 当前工作区中尚未提交的签名字段修复

- [ ] **Step 1: 运行格式和完整测试**

Run:

```bash
git diff --check
npm test
```

Expected: `git diff --check` 无错误；原 158 项测试及本轮新增测试全部通过，0 failed、0 cancelled。

- [ ] **Step 2: 运行公共主网只读验证**

Run:

```bash
npm run risex:verify
```

Expected: chain ID 4153、BTC-PERP、ETH-PERP、两个订单簿和公共 WebSocket 全部通过；命令不读取私钥、不发送写请求。

- [ ] **Step 3: 检查接口和安全边界**

Run:

```bash
git grep -n "getOrderHistory.*100" -- src/exchange/rs
git grep -n "permit_params\|permit" -- src/exchange/rs/mainnet-client.js
git status --short
git diff --stat
```

Expected: `getOrderHistory(...100)` 只剩启动/恢复快照用途；订单写接口使用 `permit`，杠杆使用 `permit_params`；没有 `.env`、私钥或无关文件进入差异。

- [ ] **Step 4: 提交本轮剩余实现**

只暂存本轮相关文件和此前已经验证的签名修复：

```bash
git add AGENTS.md src/exchange/rs/mainnet-client.js src/exchange/rs/normalize.js src/exchange/rs/private-stream.js src/exchange/rs/risex.js src/exchange/rs/verify.js test/risex-mainnet-client.test.js test/risex-normalize.test.js test/risex-private-stream.test.js test/risex-adapter.test.js test/risex-verify.test.js test/bot.test.js
git commit -m "修复：完成RISEx实盘状态确认复查"
```

- [ ] **Step 5: 交付限制**

交付时明确报告自动测试和公共只读验证结果，同时说明没有执行私有验证或真实下单。用户仍需在 VPS 运行 `npm run risex:verify -- --private`，再用最小数量完成官网对单、一次成交、停止撤单和平仓验收。
