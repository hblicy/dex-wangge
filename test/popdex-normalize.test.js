import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeFill,
  normalizeMarket,
  strictAddress,
  strictDecimalString,
  strictIntegerString,
} from '../src/exchange/px/normalize.js';

const BTC = {
  symbolId: '20000',
  symbol: 'BTCUSDT',
  category: 'Futures',
  status: 'Trading',
  tickSize: '1',
  lotSize: '0.0001',
  minQty: '0.0001',
  minNotional: '10',
  defaultLeverage: '20',
};

test('PopDEX accepts only the exact BTCUSDT and ETHUSDT mainnet identities', () => {
  assert.deepEqual(normalizeMarket(BTC), {
    marketId: 20000,
    name: 'BTCUSDT',
    displayName: 'BTCUSDT',
    symbol: 'BTC',
    stepPrice: 1,
    stepSize: 0.0001,
    minOrderSize: 0.0001,
    minNotional: 10,
    defaultLeverage: 20,
  });
  assert.throws(
    () => normalizeMarket({ ...BTC, symbol: 'SOLUSDT', symbolId: '20002' }),
    /不在白名单/,
  );
  assert.throws(() => normalizeMarket({ ...BTC, tickSize: '0.5' }), /tickSize/);
});

test('PopDEX primitive parsers reject unsafe or lossy values', () => {
  assert.equal(
    strictAddress('0x1111111111111111111111111111111111111111', 'account'),
    '0x1111111111111111111111111111111111111111',
  );
  assert.equal(strictIntegerString('90071992547409931234', 'orderId'), '90071992547409931234');
  assert.equal(strictDecimalString('0.0001', 'qty'), '0.0001');
  assert.throws(() => strictIntegerString(9007199254740992, 'orderId'), /字符串/);
  assert.throws(() => strictDecimalString('1e-4', 'qty'), /十进制字符串/);
});

test('PopDEX current mainnet execId is preserved as the canonical fillId', () => {
  const fill = normalizeFill({
    execId: '238561552737763342',
    orderId: '238561551932456960',
    symbol: 'BTCUSDT',
    side: 'Buy',
    execPrice: '64115',
    execQty: '0.0002',
  });
  assert.equal(fill.fillId, '238561552737763342');
  assert.equal(fill.execId, '238561552737763342');
  assert.throws(() => normalizeFill({
    ...fill,
    fillId: '1',
  }), /fill.*ID.*冲突/);
});
