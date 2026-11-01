import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { applyMemberScorePlayback, attachSilentExternalMedia } from '../public/member-score-sync.js';
import { decideVideoSync, targetVideoPositionMs, VIDEO_SYNC } from '../public/video-sync.js';

const appCode = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');

// 浏览器边界替身：执行真实应用，媒体解码、DOM 与网络由宿主提供。
function browser(role = 'host', sync = { applyMemberScorePlayback, attachSilentExternalMedia }) {
  const nodes = new Map(); const sent = []; const requests = []; const alphaTabApis = []; const createdElements = [];
  function element() {
    const events = new Map(); const classes = new Set(['hidden']);
    return {
      classList: { add: (...items) => items.forEach((item) => classes.add(item)), remove: (...items) => items.forEach((item) => classes.delete(item)), contains: (item) => classes.has(item), toggle: (item, force = !classes.has(item)) => { if (force) classes.add(item); else classes.delete(item); return force; } },
      addEventListener(type, listener) { const list = events.get(type) ?? []; list.push(listener); events.set(type, list); },
      removeEventListener() {}, async emit(type) { for (const listener of events.get(type) ?? []) await listener({ type }); },
      dataset: {}, style: {}, value: '', files: [], disabled: false, textContent: '', innerHTML: '',
      muted: false, defaultMuted: false, volume: 1, currentTime: 0, duration: 12, playbackRate: 1, paused: true, readyState: 4,
      play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, load() {},
      removeAttribute(name) { delete this[name]; }, replaceChildren() {}, remove() {}, append() {},
    };
  }
  const get = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const document = Object.assign(element(), { body: element(), documentElement: element(), querySelector: get, createElement() { const node = element(); createdElements.push(node); return node; }, hidden: false });
  function event(beforeEmit) {
    const listeners = [];
    return { on(listener) { listeners.push(listener); }, emit(value) { beforeEmit?.(); for (const listener of listeners) listener(value); } };
  }
  class AlphaTabApi {
    constructor(scoreElement, settings) {
      this.scoreElement = scoreElement; this.settings = settings; this.isReadyForPlayback = false; this.calls = [];
      this.player = { handler: null, masterVolume: 1, output: { updatePosition: (ms) => this.calls.push(['position', ms]) } };
      for (const name of ['renderStarted', 'renderFinished', 'error', 'midiEventsPlayed', 'soundFontLoad', 'soundFontLoaded', 'soundFontLoadFailed', 'playerStateChanged']) this[name] = event();
      this.playerReady = event(() => { this.isReadyForPlayback = true; });
      alphaTabApis.push(this);
    }
    load(bytes, tracks) { this.loaded = { bytes, tracks }; }
    play() { this.calls.push(['play']); this.playerState = 1; return true; }
    pause() { this.calls.push(['pause']); this.playerState = 0; }
    destroy() { this.destroyed = true; }
  }
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 1;
    addEventListener() {}
    send(data) { sent.push(JSON.parse(data)); }
  }
  const context = vm.createContext({
    document, window: element(), location: { pathname: role === 'host' ? '/host' : '/join', search: '', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost' },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, crypto: { randomUUID: () => 'test-client' },
    WebSocket: Socket, URLSearchParams, console, Date,
    alphaTab: {
      AlphaTabApi, LayoutMode: { Horizontal: 1 }, PlayerMode: { EnabledSynthesizer: 1, EnabledExternalMedia: 2 }, ScrollMode: { OffScreen: 1 },
      midi: { MidiEventType: { NoteOn: 1 } }, synth: { PlayerState: { Paused: 0, Playing: 1 } },
    },
    targetVideoPositionMs, decideVideoSync, VIDEO_SYNC, ...sync,
    setTimeout: () => 1, clearTimeout() {}, performance: { now: () => 1000 },
    fetch: async (...args) => { requests.push(args); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8), json: async () => ({ source: { kind: 'video', id: 'uploaded' } }) }; },
  });
  vm.runInContext(appCode, context);
  const run = (code) => vm.runInContext(code, context);
  run(`isHost = ${role === 'host'}; roomId = '1234567'; hostToken = 'host-secret';`);
  return { get, run, context, sent, requests, document, video: get('#video-player'), alphaTabApis, createdElements };
}

const videoSource = `{ kind: 'video', id: 'take-1', fileName: '排练.mp4', mimeType: 'video/mp4', durationMs: null }`;
const paused = `{ positionMs: 0, isPlaying: false, revision: 1 }`;
const scoreSource = `{ kind: 'score', id: 'score-1', title: '曲谱', durationMs: 12000, tracks: [{ index: 0, name: '吉他' }], barCount: 4, tempo: 120 }`;

