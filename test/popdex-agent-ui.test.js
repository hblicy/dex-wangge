import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const readProject = (file) => fs.readFileSync(new URL(file, root), 'utf8');

test('dashboard adds a standalone PopDEX Agent tab without replacing Extended', () => {
  const html = readProject('public/index.html');
  assert.match(html, /switchTab\('px-agent'\)[^>]*>🔐 PopDEX Agent</);
  assert.match(html, /id="tab-px-agent"/);
  assert.match(html, /switchTab\('ex'\)[^>]*>[\s\S]*Extended/);
  assert.match(html, /<script src="\/vendor\/ethers\.js"><\/script>/);
  assert.match(html, /<script src="\/popdex-agent\.js"><\/script>/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com/);
});

test('Agent key is generated only in browser memory and cleared after save', () => {
  const ui = readProject('public/popdex-agent.js');
  assert.match(ui, /ethers\.Wallet\.createRandom\(\)/);
  assert.match(ui, /let generatedPrivateKey = null/);
  assert.match(ui, /generatedPrivateKey = null/);
  assert.match(ui, /私钥已保存到 VPS，本页不再显示/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(ui, /innerHTML/);
});

test('Agent UI uses the guarded API helper and exposes no PopDEX trading action', () => {
  const ui = readProject('public/popdex-agent.js');
  assert.match(ui, /apiFetch\('\/api\/px\/agent\/status'/);
  for (const route of ['prepare-approval', 'verify', 'save', 'prepare-revoke', 'clear']) {
    assert.match(ui, new RegExp(`apiFetch\\('/api/px/agent/${route}'`));
  }
  assert.doesNotMatch(ui, /\bfetch\s*\(/);
  assert.doesNotMatch(ui, /\/api\/px\/(?:start|stop|orders|place|cancel|leverage|close)/);
  assert.match(ui, /eth_requestAccounts/);
  assert.match(ui, /wallet_switchEthereumChain/);
  assert.match(ui, /eth_sendTransaction/);
  assert.match(ui, /waitForTransaction/);
});

test('Agent UI refuses to guess unknown PopDEX network metadata', () => {
  const ui = readProject('public/popdex-agent.js');
  assert.match(ui, /4902/);
  assert.match(ui, /PopDEX 官方页面/);
  assert.doesNotMatch(ui, /wallet_addEthereumChain|nativeCurrency|rpcUrls|blockExplorerUrls/);
});

test('README and AGENTS describe authorization as isolated and not yet a trading runtime', () => {
  const readme = readProject('README.md');
  const agents = readProject('AGENTS.md');
  for (const document of [readme, agents]) {
    assert.match(document, /PopDEX.*Agent/si);
    assert.match(document, /主钱包私钥.*(?:不会|禁止|不要|绝不)/);
    assert.match(document, /(?:尚未|不开放).*PopDEX.*(?:下单|实盘|交易运行)/s);
  }
  assert.match(readme, /生成.*授权.*保存.*撤销/s);
});
