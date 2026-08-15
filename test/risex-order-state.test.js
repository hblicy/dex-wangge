import test from 'node:test';
import assert from 'node:assert/strict';
import { RisexOrderState } from '../src/exchange/rs/order-state.js';

const meta = {
  orderId: 'o1', marketId: 1, side: 'buy', sizeBase: 1, price: 100,
  levelIndex: 2, clientOrderId: 'c1', sizeTolerance: 1e-9,
};

function cursor(block, log = 0, timestamp = block) {
  return { block: BigInt(block), log: BigInt(log), timestamp: BigInt(timestamp) };
}

function order(status, filledSize, at, patch = {}) {
  return {
    orderId: 'o1', marketId: 1, side: 'buy', sizeBase: 1, price: 100,
    filledSize, avgPrice: filledSize > 0 ? 99 : 0, status, cursor: at,
    ...patch,
  };
}

function fill(fillId, sizeBase, price, at, patch = {}) {
  return {
    fillId, orderId: 'o1', marketId: 1, side: 'buy', sizeBase, price,
    fee: 0, cursor: at, ...patch,
  };
}

test('OPEN to FILLED emits one terminal fill with grid metadata', () => {
  const state = new RisexOrderState();
  state.track(meta);
  assert.equal(state.applyOrder(order('OPEN', 0, cursor(1))), null);
  const result = state.applyOrder(order('FILLED', 1, cursor(2), { avgPrice: 99.5 }));
  assert.deepEqual(result, {
    terminal: true,
    terminalFill: {
      orderId: 'o1', marketId: 1, side: 'buy', sizeBase: 1, price: 99.5,
      levelIndex: 2, clientOrderId: 'c1',
    },
  });
  assert.equal(state.applyOrder(order('FILLED', 1, cursor(2), { avgPrice: 99.5 })), null);
});

test('zero-fill CANCELLED terminates without producing a fill', () => {
  const state = new RisexOrderState();
  state.track(meta);
  state.applyOrder(order('OPEN', 0, cursor(1)));
  assert.deepEqual(state.applyOrder(order('CANCELLED', 0, cursor(2))), {
    terminal: true, terminalFill: null,
  });
  assert.equal(state.getOpen(1).length, 0);
});

test('partial order does not emit until FILLED and uses final total size', () => {
  const state = new RisexOrderState();
  state.track(meta);
  state.applyOrder(order('OPEN', 0, cursor(1)));
  state.applyFill(fill('f1', 0.25, 98, cursor(2)));
  assert.equal(state.applyOrder(order('PARTIAL', 0.25, cursor(3), { avgPrice: 98 })), null);
  state.applyFill(fill('f2', 0.75, 100, cursor(4)));
  assert.equal(state.applyOrder(order('FILLED', 1, cursor(5), { avgPrice: 99.5 })).terminalFill.sizeBase, 1);
});

test('partial then CANCELLED emits only the actual executed quantity', () => {
  const state = new RisexOrderState();
  state.track(meta);
  state.applyOrder(order('OPEN', 0, cursor(1)));
  state.applyFill(fill('f1', 0.25, 99, cursor(2)));
  state.applyOrder(order('PARTIAL', 0.25, cursor(3)));
  const result = state.applyOrder(order('CANCELLED', 0.25, cursor(4)));
  assert.deepEqual(result.terminalFill, {
    orderId: 'o1', marketId: 1, side: 'buy', price: 99, sizeBase: 0.25,
    levelIndex: 2, clientOrderId: 'c1',
  });
});

test('duplicate fills are ignored and distinct out-of-order fills are accumulated', () => {
  const state = new RisexOrderState();
  state.track(meta);
  state.applyOrder(order('OPEN', 0, cursor(1)));
  state.applyFill(fill('f2', 0.25, 102, cursor(4)));
  state.applyFill(fill('f1', 0.25, 98, cursor(2)));
  state.applyFill(fill('f1', 0.25, 98, cursor(2)));
  const record = state.get('o1');
  assert.equal(record.fillSum, 0.5);
  assert.equal(record.fillAveragePrice, 100);
});

test('older order updates are ignored but equal-cursor conflicts fail', () => {
  const state = new RisexOrderState();
  state.track(meta);
  state.applyOrder(order('PARTIAL', 0.5, cursor(3)));
  assert.equal(state.applyOrder(order('OPEN', 0, cursor(2))), null);
  assert.equal(state.get('o1').reportedFilled, 0.5);
  assert.throws(
    () => state.applyOrder(order('PARTIAL', 0.4, cursor(3))),
    /相同 cursor.*内容冲突/,
  );
});

test('quantity regressions, overfills and immutable field changes fail', () => {
  const state = new RisexOrderState();
  state.track(meta);
  state.applyOrder(order('PARTIAL', 0.5, cursor(2)));
  assert.throws(() => state.applyOrder(order('PARTIAL', 0.4, cursor(3))), /累计成交量倒退/);

  const overfill = new RisexOrderState();
  overfill.track(meta);
  assert.throws(() => overfill.applyFill(fill('f1', 1.1, 99, cursor(1))), /超过订单总量/);

  const changed = new RisexOrderState();
  changed.track(meta);
  assert.throws(() => changed.applyOrder(order('OPEN', 0, cursor(1), { side: 'sell' })), /方向发生变化/);
  assert.throws(() => changed.applyOrder(order('OPEN', 0, cursor(1), { marketId: 2 })), /市场发生变化/);
});

test('terminal fill requires an official average or a complete fill-derived average', () => {
  const state = new RisexOrderState();
  state.track(meta);
  assert.throws(
    () => state.applyOrder(order('CANCELLED', 0.25, cursor(1), { avgPrice: 0 })),
    /缺少可确认的实际成交均价/,
  );

  const fromFills = new RisexOrderState();
  fromFills.track(meta);
  fromFills.applyFill(fill('f1', 0.25, 98, cursor(1)));
  assert.equal(
    fromFills.applyOrder(order('CANCELLED', 0.25, cursor(2), { avgPrice: 0 })).terminalFill.price,
    98,
  );
});

test('fill arriving before track is buffered and merged when tracking starts', () => {
  const state = new RisexOrderState();
  assert.deepEqual(state.applyFill(fill('f1', 0.25, 99, cursor(1))), { pending: true });
  assert.deepEqual(state.unknownOrderIds(), ['o1']);
  state.track(meta);
  assert.equal(state.get('o1').fillSum, 0.25);
  assert.deepEqual(state.unknownOrderIds(), []);
});

test('order arriving before track is buffered and terminal is returned by track', () => {
  const state = new RisexOrderState();
  assert.deepEqual(state.applyOrder(order('FILLED', 1, cursor(1))), { pending: true });
  const result = state.track(meta);
  assert.equal(result.terminalFill.sizeBase, 1);
  assert.deepEqual(state.unknownOrderIds(), []);
});
