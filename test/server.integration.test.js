import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const loaded = await host.next('score:loaded');
  assert.equal(typeof loaded.score.title, 'string');
  assert.ok(Number.isFinite(loaded.score.tempo));
  assert.ok(Array.isArray(loaded.score.tempoMap));
  assert.ok(Array.isArray(loaded.score.playbackTimeline));

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
