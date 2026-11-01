import assert from 'node:assert/strict';
import fs, { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { streamVideoUpload } from '../server/video-media.js';
import test from 'node:test';
import WebSocket from 'ws';

const dataDir = await mkdtemp(join(tmpdir(), 'band-room-test-'));
process.env.PORT = '0';
process.env.BAND_ROOM_DATA_DIR = dataDir;
const serverModule = await import('../server/index.js');
const { port } = await serverModule.serverReady;
const origin = `http://127.0.0.1:${port}`;

class SocketClient {
  constructor() {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.messages = [];
    this.waiters = [];
    this.closePromise = new Promise((resolve) => { this.socket.on('close', resolve); });
    this.socket.on('message', (raw) => {
      const event = JSON.parse(raw);
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === event.type && (!waiter.predicate || waiter.predicate(event)));
      if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1)[0].resolve(event);
      else this.messages.push(event);
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
  }

  send(event) { this.socket.send(JSON.stringify(event)); }

  next(type, predicate = null, timeoutMs = 2500) {
    const queuedIndex = this.messages.findIndex((event) => event.type === type && (!predicate || predicate(event)));
    if (queuedIndex >= 0) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`等待 ${type} 超时`));
      }, timeoutMs).unref();
    });
  }

  close() { this.socket.close(); }
}

// 建立"一个主机 + N 个乐手"的房间，返回主机凭证与房间号。
async function createRoomWithMembers(memberCount) {
  const host = new SocketClient();
  await host.open();
  host.send({ type: 'room:create', clientId: 'host-scale' });
  const joined = await host.next('room:joined');
  const members = [];
  for (let index = 0; index < memberCount; index += 1) {
    const member = new SocketClient();
    await member.open();
    member.send({ type: 'room:join', roomId: joined.room.id, name: `乐手${index}`, instrument: 'guitar', clientId: `member-scale-${index}` });
    await member.next('room:joined');
    members.push(member);
  }
  return { host, hostToken: joined.hostToken, roomId: joined.room.id, members };
}

function fakeScoreBuffer(byteLength) {
  const base64 = Buffer.alloc(byteLength, 0).toString('base64');
  return { name: 'score.gp5', data: base64 };
}

test.after(async () => {
  await serverModule.stopBandRoomServer();
  await rm(dataDir, { recursive: true, force: true });
});

test('健康检查不暴露敏感信息', async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.service, 'Band Room');
  assert.match(health.version, /^\d+\.\d+\.\d+$/);
  assert.equal('hostToken' in health, false);
});

