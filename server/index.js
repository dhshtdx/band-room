import crypto from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { importer, midi } from '@coderline/alphatab';
import QRCode from 'qrcode';
import { MAX_VIDEO_BYTES, VideoMediaError, RangeNotSatisfiableError, validateVideoDescriptor, hasValidVideoSignature, parseSingleRange, streamVideoUpload } from './video-media.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const packageMetadata = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
const alphaTabDistDir = join(rootDir, 'node_modules', '@coderline', 'alphatab', 'dist');
const port = Number(process.env.PORT ?? 4173);
// 安装后的 .app/.exe 目录是只读的。桌面壳通过 BAND_ROOM_DATA_DIR
// 把临时曲谱放到系统用户数据目录；命令行开发模式仍沿用 work/scores。
const dataDir = process.env.BAND_ROOM_DATA_DIR || join(rootDir, 'work');
const scoresDir = join(dataDir, 'scores');
const videosDir = join(dataDir, 'videos');
const pendingVideoUploads = new Map();
const pendingScoreUploads = new Set();
const allowedInstruments = ['guitar', 'bass', 'drums', 'keys', 'vocals', 'other'];
const allowedScoreExtensions = new Set(['.gp', '.gp3', '.gp4', '.gp5', '.gpx']);
const rooms = new Map();
const pendingSourceCleanups = new Set();
const configuredCleanupGraceMs = Number(process.env.BAND_ROOM_CLEANUP_GRACE_MS ?? 60_000);
const roomCleanupGraceMs = Number.isSafeInteger(configuredCleanupGraceMs) && configuredCleanupGraceMs >= 0 && configuredCleanupGraceMs <= 2_147_483_647 ? configuredCleanupGraceMs : 60_000;
const maxRoomMembers = 32;
function lanAddresses() { return Object.values(os.networkInterfaces()).flat().filter((entry) => entry?.family === 'IPv4' && !entry.internal).map((entry) => entry.address); }

