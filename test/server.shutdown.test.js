import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

test('停机等待已写盘曲谱上传及失效结果清理，返回后不残留文件', { timeout: 5000 }, async (t) => {
  const dataDir = await fs.mkdtemp(join(tmpdir(), 'band-room-stop-score-'));
  process.env.PORT = '0';
  process.env.BAND_ROOM_DATA_DIR = dataDir;
  const server = await import('../server/index.js');
  const { port } = await server.serverReady;
  const host = new WebSocket(`ws://127.0.0.1:${port}`);
  let releaseWrite; let notifyWritten; let releaseCleanup; let notifyCleanup;
  const writeAllowed = new Promise((resolve) => { releaseWrite = resolve; });
  const written = new Promise((resolve) => { notifyWritten = resolve; });
  const cleanupAllowed = new Promise((resolve) => { releaseCleanup = resolve; });
  const cleaning = new Promise((resolve) => { notifyCleanup = resolve; });
  const originalWriteFile = fs.writeFile; const originalRm = fs.rm;
  let scorePath; let stopped;
  t.mock.method(fs, 'writeFile', async (path, ...args) => {
    await originalWriteFile(path, ...args);
    if (typeof path === 'string' && path.startsWith(join(dataDir, 'scores'))) {
      scorePath = path; notifyWritten(); await writeAllowed;
    }
  });
  t.mock.method(fs, 'rm', async (path, options) => {
    if (path === scorePath) { notifyCleanup(); await cleanupAllowed; }
    return originalRm(path, options);
  });
  syncBuiltinESMExports();
  try {
    await once(host, 'open');
    const joined = once(host, 'message');
    host.send(JSON.stringify({ type: 'room:create', clientId: 'shutdown-score' }));
    const { hostToken } = JSON.parse((await joined)[0]);
    host.send(JSON.stringify({ type: 'score:upload', hostToken, upload: { name: 'score.gp5', data: Buffer.alloc(64).toString('base64') } }));
    await written;
    let stopReturned = false;
    stopped = server.stopBandRoomServer().then(() => { stopReturned = true; });
    const first = await Promise.race([stopped.then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('writing'), 80))]);
    assert.equal(first, 'writing', '写盘任务挂起时停机不得返回');
    await fs.access(scorePath);
    releaseWrite();
    assert.equal(await Promise.race([stopped.then(() => 'stopped'), cleaning.then(() => 'cleaning')]), 'cleaning');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopReturned, false, '失效上传的清理挂起时停机不得返回');
    releaseCleanup(); await stopped;
    await assert.rejects(fs.access(scorePath), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(join(dataDir, 'scores')), []);
    await server.stopBandRoomServer();
  } finally {
    releaseWrite(); releaseCleanup();
    if (scorePath) await cleaning;
    await stopped;
    await server.stopBandRoomServer();
    host.terminate();
    t.mock.restoreAll(); syncBuiltinESMExports();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