test('乐手曲谱使用外部媒体原生游标且不加载音色', async () => {
  const b = browser('member');
  b.run(`renderSource(${scoreSource});`);
  await new Promise((resolve) => setImmediate(resolve));
  const api = b.alphaTabApis.at(-1); const player = api.settings.player;
  assert.equal(player.playerMode, b.context.alphaTab.PlayerMode.EnabledExternalMedia);
  assert.equal(player.soundFont, null);
  assert.equal(player.enableCursor, true);
  assert.equal(player.enableElementHighlighting, true);
  assert.equal(player.enableAnimatedBeatCursor, true);
  assert.equal(player.enableUserInteraction, false);
  assert.equal(player.scrollElement, b.get('#alpha-tab'));
  api.renderFinished.emit();
  assert.equal(b.createdElements.some((node) => node.id === 'sync-cursor'), false);
});

test('乐手在 playerReady 后补应用先到达的播放状态', () => {
  const b = browser('member');
  b.run(`renderSource(${scoreSource}); renderPlayback({ positionMs: 4200, isPlaying: true, revision: 2 });`);
  const api = b.alphaTabApis.at(-1);
  assert.deepEqual(api.calls, []);
  api.playerReady.emit();
  assert.equal(api.player.handler.backingTrackDuration, 12000);
  assert.deepEqual(api.calls, [['position', 4200], ['play']]);
});

test('连续播放快照只切换一次状态并持续更新原生位置', () => {
  const b = browser('member');
  b.run(`renderSource(${scoreSource});`);
  const api = b.alphaTabApis.at(-1); api.playerReady.emit();
  b.run('renderPlayback({ positionMs: 4200, isPlaying: true, revision: 2 }); renderPlayback({ positionMs: 5100, isPlaying: true, revision: 3 });');
  assert.deepEqual(api.calls, [['position', 4200], ['play'], ['position', 5100]]);
});

test('暂停跳转、重连与页面恢复应用最新权威位置', async () => {
  const b = browser('member');
  b.run(`renderSource(${scoreSource});`);
  const api = b.alphaTabApis.at(-1); api.playerReady.emit();
  b.run('renderPlayback({ positionMs: 4200, isPlaying: true, revision: 2 }); renderPlayback({ positionMs: 7000, isPlaying: false, revision: 3 });');
  assert.deepEqual(api.calls, [['position', 4200], ['play'], ['position', 7000], ['pause']]);
  b.context.joined = { type: 'room:joined', room: { id: '1234567', isHost: false }, source: { kind: 'score', id: 'score-1', title: '曲谱', durationMs: 12000, tracks: [{ index: 0, name: '吉他' }], barCount: 4, tempo: 120 }, members: [], playback: { positionMs: 8300, isPlaying: false, revision: 4 } };
  b.run('handleSocketMessage({ data: JSON.stringify(joined) })');
  assert.deepEqual(api.calls.at(-1), ['position', 8300]);
  api.calls.length = 0;
  await b.document.emit('visibilitychange');
  assert.deepEqual(api.calls, [['position', 8300]]);
  assert.equal(b.sent.at(-1).type, 'playback:request-state');
});

test('切轨或切源后的旧 playerReady 不驱动新来源', () => {
  const attached = [];
  const b = browser('member', {
    attachSilentExternalMedia(api, durationMs) { attached.push([api, durationMs]); return true; },
    applyMemberScorePlayback,
  });
  b.run(`renderSource(${scoreSource});`);
  const oldApi = b.alphaTabApis.at(-1);
  b.run(`renderSource({ ...${scoreSource}, id: 'score-2' });`);
  const currentApi = b.alphaTabApis.at(-1);
  oldApi.playerReady.emit();
  assert.deepEqual(attached, []);
  currentApi.playerReady.emit();
  assert.deepEqual(attached, [[currentApi, 12000]]);
});

