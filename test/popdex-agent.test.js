import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBytes32String } from 'ethers';
import { POPDEX_ACCOUNT_PRECOMPILE } from '../src/exchange/px/constants.js';
import {
  POPDEX_ACCOUNT_INTERFACE,
  agentNameBytes32,
  deriveAgentAddress,
  prepareAgentAuthorization,
  prepareAgentRevocation,
} from '../src/exchange/px/agent.js';

const MAIN = '0x1111111111111111111111111111111111111111';
const OLD_AGENT = '0x2222222222222222222222222222222222222222';
const PRIVATE_KEY = `0x${'0'.repeat(63)}1`;
const AGENT = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const NOW_MS = 1786939200123;

test('Agent private key derives an exact address and invalid keys are never echoed', () => {
  assert.equal(deriveAgentAddress(PRIVATE_KEY), AGENT);
  const secret = 'not-a-real-secret-key';
  assert.throws(
    () => deriveAgentAddress(secret),
    (error) => /私钥格式无效/.test(error.message) && !error.message.includes(secret),
  );
});

test('Agent label is deterministic and bounded to one bytes32 value', () => {
  const name = agentNameBytes32('ucloud4.tailed0493.ts.net');
  assert.equal(decodeBytes32String(name), 'UI_ucloud4.tailed0493.ts.net');
  assert.equal(agentNameBytes32('ucloud4.tailed0493.ts.net'), name);
  assert.equal(decodeBytes32String(agentNameBytes32('a'.repeat(100))).length, 31);
  assert.throws(() => agentNameBytes32('坏主机名'), /hostname/);
});

test('new Agent authorization uses official time units and non-global approveAgent', () => {
  const prepared = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: 'ucloud4.tailed0493.ts.net',
    existingAgents: [],
    nowMs: NOW_MS,
  });
  assert.deepEqual(
    {
      action: prepared.action,
      to: prepared.to,
      value: prepared.value,
      chainId: prepared.chainId,
      type: prepared.type,
      gas: prepared.gas,
      gasPrice: prepared.gasPrice,
      initialNonce: prepared.initialNonce,
      expiresAt: prepared.expiresAt,
    },
    {
      action: 'approve',
      to: POPDEX_ACCOUNT_PRECOMPILE,
      value: '0x0',
      chainId: '0x888',
      type: '0x0',
      gas: '0x0',
      gasPrice: '0x0',
      initialNonce: '1786939200',
      expiresAt: '1789531200123',
    },
  );
  const decoded = POPDEX_ACCOUNT_INTERFACE.decodeFunctionData('approveAgent', prepared.data);
  assert.equal(decoded.agent, AGENT);
  assert.equal(decoded.delegator, MAIN);
  assert.equal(decodeBytes32String(decoded.name), 'UI_ucloud4.tailed0493.ts.net');
  assert.equal(decoded.expiresAt.toString(), '1789531200123');
  assert.equal(decoded.initialNonce.toString(), '1786939200');
  assert.equal(decoded.isGlobal, false);
});

test('same Agent label prepares replaceAgent instead of a duplicate approval', () => {
  const name = agentNameBytes32('ucloud4.tailed0493.ts.net');
  const prepared = prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: 'ucloud4.tailed0493.ts.net',
    existingAgents: [{
      agent: OLD_AGENT,
      expiresAt: '1789000000000',
      isExpired: false,
      name,
      isGlobal: false,
    }],
    nowMs: NOW_MS,
  });
  assert.equal(prepared.action, 'replace');
  assert.equal(prepared.replacedAgent, OLD_AGENT);
  const decoded = POPDEX_ACCOUNT_INTERFACE.decodeFunctionData('replaceAgent', prepared.data);
  assert.equal(decoded.oldAgent, OLD_AGENT);
  assert.equal(decoded.newAgent, AGENT);
  assert.equal(decoded.expiresAt.toString(), '1789531200123');
  assert.equal(decoded.initialNonce.toString(), '1786939200');
});

test('Agent revocation encodes only the selected public Agent address', () => {
  const prepared = prepareAgentRevocation(AGENT);
  assert.equal(prepared.to, POPDEX_ACCOUNT_PRECOMPILE);
  assert.equal(prepared.chainId, '0x888');
  const decoded = POPDEX_ACCOUNT_INTERFACE.decodeFunctionData('revokeAgent', prepared.data);
  assert.equal(decoded.agent, AGENT);
});

test('Agent approval rejects invalid clocks and identical main and Agent addresses', () => {
  assert.throws(() => prepareAgentAuthorization({
    agentAddress: MAIN,
    delegator: MAIN,
    hostname: 'vps.example',
    existingAgents: [],
    nowMs: NOW_MS,
  }), /不能相同/);
  assert.throws(() => prepareAgentAuthorization({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: 'vps.example',
    existingAgents: [],
    nowMs: Number.NaN,
  }), /nowMs/);
});
