import { EventEmitter } from 'node:events';

export class FakeExchange extends EventEmitter {
  constructor(overrides = {}) {
    super();
    this.equity = 100_000;
    this.feeRate = 0.0001;
    this.price = 100;
    this.orders = new Map();
    this.position = null;
    this.cancelResult = true;
    this.nextId = 0;
    Object.assign(this, overrides);
  }

  async getMarkets() {
    return [{
      marketId: 1,
      displayName: 'TEST-USD',
      maxLeverage: 10,
      minOrderSize: 0.001,
      stepSize: 0.001,
      stepPrice: 0.1,
    }];
  }

  async setLeverage() { return true; }
  async getPrice() { return this.price; }

  async placeLimitOrder(order) {
    const orderId = String(++this.nextId);
    this.orders.set(orderId, order);
    return { orderId };
  }

  async cancelAll() {
    if (this.cancelResult === true) this.orders.clear();
    return this.cancelResult;
  }

  async cancelOrder(_marketId, orderId) {
    return this.orders.delete(String(orderId));
  }

  async fetchOpenOrders() {
    return [...this.orders].map(([orderId, order]) => ({
      orderId,
      price: order.price,
      side: order.side,
    }));
  }

  getPosition() { return this.position; }
  async closePosition() { this.position = null; return true; }
  start() {}
}
