import { PaperExchange } from './paper.js';

/** Factory: choose adapter by mode. */
export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    throw new Error('RISEx 实盘已禁用：当前 risex-client 未达到生产可用标准，请改用 RS_MODE=paper。');
  }
  return new PaperExchange({ apiUrl: cfg.apiUrl, startBalance: cfg.startBalance });
}
