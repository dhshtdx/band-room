import * as alphaTab from '/alphatab/alphaTab.mjs';

const $ = (selector) => document.querySelector(selector);
const connection = $('#connection'); const lobby = $('#lobby'); const roomPanel = $('#room'); const notice = $('#notice');
const pageRole = location.pathname === '/host' ? 'host' : 'member';
const debugMode = new URLSearchParams(location.search).has('debug');
document.body.dataset.role = pageRole;
const requestedRoomId = new URLSearchParams(location.search).get('room');
if (requestedRoomId) $('#room-id').value = requestedRoomId.replace(/\D/g, '').slice(0, 7);
const resumeKey = `band-room:${pageRole}:resume`;
const clientIdKey = `band-room:${pageRole}:client-id`;
function readSession(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function writeSession(key, value) { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* Safari 私密模式可能禁用存储，连接本身仍可使用。 */ } }
let clientId = readSession(clientIdKey);
if (!clientId) { clientId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; writeSession(clientIdKey, clientId); }
let resumeInfo = (() => { try { return JSON.parse(readSession(resumeKey) || 'null'); } catch { return null; } })();
if (pageRole === 'member' && requestedRoomId && resumeInfo?.roomId !== requestedRoomId) { resumeInfo = null; writeSession(resumeKey, null); }
let socket = null; let reconnectTimer = null; let reconnectAttempt = 0; let memberIdentity = pageRole === 'member' ? resumeInfo : null; let isHost = false; let roomId = null; let hostToken = null; let score = null; let selectedTrack = 0; let lastKnownPlaying = null; let latestPlayback = null; let controlPending = false; let pendingPlaybackTarget = null; let explicitlyPaused = false; let alphaTabApi = null; let audioReady = false; let audioLoading = false; let audioNoteEvents = 0; let audioPlayerState = alphaTab.synth.PlayerState.Paused; let audioLoadTimer = null; let audioStatusTimer = null; let playAfterAudioReady = false; let followerCursor = null; let followerBuildTimer = null; let lastPlaybackMessageAt = null; let scoreClickHandler = null; const runtimeErrors = [];
function persistResume(value) { resumeInfo = value; writeSession(resumeKey, value ? JSON.stringify(value) : null); }
function positionForTick(tick) {
  const points = score?.tempoMap ?? []; let point = points[0] ?? null;
  for (const candidate of points) { if (candidate.tick > tick) break; point = candidate; }
  if (!point) return Math.max(0, Math.round(tick * 60000 / (((score?.tempo || 120) * 960))));
  return Math.max(0, Math.min(score.durationMs ?? Number.POSITIVE_INFINITY, Math.round(point.timeMs + (tick - point.tick) * 60000 / (point.tempo * 960))));
}
function initializeAlphaTab() {
  const scoreElement = $('#alpha-tab');
  if (scoreClickHandler) scoreElement.removeEventListener('click', scoreClickHandler);
  scoreClickHandler = null;
  if (alphaTabApi) alphaTabApi.destroy();
  audioReady = false; audioLoading = false; audioNoteEvents = 0; audioPlayerState = alphaTab.synth.PlayerState.Paused; playAfterAudioReady = false; clearTimeout(audioLoadTimer); clearTimeout(audioStatusTimer); audioStatusTimer = null;
  alphaTabApi = new alphaTab.AlphaTabApi(scoreElement, { core: { fontDirectory: '/alphatab/font/', scriptFile: `${location.origin}/alphatab/alphaTab.mjs`, useWorkers: true }, display: { layoutMode: alphaTab.LayoutMode.Horizontal, scale: 1 }, player: { enablePlayer: isHost, playerMode: alphaTab.PlayerMode.EnabledSynthesizer, soundFont: isHost ? '/alphatab/soundfont/sonivox.sf2' : null, enableCursor: isHost, enableElementHighlighting: isHost, scrollMode: alphaTab.ScrollMode.OffScreen, nativeBrowserSmoothScroll: true, scrollElement: document.documentElement } });
  alphaTabApi.renderStarted.on(() => { $('#render-status').classList.remove('hidden'); $('#render-status').textContent = '正在排版谱面…'; scheduleFollowerBuild(); });
  alphaTabApi.renderFinished.on(() => { clearTimeout(renderTimeout); $('#render-status').classList.add('hidden'); $('#alpha-tab').classList.remove('hidden'); if (isHost) { ensureHostAudioMix(); $('#toggle-play').disabled = false; resumeIfServerPlaying(); } scheduleFollowerBuild(); });
  alphaTabApi.error.on((error) => { clearTimeout(renderTimeout); $('#render-status').classList.remove('hidden'); $('#render-status').textContent = `AlphaTab 渲染失败：${error.message ?? '未知错误'}`; reportRuntimeError('AlphaTab', error); });
  if (isHost) {
    scoreClickHandler = (event) => {
      const api = alphaTabApi; const model = api?.score; const lookup = api?.boundsLookup;
      const surface = scoreElement.querySelector('.at-surface');
      if (!model || !lookup || !surface) return;
      const rect = surface.getBoundingClientRect();
      const beat = lookup.getBeatAtPos(event.clientX - rect.left, event.clientY - rect.top);
      const barIndex = beat?.voice?.bar?.index;
      const masterBar = Number.isInteger(barIndex) ? model.masterBars[barIndex] : null;
      const playedBar = score?.playbackTimeline?.find((entry) => entry.barIndex === barIndex);
      const tick = (playedBar?.startTick ?? masterBar?.start) + beat?.playbackStart;
      if (!Number.isFinite(tick)) return;
      const positionMs = positionForTick(tick);
      $('#seek-seconds').value = (positionMs / 1000).toFixed(3);
      // 先驱动当前主机的 AlphaTab player，再让服务器广播同一位置给所有乐手。
      if (api.isReadyForPlayback) api.timePosition = positionMs;
      // 服务器仍是唯一时钟：点击只把 AlphaTab 命中的音乐 tick 送给服务器换成位置。
      message({ type: 'playback:control', hostToken, action: 'seek-tick', tick });
    };
    scoreElement.addEventListener('click', scoreClickHandler);
  }
  // 乐手端刻意禁用 AlphaTab player；这些 player event 在该模式下不存在。
  if (isHost) {
    alphaTabApi.midiEventsPlayedFilter = [alphaTab.midi.MidiEventType.NoteOn];
    alphaTabApi.midiEventsPlayed?.on((event) => { audioNoteEvents += event.events?.filter((midiEvent) => midiEvent.type === alphaTab.midi.MidiEventType.NoteOn).length ?? 0; scheduleHostAudioStatus(); });
    alphaTabApi.soundFontLoad?.on((event) => { audioLoading = true; $('#audio-status').classList.remove('hidden'); $('#audio-status').textContent = `正在准备主机伴奏音色…${Math.floor((event.loaded / event.total) * 100)}%`; });
    alphaTabApi.soundFontLoaded?.on(() => { audioReady = true; audioLoading = false; clearTimeout(audioLoadTimer); $('#prepare-audio').disabled = false; $('#prepare-audio').textContent = '重新加载伴奏'; $('#toggle-play').disabled = false; ensureHostAudioMix(); refreshHostAudioStatus('伴奏已就绪'); startAfterAudioReady(); if (isHost) resumeIfServerPlaying(); });
    alphaTabApi.soundFontLoadFailed?.on((error) => { audioReady = false; audioLoading = false; playAfterAudioReady = false; clearTimeout(audioLoadTimer); $('#prepare-audio').disabled = false; $('#prepare-audio').textContent = '重试准备伴奏'; $('#audio-status').textContent = `伴奏音色加载失败：${error.message ?? '未知错误'}`; reportRuntimeError('SoundFont', error); });
    alphaTabApi.playerReady?.on(() => { ensureHostAudioMix(); refreshHostAudioStatus('播放器与 MIDI 已就绪'); startAfterAudioReady(); if (isHost) resumeIfServerPlaying(); });
    alphaTabApi.playerStateChanged?.on((event) => { audioPlayerState = event.state ?? event; refreshHostAudioStatus(); });
  }
}
function reportRuntimeError(source, error) { const detail = error?.message || String(error); runtimeErrors.unshift(`${new Date().toLocaleTimeString()} [${source}] ${detail}`); $('#runtime-errors-text').textContent = runtimeErrors.slice(0, 8).join('\n'); $('#runtime-errors').classList.remove('hidden'); }
function ensureHostAudioMix() { if (!isHost || !alphaTabApi) return; alphaTabApi.masterVolume = 1; if (alphaTabApi.score?.tracks?.length) { alphaTabApi.changeTrackSolo([-1], false); alphaTabApi.changeTrackMute([-1], false); alphaTabApi.changeTrackVolume([-1], 1); } }
function refreshHostAudioStatus(prefix = '') { if (!isHost) return; const state = audioPlayerState === alphaTab.synth.PlayerState.Playing ? '播放中' : '已暂停'; $('#audio-status').classList.remove('hidden'); if (!debugMode) { $('#audio-status').textContent = audioReady ? (state === '播放中' ? '伴奏播放中' : '伴奏已就绪') : audioLoading ? '正在准备伴奏…' : '尚未准备伴奏'; return; } const contextState = alphaTabApi?.player?.output?.context?.state ?? '初始化中'; const details = [`音色${audioReady ? '已加载' : audioLoading ? '加载中' : '未加载'}`, `播放器${state}`, `AudioContext ${contextState}`, `主音量 ${alphaTabApi?.masterVolume ?? 0}`, `MIDI 音符 ${audioNoteEvents}`]; $('#audio-status').textContent = [prefix, ...details].filter(Boolean).join(' · '); }
function scheduleHostAudioStatus() { if (audioStatusTimer) return; audioStatusTimer = setTimeout(() => { audioStatusTimer = null; refreshHostAudioStatus(); }, 250); }
function requestHostPlayback() { if (!isHost || !latestPlayback || !alphaTabApi || !audioReady || !alphaTabApi.isReadyForPlayback) return false; explicitlyPaused = false; pendingPlaybackTarget = true; audioNoteEvents = 0; ensureHostAudioMix(); alphaTabApi.player?.output?.activate?.(); alphaTabApi.timePosition = latestPlayback.positionMs; const started = alphaTabApi.play(); if (!started && alphaTabApi.playerState !== alphaTab.synth.PlayerState.Playing) { pendingPlaybackTarget = null; reportRuntimeError('AlphaTab.play', '播放器未能在用户点击时启动'); return false; } refreshHostAudioStatus('已启动伴奏输出'); message({ type: 'playback:control', hostToken, action: 'set-playing', isPlaying: true }); return true; }
function startAfterAudioReady() { if (!playAfterAudioReady || !audioReady) return; playAfterAudioReady = false; requestHostPlayback(); }
function prepareHostAudio(playWhenReady = false, forceReload = false) { if (!isHost || !alphaTabApi) return false; playAfterAudioReady ||= playWhenReady; alphaTabApi.player?.output?.activate?.(); if (audioReady && !forceReload) { ensureHostAudioMix(); refreshHostAudioStatus('伴奏已就绪'); return true; } $('#prepare-audio').disabled = true; $('#prepare-audio').textContent = '正在准备…'; $('#toggle-play').disabled = true; $('#audio-status').classList.remove('hidden'); $('#audio-status').textContent = '正在主动加载主机伴奏音色…'; clearTimeout(audioLoadTimer); if (!audioLoading || forceReload) { audioReady = false; audioLoading = true; const initiated = alphaTabApi.loadSoundFont('/alphatab/soundfont/sonivox.sf2', false); if (!initiated) { audioLoading = false; $('#prepare-audio').disabled = false; $('#prepare-audio').textContent = '重试准备伴奏'; reportRuntimeError('SoundFont', 'AlphaTab 未接受音色加载请求'); return false; } } audioLoadTimer = setTimeout(() => { audioLoading = false; playAfterAudioReady = false; $('#prepare-audio').disabled = false; $('#prepare-audio').textContent = '重试准备伴奏'; $('#toggle-play').disabled = false; $('#audio-status').textContent = '准备伴奏超过 20 秒，请点击“重试准备伴奏”。'; }, 20000); return true; }
window.addEventListener('error', (event) => reportRuntimeError('window.error', event.error || event.message)); window.addEventListener('unhandledrejection', (event) => reportRuntimeError('unhandledrejection', event.reason));
function message(payload) { if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(payload)); return true; } showError('连接正在恢复，请稍后再试。'); reportRuntimeError('WebSocket.send', 'socket 未连接'); connectSocket(); return false; } function showError(text) { notice.textContent = text; }
function renderMembers(list) { $('#members').innerHTML = list.map(({ name, instrument }) => `<li>${name}<span>${instrument}</span></li>`).join(''); }
async function renderJoinAccess(nextRoomId) {
  const qr = $('#join-qr');
  if (!isHost) { qr.classList.add('hidden'); $('#host-url').classList.add('hidden'); return; }
  $('#host-url').classList.remove('hidden');
  let joinOrigin = location.origin;
  if (['localhost', '127.0.0.1', '::1'].includes(location.hostname)) {
    try { const network = await fetch('/api/network', { cache: 'no-store' }).then((response) => response.json()); joinOrigin = network.origins?.[0] || joinOrigin; } catch { /* 链接仍可回退到当前 origin。 */ }
  }
  const joinUrl = `${joinOrigin}/join?room=${nextRoomId}`;
  $('#host-url').textContent = `乐手加入链接：${joinUrl}`;
  try { const result = await fetch(`/api/qrcode?url=${encodeURIComponent(joinUrl)}`, { cache: 'no-store' }).then((response) => response.json()); if (!result.dataUrl) throw new Error('二维码数据为空'); qr.src = result.dataUrl; qr.classList.remove('hidden'); } catch (error) { qr.classList.add('hidden'); reportRuntimeError('QRCode', error); }
}
function formatPosition(ms) { return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; }
function updateSyncDebug({ playback, tick = null, match = null, cursor = null, issue = '' }) { if (isHost) return; const alphaPlayerState = alphaTabApi ? (alphaTabApi.isReadyForPlayback ? 'ready' : 'disabled / not ready') : 'instance missing'; const values = [['WebSocket', socket?.readyState === WebSocket.OPEN ? 'connected' : 'reconnecting'], ['playing', String(playback.isPlaying)], ['serverTick', String(playback.serverTick ?? 'missing')], ['currentTempo', `${playback.currentTempo ?? '—'} BPM`], ['lastReceivedTick', String(playback.serverTick ?? 'missing')], ['currentMeasure', String(playback.measure ?? match?.barIndex + 1 ?? '—')], ['currentBeat', String(playback.beat ?? match?.beatIndex + 1 ?? '—')], ['serverTimestamp', String(playback.timestamp ?? playback.serverNow ?? 'missing')], ['AlphaTab timePosition', String(alphaTabApi?.timePosition ?? 'not exposed')], ['AlphaTab player', alphaPlayerState], ['lastSyncMessage', lastPlaybackMessageAt ? new Date(lastPlaybackMessageAt).toLocaleTimeString() : '未收到'], ['clientTick', tick === null ? '—' : String(Math.round(tick))], ['cursor', cursor ? `x=${Math.round(cursor.x)}, y=${Math.round(cursor.y)}, h=${Math.round(cursor.h)}` : '无'], ['status', issue || 'ok']]; const panel = $('#sync-debug-text'); panel.replaceChildren(...values.flatMap(([term, value]) => { const dt = document.createElement('dt'); dt.textContent = term; const dd = document.createElement('dd'); dd.textContent = value; return [dt, dd]; })); }
function scheduleFollowerBuild(attempt = 0) { clearTimeout(followerBuildTimer); followerBuildTimer = setTimeout(() => { const ready = buildFollower(); if (!ready && attempt < 20) scheduleFollowerBuild(attempt + 1); }, 500); }
function buildFollower() {
  followerCursor = null; $('#sync-cursor')?.remove();
  const model = alphaTabApi?.score; const lookup = alphaTabApi?.boundsLookup; const track = model?.tracks[selectedTrack];
  if (!model || !lookup || !track) return false;
  const uniqueBeats = new Map();
  const timeline = score?.playbackTimeline?.length ? score.playbackTimeline : model.masterBars.map((bar, barIndex) => ({ barIndex, startTick: bar.start }));
  for (const playedBar of timeline) for (const staff of track.staves) {
    const bar = staff.bars[playedBar.barIndex]; if (!bar) continue;
    for (const voice of bar.voices) for (const beat of voice.beats) {
      const bounds = lookup.findBeat(beat); const tick = playedBar.startTick + beat.playbackStart;
      if (bounds && Number.isFinite(tick) && !uniqueBeats.has(tick)) uniqueBeats.set(tick, { tick, bounds, barIndex: bar.index, beatIndex: beat.index, occurrence: playedBar.occurrence ?? 0 });
    }
  }
  const beats = [...uniqueBeats.values()].sort((a, b) => a.tick - b.tick); if (!beats.length) return false;
  const node = document.createElement('div'); node.id = 'sync-cursor'; node.hidden = true;
  const scoreSurface = $('#alpha-tab .at-surface') || $('#alpha-tab'); $('#alpha-tab').append(node);
  followerCursor = { beats, tempo: model.tempo || 120, node, scoreSurface, lastScrollAt: 0 };
  if (latestPlayback) { updateSyncDebug({ playback: latestPlayback, issue: `已建立 ${beats.length} 个展开拍点` }); updateFollower(latestPlayback.positionMs, latestPlayback); }
  return true;
}
function followFollowerCursor(scoreX) { const scroller = $('#alpha-tab'); const targetLeft = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, scoreX - scroller.clientWidth * 0.35)); scroller.scrollLeft = targetLeft; }
function updateFollower(positionMs, playback) { if (!followerCursor || !followerCursor.node.isConnected) { scheduleFollowerBuild(); return updateSyncDebug({ playback, issue: '正在重新挂载同步游标' }); } const tick = playback.serverTick ?? Math.round(positionMs * followerCursor.tempo * 960 / 60000); let low = 0; let high = followerCursor.beats.length - 1; let match = null; while (low <= high) { const middle = Math.floor((low + high) / 2); if (followerCursor.beats[middle].tick <= tick) { match = followerCursor.beats[middle]; low = middle + 1; } else high = middle - 1; } if (!match) return updateSyncDebug({ playback, tick, issue: followerCursor.beats.length ? '播放位置在第一拍之前' : '没有可查找的 beat' }); const cursor = { x: match.bounds.onNotesX - 1, y: 0, h: followerCursor.scoreSurface.scrollHeight }; followerCursor.node.style.transform = `translate(${cursor.x}px, ${cursor.y}px)`; followerCursor.node.style.height = `${cursor.h}px`; followerCursor.node.hidden = false; followFollowerCursor(cursor.x); updateSyncDebug({ playback, tick, match, cursor }); }
function renderPlayback(playback) { latestPlayback = playback; if (pendingPlaybackTarget === null || playback.isPlaying === pendingPlaybackTarget) { controlPending = false; pendingPlaybackTarget = null; } const displayedPlaying = pendingPlaybackTarget ?? playback.isPlaying; if (isHost) { $('#toggle-play').disabled = false; $('#alpha-tab').classList.toggle('host-paused-cursor', !playback.isPlaying); } $('#transport-status').textContent = playback.isPlaying ? '播放中' : '已暂停'; $('#position').textContent = formatPosition(playback.positionMs); $('#toggle-play').textContent = displayedPlaying ? '暂停' : '播放'; $('#seek-seconds').value = (playback.positionMs / 1000).toFixed(1); if (!score || !alphaTabApi) { if (!isHost) updateSyncDebug({ playback, issue: '等待曲谱加载' }); return; } const playingFlipped = lastKnownPlaying === null || playback.isPlaying !== lastKnownPlaying; lastKnownPlaying = playback.isPlaying; if (isHost && playingFlipped && alphaTabApi.isReadyForPlayback) { alphaTabApi.timePosition = playback.positionMs; if (audioReady && playback.isPlaying) alphaTabApi.play(); if (!playback.isPlaying) alphaTabApi.pause(); } updateFollower(playback.positionMs, playback); }
function resumeIfServerPlaying() { if (!isHost || !alphaTabApi || !latestPlayback || explicitlyPaused) return; if (latestPlayback.isPlaying && audioReady && alphaTabApi.isReadyForPlayback) { alphaTabApi.timePosition = latestPlayback.positionMs; alphaTabApi.play(); } }
let renderTimeout = null;
async function loadSelectedTrack() { if (!score || !roomId || !alphaTabApi) return; followerCursor = null; clearTimeout(renderTimeout); $('#alpha-tab').classList.remove('hidden'); $('#render-status').classList.remove('hidden'); $('#render-status').textContent = '正在加载并排版谱面…'; renderTimeout = setTimeout(() => { $('#render-status').textContent = '排版超过 30 秒：请刷新页面后重试，并检查浏览器控制台错误。'; }, 30000); try { const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/score`, { cache: 'no-store' }); if (!response.ok) throw new Error('无法获取房间曲谱。'); const bytes = await response.arrayBuffer(); alphaTabApi.load(bytes, [selectedTrack]); } catch (error) { clearTimeout(renderTimeout); $('#render-status').textContent = `谱面加载失败：${error.message}`; } }
function renderScore(nextScore) { score = nextScore; $('#score-empty').classList.toggle('hidden', Boolean(score)); $('#score-details').classList.toggle('hidden', !score); if (!score) return; $('#score-title').textContent = score.title; $('#score-meta').textContent = [score.artist, score.tempo ? `${score.tempo} BPM` : '', `${score.barCount} 小节`, score.tempoMap?.length > 2 ? `${score.tempoMap.length - 2} 次变速` : '固定速度'].filter(Boolean).join(' · '); $('#track-select').innerHTML = score.tracks.map((track) => `<option value="${track.index}">${track.index + 1}. ${track.name}</option>`).join(''); selectedTrack = Math.min(selectedTrack, score.tracks.length - 1); $('#track-select').value = String(selectedTrack); loadSelectedTrack(); }
function resetExpiredRoom() {
  persistResume(null); memberIdentity = null; roomId = null; hostToken = null; isHost = false;
  lobby.classList.remove('hidden'); roomPanel.classList.add('hidden');
  if (alphaTabApi) { alphaTabApi.destroy(); alphaTabApi = null; }
}
function handleSocketMessage({ data }) {
  let event; try { event = JSON.parse(data); } catch (error) { reportRuntimeError('WebSocket.parse', error); return; }
  if (event.type === 'error') {
    showError(event.message); reportRuntimeError('server', event.message);
    if (event.code === 'ROOM_NOT_FOUND' || event.code === 'HOST_AUTH_INVALID') resetExpiredRoom();
    return;
  }
  if (event.type === 'room:members') return renderMembers(event.members);
  if (event.type === 'playback:state') { lastPlaybackMessageAt = Date.now(); return renderPlayback(event.playback); }
  if (event.type === 'score:loaded') return renderScore(event.score);
  if (event.type !== 'room:joined') return;
  const sameRoom = roomId === event.room.id && Boolean(alphaTabApi);
  const scoreChanged = score?.fileName !== event.score?.fileName || score?.barCount !== event.score?.barCount;
  notice.textContent = ''; lobby.classList.add('hidden'); roomPanel.classList.remove('hidden'); roomId = event.room.id;
  $('#room-title').textContent = `房间 ${roomId}`; isHost = pageRole === 'host' && event.room.isHost;
  renderJoinAccess(roomId);
  hostToken = event.hostToken ?? hostToken;
  if (isHost) persistResume({ roomId, hostToken });
  else if (memberIdentity) persistResume({ roomId, name: memberIdentity.name, instrument: memberIdentity.instrument });
  if (!sameRoom) initializeAlphaTab();
  $('#host-transport').classList.toggle('hidden', !isHost); $('#score-host-actions').classList.toggle('hidden', !isHost); $('#sync-debug').classList.toggle('hidden', isHost || !debugMode);
  renderMembers(event.members); renderPlayback(event.playback);
  if (!sameRoom || scoreChanged) renderScore(event.score);
  connection.textContent = '已连接并进入房间';
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(5_000, 500 * 2 ** Math.min(reconnectAttempt, 4)); reconnectAttempt += 1;
  connection.textContent = `连接中断，${(delay / 1000).toFixed(1)} 秒后自动重连…`;
  reconnectTimer = setTimeout(connectSocket, delay);
}
function connectSocket() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(reconnectTimer); connection.textContent = reconnectAttempt ? '正在重新连接主机…' : '正在连接主机…';
  const current = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`); socket = current;
  current.addEventListener('open', () => {
    if (socket !== current) return;
    reconnectAttempt = 0; connection.textContent = '已连接到主机';
    if (resumeInfo?.roomId && pageRole === 'host') current.send(JSON.stringify({ type: 'room:resume', roomId: resumeInfo.roomId, hostToken: resumeInfo.hostToken, clientId }));
    else if (resumeInfo?.roomId && pageRole === 'member') { memberIdentity = resumeInfo; current.send(JSON.stringify({ type: 'room:join', roomId: resumeInfo.roomId, name: resumeInfo.name, instrument: resumeInfo.instrument, clientId })); }
  });
  current.addEventListener('message', handleSocketMessage);
  current.addEventListener('close', () => { if (socket !== current) return; socket = null; if (latestPlayback && !isHost) updateSyncDebug({ playback: latestPlayback, issue: '连接中断，游标保持在最后位置' }); scheduleReconnect(); });
  current.addEventListener('error', () => reportRuntimeError('WebSocket', '连接发生错误，正在自动重试'));
}
window.addEventListener('online', connectSocket);
document.addEventListener('visibilitychange', () => { if (!document.hidden) connectSocket(); });
$('#create-room').addEventListener('click', () => { if (pageRole === 'host') { persistResume(null); message({ type: 'room:create', clientId }); } });
$('#join-room').addEventListener('click', () => { if (pageRole === 'member') { memberIdentity = { roomId: $('#room-id').value.replace(/\D/g, ''), name: $('#name').value.trim(), instrument: $('#instrument').value }; message({ type: 'room:join', ...memberIdentity, clientId }); } });
$('#prepare-audio').addEventListener('click', () => prepareHostAudio(false, true));
$('#toggle-play').addEventListener('click', () => {
  if (!isHost || !latestPlayback) return;
  const currentlyPlaying = pendingPlaybackTarget ?? latestPlayback.isPlaying;
  if (currentlyPlaying) { explicitlyPaused = true; pendingPlaybackTarget = false; alphaTabApi?.pause(); message({ type: 'playback:control', hostToken, action: 'set-playing', isPlaying: false }); return; }
  if (!audioReady || !alphaTabApi?.isReadyForPlayback) { prepareHostAudio(false); $('#audio-status').classList.remove('hidden'); $('#audio-status').textContent = '伴奏仍在准备，显示“伴奏已就绪”后请再点一次播放。'; return; }
  requestHostPlayback();
});
$('#seek').addEventListener('click', () => { if (isHost) message({ type: 'playback:control', hostToken, action: 'seek', positionMs: Number($('#seek-seconds').value) * 1000 }); });
$('#track-select').addEventListener('change', () => { selectedTrack = Number($('#track-select').value); loadSelectedTrack(); });
$('#fullscreen-score').addEventListener('click', async () => { const scoreElement = $('#alpha-tab'); if (!scoreElement || scoreElement.classList.contains('hidden')) return showError('请先等待谱面加载完成。'); try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('#room').requestFullscreen) await $('#room').requestFullscreen(); else document.body.classList.toggle('score-focus'); } catch { document.body.classList.toggle('score-focus'); } });
function syncFullscreenUi() { const active = Boolean(document.fullscreenElement) || document.body.classList.contains('score-focus'); $('#fullscreen-score').textContent = active ? '退出全屏' : '全屏看谱'; $('#fullscreen-exit').classList.toggle('hidden', !active); }
$('#fullscreen-exit').addEventListener('click', async () => { if (document.fullscreenElement) await document.exitFullscreen(); document.body.classList.remove('score-focus'); syncFullscreenUi(); });
document.addEventListener('fullscreenchange', syncFullscreenUi);
$('#load-score').addEventListener('click', async () => { const file = $('#score-file').files[0]; if (!isHost || !file) return showError('请选择一个 Guitar Pro 文件。'); if (file.size > 20 * 1024 * 1024) return showError('曲谱不能超过 20 MB。'); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); message({ type: 'score:upload', hostToken, upload: { name: file.name, data: btoa(binary) } }); });
connectSocket();
