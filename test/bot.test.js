import test from 'node:test';
import assert from 'node:assert/strict';
import { GridBot } from '../src/bot.js';
import { FakeExchange } from './helpers/fake-exchange.js';

const config = {
  marketId: 1,
  mode: 'neutral',
  lower: 90,
  upper: 110,
  gridCount: 4,
  sizeBase: 1,
  leverage: 2,
  outOfRangeAction: 'close',
};

test('adjustRange keeps tracking and does not reseed when cancelAll fails', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start(config);
  exchange.cancelResult = false;

  await assert.rejects(bot.adjustRange({ lower: 88, upper: 112 }), /撤单失败/);

  assert.equal(exchange.orders.size, 4);
  assert.equal(bot.active.size, 4);
  assert.deepEqual([bot.config.lower, bot.config.upper], [90, 110]);
});

test('stop stays running and keeps tracking when cancelAll fails', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start(config);
  exchange.cancelResult = false;

  await assert.rejects(bot.stop({ closePosition: false }), /撤单失败/);

  assert.equal(bot.running, true);
  assert.equal(bot.active.size, 4);
});

test('start rejects a price outside the grid before placing orders', async () => {
  const exchange = new FakeExchange({ price: 80 });
  const bot = new GridBot(exchange);

  await assert.rejects(bot.start(config), /网格区间之外/);

  assert.equal(exchange.orders.size, 0);
  assert.equal(bot.running, false);
});

for (const invalid of [
  { name: 'fractional gridCount', patch: { gridCount: 2.5 } },
  { name: 'NaN sizeBase', patch: { sizeBase: Number.NaN } },
  { name: 'NaN leverage', patch: { leverage: Number.NaN } },
]) {
  test(`start rejects ${invalid.name}`, async () => {
    const bot = new GridBot(new FakeExchange());
    await assert.rejects(bot.start({ ...config, ...invalid.patch }), /参数/);
  });
}

test('start rejects leverage setup failure before placing orders', async () => {
  const exchange = new FakeExchange();
  exchange.setLeverage = async () => false;
  const bot = new GridBot(exchange);

  await assert.rejects(bot.start(config), /杠杆设置失败/);

  assert.equal(exchange.orders.size, 0);
  assert.equal(bot.running, false);
});

test('start aborts and cancels accepted seed orders after a placement failure', async () => {
  const exchange = new FakeExchange();
  const original = exchange.placeLimitOrder.bind(exchange);
  exchange.placeLimitOrder = async (order) => (
    exchange.nextId === 1 ? Promise.reject(new Error('rejected')) : original(order)
  );
  const bot = new GridBot(exchange);

  await assert.rejects(bot.start(config), /初始挂单失败/);

  assert.equal(exchange.orders.size, 0);
  assert.equal(bot.running, false);
});

test('close confirmation reports failure when closePosition throws', async () => {
  const exchange = new FakeExchange();
  let reads = 0;
  exchange.getPosition = () => (++reads === 1 ? { sizeBase: 1 } : null);
  exchange.closePosition = async () => { throw new Error('close rejected'); };
  const bot = new GridBot(exchange);

  assert.equal(await bot._closeWithConfirm(1, { attempts: 1, waitMs: 0 }), false);
});

test('automatic out-of-range stop records cancellation failure', async () => {
  const exchange = new FakeExchange();
  const bot = new GridBot(exchange);
  await bot.start(config);
  exchange.cancelResult = false;

  const originalError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    bot._handlePrice({ marketId: 1, price: 111 });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }

  assert.match(bot.alerts.map((item) => item.message).join('\n'), /自动停止失败.*撤单失败/);
  assert.match(errors.join('\n'), /自动停止失败.*撤单失败/);
  assert.equal(bot.running, true);
});
