import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmMissingCancelledOrder } from '../src/exchange/px/cancel-confirmation.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const ORDER_ID = '234237619377012736';

function dependencies({ getFills, getOpenPositions }) {
  return {
    accountClient: { getFills },
    readRpc: { getOpenPositions },
    mainAccount: ACCOUNT,
    symbol: 'BTCUSDT',
    orderId: ORDER_ID,
  };
}

test('cancel confirmation finds an exact fill on a later REST page', async () => {
  const first = [];
  first.cursor = '7';
  const result = await confirmMissingCancelledOrder(dependencies({
    getFills: async (_account, _symbol, cursor) => (
      cursor === null ? first : [{ orderId: ORDER_ID, execQty: '0.0001' }]
    ),
    getOpenPositions: async () => {
      throw new Error('成交存在时不应查询持仓');
    },
  }));

  assert.equal(result.status, 'filled');
  assert.equal(result.filledQtyWad, '100000000000000');
  assert.equal(result.fillPages, 2);
});

test('cancel confirmation rejects a repeated fills cursor', async () => {
  const page = [];
  page.cursor = '7';
  await assert.rejects(
    confirmMissingCancelledOrder(dependencies({
      getFills: async () => page,
      getOpenPositions: async () => ({ positions: [], hasMore: false }),
    })),
    /fills cursor 重复：7/,
  );
});

test('cancel confirmation finds the target position on a later chain page', async () => {
  const result = await confirmMissingCancelledOrder(dependencies({
    getFills: async () => [],
    getOpenPositions: async (_account, offset) => {
      if (offset === 0) {
        return {
          positions: [{ walletId: ACCOUNT, symbolId: '20001', holdSizeWad: '1' }],
          hasMore: true,
        };
      }
      return {
        positions: [{ walletId: ACCOUNT, symbolId: '20000', holdSizeWad: '200000000000000' }],
        hasMore: false,
      };
    },
  }));

  assert.equal(result.status, 'position-open');
  assert.equal(result.holdSizeWad, '200000000000000');
  assert.equal(result.positionPages, 2);
});

test('cancel confirmation rejects an empty position page that claims more data', async () => {
  await assert.rejects(
    confirmMissingCancelledOrder(dependencies({
      getFills: async () => [],
      getOpenPositions: async () => ({ positions: [], hasMore: true }),
    })),
    /positions hasMore=true 但当前页为空/,
  );
});
