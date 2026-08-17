import { encodeBytes32String, Interface, Wallet } from 'ethers';
import { POPDEX_ACCOUNT_PRECOMPILE } from './constants.js';
import { strictAddress } from './normalize.js';

const THIRTY_DAYS_MS = 2_592_000_000;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9.-]+$/;

export const POPDEX_ACCOUNT_INTERFACE = new Interface([
  'function approveAgent(address agent,address delegator,bytes32 name,uint64 expiresAt,uint64 initialNonce,bool isGlobal)',
  'function replaceAgent(address oldAgent,address newAgent,uint64 expiresAt,uint64 initialNonce)',
  'function revokeAgent(address agent)',
  'function getAgentInfo(address agent) view returns (bool exists,uint64 expiresAt,bool isExpired,address delegator,bytes32 name,bool isGlobal)',
  'function getAgents(address delegator) view returns (address[] agents,uint64[] expiresAts,bool[] isExpireds,bytes32[] names,bool[] isGlobals)',
]);

function transaction(data) {
  return {
    to: POPDEX_ACCOUNT_PRECOMPILE,
    data,
    value: '0x0',
    chainId: '0x888',
    type: '0x0',
    gas: '0x0',
    gasPrice: '0x0',
  };
}

function exactNow(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('PopDEX Agent nowMs 必须是非负安全整数。');
  }
  return value;
}

export function deriveAgentAddress(privateKey) {
  if (typeof privateKey !== 'string' || !PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new Error('PopDEX Agent 私钥格式无效。');
  }
  try {
    return new Wallet(privateKey).address;
  } catch {
    throw new Error('PopDEX Agent 私钥格式无效。');
  }
}

export function agentNameBytes32(hostname) {
  if (
    typeof hostname !== 'string'
    || hostname.length === 0
    || hostname.length > 253
    || !HOSTNAME_PATTERN.test(hostname)
  ) {
    throw new Error('PopDEX Agent hostname 必须是有效 ASCII 主机名。');
  }
  return encodeBytes32String(`UI_${hostname}`.slice(0, 31));
}

export function prepareAgentAuthorization({
  agentAddress,
  delegator,
  hostname,
  existingAgents,
  nowMs = Date.now(),
}) {
  const agent = strictAddress(agentAddress, 'agentAddress');
  const main = strictAddress(delegator, 'delegator');
  if (agent === main) {
    throw new Error('PopDEX Agent 地址与主账户不能相同。');
  }
  if (!Array.isArray(existingAgents)) {
    throw new Error('PopDEX existingAgents 必须是数组。');
  }
  const currentMs = exactNow(nowMs);
  const initialNonce = BigInt(Math.floor(currentMs / 1000));
  const expiresAt = BigInt(currentMs + THIRTY_DAYS_MS);
  const name = agentNameBytes32(hostname);
  const matches = existingAgents.filter((entry) => entry?.name === name);
  if (matches.length > 1) {
    throw new Error('PopDEX 同名 Agent 不唯一，拒绝猜测替换目标。');
  }

  if (matches.length === 1) {
    const oldAgent = strictAddress(matches[0].agent, 'existing agent');
    if (oldAgent === agent) {
      throw new Error('PopDEX 新 Agent 与待替换 Agent 地址相同。');
    }
    return {
      action: 'replace',
      replacedAgent: oldAgent,
      name,
      initialNonce: initialNonce.toString(),
      expiresAt: expiresAt.toString(),
      ...transaction(POPDEX_ACCOUNT_INTERFACE.encodeFunctionData('replaceAgent', [
        oldAgent,
        agent,
        expiresAt,
        initialNonce,
      ])),
    };
  }

  return {
    action: 'approve',
    name,
    initialNonce: initialNonce.toString(),
    expiresAt: expiresAt.toString(),
    ...transaction(POPDEX_ACCOUNT_INTERFACE.encodeFunctionData('approveAgent', [
      agent,
      main,
      name,
      expiresAt,
      initialNonce,
      false,
    ])),
  };
}

export function prepareAgentRevocation(agentAddress) {
  const agent = strictAddress(agentAddress, 'agentAddress');
  return transaction(
    POPDEX_ACCOUNT_INTERFACE.encodeFunctionData('revokeAgent', [agent]),
  );
}