test('法律文件可在离线主机页面读取，二维码拒绝危险协议', async () => {
  const legal = await fetch(`${origin}/legal.html`);
  assert.equal(legal.status, 200);
  assert.match(await legal.text(), /AGPL-3\.0-only/);
  const license = await fetch(`${origin}/legal-files/Band-Room-AGPL-3.0.txt`);
  assert.equal(license.status, 200);
  assert.match(await license.text(), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  const notices = await fetch(`${origin}/legal-files/THIRD_PARTY_NOTICES.md`);
  assert.equal(notices.status, 200);
  const releaseInfo = await fetch(`${origin}/release-info.json`).then((response) => response.json());
  assert.match(releaseInfo.sourceUrl, /^https:\/\/github\.com\//);
  const invalidQr = await fetch(`${origin}/api/qrcode?url=${encodeURIComponent('javascript:alert(1)')}`);
  assert.equal(invalidQr.status, 400);
  const missingQr = await fetch(`${origin}/api/qrcode`);
  assert.equal(missingQr.status, 400);
});

test('主机凭证、持续时钟、暂停和跳转形成最小同步闭环', async () => {
  const host = new SocketClient();
  const member = new SocketClient();
  await Promise.all([host.open(), member.open()]);

  host.send({ type: 'room:create', clientId: 'host-test' });
  const hostJoined = await host.next('room:joined');
  assert.match(hostJoined.room.id, /^\d{7}$/);
  assert.equal(hostJoined.source, null);
  assert.equal('score' in hostJoined, false);
  assert.equal(typeof hostJoined.hostToken, 'string');
  assert.ok(hostJoined.hostToken.length >= 24);

  member.send({ type: 'room:join', roomId: hostJoined.room.id, name: '测试乐手', instrument: 'guitar', clientId: 'member-test' });
  const memberJoined = await member.next('room:joined');
  assert.equal(memberJoined.room.isHost, false);
  assert.equal(memberJoined.hostToken, undefined);

  member.send({ type: 'playback:control', hostToken: hostJoined.hostToken, action: 'set-playing', isPlaying: true });
  const forbidden = await member.next('error');
  assert.equal(forbidden.code, 'HOST_AUTH_INVALID');

  host.send({ type: 'playback:control', hostToken: hostJoined.hostToken, action: 'set-playing', isPlaying: true });
  const first = await member.next('playback:state', (event) => event.playback.isPlaying);
  const second = await member.next('playback:state', (event) => event.playback.isPlaying && event.playback.serverTick > first.playback.serverTick);
  assert.ok(second.playback.positionMs > first.playback.positionMs);
  assert.ok(second.playback.timestamp >= first.playback.timestamp);

  host.send({ type: 'playback:control', hostToken: hostJoined.hostToken, action: 'set-playing', isPlaying: false });
  const paused = await member.next('playback:state', (event) => !event.playback.isPlaying);
  const pausedPosition = paused.playback.positionMs;
  member.send({ type: 'playback:request-state' });
  const pausedAgain = await member.next('playback:state', (event) => !event.playback.isPlaying);
  assert.equal(pausedAgain.playback.positionMs, pausedPosition);

  host.send({ type: 'playback:control', hostToken: hostJoined.hostToken, action: 'seek', positionMs: 5000 });
  const sought = await member.next('playback:state', (event) => !event.playback.isPlaying && event.playback.positionMs === 5000);
  assert.equal(sought.playback.serverTick, 9600);

  host.close();
  member.close();
});

test('伪造主机凭证与非法房间号被拒绝', async () => {
  const host = new SocketClient();
  const attacker = new SocketClient();
  await Promise.all([host.open(), attacker.open()]);
  host.send({ type: 'room:create', clientId: 'host-auth' });
  const joined = await host.next('room:joined');

  attacker.send({ type: 'room:join', roomId: '123', name: '短房间号', instrument: 'guitar', clientId: 'attacker-1' });
  assert.equal((await attacker.next('error')).code, 'INVALID_ROOM_ID');

  attacker.send({ type: 'room:join', roomId: '9999999', name: '不存在', instrument: 'guitar', clientId: 'attacker-2' });
  assert.equal((await attacker.next('error')).code, 'ROOM_NOT_FOUND');

  // 乐手加入后，携带错误令牌上传曲谱与控制播放都应被拒。
  attacker.send({ type: 'room:join', roomId: joined.room.id, name: '乐手', instrument: 'bass', clientId: 'attacker-3' });
  await attacker.next('room:joined');
  attacker.send({ type: 'score:upload', hostToken: 'not-the-real-token', upload: fakeScoreBuffer(16) });
  assert.equal((await attacker.next('error')).code, 'HOST_AUTH_INVALID');
  attacker.send({ type: 'playback:control', hostToken: 'not-the-real-token', action: 'seek', positionMs: 1000 });
  assert.equal((await attacker.next('error')).code, 'HOST_AUTH_INVALID');

  host.close();
  attacker.close();
});

test('曲谱上传校验：扩展名、体积与损坏文件', async () => {
  const { host, hostToken, members } = await createRoomWithMembers(1);

  host.send({ type: 'score:upload', hostToken, upload: { name: '曲谱.pdf', data: fakeScoreBuffer(32).data } });
  assert.match((await host.next('error')).message, /仅支持/);

  host.send({ type: 'score:upload', hostToken, upload: { name: 'score.gp5', data: '' } });
  assert.match((await host.next('error')).message, /1 字节和 20 MB/);

  // 注意：base64 后约 27 MB，已接近 30 MB 的 WebSocket 上限，因此只发一次。
  host.send({ type: 'score:upload', hostToken, upload: { name: 'huge.gp5', data: Buffer.alloc(20 * 1024 * 1024 + 1, 0).toString('base64') } });
  assert.match((await host.next('error', null, 20000)).message, /1 字节和 20 MB/);

  // 扩展名合法但内容不是 Guitar Pro：AlphaTab 的解析器对垃圾字节相当宽容，
  // 会给出一个只有默认速度、1 小节的"空谱"而不是抛错。这里锁定真实行为：
  // 服务器必须仍然给出响应（不崩溃、不断线），且曲谱元数据结构完整。
  host.send({ type: 'score:upload', hostToken, upload: fakeScoreBuffer(64) });
  const loaded = await host.next('source:loaded');
  assert.equal(loaded.source.kind, 'score');
  assert.match(loaded.source.id, /^[a-f0-9-]{36}$/);
  assert.equal('storagePath' in loaded.source, false);
  assert.equal(typeof loaded.source.title, 'string');
  assert.ok(Number.isFinite(loaded.source.tempo));
  assert.ok(Array.isArray(loaded.source.tempoMap));
  assert.ok(Array.isArray(loaded.source.playbackTimeline));

  // 主机仍然存活：上传后房间照常响应。
  host.send({ type: 'playback:control', hostToken, action: 'seek', positionMs: 1234 });
  const stillAlive = await host.next('playback:state', (event) => event.playback.positionMs === 1234);
  assert.equal(stillAlive.playback.positionMs, 1234);

  host.close();
  for (const member of members) member.close();
});

test('同一 clientId 重连时接管旧连接', async () => {
  const host = new SocketClient();
  const first = new SocketClient();
  const second = new SocketClient();
  await Promise.all([host.open(), first.open(), second.open()]);
  host.send({ type: 'room:create', clientId: 'host-reconnect' });
  const joined = await host.next('room:joined');

  first.send({ type: 'room:join', roomId: joined.room.id, name: '乐手', instrument: 'keys', clientId: 'same-client' });
  await first.next('room:joined');

  // 同一 clientId 再连一次（模拟刷新页面）。服务端是"先关闭旧连接、再加入新连接"，
  // 并在关闭旧连接时重新计算成员列表，所以成员数应保持 2（主机 + 该乐手），
  // 绝不能出现 3 个成员，也不能出现只有主机自己的 1 个成员（那意味着新连接没接管成功）。
  let memberCounts = [];
  const seen = (event) => {
    memberCounts.push(event.members.length);
    return event.members.length === 1 && event.members.some((member) => member.instrument === 'host');
  };
  const hostAlone = host.next('room:members', seen, 2000).then(() => true, () => false);
  second.send({ type: 'room:join', roomId: joined.room.id, name: '乐手', instrument: 'keys', clientId: 'same-client' });
  await second.next('room:joined');
  await first.closePromise;
  // 给服务端关闭旧连接后再次广播成员列表留出时间，避免漏掉最后一次广播。
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await hostAlone, false, `成员列表不应退化为只剩主机，实际广播过：${memberCounts.join(', ')}`);
  assert.ok(memberCounts.every((count) => count <= 2), `成员数不应超过 2，实际广播过：${memberCounts.join(', ')}`);

  host.close();
  first.close();
  second.close();
});

test('房间设备数达到上限后拒绝新设备，但已加入设备可重连', async () => {
  const maxRoomMembers = 32;
  const { host, roomId, members } = await createRoomWithMembers(maxRoomMembers - 1);
  assert.equal(members.length, maxRoomMembers - 1);

  const overflow = new SocketClient();
  await overflow.open();
  overflow.send({ type: 'room:join', roomId, name: '多余乐手', instrument: 'other', clientId: 'member-overflow' });
  assert.equal((await overflow.next('error')).code, 'ROOM_FULL');

  // 已加入的设备用同一 clientId 重连不受上限影响。
  const rejoin = new SocketClient();
  await rejoin.open();
  rejoin.send({ type: 'room:join', roomId, name: '乐手0', instrument: 'guitar', clientId: 'member-scale-0' });
  const rejoined = await rejoin.next('room:joined');
  assert.equal(rejoined.room.id, roomId);

  host.close();
  overflow.close();
  rejoin.close();
  for (const member of members) member.close();
});

test('跳转与请求状态在时间线上保持一致（变速换算基础）', async () => {
  const host = new SocketClient();
  const member = new SocketClient();
  await Promise.all([host.open(), member.open()]);
  host.send({ type: 'room:create', clientId: 'host-timeline' });
  const joined = await host.next('room:joined');
  member.send({ type: 'room:join', roomId: joined.room.id, name: '乐手', instrument: 'drums', clientId: 'member-timeline' });
  await member.next('room:joined');

  // 每次 seek 后向服务端索取状态，位置必须与刚跳转的值一致（服务端是唯一时钟）。
  for (const positionMs of [0, 1200, 60000, 123456]) {
    host.send({ type: 'playback:control', hostToken: joined.hostToken, action: 'seek', positionMs });
    const sought = await member.next('playback:state', (event) => event.playback.positionMs === positionMs);
    assert.equal(sought.playback.isPlaying, false);
    member.send({ type: 'playback:request-state' });
    const confirmed = await member.next('playback:state', (event) => event.playback.positionMs === positionMs);
    assert.equal(confirmed.playback.positionMs, positionMs);
    assert.ok(confirmed.playback.serverTick >= 0);
    assert.ok(confirmed.playback.measure >= 1);
    assert.ok(confirmed.playback.beat >= 1);
  }

  host.close();
  member.close();
});


test('曲谱来源替换暂停归零、更新加入状态并使旧来源地址失效', async () => {
  const { host, hostToken, roomId, members: [member] } = await createRoomWithMembers(1);
  const upload = fakeScoreBuffer(64);
  const scoreUrl = (id) => `${origin}/api/rooms/${roomId}/score/${id}`;
  host.send({ type: 'score:upload', hostToken, upload });
  const first = (await host.next('source:loaded')).source;
  assert.deepEqual((await member.next('source:loaded')).source, first);
  const response = await fetch(scoreUrl(first.id));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(upload.data, 'base64'));
  assert.equal((await fetch(scoreUrl('unknown-source'))).status, 404);
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}/score`)).status, 404);

  host.send({ type: 'playback:control', hostToken, action: 'seek-tick', tick: 960 });
  const sought = await host.next('playback:state', (event) => event.playback.serverTick === 960);
  assert.equal(sought.playback.positionMs, 500);
  assert.equal(sought.playback.measure, 1);
  host.send({ type: 'playback:control', hostToken, action: 'set-playing', isPlaying: true });
  const playing = await host.next('playback:state', (event) => event.playback.isPlaying);

  host.send({ type: 'score:upload', hostToken, upload });
  const second = (await host.next('source:loaded')).source;
  assert.notEqual(second.id, first.id);
  assert.equal(second.fileName, first.fileName);
  assert.equal('storagePath' in second, false);
  assert.deepEqual((await member.next('source:loaded')).source, second);
  const reset = await host.next('playback:state', (event) => event.playback.revision > playing.playback.revision && !event.playback.isPlaying);
  assert.equal(reset.playback.positionMs, 0);
  assert.equal(reset.playback.serverTick, 0);
  assert.equal((await fetch(scoreUrl(first.id))).status, 404);
  assert.equal((await fetch(scoreUrl(second.id))).status, 200);

  host.send({ type: 'room:resume', roomId, hostToken, clientId: 'host-source-resume' });
  assert.deepEqual((await host.next('room:joined')).source, second);
  host.send({ type: 'playback:control', hostToken, action: 'seek', positionMs: second.durationMs + 1000 });
  const clamped = await host.next('playback:state', (event) => event.playback.positionMs === second.durationMs);
  assert.equal(clamped.playback.isPlaying, false);
  assert.equal(clamped.playback.serverTick, second.durationTicks);

  // 无效上传必须保留当前来源，不能先删除旧文件。
  host.send({ type: 'score:upload', hostToken, upload: { name: 'invalid.pdf', data: upload.data } });
  await host.next('error');
  assert.equal((await fetch(scoreUrl(second.id))).status, 200);
  // 等待异步清理完成，磁盘上只留下当前来源。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const files = await readdir(join(dataDir, 'scores'));
    if (!files.some((file) => file.includes(first.id))) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await readdir(join(dataDir, 'scores'))).some((file) => file.includes(first.id)), false);
  host.close();
  member.close();
});


test('来源清理短暂锁定时重试，清理失败仍上线新来源并报告错误', async (t) => {
  for (const { code, failures, expectedAttempts } of [
    { code: 'EBUSY', failures: 2, expectedAttempts: 3 },
    { code: 'EBUSY', failures: Infinity, expectedAttempts: 3 },
    { code: 'EIO', failures: Infinity, expectedAttempts: 1 }
  ]) {
    const { host, hostToken, roomId, members } = await createRoomWithMembers(0);
    host.send({ type: 'score:upload', hostToken, upload: fakeScoreBuffer(64) });
    const first = (await host.next('source:loaded')).source;
    const oldFile = (await readdir(join(dataDir, 'scores'))).find((file) => file.includes(first.id));
    assert.ok(oldFile);
    const oldPath = join(dataDir, 'scores', oldFile);
    const originalRm = fs.rm;
    const errors = [];
    let attempts = 0;
    t.mock.method(fs, 'rm', async (path, options) => {
      if (path === oldPath && ++attempts <= failures) throw Object.assign(new Error('清理失败'), { code });
      return originalRm(path, options);
    });
    t.mock.method(console, 'error', (...args) => errors.push(args));
    syncBuiltinESMExports();
    try {
      host.send({ type: 'score:upload', hostToken, upload: fakeScoreBuffer(64) });
      const second = (await host.next('source:loaded')).source;
      assert.notEqual(second.id, first.id);
      assert.equal((await fetch(`${origin}/api/rooms/${roomId}/score/${second.id}`)).status, 200);
      for (let wait = 0; wait < 50; wait += 1) {
        const removed = await fs.access(oldPath).then(() => false, () => true);
        if (failures === 2 ? removed : errors.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(attempts, expectedAttempts);
      if (failures === 2) {
        await assert.rejects(fs.access(oldPath), { code: 'ENOENT' });
        assert.equal(errors.length, 0);
      } else {
        assert.equal(errors.length, 1);
        assert.equal(errors[0].at(-1).code, code);
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      host.close();
      for (const member of members) member.close();
    }
  }
});

const mp4Bytes = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom01234567')]);
const webmBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
function uploadVideo(roomId, hostToken, body = mp4Bytes, headers = {}) {
  return fetch(`${origin}/api/rooms/${roomId}/video`, {
    method: 'POST', headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'video/mp4', 'x-file-name': encodeURIComponent('排练.mp4'), ...headers }, body,
  });
}
async function videoFiles() { return readdir(join(dataDir, 'videos')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; }); }
async function waitForUploadFile() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await videoFiles()).some((name) => name.endsWith('.upload'))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待上传临时文件超时');
}
function beginChunkedUpload(roomId, hostToken, t) {
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  // 闸门等待期间也收集拒绝，避免失败清理时出现未处理 rejection。
  response.catch(() => {});
  const request = http.request(`${origin}/api/rooms/${roomId}/video`, { method: 'POST', agent: false, headers: {
    authorization: `Bearer ${hostToken}`, 'content-type': 'video/mp4', 'x-file-name': 'clip.mp4', 'transfer-encoding': 'chunked',
  } }, (incoming) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => resolveResponse({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  request.on('error', rejectResponse);
  t.after(async () => { request.destroy(); await response.catch(() => {}); });
  return { request, response };
}

test('视频上传流逐块写盘并在空文件、超限和中断时删除临时文件', async () => {
  const directory = await mkdtemp(join(dataDir, 'stream-'));
  const temporaryPath = join(directory, 'valid.upload');
  const uploaded = await streamVideoUpload({ request: Readable.from([mp4Bytes.subarray(0, 3), mp4Bytes.subarray(3)]), temporaryPath, maxBytes: 20 });
  assert.equal(uploaded.size, 20);
  assert.deepEqual(uploaded.headerBytes, Buffer.from([0, 0, 0, 24, ...Buffer.from('ftyp')]));
  assert.deepEqual(await fs.readFile(temporaryPath), mp4Bytes);
  for (const [name, chunks, maxBytes, statusCode] of [['empty', [], 20, 400], ['large', [mp4Bytes.subarray(0, 8), mp4Bytes.subarray(8)], 19, 413]]) {
    await assert.rejects(streamVideoUpload({ request: Readable.from(chunks), temporaryPath: join(directory, `${name}.upload`), maxBytes }), (error) => error.statusCode === statusCode);
    assert.equal((await readdir(directory)).includes(`${name}.upload`), false);
  }
  const interrupted = new PassThrough();
  const pending = streamVideoUpload({ request: interrupted, temporaryPath: join(directory, 'aborted.upload'), maxBytes: 20 });
  interrupted.write(mp4Bytes.subarray(0, 5));
  interrupted.destroy(new Error('连接中断'));
  await assert.rejects(pending);
  assert.equal((await readdir(directory)).includes('aborted.upload'), false);
});

test('视频上传验证主机凭证、格式及失败原子性', async (t) => {
  const { host, hostToken, roomId, members: [member] } = await createRoomWithMembers(1);
  t.after(() => { host.close(); member.close(); });
  assert.equal((await uploadVideo(roomId, hostToken, mp4Bytes, { authorization: '' })).status, 401);
  assert.equal((await uploadVideo(roomId, 'wrong-token')).status, 403);
  const uploaded = await uploadVideo(roomId, hostToken);
  assert.equal(uploaded.status, 200);
  const { source } = await uploaded.json();
  assert.equal(source.kind, 'video');
  assert.equal(source.fileName, '排练.mp4');
  assert.equal(source.mimeType, 'video/mp4');
  assert.equal(source.size, mp4Bytes.length);
  assert.equal('storagePath' in source, false);
  assert.deepEqual((await host.next('source:loaded')).source, source);
  assert.deepEqual((await member.next('source:loaded')).source, source);
  const cases = [
    [Buffer.alloc(0), {}, 400],
    [mp4Bytes, { 'content-type': 'application/octet-stream' }, 400],
    [mp4Bytes, { 'x-file-name': 'clip.mkv' }, 400],
    [mp4Bytes, { 'x-file-name': '%broken' }, 400],
    [Buffer.from('invalid video bytes'), {}, 400],
    [mp4Bytes, { 'content-length': String(2 * 1024 * 1024 * 1024 + 1) }, 413],
  ];
  for (const [body, headers, status] of cases) {
    // 超大 Content-Length 使用原始 HTTP，避免 fetch 先拒绝声明长度与正文不符。
    const response = headers['content-length'] ? await new Promise((resolve, reject) => {
      const request = http.request(`${origin}/api/rooms/${roomId}/video`, { method: 'POST', agent: false, headers: {
        authorization: `Bearer ${hostToken}`, 'content-type': 'video/mp4', 'x-file-name': 'clip.mp4', ...headers,
      } }, (incoming) => { incoming.resume(); incoming.on('end', () => resolve({ status: incoming.statusCode })); });
      request.on('error', reject); request.end(body);
    }) : await uploadVideo(roomId, hostToken, body, headers);
    assert.equal(response.status, status);
    assert.equal((await fetch(`${origin}/api/rooms/${roomId}/video/${source.id}`)).status, 200);
    assert.equal((await videoFiles()).some((name) => name.endsWith('.upload')), false);
  }
  const webm = await uploadVideo(roomId, hostToken, webmBytes, { 'content-type': 'video/webm', 'x-file-name': 'take.webm' });
  assert.equal(webm.status, 200);
  assert.equal((await webm.json()).source.mimeType, 'video/webm');
});

test('视频上传允许未知长度、断开清理并由最后开始的请求胜出', async (t) => {
  const { host, hostToken, roomId } = await createRoomWithMembers(0);
  t.after(() => host.close());
  const first = beginChunkedUpload(roomId, hostToken, t);
  first.request.write(mp4Bytes.subarray(0, 8));
  await waitForUploadFile();
  const newest = await uploadVideo(roomId, hostToken);
  assert.equal(newest.status, 200);
  const { source } = await newest.json();
  first.request.end(mp4Bytes.subarray(8));
  assert.equal((await first.response).status, 409);
  assert.equal((await videoFiles()).filter((name) => name.includes(roomId)).length, 1);
  const interrupted = beginChunkedUpload(roomId, hostToken, t);
  const disconnected = interrupted.response.catch(() => {});
  interrupted.request.write(mp4Bytes.subarray(0, 8));
  await waitForUploadFile();
  interrupted.request.destroy();
  await disconnected;
  for (let attempt = 0; attempt < 100 && (await videoFiles()).some((name) => name.endsWith('.upload')); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await videoFiles()).some((name) => name.endsWith('.upload')), false);
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}/video/${source.id}`)).status, 200);
  const unknown = beginChunkedUpload(roomId, hostToken, t);
  unknown.request.write(mp4Bytes.subarray(0, 5));
  unknown.request.end(mp4Bytes.subarray(5));
  assert.equal((await unknown.response).status, 200);
  const empty = beginChunkedUpload(roomId, hostToken, t);
  empty.request.end();
  assert.equal((await empty.response).status, 400);
  assert.equal((await videoFiles()).some((name) => name.endsWith('.upload')), false);
});