function createRoom() {
  let id; do { id = crypto.randomInt(1_000_000, 10_000_000).toString(); } while (rooms.has(id));
  const room = { id, hostToken: crypto.randomBytes(24).toString('base64url'), members: new Set(), sourceRevision: 0, source: null, cleanupTimer: null, playback: { isPlaying: false, positionMs: 0, updatedAt: Date.now(), revision: 0 } };
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
  const score = room.source?.kind === 'score' ? room.source : null;
  const rawPositionMs = Math.round(state.positionMs + (state.isPlaying ? Date.now() - state.updatedAt : 0));
  const positionMs = room.source?.durationMs !== undefined ? Math.min(rawPositionMs, room.source.durationMs) : rawPositionMs;
  const isPlaying = state.isPlaying && positionMs < (room.source?.durationMs ?? Number.POSITIVE_INFINITY);
  const serverTick = room.source && !score ? 0 : positionToTick(score, positionMs);
  const timeline = score?.playbackTimeline || [];
  const timelineEntry = findLastAtOrBefore(timeline, serverTick, 'startTick') || { startTick: 0, numerator: 4, denominator: 4, measure: 1, occurrence: 0 };
  const ticksPerBeat = 960 * 4 / (timelineEntry.denominator || 4);
  const tempoPoint = findLastAtOrBefore(score?.tempoMap ?? [], serverTick, 'tick');
  return { ...state, isPlaying, positionMs, serverTick, currentTempo: tempoPoint?.tempo ?? score?.tempo ?? 120, measure: timelineEntry.measure, beat: Math.max(1, Math.floor((serverTick - timelineEntry.startTick) / ticksPerBeat) + 1), occurrence: timelineEntry.occurrence, timestamp: Date.now(), serverNow: Date.now() };
}
function updatePlayback(room, patch) { const current = playbackState(room); room.playback = { isPlaying: patch.isPlaying ?? current.isPlaying, positionMs: Number.isFinite(patch.positionMs) ? Math.max(0, Math.round(patch.positionMs)) : current.positionMs, updatedAt: Date.now(), revision: current.revision + 1 }; broadcast(room, { type: 'playback:state', playback: playbackState(room) }); }
function cancelRoomCleanup(room) { if (room.cleanupTimer) clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
function scheduleRoomCleanup(room) {
  if (stopping || room.members.size || room.cleanupTimer) return;
  room.cleanupTimer = setTimeout(async () => {
    room.cleanupTimer = null;
    if (room.members.size || rooms.get(room.id) !== room) return;
    rooms.delete(room.id);
    const cleanup = scheduleSourceCleanup(room.source);
    const uploads = [];
    for (const [request, task] of pendingVideoUploads) {
      if (request.params.roomId !== room.id) continue;
      uploads.push(task);
      request.destroy();
    }
    await Promise.allSettled([cleanup, ...uploads]);
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
  return { type: 'room:joined', room: { id: room.id, isHost: socket.member.isHost }, ...(hostToken ? { hostToken } : {}), members: members(room), playback: playbackState(room), source: publicSource(room.source) };
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
function publicSource(source) { if (!source) return null; const { storagePath, ...metadata } = source; return metadata; }
async function removeStoredSource(source) {
  if (!source?.storagePath) return;
  for (let attempt = 0; ; attempt += 1) {
    try { await rm(source.storagePath, { force: true }); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
function reportSourceCleanupError(error) { console.error('无法清理播放源临时文件：', error); }
function scheduleSourceCleanup(source) {
  const task = removeStoredSource(source).catch(reportSourceCleanupError);
  pendingSourceCleanups.add(task);
  const finished = () => pendingSourceCleanups.delete(task);
  task.then(finished, finished);
  return task;
}
function beginSourceUpload(room) { return ++room.sourceRevision; }
function isCurrentSourceUpload(room, revision) { return !stopping && rooms.get(room.id) === room && room.sourceRevision === revision; }
function replaceSource(room, nextSource) {
  const previousSource = room.source;
  room.playback = { isPlaying: false, positionMs: 0, updatedAt: Date.now(), revision: room.playback.revision + 1 };
  room.source = nextSource;
  broadcast(room, { type: 'source:loaded', source: publicSource(nextSource) });
  broadcast(room, { type: 'playback:state', playback: playbackState(room) });
  scheduleSourceCleanup(previousSource);
}
async function storeAndParseScore(room, upload) {
  const raw = Buffer.from(upload.data, 'base64'); const fileName = basename(String(upload.name ?? 'score.gp'));
  if (!raw.length || raw.length > 20 * 1024 * 1024) throw new Error('曲谱文件必须介于 1 字节和 20 MB 之间。');
  if (!allowedScoreExtensions.has(extname(fileName).toLowerCase())) throw new Error('仅支持 .gp、.gp3、.gp4、.gp5、.gpx 文件。');
  let score; try { score = importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(raw)); } catch { throw new Error('无法解析此 Guitar Pro 文件，请确认文件未损坏且格式受支持。'); }
  const source = { kind: 'score', id: crypto.randomUUID(), ...serializeScore(score, fileName) };
  await mkdir(scoresDir, { recursive: true });
  const storagePath = join(scoresDir, `${room.id}-${source.id}${extname(fileName).toLowerCase()}`);
  await writeFile(storagePath, raw);
  return { ...source, storagePath };
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
async function receiveVideo(request, response) {
  const room = rooms.get(request.params.roomId);
  if (!room) return response.status(404).json({ message: '排练房间不存在或已过期。' });
  const authorization = request.get('authorization');
  const bearer = /^Bearer (\S+)$/.exec(authorization ?? '');
  if (!bearer) return response.status(401).json({ message: '需要主机控制凭证。' });
  if (bearer[1] !== room.hostToken) return response.status(403).json({ message: '主机控制凭证无效。' });
  const revision = beginSourceUpload(room);
  const sourceId = crypto.randomUUID();
  const temporaryPath = join(videosDir, `${room.id}-${sourceId}.upload`);
  let storagePath;
  try {
    const lengthHeader = request.get('content-length');
    const contentLength = lengthHeader === undefined ? undefined : Number(lengthHeader);
    if (contentLength > MAX_VIDEO_BYTES) return response.status(413).json({ message: '视频文件不能超过 2 GiB。' });
    let fileName;
    try { fileName = decodeURIComponent(request.get('x-file-name') ?? ''); }
    catch { throw new VideoMediaError('视频文件名编码无效。'); }
    const descriptor = validateVideoDescriptor({ fileName, mimeType: request.get('content-type'), contentLength });
    await mkdir(videosDir, { recursive: true });
    const { size, headerBytes } = await streamVideoUpload({ request, temporaryPath, maxBytes: MAX_VIDEO_BYTES });
    if (!hasValidVideoSignature(descriptor.mimeType, headerBytes)) throw new VideoMediaError('视频文件标识无效。');
    if (!isCurrentSourceUpload(room, revision)) {
      await rm(temporaryPath, { force: true });
      return response.status(409).json({ code: 'SOURCE_UPLOAD_CONFLICT', message: '此上传已被新的播放源替换。' });
    }
    storagePath = join(videosDir, `${room.id}-${sourceId}${descriptor.extension}`);
    await rename(temporaryPath, storagePath);
    // rename 是异步边界，新请求可能已占用下一代次。
    if (!isCurrentSourceUpload(room, revision)) {
      await rm(storagePath, { force: true });
      return response.status(409).json({ code: 'SOURCE_UPLOAD_CONFLICT', message: '此上传已被新的播放源替换。' });
    }
    const source = { kind: 'video', id: sourceId, fileName: descriptor.fileName, mimeType: descriptor.mimeType, size, storagePath };
    replaceSource(room, source);
    response.json({ source: publicSource(source) });
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (storagePath) await rm(storagePath, { force: true });
    if (!response.destroyed && !response.headersSent) response.status(error.statusCode === 413 ? 413 : error instanceof VideoMediaError ? 400 : 500).json({ message: error instanceof VideoMediaError ? error.message : '视频上传失败。' });
  }
}
app.post('/api/rooms/:roomId/video', (request, response) => {
  if (stopping) return response.status(503).json({ message: '服务器正在停止。' });
  const task = receiveVideo(request, response);
  pendingVideoUploads.set(request, task);
  task.finally(() => pendingVideoUploads.delete(request)).catch(reportSourceCleanupError);
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
app.get('/api/rooms/:roomId/score/:sourceId', async (request, response) => { const source = rooms.get(request.params.roomId)?.source; if (source?.kind !== 'score' || source.id !== request.params.sourceId || !source.storagePath) return response.status(404).json({ message: '此曲谱来源已失效或尚未加载。' }); response.type('application/octet-stream').send(await readFile(source.storagePath)); });
app.get('/api/rooms/:roomId/video/:sourceId', async (request, response) => {
  const source = rooms.get(request.params.roomId)?.source;
  if (source?.kind !== 'video' || source.id !== request.params.sourceId || !source.storagePath) return response.status(404).json({ message: '此视频来源已失效或尚未加载。' });
  try {
    const { size } = await stat(source.storagePath);
    let range;
    try { range = parseSingleRange(request.get('range'), size); }
    catch (error) {
      if (!(error instanceof RangeNotSatisfiableError)) throw error;
      return response.status(416).set('Content-Range', `bytes */${size}`).json({ message: error.message });
    }
    const stream = createReadStream(source.storagePath, range ? { start: range.start, end: range.end } : {});
    // 在返回响应头前打开句柄；来源替换删除路径后，已开始的读取仍持有文件。
    await once(stream, 'open');
    if (response.destroyed) { stream.destroy(); return; }
    response.status(range ? 206 : 200).set({
      'Content-Type': source.mimeType,
      'Content-Length': String(range?.length ?? size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}),
    });
    await pipeline(stream, response);
  } catch (error) {
    if (!response.headersSent && !response.destroyed) response.status(error.code === 'ENOENT' ? 404 : 500).json({ message: '无法读取此视频来源。' });
  }
});
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
  if (stopping) return;
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
  if (event.type === 'score:upload') {
    if (!room || !socket.member.isHost || event.hostToken !== room.hostToken) { socket.send(JSON.stringify({ type: 'error', code: 'HOST_AUTH_INVALID', message: '主机控制凭证无效。' })); return; }
    const revision = beginSourceUpload(room);
    const task = (async () => { try {
      const source = await storeAndParseScore(room, event.upload ?? {});
      if (!isCurrentSourceUpload(room, revision)) {
        await scheduleSourceCleanup(source);
        socket.send(JSON.stringify({ type: 'error', code: 'SOURCE_UPLOAD_CONFLICT', message: '此上传已被新的播放源替换。' }));
        return;
      }
      replaceSource(room, source);
    } catch (error) { socket.send(JSON.stringify({ type: 'error', message: error.message })); } })();
    pendingScoreUploads.add(task);
    try { await task; } finally { pendingScoreUploads.delete(task); }
    return;
  }
  if (event.type === 'source:set-duration') {
    if (!room || !socket.member.isHost || event.hostToken !== room.hostToken) { socket.send(JSON.stringify({ type: 'error', code: 'HOST_AUTH_INVALID', message: '主机控制凭证无效。' })); return; }
    if (room.source?.kind !== 'video' || event.sourceId !== room.source.id || !Number.isFinite(event.durationMs) || event.durationMs <= 0 || event.durationMs > 86_400_000) {
      socket.send(JSON.stringify({ type: 'error', message: '视频来源或时长无效。' })); return;
    }
    room.source.durationMs = event.durationMs;
    broadcast(room, { type: 'source:loaded', source: publicSource(room.source) });
    updatePlayback(room, {});
    return;
  }
  if (event.type === 'playback:control') { if (!room || !socket.member.isHost || event.hostToken !== room.hostToken) { socket.send(JSON.stringify({ type: 'error', code: 'HOST_AUTH_INVALID', message: '主机控制凭证无效。' })); return; } if (event.action === 'set-playing' && typeof event.isPlaying === 'boolean') updatePlayback(room, { isPlaying: event.isPlaying }); if (event.action === 'seek') updatePlayback(room, { positionMs: Number(event.positionMs) }); if (event.action === 'seek-tick') updatePlayback(room, { positionMs: tickToPosition(room.source?.kind === 'score' ? room.source : null, Math.max(0, Number(event.tick) || 0)) }); return; }
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
  for (const request of pendingVideoUploads.keys()) request.destroy();
  await Promise.allSettled([...pendingVideoUploads.values(), ...pendingScoreUploads]);
  const sources = [];
  for (const room of rooms.values()) {
    cancelRoomCleanup(room);
    if (room.source) sources.push(room.source);
  }
  for (const socket of wss.clients) socket.terminate();
  await Promise.allSettled([
    new Promise((resolve) => wss.close(resolve)),
    new Promise((resolve) => server.close(resolve)),
    ...sources.map(scheduleSourceCleanup)
  ]);
  while (pendingSourceCleanups.size) await Promise.allSettled([...pendingSourceCleanups]);
  rooms.clear();
}

// 命令行启动时让端口错误清楚可见；Electron 会自行显示原生报错窗口。
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) serverReady.catch((error) => {
  console.error(`服务器启动失败：${error.message}`);
  process.exitCode = 1;
});
