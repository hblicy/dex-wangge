import { PaperExchange } from './paper.js';
import { RisexExchange } from './risex.js';

export const RISEX_MAINNET_API = 'https://api.rise.trade';
export const RISEX_MAINNET_WS = 'wss://api.rise.trade/ws/';

export function assertRisexLiveConfig(cfg) {
  if (cfg.network !== 'mainnet') throw new Error('RISEx 实盘只支持 mainnet。');
  if (!cfg.account || !cfg.signerKey) {
    throw new Error('RISEx LIVE 模式需要 RISEX_ACCOUNT 和 RISEX_SIGNER_KEY。');
  }
  if (cfg.apiUrl !== RISEX_MAINNET_API) {
    throw new Error(`RISEX_API_URL 必须为 ${RISEX_MAINNET_API}`);
  }
  if (cfg.wsUrl !== RISEX_MAINNET_WS) {
    throw new Error(`RISEX_WS_URL 必须为 ${RISEX_MAINNET_WS}`);
  }
}

/** Factory: choose adapter by mode. */
export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    assertRisexLiveConfig(cfg);
    return new RisexExchange(cfg);
  }
  return new PaperExchange({ apiUrl: cfg.apiUrl, startBalance: cfg.startBalance });
}