test('来源交错：较早视频晚完成不得覆盖较晚曲谱', async (t) => {
  const { host, hostToken, roomId } = await createRoomWithMembers(0);
  t.after(() => host.close());
  const earlierVideo = beginChunkedUpload(roomId, hostToken, t);
  earlierVideo.request.write(mp4Bytes.subarray(0, 8));
  await waitForUploadFile();
  host.send({ type: 'score:upload', hostToken, upload: fakeScoreBuffer(64) });
  const score = (await host.next('source:loaded', (event) => event.source.kind === 'score')).source;
  earlierVideo.request.end(mp4Bytes.subarray(8));
  assert.equal((await earlierVideo.response).status, 409);
  assert.equal((await videoFiles()).some((name) => name.includes(roomId)), false);
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}/score/${score.id}`)).status, 200);
  host.send({ type: 'room:resume', roomId, hostToken, clientId: 'score-wins-over-video' });
  assert.deepEqual((await host.next('room:joined')).source, score);
});

test('来源交错：较早曲谱晚完成不得覆盖较晚视频', async (t) => {
  const { host, hostToken, roomId } = await createRoomWithMembers(0);
  let releaseWrite;
  let notifyWritten;
  const writeAllowed = new Promise((resolve) => { releaseWrite = resolve; });
  const written = new Promise((resolve) => { notifyWritten = resolve; });
  const originalWriteFile = fs.writeFile;
  let earlierScorePath;
  t.mock.method(fs, 'writeFile', async (path, ...args) => {
    await originalWriteFile(path, ...args);
    if (typeof path === 'string' && path.startsWith(join(dataDir, 'scores', `${roomId}-`))) {
      earlierScorePath = path;
      notifyWritten();
      await writeAllowed;
    }
  });
  syncBuiltinESMExports();
  t.after(() => { releaseWrite(); t.mock.restoreAll(); syncBuiltinESMExports(); host.close(); });
  host.send({ type: 'score:upload', hostToken, upload: fakeScoreBuffer(64) });
  await written;
  const { source } = await (await uploadVideo(roomId, hostToken)).json();
  await host.next('source:loaded', (event) => event.source.id === source.id);
  releaseWrite();
  assert.equal((await host.next('error')).code, 'SOURCE_UPLOAD_CONFLICT');
  await assert.rejects(fs.access(earlierScorePath), { code: 'ENOENT' });
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}/video/${source.id}`)).status, 200);
  host.send({ type: 'room:resume', roomId, hostToken, clientId: 'video-wins-over-score' });
  assert.deepEqual((await host.next('room:joined')).source, source);
});

