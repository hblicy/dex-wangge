import { Interface } from 'ethers';

export const POPDEX_USER_CONFIG_INTERFACE = new Interface([
  'function getAccountConfig(address account) view returns ((uint8 status,uint8 vipLevel,uint8 positionMode,uint64 bizPermissionCode,tuple(uint16 symbolId,uint8 leverage)[] symbolLeverages,tuple(address tokenAddress,uint8 leverage)[] tokenLeverages) config)',
  'function updateLeverage(address account,(uint8 newLeverage,uint16 symbolId,address tokenAddress,uint8 category) request) returns (bool success)',
  'event LeverageUpdated(address indexed account,uint8 category,uint16 symbolId,address tokenAddress,uint8 newLeverage,bool succeeded,uint32 code)',
]);