test('外部媒体能力缺失显示运行错误且不创建蓝线', () => {
  let attachCalls = 0; let applyCalls = 0;
  const b = browser('member', {
    attachSilentExternalMedia(api, durationMs) { attachCalls += 1; return attachSilentExternalMedia(api, durationMs); },
    applyMemberScorePlayback(api, playback, previousPlaying) { applyCalls += 1; return applyMemberScorePlayback(api, playback, previousPlaying); },
  });
  b.run(`renderSource(${videoSource}); renderPlayback({ positionMs: 1000, isPlaying: true, revision: 1 });`);
  assert.equal(attachCalls, 0); assert.equal(applyCalls, 0);
  b.run(`renderSource(${scoreSource});`);
  const api = b.alphaTabApis.at(-1); api.player.output = {};
  api.playerReady.emit();
  assert.equal(attachCalls, 1);
  assert.match(b.get('#runtime-errors-text').textContent, /MemberScoreSync.*updatePosition/);
  assert.equal(b.createdElements.some((node) => node.id === 'sync-cursor'), false);
});

test('视频主机 play 成功后才广播；失败保留服务器暂停', async () => {
  const b = browser(); b.run(`renderSource(${videoSource}); renderPlayback(${paused});`);
  let resolvePlay;
  b.video.play = () => new Promise((resolve) => { resolvePlay = resolve; });
  const clicked = b.get('#toggle-play').emit('click');
  assert.equal(b.sent.length, 0);
  assert.equal(typeof resolvePlay, 'function', '用户点击应直接启动视频 play()');
  resolvePlay(); await clicked;
  assert.equal(b.sent.at(-1).action, 'set-playing');
  assert.equal(b.sent.at(-1).isPlaying, true);
  const failed = browser(); failed.run(`renderSource(${videoSource}); renderPlayback(${paused});`);
  failed.video.play = () => Promise.reject(new Error('手势被拒绝'));
  await failed.get('#toggle-play').emit('click');
  assert.equal(failed.sent.length, 0);
  assert.equal(failed.run('latestPlayback.isPlaying'), false);
  assert.match(failed.get('#media-status').textContent, /播放|点击/);
});

test('结尾重播先归零服务端位置，再广播播放，且等待本地 play 成功', async () => {
  const b = browser();
  b.run(`renderSource({ ...${videoSource}, durationMs: 12000 }); renderPlayback({ positionMs: 12000, isPlaying: false, revision: 3 });`);
  let finish;
  b.video.play = () => { b.video.paused = false; return new Promise((resolve) => { finish = resolve; }); };
  const click = b.get('#toggle-play').emit('click');
  assert.equal(b.sent.length, 0);
  assert.equal(b.video.currentTime, 0, '在本地 play 开始前也应归零');
  finish(); await click;
  assert.deepEqual(b.sent, [
    { type: 'playback:control', hostToken: 'host-secret', action: 'seek', positionMs: 0 },
    { type: 'playback:control', hostToken: 'host-secret', action: 'set-playing', isPlaying: true },
  ]);
  b.run('renderPlayback({ positionMs: 0, isPlaying: false, revision: 4 }); renderPlayback({ positionMs: 0, isPlaying: true, revision: 5 });');
  assert.equal(b.run('hostVideoPlayIntent'), null);
  assert.equal(b.video.paused, false);
  assert.equal(b.video.currentTime, 0);
});

for (const pending of [true, false]) test(`同来源重连取消${pending ? '尚未完成' : '尚未确认'}的主机播放意图并应用权威暂停`, async () => {
  const b = browser(); b.run(`renderSource(${videoSource}); renderPlayback(${paused});`);
  let finish;
  b.video.play = () => { b.video.paused = false; return new Promise((resolve) => { finish = resolve; }); };
  const click = b.get('#toggle-play').emit('click');
  if (!pending) { finish(); await click; }
  b.sent.length = 0;
  b.context.joined = { type: 'room:joined', room: { id: '1234567', isHost: true }, source: { kind: 'video', id: 'take-1', durationMs: 12000 }, members: [], playback: { positionMs: 6000, isPlaying: false, revision: 4 } };
  b.run('handleSocketMessage({ data: JSON.stringify(joined) })');
  assert.equal(b.run('hostVideoPlayIntent'), null);
  assert.equal(b.video.paused, true);
  assert.equal(b.video.currentTime, 6);
  assert.equal(b.get('#toggle-play').textContent, '播放');
  finish(); await click;
  assert.equal(b.sent.length, 0, '重连前的异步结果不能重新广播播放');
});

