export function collectMissingLiveCredentials(config) {
  const missing = [];
  if (config.de.mode === 'live') {
    if (!config.de.apiKey) missing.push(['Decibel ', 'DECIBEL_API_KEY', '在 geomi.dev 免费创建']);
    if (!config.de.privateKey) missing.push(['Decibel ', 'DECIBEL_PRIVATE_KEY', '在 app.decibel.trade/api 创建 API 钱包']);
  }
  if (config.ex.mode === 'live') {
    if (!config.ex.apiKey) missing.push(['Extended', 'EXTENDED_API_KEY', 'app.extended.exchange → API Management']);
    if (!config.ex.vault) missing.push(['Extended', 'EXTENDED_VAULT', '同上，创建 API Key 时一并显示']);
    if (!config.ex.starkPrivateKey) missing.push(['Extended', 'EXTENDED_STARK_PRIVATE_KEY', '同上，只显示一次务必保存']);
  }
  if (config.rs.mode === 'live') {
    if (!config.rs.account) missing.push(['RISEx   ', 'RISEX_ACCOUNT', '独立 RISEx 实盘账户的 EVM 地址']);
    if (!config.rs.signerKey) missing.push(['RISEx   ', 'RISEX_SIGNER_KEY', '该账户已注册的 session signer 私钥']);
  }
  return missing;
}

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
