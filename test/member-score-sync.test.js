import test from 'node:test';
import assert from 'node:assert/strict';
import * as sync from '../public/member-score-sync.js';

function createApi() {
  const calls = [];
  const api = {
    masterVolume: 1,
    isReadyForPlayback: true,
    player: {
      masterVolume: 1,
      handler: null,
      output: { updatePosition(ms) { calls.push(['position', ms, api.masterVolume, api.player.masterVolume]); } },
    },
    play() { calls.push(['play']); },
    pause() { calls.push(['pause']); },
  };
  return { api, calls };
}

test('安装外部媒体 handler 时始终静音且不控制真实媒体', () => {
  const { api, calls } = createApi();
  assert.equal(sync.attachSilentExternalMedia(api, 12000), true);
  const handler = api.player.handler;
  assert.equal(handler.backingTrackDuration, 12000);
  assert.equal(handler.masterVolume, 0);
  handler.masterVolume = 0.8;
  assert.equal(handler.masterVolume, 0);
  assert.equal(handler.playbackRate, 1);
  handler.playbackRate = 1.25;
  assert.equal(handler.playbackRate, 1.25);
  handler.play();
  handler.pause();
  handler.seekTo(4200);
  assert.deepEqual(calls, []);
  assert.equal(api.masterVolume, 0);
  assert.equal(api.player.masterVolume, 0);
});

test('player 未 ready 时保留 previousPlaying 且不更新位置', () => {
  const { api, calls } = createApi();
  api.isReadyForPlayback = false;
  for (const previous of [null, false, true]) {
    assert.deepEqual(sync.applyMemberScorePlayback(api, { positionMs: 4200, isPlaying: true }, previous), {
      applied: false, isPlaying: previous,
    });
  }
  assert.deepEqual(calls, []);
  api.isReadyForPlayback = true;
  api.player = null;
  assert.deepEqual(sync.applyMemberScorePlayback(api, { positionMs: 4200, isPlaying: true }, null), {
    applied: false, isPlaying: null,
  });
  assert.deepEqual(calls, []);
});

test('首次播放更新位置并调用一次 play，重复播放快照只更新位置', () => {
  const { api, calls } = createApi();
  const first = sync.applyMemberScorePlayback(api, { positionMs: 4200, isPlaying: true }, null);
  assert.deepEqual(first, { applied: true, isPlaying: true });
  api.masterVolume = 0.9;
  api.player.masterVolume = 0.8;
  assert.deepEqual(sync.applyMemberScorePlayback(api, { positionMs: 5100, isPlaying: true }, first.isPlaying), {
    applied: true, isPlaying: true,
  });
  assert.deepEqual(calls, [['position', 4200, 0, 0], ['play'], ['position', 5100, 0, 0]]);
});

test('暂停边沿调用一次 pause，暂停跳转仍更新位置', () => {
  const { api, calls } = createApi();
  const paused = sync.applyMemberScorePlayback(api, { positionMs: 5100, isPlaying: false }, true);
  assert.deepEqual(paused, { applied: true, isPlaying: false });
  assert.deepEqual(sync.applyMemberScorePlayback(api, { positionMs: 7000, isPlaying: false }, paused.isPlaying), {
    applied: true, isPlaying: false,
  });
  assert.deepEqual(calls, [['position', 5100, 0, 0], ['pause'], ['position', 7000, 0, 0]]);
});

test('缺少 updatePosition 时抛出可诊断错误', () => {
  for (const output of [{}, { updatePosition: 1 }, null]) {
    const { api, calls } = createApi();
    api.player.output = output;
    assert.throws(() => sync.applyMemberScorePlayback(api, { positionMs: 4200, isPlaying: true }, null), (error) => {
      assert.ok(error instanceof sync.MemberScoreSyncError);
      assert.equal(error.name, 'MemberScoreSyncError');
      assert.match(error.message, /player\.output\.updatePosition/);
      return true;
    });
    assert.deepEqual(calls, []);
  }
});

test('非法位置归零且初始暂停与恢复播放均应用状态边沿', () => {
  const { api, calls } = createApi();
  let previous = null;
  for (const positionMs of [-1, Infinity, NaN, undefined, 'invalid']) {
    const result = sync.applyMemberScorePlayback(api, { positionMs, isPlaying: false }, previous);
    assert.deepEqual(result, { applied: true, isPlaying: false });
    previous = result.isPlaying;
  }
  assert.deepEqual(calls, [
    ['position', 0, 0, 0], ['pause'], ['position', 0, 0, 0],
    ['position', 0, 0, 0], ['position', 0, 0, 0], ['position', 0, 0, 0],
  ]);
  calls.length = 0;
  assert.deepEqual(sync.applyMemberScorePlayback(api, { positionMs: 7000, isPlaying: true }, previous), {
    applied: true, isPlaying: true,
  });
  assert.deepEqual(calls, [['position', 7000, 0, 0], ['play']]);
});

test('安装时等待 player 建立、拒绝缺失能力并归一化时长', () => {
  assert.equal(sync.attachSilentExternalMedia({ player: null }, 12000), false);
  for (const duration of [-1, Infinity, NaN, undefined, 'invalid']) {
    const { api } = createApi();
    assert.equal(sync.attachSilentExternalMedia(api, duration), true);
    assert.equal(api.player.handler.backingTrackDuration, 0);
  }
  const { api } = createApi();
  api.player.output = {};
  assert.throws(() => sync.attachSilentExternalMedia(api, 12000), sync.MemberScoreSyncError);
});