test('乐手渲染和音量事件始终强制静音，且不能登记时长', async () => {
  const b = browser('member'); b.run(`renderSource(${videoSource});`);
  assert.equal(b.video.muted, true); assert.equal(b.video.defaultMuted, true); assert.equal(b.video.volume, 0);
  b.video.muted = false; b.video.defaultMuted = false; b.video.volume = 1;
  await b.video.emit('volumechange');
  assert.equal(b.video.muted, true); assert.equal(b.video.defaultMuted, true); assert.equal(b.video.volume, 0);
  await b.video.emit('loadedmetadata'); assert.equal(b.sent.length, 0);
  const host = browser(); host.run(`renderSource(${videoSource});`);
  assert.equal(host.video.muted, false); assert.equal(host.video.volume, 1);
  await host.video.emit('loadedmetadata');
  assert.deepEqual(host.sent.at(-1), { type: 'source:set-duration', hostToken: 'host-secret', sourceId: 'take-1', durationMs: 12000 });
});

test('上传使用原始文件和凭证，等待广播切源，失败与超限均恢复按钮', async () => {
  const b = browser(); const file = { name: '排练.mp4', type: 'video/mp4', size: 20 };
  b.context.file = file;
  let finish;
  b.context.fetch = (...args) => { b.requests.push(args); return new Promise((resolve) => { finish = resolve; }); };
  const pending = b.run('uploadSelectedVideo(file)');
  assert.equal(b.get('#load-video').disabled, true);
  assert.match(b.get('#media-status').textContent, /上传/);
  assert.equal(b.requests[0][0], '/api/rooms/1234567/video');
  assert.equal(b.requests[0][1].body, file);
  assert.equal(b.requests[0][1].headers.Authorization, 'Bearer host-secret');
  assert.equal(b.requests[0][1].headers['X-File-Name'], encodeURIComponent(file.name));
  assert.equal(b.requests[0][1].headers['Content-Type'], 'video/mp4');
  finish({ ok: true, json: async () => ({ source: { kind: 'video', id: 'uploaded' } }) }); await pending;
  assert.equal(b.run('source'), null); assert.equal(b.get('#load-video').disabled, false);
  b.context.fetch = async () => ({ ok: false, json: async () => ({ message: '视频格式不受支持' }) });
  await b.run('uploadSelectedVideo(file)');
  assert.match(b.get('#notice').textContent, /视频格式不受支持/); assert.equal(b.get('#load-video').disabled, false);
  b.context.fetch = () => { throw new Error('不应上传'); };
  await b.run('uploadSelectedVideo({ ...file, size: 2147483649 })');
  assert.match(b.get('#notice').textContent, /2 GiB/);
  await b.run('uploadSelectedVideo({ ...file, type: "video/quicktime" })');
  assert.match(b.get('#notice').textContent, /MP4|WebM/);
});

test('乐手自动播放失败后在交互重试最新状态，暂停和跳转应用同步决策', async () => {
  const b = browser('member'); b.run(`renderSource(${videoSource});`);
  let attempts = 0;
  b.video.play = () => { attempts += 1; return Promise.reject(new Error('autoplay blocked')); };
  b.run('renderPlayback({ positionMs: 4000, isPlaying: true, revision: 2 })');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1); assert.equal(b.video.currentTime, 4);
  b.video.play = () => { attempts += 1; b.video.paused = false; return Promise.resolve(); };
  await b.document.emit('pointerdown');
  assert.equal(attempts, 2); assert.equal(b.video.muted, true);
  b.run('renderPlayback({ positionMs: 6000, isPlaying: false, revision: 3 })');
  assert.equal(b.video.currentTime, 6); assert.equal(b.video.paused, true);
});

test('同一视频时长更新不重载，切源销毁曲谱或清空视频并复位同步状态', () => {
  const b = browser(); let destroyed = 0;
  b.context.api = { pause() {}, destroy() { destroyed += 1; } };
  b.run('alphaTabApi = api'); b.run(`renderSource(${videoSource});`);
  assert.equal(destroyed, 1);
  const url = b.video.src; b.video.currentTime = 7;
  b.run(`renderSource({ ...${videoSource}, durationMs: 12000 })`);
  assert.equal(b.video.src, url); assert.equal(b.video.currentTime, 7);
  b.run('renderSource(null)');
  assert.equal(b.video.paused, true); assert.equal(b.video.src, undefined);
  assert.equal(b.run('latestPlayback'), null);
  assert.equal(b.get('#video-player').classList.contains('hidden'), true);
});

