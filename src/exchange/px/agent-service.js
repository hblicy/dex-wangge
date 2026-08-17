import fs from 'node:fs';
import {
  deriveAgentAddress,
  prepareAgentAuthorization,
  prepareAgentRevocation,
} from './agent.js';
import { strictAddress } from './normalize.js';
import { PopdexRpcClient } from './rpc-client.js';
import { writeEnvFile } from '../../envfile.js';

const MAIN_ACCOUNT_KEY = 'POPDEX_MAIN_ACCOUNT';
const AGENT_PRIVATE_KEY = 'POPDEX_AGENT_PRIVATE_KEY';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setEnvLine(content, key, value) {
  const line = value ? `${key}=${value}` : `# ${key}=`;
  const pattern = new RegExp(`^\\s*(?:#\\s*)?${escapeRegExp(key)}\\s*=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  const prefix = content.trimEnd();
  return `${prefix}${prefix ? '\n' : ''}${line}\n`;
}

function exactExpiry(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error('PopDEX Agent expiresAt 必须是非负整数字符串。');
  }
  return BigInt(value);
}

export class PopdexAgentService {
  constructor({
    rpcClient = new PopdexRpcClient(),
    envFile,
    processEnv = process.env,
    fsImpl = fs,
    platform = process.platform,
    now = () => Date.now(),
  } = {}) {
    if (typeof envFile !== 'string' || envFile.length === 0) {
      throw new Error('PopDEX Agent envFile 必须是非空路径。');
    }
    if (typeof now !== 'function') {
      throw new Error('PopDEX Agent now 必须是函数。');
    }
    this.rpcClient = rpcClient;
    this.envFile = envFile;
    this.processEnv = processEnv;
    this.fsImpl = fsImpl;
    this.platform = platform;
    this.now = now;
  }

  async inspectAuthorization(mainAccount, agentAddress) {
    const main = strictAddress(mainAccount, 'mainAccount');
    const agent = strictAddress(agentAddress, 'agentAddress');
    if (main === agent) {
      throw new Error('PopDEX Agent 地址与主账户不能相同。');
    }
    await this.rpcClient.verifyChain();
    const info = await this.rpcClient.getAgentInfo(agent);
    const expiry = exactExpiry(info.expiresAt);
    const nowMs = this.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error('PopDEX Agent 当前时间无效。');
    }

    let reason = null;
    if (!info.exists) reason = 'Agent 不存在或已撤销';
    else if (info.isExpired || expiry <= BigInt(nowMs)) reason = 'Agent 授权已过期';
    else if (info.delegator !== main) reason = 'Agent delegator 与主账户不一致';
    else if (info.isGlobal) reason = 'Agent 被授权为全局权限';

    return {
      configured: true,
      mainAccount: main,
      agentAddress: agent,
      authorized: reason === null,
      reason,
      expiresAt: info.expiresAt,
      isGlobal: info.isGlobal,
      info,
    };
  }

  async verifyAuthorization({ mainAccount, agentAddress }) {
    const status = await this.inspectAuthorization(mainAccount, agentAddress);
    if (!status.authorized) {
      throw new Error(`PopDEX Agent 尚未获得有效授权：${status.reason}。`);
    }
    const { info: _info, ...publicStatus } = status;
    return publicStatus;
  }

  async status() {
    const rawMain = this.processEnv[MAIN_ACCOUNT_KEY] || '';
    const privateKey = this.processEnv[AGENT_PRIVATE_KEY] || '';
    if (!privateKey) {
      return {
        configured: false,
        mainAccount: rawMain ? strictAddress(rawMain, 'mainAccount') : null,
      };
    }
    if (!rawMain) {
      throw new Error('PopDEX Agent 已配置私钥但缺少主账户。');
    }
    const status = await this.inspectAuthorization(
      rawMain,
      deriveAgentAddress(privateKey),
    );
    const { info: _info, ...publicStatus } = status;
    return publicStatus;
  }

  async prepareApproval({ agentAddress, delegator, hostname }) {
    const main = strictAddress(delegator, 'delegator');
    await this.rpcClient.verifyChain();
    const existingAgents = await this.rpcClient.getAgents(main);
    return {
      from: main,
      ...prepareAgentAuthorization({
        agentAddress,
        delegator: main,
        hostname,
        existingAgents,
        nowMs: this.now(),
      }),
    };
  }

  async save({ mainAccount, agentPrivateKey }) {
    const main = strictAddress(mainAccount, 'mainAccount');
    const agentAddress = deriveAgentAddress(agentPrivateKey);
    const status = await this.verifyAuthorization({ mainAccount: main, agentAddress });
    this.writeSettings({
      [MAIN_ACCOUNT_KEY]: main,
      [AGENT_PRIVATE_KEY]: agentPrivateKey,
    });
    return status;
  }

  async prepareRevoke({ mainAccount, agentAddress }) {
    const status = await this.verifyAuthorization({ mainAccount, agentAddress });
    return {
      from: status.mainAccount,
      ...prepareAgentRevocation(status.agentAddress),
    };
  }

  async clear() {
    const rawMain = this.processEnv[MAIN_ACCOUNT_KEY] || '';
    const privateKey = this.processEnv[AGENT_PRIVATE_KEY] || '';
    const main = rawMain ? strictAddress(rawMain, 'mainAccount') : null;
    if (!privateKey) return { configured: false, mainAccount: main };
    if (!main) throw new Error('PopDEX Agent 已配置私钥但缺少主账户。');

    const agentAddress = deriveAgentAddress(privateKey);
    await this.rpcClient.verifyChain();
    const info = await this.rpcClient.getAgentInfo(agentAddress);
    if (info.exists) {
      throw new Error('PopDEX Agent 链上撤销尚未确认，拒绝清除本地私钥。');
    }
    this.writeSettings({ [AGENT_PRIVATE_KEY]: '' });
    return { configured: false, mainAccount: main };
  }

  writeSettings(values) {
    let content = this.fsImpl.existsSync(this.envFile)
      ? this.fsImpl.readFileSync(this.envFile, 'utf8')
      : '';
    for (const [key, value] of Object.entries(values)) {
      content = setEnvLine(content, key, value);
    }
    if (!content.endsWith('\n')) content += '\n';
    writeEnvFile(this.envFile, content, {
      fsImpl: this.fsImpl,
      platform: this.platform,
    });
    for (const [key, value] of Object.entries(values)) {
      if (value) this.processEnv[key] = value;
      else delete this.processEnv[key];
    }
  }
}
