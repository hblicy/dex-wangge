import assert from 'node:assert/strict';
import test from 'node:test';
import { agentNameBytes32 } from '../src/exchange/px/agent.js';
import { PopdexAgentService } from '../src/exchange/px/agent-service.js';

const MAIN = '0x1111111111111111111111111111111111111111';
const PRIVATE_KEY = `0x${'0'.repeat(63)}1`;
const AGENT = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const OLD_AGENT = '0x2222222222222222222222222222222222222222';
const NAME = agentNameBytes32('vps.example');
const NOW_MS = 1786939200123;

function authorizedInfo(overrides = {}) {
  return {
    exists: true,
    expiresAt: '1789531200123',
    isExpired: false,
    delegator: MAIN,
    name: NAME,
    isGlobal: false,
    ...overrides,
  };
}

class MemoryFs {
  constructor(content = '') {
    this.content = content;
    this.exists = content !== null;
    this.writeMode = null;
    this.chmodModes = [];
    this.writeError = null;
  }

  existsSync() { return this.exists; }

  readFileSync() { return this.content; }

  statSync() { return { mode: 0o100600 }; }

  chmodSync(_file, mode) { this.chmodModes.push(mode); }

  writeFileSync(_file, content, options) {
    if (this.writeError) throw this.writeError;
    this.exists = true;
    this.content = content;
    this.writeMode = options.mode;
  }
}

function fakeRpc(info = authorizedInfo(), agents = []) {
  return {
    chainChecks: 0,
    infoChecks: 0,
    agentListChecks: 0,
    async verifyChain() { this.chainChecks += 1; return 2184n; },
    async getAgentInfo(agent) {
      this.infoChecks += 1;
      assert.equal(agent, AGENT);
      return info;
    },
    async getAgents(account) {
      this.agentListChecks += 1;
      assert.equal(account, MAIN);
      return agents;
    },
  };
}

function service({
  info = authorizedInfo(),
  agents = [],
  content = 'DE_MODE=live\nRS_MODE=live\n',
  processEnv = {},
} = {}) {
  const fsImpl = new MemoryFs(content);
  const rpcClient = fakeRpc(info, agents);
  return {
    fsImpl,
    processEnv,
    rpcClient,
    service: new PopdexAgentService({
      rpcClient,
      envFile: '/app/.env',
      processEnv,
      fsImpl,
      platform: 'linux',
      now: () => NOW_MS,
    }),
  };
}

test('Agent cannot be saved before an exact active non-global authorization exists', async () => {
  const cases = [
    authorizedInfo({ exists: false, delegator: null }),
    authorizedInfo({ isExpired: true }),
    authorizedInfo({ expiresAt: String(NOW_MS - 1) }),
    authorizedInfo({ delegator: OLD_AGENT }),
    authorizedInfo({ isGlobal: true }),
  ];
  for (const info of cases) {
    const ctx = service({ info });
    await assert.rejects(
      ctx.service.save({ mainAccount: MAIN, agentPrivateKey: PRIVATE_KEY }),
      (error) => /尚未获得有效授权/.test(error.message)
        && !error.message.includes(PRIVATE_KEY),
    );
    assert.equal(ctx.fsImpl.content, 'DE_MODE=live\nRS_MODE=live\n');
  }
});

test('valid Agent save preserves existing exchanges and writes owner-only env values', async () => {
  const ctx = service();
  const status = await ctx.service.save({
    mainAccount: MAIN,
    agentPrivateKey: PRIVATE_KEY,
  });
  assert.equal(status.configured, true);
  assert.equal(status.authorized, true);
  assert.equal(status.mainAccount, MAIN);
  assert.equal(status.agentAddress, AGENT);
  assert.equal(status.expiresAt, '1789531200123');
  assert.equal(JSON.stringify(status).includes(PRIVATE_KEY), false);
  assert.match(ctx.fsImpl.content, /^DE_MODE=live$/m);
  assert.match(ctx.fsImpl.content, /^RS_MODE=live$/m);
  assert.match(ctx.fsImpl.content, new RegExp(`^POPDEX_MAIN_ACCOUNT=${MAIN}$`, 'm'));
  assert.match(ctx.fsImpl.content, new RegExp(`^POPDEX_AGENT_PRIVATE_KEY=${PRIVATE_KEY}$`, 'm'));
  assert.equal(ctx.fsImpl.writeMode, 0o600);
  assert.deepEqual(ctx.fsImpl.chmodModes, [0o600, 0o600]);
  assert.equal(ctx.processEnv.POPDEX_MAIN_ACCOUNT, MAIN);
  assert.equal(ctx.processEnv.POPDEX_AGENT_PRIVATE_KEY, PRIVATE_KEY);
});

