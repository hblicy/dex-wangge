export const POPDEX_CHAIN_ID = 2184n;
export const POPDEX_API_BASE = 'https://api.popdex.xyz';
export const POPDEX_WEB_BASE = 'https://app.popdex.xyz';
export const POPDEX_RPC_URL = 'https://app.popdex.xyz/api/v1/web3/rpc';
export const POPDEX_PUBLIC_WS = 'wss://ws.popdex.xyz/v1/ws/public';
export const POPDEX_ORDER_PRECOMPILE = '0x0000000000000000000000000000000000001000';
export const POPDEX_ACCOUNT_PRECOMPILE = '0x0000000000000000000000000000000000001008';
export const POPDEX_USER_CONFIG_PRECOMPILE = '0x0000000000000000000000000000000000001009';

export const POPDEX_EXPECTED_MARKETS = Object.freeze({
  BTCUSDT: Object.freeze({
    symbolId: '20000',
    tickSize: '1',
    lotSize: '0.0001',
    minQty: '0.0001',
    minNotional: '10',
  }),
  ETHUSDT: Object.freeze({
    symbolId: '20001',
    tickSize: '0.1',
    lotSize: '0.001',
    minQty: '0.001',
    minNotional: '10',
  }),
});
