(() => {
  'use strict';

  const POPDEX_CHAIN_ID = '0x888';
  const RECEIPT_TIMEOUT_MS = 120000;
  let generatedPrivateKey = null;
  let generatedAgentAddress = null;
  let connectedMainAccount = null;
  let authorizationVerified = false;
  let configuredStatus = null;

  const byId = (id) => document.getElementById(id);

  function setStatus(message, kind = 'muted') {
    const element = byId('px-agent-status');
    element.className = kind;
    element.textContent = message;
  }

  function errorMessage(error) {
    return error?.message || String(error);
  }

  async function responseJson(response) {
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`PopDEX Agent 接口返回了非 JSON 数据（HTTP ${response.status}）。`);
    }
    if (!response.ok || body?.error) {
      throw new Error(body?.error || `PopDEX Agent 接口请求失败（HTTP ${response.status}）。`);
    }
    return body;
  }

  function getAgentStatus() {
    return apiFetch('/api/px/agent/status').then(responseJson);
  }

  function prepareApproval(body) {
    return apiFetch('/api/px/agent/prepare-approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(responseJson);
  }

  function verifyApproval(body) {
    return apiFetch('/api/px/agent/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(responseJson);
  }

  function saveAgent(body) {
    return apiFetch('/api/px/agent/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(responseJson);
  }

  function prepareRevoke(body) {
    return apiFetch('/api/px/agent/prepare-revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(responseJson);
  }

  function clearAgent() {
    return apiFetch('/api/px/agent/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(responseJson);
  }

  function renderStatus(status) {
    configuredStatus = status;
    byId('px-agent-main').textContent = status.mainAccount || connectedMainAccount || '—';
    if (!generatedAgentAddress) {
      byId('px-agent-address').textContent = status.agentAddress || '—';
    }
    byId('px-agent-revoke').disabled = !(status.configured && status.authorized);
    if (!status.configured) {
      setStatus('未配置临时 Agent');
    } else if (status.authorized) {
      setStatus(`已授权，有效期至 ${new Date(Number(status.expiresAt)).toLocaleString('zh-CN')}`, 'up');
    } else {
      setStatus(`已配置但授权无效：${status.reason || '原因未知'}`, 'down');
    }
  }

  async function refresh() {
    setStatus('正在读取链上状态…');
    try {
      renderStatus(await getAgentStatus());
      return configuredStatus;
    } catch (error) {
      setStatus(`读取失败：${errorMessage(error)}`, 'down');
      throw error;
    }
  }

  function generateAgent() {
    const wallet = ethers.Wallet.createRandom();
    generatedPrivateKey = wallet.privateKey;
    generatedAgentAddress = wallet.address;
    connectedMainAccount = null;
    authorizationVerified = false;
    byId('px-agent-address').textContent = generatedAgentAddress;
    byId('px-agent-private').textContent = generatedPrivateKey;
    byId('px-agent-copy').disabled = false;
    byId('px-agent-authorize').disabled = false;
    byId('px-agent-save').disabled = true;
    setStatus('新 Agent 只存在于本页内存，请先备份私钥再授权。', 'down');
  }

  async function copyPrivateKey() {
    if (!generatedPrivateKey) throw new Error('当前没有可复制的 Agent 私钥。');
    await navigator.clipboard.writeText(generatedPrivateKey);
    setStatus('Agent 私钥已复制，请离线妥善保管。', 'up');
  }

  function walletErrorCode(error) {
    return error?.code ?? error?.data?.originalError?.code ?? error?.cause?.code;
  }

  async function connectWallet(expectedMainAccount = null) {
    if (!window.ethereum) throw new Error('未检测到浏览器钱包。');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('浏览器钱包没有返回账户。');
    }
    const account = ethers.getAddress(accounts[0]);
    if (expectedMainAccount && account !== ethers.getAddress(expectedMainAccount)) {
      throw new Error(`当前钱包 ${account} 与已配置主账户不一致。`);
    }
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: POPDEX_CHAIN_ID }],
      });
    } catch (error) {
      if (walletErrorCode(error) === 4902) {
        throw new Error('钱包尚未添加 PopDEX Mainnet。请先在 PopDEX 官方页面连接钱包并添加网络，然后返回重试。');
      }
      throw error;
    }
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (String(chainId).toLowerCase() !== POPDEX_CHAIN_ID) {
      throw new Error(`钱包网络切换失败：期望 ${POPDEX_CHAIN_ID}，实际 ${chainId}。`);
    }
    return account;
  }

  function checkedTransaction(prepared, account) {
    if (
      prepared?.from !== account
      || typeof prepared?.to !== 'string'
      || typeof prepared?.data !== 'string'
      || prepared.chainId !== POPDEX_CHAIN_ID
    ) {
      throw new Error('服务端返回的 PopDEX Agent 交易参数与当前钱包不一致。');
    }
    return {
      from: account,
      to: prepared.to,
      data: prepared.data,
      value: prepared.value,
      chainId: prepared.chainId,
      type: prepared.type,
      gas: prepared.gas,
      gasPrice: prepared.gasPrice,
    };
  }

  async function sendAndConfirm(transaction) {
    const transactionHash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [transaction],
    });
    const provider = new ethers.BrowserProvider(window.ethereum);
    const receipt = await provider.waitForTransaction(transactionHash, 1, RECEIPT_TIMEOUT_MS);
    if (!receipt || Number(receipt.status) !== 1) {
      throw new Error(`PopDEX Agent 链上交易未成功确认：${transactionHash}`);
    }
    return transactionHash;
  }

  async function authorizeAgent() {
    if (!generatedPrivateKey || !generatedAgentAddress) {
      throw new Error('请先生成临时 Agent。');
    }
    const mainAccount = await connectWallet();
    const prepared = await prepareApproval({
      agentAddress: generatedAgentAddress,
      delegator: mainAccount,
      hostname: window.location.hostname,
    });
    const action = prepared.action === 'replace' ? '替换现有同名 Agent' : '授权新 Agent';
    if (!window.confirm(`确认使用主钱包 ${mainAccount} ${action}？\nAgent：${generatedAgentAddress}`)) return;
    let transactionHash = null;
    try {
      transactionHash = await sendAndConfirm(checkedTransaction(prepared, mainAccount));
      await verifyApproval({ mainAccount, agentAddress: generatedAgentAddress });
      connectedMainAccount = mainAccount;
      authorizationVerified = true;
      byId('px-agent-main').textContent = mainAccount;
      byId('px-agent-save').disabled = false;
      byId('px-agent-authorize').disabled = true;
      setStatus(`链上授权已确认（${transactionHash}），请保存 Agent 私钥。`, 'up');
    } catch (error) {
      if (transactionHash) {
        throw new Error(`链上交易 ${transactionHash} 已确认，但授权回验失败：${errorMessage(error)}。请保留私钥并刷新状态，不要重复授权。`);
      }
      throw error;
    }
  }

  async function persistAgent() {
    if (!authorizationVerified || !generatedPrivateKey || !connectedMainAccount) {
      throw new Error('Agent 尚未完成链上授权回验，拒绝保存。');
    }
    if (!window.confirm('确认把临时 Agent 私钥保存到 VPS 的 .env？主钱包私钥不会保存。')) return;
    await saveAgent({
      mainAccount: connectedMainAccount,
      agentPrivateKey: generatedPrivateKey,
    });
    generatedPrivateKey = null;
    authorizationVerified = false;
    byId('px-agent-private').textContent = '私钥已保存到 VPS，本页不再显示';
    byId('px-agent-copy').disabled = true;
    byId('px-agent-authorize').disabled = true;
    byId('px-agent-save').disabled = true;
    await refresh();
  }

  async function waitUntilRevoked(mainAccount, agentAddress) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const status = await getAgentStatus();
      if (
        status.configured
        && status.mainAccount === mainAccount
        && status.agentAddress === agentAddress
        && status.authorized === false
      ) {
        renderStatus(status);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('链上撤销交易已确认，但只读回验仍显示 Agent 有效。请稍后刷新，暂不清除 VPS 私钥。');
  }

  async function revokeAgent() {
    const status = await refresh();
    if (!status?.configured || !status.authorized || !status.mainAccount || !status.agentAddress) {
      throw new Error('当前没有可撤销的有效 Agent。');
    }
    const mainAccount = await connectWallet(status.mainAccount);
    const prepared = await prepareRevoke({
      mainAccount,
      agentAddress: status.agentAddress,
    });
    if (!window.confirm(`确认撤销 Agent ${status.agentAddress}？撤销确认后将清除 VPS 中的 Agent 私钥。`)) return;
    let transactionHash = null;
    try {
      transactionHash = await sendAndConfirm(checkedTransaction(prepared, mainAccount));
      await waitUntilRevoked(mainAccount, status.agentAddress);
      await clearAgent();
      generatedPrivateKey = null;
      generatedAgentAddress = null;
      connectedMainAccount = null;
      authorizationVerified = false;
      byId('px-agent-private').textContent = '已撤销并清除 VPS 私钥';
      byId('px-agent-copy').disabled = true;
      byId('px-agent-authorize').disabled = true;
      byId('px-agent-save').disabled = true;
      await refresh();
    } catch (error) {
      if (transactionHash) {
        throw new Error(`链上撤销交易 ${transactionHash} 已确认，但本地清理未完成：${errorMessage(error)}`);
      }
      throw error;
    }
  }

  function run(button, action) {
    return async () => {
      button.disabled = true;
      try {
        await action();
      } catch (error) {
        setStatus(errorMessage(error), 'down');
      } finally {
        if (button.id === 'px-agent-refresh' || button.id === 'px-agent-generate') {
          button.disabled = false;
        } else if (button.id === 'px-agent-copy') {
          button.disabled = !generatedPrivateKey;
        } else if (button.id === 'px-agent-authorize') {
          button.disabled = !generatedPrivateKey || authorizationVerified;
        } else if (button.id === 'px-agent-save') {
          button.disabled = !generatedPrivateKey || !authorizationVerified;
        } else if (button.id === 'px-agent-revoke') {
          button.disabled = !(configuredStatus?.configured && configuredStatus.authorized);
        }
      }
    };
  }

  const generateButton = byId('px-agent-generate');
  const copyButton = byId('px-agent-copy');
  const authorizeButton = byId('px-agent-authorize');
  const saveButton = byId('px-agent-save');
  const refreshButton = byId('px-agent-refresh');
  const revokeButton = byId('px-agent-revoke');
  generateButton.addEventListener('click', run(generateButton, generateAgent));
  copyButton.addEventListener('click', run(copyButton, copyPrivateKey));
  authorizeButton.addEventListener('click', run(authorizeButton, authorizeAgent));
  saveButton.addEventListener('click', run(saveButton, persistAgent));
  refreshButton.addEventListener('click', run(refreshButton, refresh));
  revokeButton.addEventListener('click', run(revokeButton, revokeAgent));
  window.refreshPopdexAgentStatus = () => refresh().catch(() => {});
  window.refreshPopdexAgentStatus();
})();