test('视频 Range 读取返回精确字节和响应头，陈旧来源失效且已开始读取安全结束', async (t) => {
  const { host, hostToken, roomId } = await createRoomWithMembers(0);
  t.after(() => host.close());
  const { source } = await (await uploadVideo(roomId, hostToken)).json();
  const url = `${origin}/api/rooms/${roomId}/video/${source.id}`;
  for (const [range, status, expected, contentRange] of [
    [undefined, 200, mp4Bytes, null],
    ['bytes=4-7', 206, Buffer.from('ftyp'), 'bytes 4-7/20'],
    ['bytes=-4', 206, Buffer.from('4567'), 'bytes 16-19/20'],
  ]) {
    const response = await fetch(url, { headers: range ? { range } : {} });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  for (const range of ['bytes=0-1,4-5', 'bytes=20-', 'bytes=8-7']) {
    const response = await fetch(url, { headers: { range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */20');
    assert.doesNotMatch(await response.text(), /storagePath|band-room-test/);
  }
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}/video/wrong-source`)).status, 404);
  const large = Buffer.concat([mp4Bytes, Buffer.alloc(4 * 1024 * 1024, 0x63)]);
  const second = (await (await uploadVideo(roomId, hostToken, large)).json()).source;
  assert.equal((await fetch(url)).status, 404);
  const incoming = await new Promise((resolve, reject) => {
    http.get(`${origin}/api/rooms/${roomId}/video/${second.id}`, (response) => { response.pause(); resolve(response); }).on('error', reject);
  });
  t.after(() => incoming.destroy());
  host.send({ type: 'score:upload', hostToken, upload: fakeScoreBuffer(64) });
  await host.next('source:loaded', (event) => event.source.kind === 'score');
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}/video/${second.id}`)).status, 404);
  const completed = await new Promise((resolve, reject) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => resolve(Buffer.concat(chunks)));
    incoming.on('error', reject);
    incoming.resume();
  });
  assert.deepEqual(completed, large);
});

