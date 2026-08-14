import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateStore } from '../src/persist.js';

function missingFile() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

test('missing state starts empty', () => {
  const fs = { readFileSync: missingFile };
  assert.deepEqual(createStateStore('state.json', fs).loadState(), {});
});

test('corrupt state is not silently converted to empty', () => {
  const fs = { readFileSync: () => '{broken' };
  assert.throws(() => createStateStore('state.json', fs).loadState(), /状态文件读取失败/);
});

test('save writes a private temp file and atomically renames it', () => {
  const calls = [];
  const fs = {
    readFileSync: missingFile,
    writeFileSync: (...args) => calls.push(['write', ...args]),
    renameSync: (...args) => calls.push(['rename', ...args]),
  };

  createStateStore('state.json', fs).saveSnapshot('de', { running: true });

  assert.equal(calls[0][1], 'state.json.tmp');
  assert.deepEqual(calls[0][3], { encoding: 'utf8', mode: 0o600 });
  assert.deepEqual(calls[1], ['rename', 'state.json.tmp', 'state.json']);
});

test('write failure propagates to caller', () => {
  const fs = {
    readFileSync: missingFile,
    writeFileSync() { throw new Error('disk full'); },
  };
  const store = createStateStore('state.json', fs);

  assert.throws(() => store.saveSnapshot('de', {}), /状态文件写入失败.*disk full/);
});
