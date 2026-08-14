// Crash-safe state persistence. Snapshots contain public bot configuration and
// accounting data only; credentials are never written here.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const STATE_FILE = path.join(ROOT, '.state.json');

export function createStateStore(stateFile, fsImpl = fs) {
  let cache = null;

  const persist = () => {
    try {
      const tempFile = stateFile + '.tmp';
      fsImpl.writeFileSync(tempFile, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
      fsImpl.renameSync(tempFile, stateFile);
    } catch (cause) {
      throw new Error(`状态文件写入失败 (${stateFile}): ${cause?.message || cause}`, { cause });
    }
  };

  const loadState = () => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8'));
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('根节点必须是 JSON 对象');
      }
      cache = parsed;
    } catch (cause) {
      if (cause?.code === 'ENOENT') return (cache = {});
      throw new Error(`状态文件读取失败 (${stateFile}): ${cause?.message || cause}`, { cause });
    }
    return cache;
  };

  return {
    loadState,
    loadSnapshot: (key) => loadState()[key] || null,
    saveSnapshot(key, snapshot) {
      const state = loadState();
      state[key] = snapshot;
      cache = state;
      persist();
    },
    flushState() {
      if (cache) persist();
    },
  };
}

const defaultStore = createStateStore(STATE_FILE);

export const loadState = defaultStore.loadState;
export const loadSnapshot = defaultStore.loadSnapshot;
export const saveSnapshot = defaultStore.saveSnapshot;
export const flushState = defaultStore.flushState;