test('视频时长仅允许主机登记当前来源，校验时长并裁剪播放位置至结尾暂停', async (t) => {
  const { host, hostToken, roomId, members: [member] } = await createRoomWithMembers(1);
  t.after(() => { host.close(); member.close(); });
  const { source } = await (await uploadVideo(roomId, hostToken)).json();
  await host.next('source:loaded');
  await member.next('source:loaded');
  member.send({ type: 'source:set-duration', hostToken, sourceId: source.id, durationMs: 1000 });
  assert.equal((await member.next('error')).code, 'HOST_AUTH_INVALID');
  host.send({ type: 'source:set-duration', hostToken: 'wrong', sourceId: source.id, durationMs: 1000 });
  assert.equal((await host.next('error')).code, 'HOST_AUTH_INVALID');
  for (const patch of [{ sourceId: 'stale' }, { durationMs: NaN }, { durationMs: 0 }, { durationMs: -1 }, { durationMs: 86_400_001 }, { durationMs: '1000' }]) {
    host.send({ type: 'source:set-duration', hostToken, sourceId: source.id, durationMs: 1000, ...patch });
    await host.next('error');
  }
  host.send({ type: 'source:set-duration', hostToken, sourceId: source.id, durationMs: 86_400_000 });
  assert.equal((await host.next('source:loaded')).source.durationMs, 86_400_000);
  await member.next('source:loaded');
  host.send({ type: 'source:set-duration', hostToken, sourceId: source.id, durationMs: 250 });
  const registered = (await host.next('source:loaded')).source;
  assert.equal(registered.durationMs, 250);
  assert.equal(registered.id, source.id);
  assert.equal('storagePath' in registered, false);
  assert.deepEqual((await member.next('source:loaded')).source, registered);
  host.send({ type: 'playback:control', hostToken, action: 'seek', positionMs: 500 });
  const clamped = (await member.next('playback:state', (event) => event.playback.positionMs === 250)).playback;
  assert.equal(clamped.isPlaying, false);
  assert.equal(clamped.serverTick, 0);
  host.send({ type: 'playback:control', hostToken, action: 'seek', positionMs: 230 });
  await member.next('playback:state', (event) => event.playback.positionMs === 230);
  host.send({ type: 'playback:control', hostToken, action: 'set-playing', isPlaying: true });
  const ended = await member.next('playback:state', (event) => event.playback.positionMs === 250 && !event.playback.isPlaying && event.playback.revision > clamped.revision);
  assert.equal(ended.playback.positionMs, 250);
  host.send({ type: 'room:resume', roomId, hostToken, clientId: 'duration-resume' });
  assert.equal((await host.next('room:joined')).source.durationMs, 250);
});

