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
  assert.equal(health.version, '1.0.3');
  assert.equal('hostToken' in health, false);
});

test('法律文件可在离线主机页面读取，二维码拒绝危险协议', async () => {
  const legal = await fetch(`${origin}/legal.html`);
  assert.equal(legal.status, 200);
  assert.match(await legal.text(), /AGPL-3\.0-only/);
  const license = await fetch(`${origin}/legal-files/Band-Room-AGPL-3.0.txt`);
  assert.equal(license.status, 200);
  assert.match(await license.text(), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  const invalidQr = await fetch(`${origin}/api/qrcode?url=${encodeURIComponent('javascript:alert(1)')}`);
  assert.equal(invalidQr.status, 400);
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
