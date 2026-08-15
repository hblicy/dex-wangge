export async function initializeExchange(exchange, name, config, logger = console) {
  try {
    await exchange.init();
    logger.log(`[${name}] ✓ 连接成功 [${config.mode.toUpperCase()} 模式]`);
    return true;
  } catch (cause) {
    logger.error(`[${name}] ✗ 初始化失败：${cause?.message || cause}`);
    if (config.mode === 'live') {
      throw new Error(`${name} 实盘初始化失败，服务已停止`, { cause });
    }
    return false;
  }
}

export function prepareExchangeRecovery(exchange, snapshot) {
  exchange.setRecoverySnapshot?.(snapshot);
}
