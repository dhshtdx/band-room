import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_SYNC, targetVideoPositionMs, decideVideoSync } from '../public/video-sync.js';

test('advances only a playing server position by elapsed message age', () => {
  assert.equal(targetVideoPositionMs({ positionMs: 1200, isPlaying: true }, 350), 1550);
  assert.equal(targetVideoPositionMs({ positionMs: 1200, isPlaying: false }, 350), 1200);
  assert.equal(targetVideoPositionMs({ positionMs: -8, isPlaying: true }, -5), 0);
  assert.ok(Number.isFinite(targetVideoPositionMs({ positionMs: Infinity, isPlaying: true }, NaN)));
});

test('pauses a playing element and can also correct a large paused drift', () => {
  assert.deepEqual(decideVideoSync({ isHost: false, isPlaying: false, targetMs: 1000, currentMs: 1200, paused: false, readyState: 4, playbackRate: 1 }), {
    shouldPause: true, shouldPlay: false, seekToMs: 1000, playbackRate: 1,
  });
  assert.equal(decideVideoSync({ isHost: false, isPlaying: false, targetMs: 1000, currentMs: 900, paused: true, readyState: 4, playbackRate: 1 }).seekToMs, null);
  assert.deepEqual(VIDEO_SYNC, { PAUSED_SEEK_MS: 150, RATE_ADJUST_MS: 250, HARD_SEEK_MS: 1000, MIN_PLAYBACK_RATE: 0.97, MAX_PLAYBACK_RATE: 1.03 });
});

test('plays when ready and adjusts member rate in the direction that closes drift', () => {
  const decide = (targetMs, currentMs, playbackRate = 1, isHost = false) => decideVideoSync({ isHost, isPlaying: true, targetMs, currentMs, paused: true, readyState: 4, playbackRate });
  assert.equal(decide(1000, 900).shouldPlay, true);
  assert.equal(decide(1000, 900).seekToMs, null);
  assert.equal(decide(1000, 900).playbackRate, 1);
  assert.ok(decide(1000, 600).playbackRate > 1);
  assert.ok(decide(600, 1000).playbackRate < 1);
  assert.ok(decide(1000, 0).playbackRate <= VIDEO_SYNC.MAX_PLAYBACK_RATE);
  assert.ok(decide(0, 1000).playbackRate >= VIDEO_SYNC.MIN_PLAYBACK_RATE);
  assert.ok(decide(1101, 0).seekToMs !== null);
  assert.ok(decide(1000, 700, 1, true).seekToMs !== null);
  assert.equal(decide(1000, 900, 1.02).playbackRate, 1);
});

test('does not repeatedly request playback while media is not ready', () => {
  const decision = decideVideoSync({ isHost: false, isPlaying: true, targetMs: 1000, currentMs: 1000, paused: true, readyState: 1, playbackRate: 1 });
  assert.equal(decision.shouldPlay, false);
});

test('paused correction starts above 150ms in both drift directions', () => {
  for (const direction of [-1, 1]) for (const [drift, seeks] of [[150, false], [151, true]]) {
    const result = decideVideoSync({ isHost: false, isPlaying: false, targetMs: 2000 + direction * drift, currentMs: 2000, paused: true, readyState: 4, playbackRate: 1 });
    assert.equal(result.seekToMs, seeks ? 2000 + direction * drift : null, `paused drift ${direction * drift}ms`);
  }
});

test('member rate adjustment begins at 250ms and hard seek above 1000ms', () => {
  for (const direction of [-1, 1]) for (const [drift, seeks, rate] of [[249, false, 1], [250, false, direction < 0 ? 0.975 : 1.025], [251, false, direction < 0 ? 0.9749 : 1.0251], [1000, false, direction < 0 ? 0.97 : 1.03], [1001, true, 1]]) {
    const result = decideVideoSync({ isHost: false, isPlaying: true, targetMs: 2000 + direction * drift, currentMs: 2000, paused: false, readyState: 4, playbackRate: 1.02 });
    assert.equal(result.seekToMs, seeks ? 2000 + direction * drift : null, `member drift ${direction * drift}ms`);
    assert.equal(result.playbackRate, rate, `member drift ${direction * drift}ms`);
  }
});

test('host seeks only above 250ms and always restores normal rate', () => {
  for (const direction of [-1, 1]) for (const [drift, seeks] of [[249, false], [250, false], [251, true], [1000, true], [1001, true]]) {
    const result = decideVideoSync({ isHost: true, isPlaying: true, targetMs: 2000 + direction * drift, currentMs: 2000, paused: false, readyState: 4, playbackRate: 1.02 });
    assert.equal(result.seekToMs, seeks ? 2000 + direction * drift : null, `host drift ${direction * drift}ms`);
    assert.equal(result.playbackRate, 1);
  }
});
