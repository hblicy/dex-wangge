import { parseUnits } from 'ethers';
import { POPDEX_EXPECTED_MARKETS } from './constants.js';
import { strictAddress, strictDecimalString, strictIntegerString } from './normalize.js';

const MAX_PAGES = 10;
const PAGE_SIZE = 100;

export async function confirmMissingCancelledOrder({
  accountClient,
  readRpc,
  mainAccount,
  symbol,
  orderId,
}) {
  if (!accountClient || typeof accountClient.getFills !== 'function') {
    throw new Error('PopDEX 撤单消失确认缺少账户成交查询。');
  }
  if (!readRpc || typeof readRpc.getOpenPositions !== 'function') {
    throw new Error('PopDEX 撤单消失确认缺少链上持仓查询。');
  }
  const wallet = strictAddress(mainAccount, 'cancel confirmation mainAccount');
  const market = POPDEX_EXPECTED_MARKETS[symbol];
  if (!market) throw new Error(`PopDEX 撤单消失确认 symbol ${String(symbol)} 不在白名单。`);
  const exactOrderId = strictIntegerString(orderId, 'cancel confirmation orderId');

  let cursor = null;
  const seenCursors = new Set();
  let filledQtyWad = 0n;
  let fillPages = 0;
  for (; fillPages < MAX_PAGES; fillPages += 1) {
    const fills = await accountClient.getFills(wallet, symbol, cursor);
    if (!Array.isArray(fills)) throw new Error('PopDEX 撤单消失确认 fills 必须是数组。');
    for (const fill of fills) {
      if (strictIntegerString(fill.orderId, 'cancel confirmation fill.orderId') !== exactOrderId) continue;
      const qty = parseUnits(
        strictDecimalString(fill.execQty, 'cancel confirmation fill.execQty'),
        18,
      );
      if (qty <= 0n) throw new Error('PopDEX 撤单消失确认 fill.execQty 必须大于 0。');
      filledQtyWad += qty;
    }
    if (fills.cursor === undefined) break;
    if (seenCursors.has(fills.cursor)) {
      throw new Error(`PopDEX 撤单消失确认 fills cursor 重复：${fills.cursor}。`);
    }
    seenCursors.add(fills.cursor);
    cursor = fills.cursor;
  }
  if (fillPages === MAX_PAGES) {
    throw new Error(`PopDEX 撤单消失确认 fills 分页超过 ${MAX_PAGES} 页。`);
  }
  if (filledQtyWad > 0n) {
    return {
      status: 'filled',
      filledQtyWad: filledQtyWad.toString(),
      fillPages: fillPages + 1,
      positionPages: 0,
    };
  }

  let offset = 0;
  let positionPages = 0;
  for (; positionPages < MAX_PAGES; positionPages += 1) {
    const page = await readRpc.getOpenPositions(wallet, offset, PAGE_SIZE);
    if (!page || !Array.isArray(page.positions) || typeof page.hasMore !== 'boolean') {
      throw new Error('PopDEX 撤单消失确认 positions page 格式无效。');
    }
    for (const position of page.positions) {
      const positionWallet = strictAddress(position.walletId, 'cancel confirmation position.walletId');
      if (positionWallet.toLowerCase() !== wallet.toLowerCase()) {
        throw new Error('PopDEX 撤单消失确认 position.walletId 与主账户不匹配。');
      }
      if (String(position.symbolId) !== market.symbolId) continue;
      const holdSizeWad = BigInt(strictIntegerString(
        position.holdSizeWad,
        'cancel confirmation position.holdSizeWad',
      ));
      if (holdSizeWad !== 0n) {
        return {
          status: 'position-open',
          filledQtyWad: '0',
          holdSizeWad: holdSizeWad.toString(),
          fillPages: fillPages + 1,
          positionPages: positionPages + 1,
        };
      }
    }
    if (!page.hasMore) break;
    if (page.positions.length === 0) {
      throw new Error('PopDEX 撤单消失确认 positions hasMore=true 但当前页为空。');
    }
    offset += page.positions.length;
  }
  if (positionPages === MAX_PAGES) {
    throw new Error(`PopDEX 撤单消失确认 positions 分页超过 ${MAX_PAGES} 页。`);
  }
  return {
    status: 'zero-fill-flat',
    filledQtyWad: '0',
    fillPages: fillPages + 1,
    positionPages: positionPages + 1,
  };
}
