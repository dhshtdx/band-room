import crypto from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { importer, midi } from '@coderline/alphatab';
import QRCode from 'qrcode';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const packageMetadata = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
const alphaTabDistDir = join(rootDir, 'node_modules', '@coderline', 'alphatab', 'dist');
const port = Number(process.env.PORT ?? 4173);
// 安装后的 .app/.exe 目录是只读的。桌面壳通过 BAND_ROOM_DATA_DIR
// 把临时曲谱放到系统用户数据目录；命令行开发模式仍沿用 work/scores。
const dataDir = process.env.BAND_ROOM_DATA_DIR || join(rootDir, 'work');
const scoresDir = join(dataDir, 'scores');
const allowedInstruments = ['guitar', 'bass', 'drums', 'keys', 'vocals', 'other'];
const allowedScoreExtensions = new Set(['.gp', '.gp3', '.gp4', '.gp5', '.gpx']);
const rooms = new Map();
const roomCleanupGraceMs = 60_000;
const maxRoomMembers = 32;
function lanAddresses() { return Object.values(os.networkInterfaces()).flat().filter((entry) => entry?.family === 'IPv4' && !entry.internal).map((entry) => entry.address); }

function createRoom() {
  let id; do { id = crypto.randomInt(1_000_000, 10_000_000).toString(); } while (rooms.has(id));
  const room = { id, hostToken: crypto.randomBytes(24).toString('base64url'), members: new Set(), score: null, cleanupTimer: null, playback: { isPlaying: false, positionMs: 0, updatedAt: Date.now(), revision: 0 } };
  rooms.set(id, room); return room;
}
function members(room) { return [...room.members].map((socket) => ({ name: socket.member.name, instrument: socket.member.instrument })); }
function broadcast(room, event) { const payload = JSON.stringify(event); for (const socket of room.members) if (socket.readyState === socket.OPEN) socket.send(payload); }
function findLastAtOrBefore(items, value, field) {
  let low = 0; let high = items.length - 1; let result = items[0] ?? null;
  while (low <= high) { const middle = Math.floor((low + high) / 2); if (items[middle][field] <= value) { result = items[middle]; low = middle + 1; } else high = middle - 1; }
  return result;
}
function positionToTick(score, positionMs) {
  const point = findLastAtOrBefore(score?.tempoMap ?? [], positionMs, 'timeMs');
  if (!point) return Math.round(positionMs * (score?.tempo || 120) * 960 / 60000);
  return Math.min(score.durationTicks, Math.round(point.tick + (positionMs - point.timeMs) * point.tempo * 960 / 60000));
}
function tickToPosition(score, tick) {
  const point = findLastAtOrBefore(score?.tempoMap ?? [], tick, 'tick');
  if (!point) return Math.round(tick * 60000 / ((score?.tempo || 120) * 960));
  return Math.min(score.durationMs, Math.round(point.timeMs + (tick - point.tick) * 60000 / (point.tempo * 960)));
}
function playbackState(room) {
  const state = room.playback;
  const rawPositionMs = Math.round(state.positionMs + (state.isPlaying ? Date.now() - state.updatedAt : 0));
  const positionMs = room.score?.durationMs ? Math.min(rawPositionMs, room.score.durationMs) : rawPositionMs;
  const isPlaying = state.isPlaying && positionMs < (room.score?.durationMs ?? Number.POSITIVE_INFINITY);
  const serverTick = positionToTick(room.score, positionMs);
  const timeline = room.score?.playbackTimeline || [];
  const timelineEntry = findLastAtOrBefore(timeline, serverTick, 'startTick') || { startTick: 0, numerator: 4, denominator: 4, measure: 1, occurrence: 0 };
  const ticksPerBeat = 960 * 4 / (timelineEntry.denominator || 4);
  const tempoPoint = findLastAtOrBefore(room.score?.tempoMap ?? [], serverTick, 'tick');
  return { ...state, isPlaying, positionMs, serverTick, currentTempo: tempoPoint?.tempo ?? room.score?.tempo ?? 120, measure: timelineEntry.measure, beat: Math.max(1, Math.floor((serverTick - timelineEntry.startTick) / ticksPerBeat) + 1), occurrence: timelineEntry.occurrence, timestamp: Date.now(), serverNow: Date.now() };
}
function updatePlayback(room, patch) { const current = playbackState(room); room.playback = { isPlaying: patch.isPlaying ?? current.isPlaying, positionMs: Number.isFinite(patch.positionMs) ? Math.max(0, Math.round(patch.positionMs)) : current.positionMs, updatedAt: Date.now(), revision: current.revision + 1 }; broadcast(room, { type: 'playback:state', playback: playbackState(room) }); }
function cancelRoomCleanup(room) { if (room.cleanupTimer) clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
function scheduleRoomCleanup(room) {
  if (stopping || room.members.size || room.cleanupTimer) return;
  room.cleanupTimer = setTimeout(() => {
    room.cleanupTimer = null;
    if (room.members.size || rooms.get(room.id) !== room) return;
    if (room.score?.storagePath) rm(room.score.storagePath, { force: true }).catch(() => {});
    rooms.delete(room.id);
  }, roomCleanupGraceMs);
}
function leave(socket) {
  const room = socket.member?.roomId && rooms.get(socket.member.roomId);
  if (!room) { socket.member = null; return; }
  room.members.delete(socket);
  socket.member = null;
  broadcast(room, { type: 'room:members', members: members(room) });
  scheduleRoomCleanup(room);
}
function joinSocket(room, socket, member) {
  cancelRoomCleanup(room);
  for (const existing of room.members) {
    if (existing !== socket && member.clientId && existing.member?.clientId === member.clientId) {
      room.members.delete(existing);
      existing.member = null;
      existing.close(4001, '连接已由新页面接管');
    }
  }
  socket.member = { ...member, roomId: room.id };
  room.members.add(socket);
}
function joinedEvent(room, socket, hostToken = null) {
  return { type: 'room:joined', room: { id: room.id, isHost: socket.member.isHost }, ...(hostToken ? { hostToken } : {}), members: members(room), playback: playbackState(room), score: publicScore(room.score) };
}
function buildPlaybackTiming(score) {
  const syncPoints = midi.MidiFileGenerator.generateSyncPoints(score, true);
  const tempoMap = syncPoints.map((point) => ({ tick: Math.round(point.synthTick), timeMs: Math.round(point.synthTime), tempo: point.synthBpm, barIndex: point.masterBarIndex, occurrence: point.masterBarOccurence }));
  const midiFile = new midi.MidiFile();
  const handler = new midi.AlphaSynthMidiFileHandler(midiFile);
  const generator = new midi.MidiFileGenerator(score, null, handler);
  generator.generate();
  const occurrences = new Map();
  const playbackTimeline = generator.tickLookup.masterBars.map((lookup) => {
    const barIndex = lookup.masterBar.index; const occurrence = occurrences.get(barIndex) ?? 0; occurrences.set(barIndex, occurrence + 1);
    return { measure: barIndex + 1, barIndex, occurrence, startTick: Math.round(lookup.start), endTick: Math.round(lookup.end), numerator: lookup.masterBar.timeSignatureNumerator || 4, denominator: lookup.masterBar.timeSignatureDenominator || 4 };
  });
  const durationTicks = Math.round(playbackTimeline.at(-1)?.endTick ?? tempoMap.at(-1)?.tick ?? 0);
  const durationMs = tickToPosition({ tempo: score.tempo, tempoMap, durationTicks, durationMs: Number.POSITIVE_INFINITY }, durationTicks);
  return { tempoMap, playbackTimeline, durationTicks, durationMs };
}
function serializeScore(score, fileName) { return { fileName, title: score.title || basename(fileName, extname(fileName)), artist: score.artist || '', album: score.album || '', tempo: score.tempo, barCount: score.masterBars.length, ...buildPlaybackTiming(score), tracks: score.tracks.map((track, index) => ({ index, name: track.name || `轨道 ${index + 1}`, isPercussion: track.staves.some((staff) => staff.isPercussion), stringCount: track.staves[0]?.tuning?.tunings?.length ?? 0 })) }; }
function publicScore(score) { if (!score) return null; const { storagePath, ...metadata } = score; return metadata; }
async function storeAndParseScore(room, upload) {
  const raw = Buffer.from(upload.data, 'base64'); const fileName = basename(String(upload.name ?? 'score.gp'));
  if (!raw.length || raw.length > 20 * 1024 * 1024) throw new Error('曲谱文件必须介于 1 字节和 20 MB 之间。');
  if (!allowedScoreExtensions.has(extname(fileName).toLowerCase())) throw new Error('仅支持 .gp、.gp3、.gp4、.gp5、.gpx 文件。');
  let score; try { score = importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(raw)); } catch { throw new Error('无法解析此 Guitar Pro 文件，请确认文件未损坏且格式受支持。'); }
  await mkdir(scoresDir, { recursive: true }); if (room.score?.storagePath) await rm(room.score.storagePath, { force: true });
  const storagePath = join(scoresDir, `${room.id}-${Date.now()}${extname(fileName).toLowerCase()}`); await writeFile(storagePath, raw);
  room.score = { ...serializeScore(score, fileName), storagePath }; return room.score;
}