test('停机等待来源替换触发的 EBUSY 重试完成', async (t) => {
  const { host, hostToken } = await createRoomWithMembers(0);
  host.send({ type: 'score:upload', hostToken, upload: fakeScoreBuffer(64) });
  const first = (await host.next('source:loaded')).source;
  const oldFile = (await readdir(join(dataDir, 'scores'))).find((file) => file.includes(first.id));
  assert.ok(oldFile);
  const oldPath = join(dataDir, 'scores', oldFile);
  const originalRm = fs.rm;
  let attempts = 0;
  let releaseDeletion;
  let notifyRetry;
  const deletionAllowed = new Promise((resolve) => { releaseDeletion = resolve; });
  const retryStarted = new Promise((resolve) => { notifyRetry = resolve; });
  t.mock.method(fs, 'rm', async (path, options) => {
    if (path === oldPath) {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('临时锁定'), { code: 'EBUSY' });
      notifyRetry();
      await deletionAllowed;
    }
    return originalRm(path, options);
  });
  syncBuiltinESMExports();
  let stopped;
  try {
    host.send({ type: 'score:upload', hostToken, upload: fakeScoreBuffer(64) });
    await host.next('source:loaded');
    let stopReturned = false;
    stopped = serverModule.stopBandRoomServer().then(() => { stopReturned = true; });
    const firstCompleted = await Promise.race([
      stopped.then(() => 'stopped'),
      retryStarted.then(() => 'retrying')
    ]);
    assert.equal(firstCompleted, 'retrying');
    // 第二次删除仍被闸门挂起，停机不能提前返回。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopReturned, false);
    await fs.access(oldPath);
    releaseDeletion();
    await stopped;
    assert.equal(attempts, 2);
    await assert.rejects(fs.access(oldPath), { code: 'ENOENT' });
  } finally {
    releaseDeletion();
    await stopped;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    host.close();
  }
});