test('视频结束只由主机暂停，缓冲和解码错误显示状态，全屏跟随当前来源', async () => {
  const b = browser(); b.run(`renderSource(${videoSource}); renderPlayback({ positionMs: 0, isPlaying: true, revision: 1 });`);
  await b.video.emit('waiting'); assert.match(b.get('#media-status').textContent, /缓冲/);
  await b.video.emit('playing'); assert.match(b.get('#media-status').textContent, /播放/);
  await b.video.emit('error'); assert.match(b.get('#media-status').textContent, /编码|损坏/);
  await b.video.emit('ended'); assert.equal(b.sent.at(-1).isPlaying, false);
  let target; b.video.requestFullscreen = async () => { target = 'video'; };
  await b.get('#fullscreen-score').emit('click'); assert.equal(target, 'video');
  const member = browser('member'); member.run(`renderSource(${videoSource});`);
  await member.video.emit('ended'); assert.equal(member.sent.length, 0);
});

test('视频结束事件不会从旧的播放状态重新启动视频', async () => {
  const b = browser('member'); b.run(`renderSource(${videoSource}); renderPlayback({ positionMs: 11000, isPlaying: true, revision: 1 });`);
  await new Promise((resolve) => setImmediate(resolve));
  let restarts = 0;
  b.video.play = () => { restarts += 1; return Promise.resolve(); };
  b.video.currentTime = 12; b.video.paused = true;
  await b.video.emit('ended');
  assert.equal(restarts, 0); assert.equal(b.video.paused, true);
});

test('同房重连更新视频时长并恢复最新位置，后台恢复按消息经过时间对齐', async () => {
  const b = browser('member'); b.run(`renderSource(${videoSource});`);
  b.context.joined = { type: 'room:joined', room: { id: '1234567', isHost: false }, source: { kind: 'video', id: 'take-1', durationMs: 12000 }, members: [], playback: { positionMs: 3000, isPlaying: true, revision: 4 } };
  b.run('handleSocketMessage({ data: JSON.stringify(joined) })');
  assert.equal(b.run('source.durationMs'), 12000); assert.equal(b.video.currentTime, 3);
  b.context.performance.now = () => 4000;
  b.video.currentTime = 0;
  await b.document.emit('visibilitychange');
  assert.equal(b.video.currentTime, 6); assert.equal(b.sent.at(-1).type, 'playback:request-state');
});

test('主机 play 等待期间切源时，旧完成结果不得广播播放', async () => {
  const b = browser(); b.run(`renderSource(${videoSource}); renderPlayback(${paused});`);
  let finish; b.video.play = () => new Promise((resolve) => { finish = resolve; });
  const click = b.get('#toggle-play').emit('click');
  b.run('renderSource(null)'); finish(); await click;
  assert.equal(b.sent.length, 0); assert.equal(b.video.paused, true);
});

test('视频切回曲谱后重新加载 AlphaTab、保留主机伴奏和谱面全屏', async () => {
  const b = browser(); let api;
  Object.assign(b.context.alphaTab, {
    LayoutMode: { Horizontal: 1 }, PlayerMode: { EnabledSynthesizer: 1 }, ScrollMode: { OffScreen: 1 },
    AlphaTabApi: class {
      constructor(element, settings) {
        api = this; this.settings = settings; this.isReadyForPlayback = true;
        for (const name of ['renderStarted', 'renderFinished', 'error', 'midiEventsPlayed', 'soundFontLoad', 'soundFontLoaded', 'soundFontLoadFailed', 'playerReady', 'playerStateChanged']) this[name] = { on: (listener) => { this[name].emit = listener; } };
      }
      load(bytes, tracks) { this.loaded = { bytes, tracks }; }
      play() { this.playerState = 1; return true; }
      pause() {}
      destroy() {}
    }, midi: { MidiEventType: { NoteOn: 1 } },
  });
  b.context.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  b.run(`renderSource(${videoSource}); renderSource({ kind: 'score', id: 'score-1', title: '曲谱', tracks: [{ index: 0, name: '吉他' }], barCount: 4, tempo: 120 });`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.settings.player.enablePlayer, true);
  assert.equal(api.settings.player.playerMode, b.context.alphaTab.PlayerMode.EnabledSynthesizer);
  assert.equal(api.loaded.bytes.byteLength, 8);
  assert.equal(b.get('#video-player').classList.contains('hidden'), true);
  assert.equal(b.get('#prepare-audio').classList.contains('hidden'), false);
  b.run(`renderPlayback(${paused});`); api.soundFontLoaded.emit();
  await b.get('#toggle-play').emit('click'); assert.equal(b.sent.at(-1).isPlaying, true);
  let fullscreen = false; b.get('#alpha-tab').requestFullscreen = async () => { fullscreen = true; };
  await b.get('#fullscreen-score').emit('click'); assert.equal(fullscreen, true);
});

