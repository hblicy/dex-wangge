const normalizeMarket = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function remapSnapshotMarket(exchange, snapshot) {
  if (!snapshot?.config?.displayName) throw new Error('恢复快照缺少市场名称');
  const wanted = normalizeMarket(snapshot.config.displayName);
  const markets = await exchange.getMarkets();
  const market = markets.find((item) => (
    [item.displayName, item.name, item.symbol]
      .some((value) => normalizeMarket(value) === wanted)
  ));
  if (!market) throw new Error(`恢复失败：找不到市场 ${snapshot.config.displayName}`);
  return { ...snapshot, config: { ...snapshot.config, marketId: market.marketId } };
}

export async function resumeRunningSnapshot(bot, exchange, snapshot) {
  if (!(snapshot?.running && snapshot?.config)) return false;
  if (exchange.dataSource == null) throw new Error('恢复失败：交易所未连接');
  const health = exchange.getHealth?.();
  if (health?.halted) throw new Error(`恢复失败：${health.reason || '交易所处于 HALTED'}`);
  await bot.resume(await remapSnapshotMarket(exchange, snapshot));
  return true;
}