test('env write failure leaves runtime credentials unchanged', async () => {
  const processEnv = { POPDEX_MAIN_ACCOUNT: OLD_AGENT };
  const ctx = service({ processEnv });
  ctx.fsImpl.writeError = new Error('disk full');
  await assert.rejects(
    ctx.service.save({ mainAccount: MAIN, agentPrivateKey: PRIVATE_KEY }),
    /disk full/,
  );
  assert.deepEqual(processEnv, { POPDEX_MAIN_ACCOUNT: OLD_AGENT });
});

test('configured status derives the Agent address but never returns its private key', async () => {
  const processEnv = {
    POPDEX_MAIN_ACCOUNT: MAIN,
    POPDEX_AGENT_PRIVATE_KEY: PRIVATE_KEY,
  };
  const ctx = service({ processEnv });
  const status = await ctx.service.status();
  assert.deepEqual(status, {
    configured: true,
    mainAccount: MAIN,
    agentAddress: AGENT,
    authorized: true,
    reason: null,
    expiresAt: '1789531200123',
    isGlobal: false,
  });
  assert.equal(JSON.stringify(status).includes(PRIVATE_KEY), false);
});

test('configured status reports a revoked Agent without hiding the configured identity', async () => {
  const processEnv = {
    POPDEX_MAIN_ACCOUNT: MAIN,
    POPDEX_AGENT_PRIVATE_KEY: PRIVATE_KEY,
  };
  const ctx = service({
    processEnv,
    info: authorizedInfo({ exists: false, delegator: null }),
  });
  assert.deepEqual(await ctx.service.status(), {
    configured: true,
    mainAccount: MAIN,
    agentAddress: AGENT,
    authorized: false,
    reason: 'Agent 不存在或已撤销',
    expiresAt: '1789531200123',
    isGlobal: false,
  });
});

test('prepare approval reads existing Agents and chooses the exact replace target', async () => {
  const ctx = service({ agents: [{
    agent: OLD_AGENT,
    expiresAt: '1789000000000',
    isExpired: false,
    name: NAME,
    isGlobal: false,
  }] });
  const prepared = await ctx.service.prepareApproval({
    agentAddress: AGENT,
    delegator: MAIN,
    hostname: 'vps.example',
  });
  assert.equal(prepared.action, 'replace');
  assert.equal(prepared.replacedAgent, OLD_AGENT);
  assert.equal(prepared.from, MAIN);
  assert.equal(ctx.rpcClient.chainChecks, 1);
  assert.equal(ctx.rpcClient.agentListChecks, 1);
});

test('revoke preparation requires the connected main account and active Agent', async () => {
  const ctx = service();
  const prepared = await ctx.service.prepareRevoke({
    mainAccount: MAIN,
    agentAddress: AGENT,
  });
  assert.equal(prepared.from, MAIN);
  assert.equal(prepared.to, '0x0000000000000000000000000000000000001008');
  await assert.rejects(ctx.service.prepareRevoke({
    mainAccount: OLD_AGENT,
    agentAddress: AGENT,
  }), /尚未获得有效授权/);
});

test('clear refuses an active Agent and removes only its key after revocation is confirmed', async () => {
  const processEnv = {
    POPDEX_MAIN_ACCOUNT: MAIN,
    POPDEX_AGENT_PRIVATE_KEY: PRIVATE_KEY,
  };
  const active = service({
    processEnv,
    content: `DE_MODE=live\nPOPDEX_MAIN_ACCOUNT=${MAIN}\nPOPDEX_AGENT_PRIVATE_KEY=${PRIVATE_KEY}\nRS_MODE=live\n`,
  });
  await assert.rejects(active.service.clear(), /撤销尚未确认/);

  const revoked = service({
    info: authorizedInfo({ exists: false, delegator: null }),
    processEnv,
    content: `DE_MODE=live\nPOPDEX_MAIN_ACCOUNT=${MAIN}\nPOPDEX_AGENT_PRIVATE_KEY=${PRIVATE_KEY}\nRS_MODE=live\n`,
  });
  const result = await revoked.service.clear();
  assert.deepEqual(result, { configured: false, mainAccount: MAIN });
  assert.match(revoked.fsImpl.content, /^DE_MODE=live$/m);
  assert.match(revoked.fsImpl.content, /^RS_MODE=live$/m);
  assert.match(revoked.fsImpl.content, new RegExp(`^POPDEX_MAIN_ACCOUNT=${MAIN}$`, 'm'));
  assert.match(revoked.fsImpl.content, /^# POPDEX_AGENT_PRIVATE_KEY=$/m);
  assert.equal(processEnv.POPDEX_MAIN_ACCOUNT, MAIN);
  assert.equal(Object.hasOwn(processEnv, 'POPDEX_AGENT_PRIVATE_KEY'), false);
});