test('适配器将小漂移转为倍速调整，大漂移跳转，并在 canplay 应用等待的状态', async () => {
  const b = browser('member'); b.run(`renderSource(${videoSource});`);
  b.video.paused = false; b.video.currentTime = 1;
  b.run('renderPlayback({ positionMs: 1500, isPlaying: true, revision: 2 })');
  assert.equal(b.video.currentTime, 1); assert.equal(b.video.playbackRate, 1.03);
  b.video.readyState = 0;
  b.run('renderPlayback({ positionMs: 9000, isPlaying: false, revision: 3 })');
  assert.equal(b.video.currentTime, 1);
  b.video.readyState = 4; await b.video.emit('canplay');
  assert.equal(b.video.currentTime, 9); assert.equal(b.video.paused, true);
});

test('来源清空时退出原生全屏且无来源时禁止播放', async () => {
  const b = browser(); b.run(`renderSource(${videoSource});`);
  let exited = false; b.document.fullscreenElement = b.video;
  b.document.exitFullscreen = async () => { exited = true; b.document.fullscreenElement = null; };
  b.run(`renderSource(null); renderPlayback(${paused});`);
  assert.equal(exited, true); assert.equal(b.get('#toggle-play').disabled, true);
});

test('空房初始化不显示曲谱伴奏准备按钮', () => {
  const b = browser();
  b.get('#prepare-audio').classList.remove('hidden');
  b.run(`renderSource(null); renderPlayback(${paused});`);
  assert.equal(b.get('#prepare-audio').classList.contains('hidden'), true);
  assert.equal(b.get('#toggle-play').disabled, true);
});

for (const trigger of ['canplay', '旧暂停状态']) test(`主机 play 待完成时${trigger}不能打断首次播放`, async () => {
  const b = browser(); b.run(`renderSource(${videoSource}); renderPlayback(${paused});`);
  let finish; let abort; let pauses = 0;
  b.video.play = () => { b.video.paused = false; return new Promise((resolve, reject) => { finish = resolve; abort = reject; }); };
  b.video.pause = () => { pauses += 1; b.video.paused = true; abort(new Error('The play() request was interrupted by a call to pause()')); };
  const click = b.get('#toggle-play').emit('click');
  if (trigger === 'canplay') await b.video.emit('canplay');
  else b.run(`renderPlayback(${paused})`);
  assert.equal(pauses, 0, '尚未完成的主机用户播放不能被旧暂停快照中断');
  assert.equal(b.sent.length, 0, 'play 完成之前仍不能广播');
  finish(); await click;
  assert.equal(b.sent.at(-1).isPlaying, true); assert.equal(b.video.paused, false);
  b.run(`renderPlayback(${paused})`);
  assert.equal(pauses, 0, '服务端确认播放前的旧暂停快照仍不能打断');
  b.run('renderPlayback({ positionMs: 0, isPlaying: true, revision: 2 }); renderPlayback({ positionMs: 0, isPlaying: false, revision: 3 });');
  assert.equal(pauses, 1, '确认播放后应恢复应用正常暂停状态');
});

test('主机 play 待完成时可显式暂停，并阻止旧 play 成功后广播', async () => {
  const b = browser(); b.run(`renderSource(${videoSource}); renderPlayback(${paused});`);
  let finish;
  b.video.play = () => { b.video.paused = false; return new Promise((resolve) => { finish = resolve; }); };
  const play = b.get('#toggle-play').emit('click');
  assert.equal(b.get('#toggle-play').disabled, false, '等待播放期间仍允许用户取消');
  assert.equal(b.get('#toggle-play').textContent, '暂停');
  await b.get('#toggle-play').emit('click');
  assert.equal(b.video.paused, true); assert.equal(b.sent.at(-1)?.isPlaying, false);
  finish(); await play;
  assert.equal(b.sent.some((event) => event.isPlaying === true), false);
  assert.equal(b.video.paused, true);
});

test('房间失效取消待完成的主机播放意图', async () => {
  const b = browser(); b.run(`renderSource(${videoSource}); renderPlayback(${paused});`);
  let finish;
  b.video.play = () => new Promise((resolve) => { finish = resolve; });
  const click = b.get('#toggle-play').emit('click');
  b.run('handleSocketMessage({ data: JSON.stringify({ type: "error", code: "ROOM_NOT_FOUND", message: "房间不存在" }) })');
  finish(); await click;
  assert.equal(b.sent.length, 0); assert.equal(b.video.paused, true);
  assert.equal(b.run('roomId'), null);
});