const app = express();
app.disable('x-powered-by');
app.use((_request, response, next) => {
  response.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; worker-src 'self' blob:; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()'
  });
  next();
});
app.use(express.json({ limit: '22mb' }));
// 将 AlphaTab 的 ESM、字体和 worker 作为本地静态资源提供，局域网客户端无需联网。
app.use('/alphatab', express.static(alphaTabDistDir, { cacheControl: true, maxAge: '1d' }));
app.get('/legal-files/Band-Room-AGPL-3.0.txt', (_request, response) => response.sendFile(join(rootDir, 'LICENSE')));
app.get('/legal-files/THIRD_PARTY_NOTICES.md', (_request, response) => response.sendFile(join(rootDir, 'THIRD_PARTY_NOTICES.md')));
app.use('/legal-files', express.static(join(rootDir, 'legal'), { cacheControl: true, maxAge: '1d' }));
app.use(express.static(`${rootDir}/public`, { cacheControl: false }));
app.get(['/host', '/join'], (_request, response) => response.sendFile(join(rootDir, 'public', 'index.html')));
function listeningPort() { const address = server.address(); return typeof address === 'object' && address ? address.port : port; }
app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'Band Room', version: packageMetadata.version, rooms: rooms.size, timestamp: Date.now() }));
app.get('/api/network', (_request, response) => { const activePort = listeningPort(); response.json({ port: activePort, origins: lanAddresses().map((ip) => `http://${ip}:${activePort}`) }); });
app.get('/api/qrcode', async (request, response) => {
  const value = String(request.query.url ?? '');
  if (!value || value.length > 2048) return response.status(400).json({ message: '无效二维码地址。' });
  let target; try { target = new URL(value); } catch { return response.status(400).json({ message: '无效二维码地址。' }); }
  if (!['http:', 'https:'].includes(target.protocol)) return response.status(400).json({ message: '无效二维码地址。' });
  response.json({ dataUrl: await QRCode.toDataURL(target.href, { width: 260, margin: 1 }) });
});
app.get('/api/rooms/:roomId/score', async (request, response) => { const room = rooms.get(request.params.roomId); if (!room?.score?.storagePath) return response.status(404).json({ message: '此房间尚未加载曲谱。' }); response.type('application/octet-stream').send(await readFile(room.score.storagePath)); });
const server = app.listen(port, '0.0.0.0');
export const serverReady = new Promise((resolve, reject) => {
  server.once('listening', () => {
    const activePort = listeningPort();
    console.log(`主机控制台：http://localhost:${activePort}`);
    for (const ip of lanAddresses()) console.log(`局域网加入地址：http://${ip}:${activePort}`);
    resolve({ port: activePort });
  });
  server.once('error', reject);
});
const wss = new WebSocketServer({ server, maxPayload: 30 * 1024 * 1024, perMessageDeflate: false });
const playbackTicker = setInterval(() => { for (const room of rooms.values()) if (room.playback.isPlaying) { const current = playbackState(room); if (!current.isPlaying) updatePlayback(room, { isPlaying: false, positionMs: current.positionMs }); else broadcast(room, { type: 'playback:state', playback: current }); } }, 100);
wss.on('connection', (socket) => socket.on('message', async (raw) => {
  let event; try { event = JSON.parse(raw); } catch { socket.send(JSON.stringify({ type: 'error', message: '消息格式无效。' })); return; }
  if (event.type === 'room:create') { leave(socket); const room = createRoom(); joinSocket(room, socket, { clientId: String(event.clientId ?? ''), name: '主机', instrument: 'host', isHost: true }); socket.send(JSON.stringify(joinedEvent(room, socket, room.hostToken))); return; }
  if (event.type === 'room:resume') {
    const targetRoom = rooms.get(String(event.roomId ?? ''));
    if (!targetRoom) { socket.send(JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND', message: '原排练房间已过期，请重新创建。' })); return; }
    if (!event.hostToken || event.hostToken !== targetRoom.hostToken) { socket.send(JSON.stringify({ type: 'error', code: 'HOST_AUTH_INVALID', message: '主机控制凭证无效，请重新创建房间。' })); return; }
    leave(socket);
    joinSocket(targetRoom, socket, { clientId: String(event.clientId ?? ''), name: '主机', instrument: 'host', isHost: true });
    socket.send(JSON.stringify(joinedEvent(targetRoom, socket, targetRoom.hostToken)));
    broadcast(targetRoom, { type: 'room:members', members: members(targetRoom) });
    return;
  }
  const room = socket.member?.roomId && rooms.get(socket.member.roomId);
  if (event.type === 'playback:request-state') { if (room) socket.send(JSON.stringify({ type: 'playback:state', playback: playbackState(room) })); return; }
  if (event.type === 'score:upload') { if (!room || !socket.member.isHost || event.hostToken !== room.hostToken) { socket.send(JSON.stringify({ type: 'error', code: 'HOST_AUTH_INVALID', message: '主机控制凭证无效。' })); return; } try { broadcast(room, { type: 'score:loaded', score: publicScore(await storeAndParseScore(room, event.upload ?? {})) }); } catch (error) { socket.send(JSON.stringify({ type: 'error', message: error.message })); } return; }
  if (event.type === 'playback:control') { if (!room || !socket.member.isHost || event.hostToken !== room.hostToken) { socket.send(JSON.stringify({ type: 'error', code: 'HOST_AUTH_INVALID', message: '主机控制凭证无效。' })); return; } if (event.action === 'set-playing' && typeof event.isPlaying === 'boolean') updatePlayback(room, { isPlaying: event.isPlaying }); if (event.action === 'seek') updatePlayback(room, { positionMs: Number(event.positionMs) }); if (event.action === 'seek-tick') updatePlayback(room, { positionMs: tickToPosition(room.score, Math.max(0, Number(event.tick) || 0)) }); return; }
  if (event.type !== 'room:join') return;
  const roomId = String(event.roomId ?? ''); const targetRoom = rooms.get(roomId); const name = String(event.name ?? '').trim().slice(0, 24); const instrument = String(event.instrument ?? 'other');
  if (!/^\d{7}$/.test(roomId)) { socket.send(JSON.stringify({ type: 'error', code: 'INVALID_ROOM_ID', message: '请输入有效的 7 位数字房间号。' })); return; }
  if (!targetRoom) { socket.send(JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND', message: '排练房间不存在或已过期，请向主机确认房间号。' })); return; }
  if (!name || !allowedInstruments.includes(instrument)) { socket.send(JSON.stringify({ type: 'error', message: '请填写昵称并选择乐器。' })); return; }
  const reconnecting = [...targetRoom.members].some((existing) => event.clientId && existing.member?.clientId === String(event.clientId));
  if (!reconnecting && targetRoom.members.size >= maxRoomMembers) { socket.send(JSON.stringify({ type: 'error', code: 'ROOM_FULL', message: '排练房间已达到 32 台设备上限。' })); return; }
  leave(socket); joinSocket(targetRoom, socket, { clientId: String(event.clientId ?? ''), name, instrument, isHost: false }); socket.send(JSON.stringify(joinedEvent(targetRoom, socket))); broadcast(targetRoom, { type: 'room:members', members: members(targetRoom) });
}).on('close', () => leave(socket)));

// 浏览器会自动响应 WebSocket ping。定期终止半开连接，让前端及时进入重连流程。
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
wss.on('connection', (socket) => { socket.isAlive = true; socket.on('pong', () => { socket.isAlive = true; }); });
wss.on('close', () => clearInterval(heartbeat));

let stopping = false;
export async function stopBandRoomServer() {
  if (stopping) return;
  stopping = true;
  clearInterval(playbackTicker);
  clearInterval(heartbeat);
  const scorePaths = [];
  for (const room of rooms.values()) {
    cancelRoomCleanup(room);
    if (room.score?.storagePath) scorePaths.push(room.score.storagePath);
  }
  for (const socket of wss.clients) socket.terminate();
  await Promise.allSettled([
    new Promise((resolve) => wss.close(resolve)),
    new Promise((resolve) => server.close(resolve)),
    ...scorePaths.map((path) => rm(path, { force: true }))
  ]);
  rooms.clear();
}

// 命令行启动时让端口错误清楚可见；Electron 会自行显示原生报错窗口。
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) serverReady.catch((error) => {
  console.error(`服务器启动失败：${error.message}`);
  process.exitCode = 1;
});
