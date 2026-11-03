import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const project = join(root, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project');
const token = 'test-shutdown-token-7342';
after(() => rm(project, { recursive: true, force: true }));

async function filesBelow(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relative = join(prefix, entry.name);
    assert.equal((await lstat(path)).isSymbolicLink(), false, `未物化的链接：${relative}`);
    if (entry.isDirectory()) found.push(...await filesBelow(path, relative));
    else found.push(relative);
  }
  return found;
}

function request(port, path, { method = 'GET', authorization, localAddress, hostname = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method, localAddress, headers: authorization ? { authorization } : {} }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('HTTP 请求超时')));
    req.end();
  });
}

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Android 入口提前退出：${child.exitCode}`);
    try { if ((await request(port, '/api/health')).status === 200) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Android 入口未就绪');
}

test('准备脚本只打包运行期文件和完整 AlphaTab，并物化生产依赖', { timeout: 120_000 }, async () => {
  const result = spawnSync(process.execPath, ['scripts/prepare-android-node.mjs'], { cwd: root, encoding: 'utf8', timeout: 110_000 });
  assert.equal(result.status, 0, result.stderr);
  const files = await filesBelow(project);
  assert(files.includes('main.mjs'));
  assert(files.includes(join('server', 'index.js')));
  assert(files.includes(join('public', 'app.js')));
  assert(files.includes(join('legal', 'alphatab-MPL-2.0.txt')));
  assert(files.includes('LICENSE'));
  assert(files.includes('THIRD_PARTY_NOTICES.md'));
  assert.deepEqual(JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).type, 'module');
  for (const name of ['express', 'qrcode', 'ws', '@coderline/alphatab']) {
    assert(files.includes(join('node_modules', name, 'package.json')), `${name} 未物化`);
  }
  const sourceDist = await filesBelow(join(root, 'node_modules', '@coderline', 'alphatab', 'dist'));
  const packedDist = files.filter((file) => file.startsWith(join('node_modules', '@coderline', 'alphatab', 'dist') + '/'))
    .map((file) => file.slice(join('node_modules', '@coderline', 'alphatab', 'dist').length + 1));
  assert.deepEqual(packedDist.sort(), sourceDist.sort());
  for (const excluded of ['desktop/', 'work/', 'build/', 'scripts/']) assert(!files.some((file) => file.startsWith(excluded)), `不应打包 ${excluded}`);
  for (const excluded of ['test/', '.pnpm/']) assert(!files.some((file) => file.startsWith(excluded) || file.includes(`/${excluded}`)), `不应打包 ${excluded}`);
  assert(!files.some((file) => /\.(?:gp|gp3|gp4|gp5|gpx|mp4|webm|upload)$/i.test(file)));
});

test('Android 入口沿用服务路由且内部停机要求回环地址和随机令牌', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), 'band-room-android-'));
  const port = 42000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [join(project, 'main.mjs')], {
    cwd: project,
    env: { ...process.env, PORT: String(port), BAND_ROOM_DATA_DIR: dataDir, BAND_ROOM_SHUTDOWN_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitForHealth(port, child);
  assert.equal((await request(port, '/host')).status, 200, stderr);
  assert.equal((await request(port, '/alphatab/alphaTab.mjs')).status, 200);
  assert.equal((await request(port, '/api/internal/shutdown', { method: 'POST' })).status, 401);
  assert.equal((await request(port, '/api/internal/shutdown', { method: 'POST', authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await request(port, '/api/health')).status, 200);
  const lan = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (lan) {
    assert.equal((await request(port, '/api/internal/shutdown', { method: 'POST', authorization: `Bearer ${token}`, hostname: lan })).status, 403);
  }
  assert.equal((await request(port, '/api/internal/shutdown', { method: 'POST', authorization: `Bearer ${token}` })).status, 202);
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, stderr);
});

test('Android 启动清理上次崩溃遗留的上传暂存文件', { timeout: 20_000 }, async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), 'band-room-android-orphan-'));
  const videos = join(dataDir, 'videos');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(videos));
  await writeFile(join(videos, 'orphan.upload'), 'incomplete');
  const port = 52000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [join(project, 'main.mjs')], { cwd: project, env: { ...process.env, PORT: String(port), BAND_ROOM_DATA_DIR: dataDir, BAND_ROOM_SHUTDOWN_TOKEN: token }, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(dataDir, { recursive: true, force: true }); });
  await waitForHealth(port, child);
  assert.deepEqual(await readdir(videos), []);
  assert.equal((await request(port, '/api/internal/shutdown', { method: 'POST', authorization: `Bearer ${token}` })).status, 202);
  await once(child, 'exit');
});
