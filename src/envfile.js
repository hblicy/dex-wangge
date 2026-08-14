import fs from 'node:fs';

export function assertEnvFileSecure(envFile, { fsImpl = fs, platform = process.platform } = {}) {
  if (platform === 'win32' || !fsImpl.existsSync(envFile)) return;
  const mode = fsImpl.statSync(envFile).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`密钥文件权限不安全 (${mode.toString(8)})，请执行 chmod 600 ${envFile}`);
  }
}

export function writeEnvFile(envFile, content, { fsImpl = fs, platform = process.platform } = {}) {
  if (platform !== 'win32' && fsImpl.existsSync(envFile)) fsImpl.chmodSync(envFile, 0o600);
  fsImpl.writeFileSync(envFile, content, { encoding: 'utf8', mode: 0o600 });
  if (platform !== 'win32') fsImpl.chmodSync(envFile, 0o600);
}
