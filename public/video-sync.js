export const VIDEO_SYNC = Object.freeze({
  PAUSED_SEEK_MS: 150,
  RATE_ADJUST_MS: 250,
  HARD_SEEK_MS: 1000,
  MIN_PLAYBACK_RATE: 0.97,
  MAX_PLAYBACK_RATE: 1.03,
});

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function targetVideoPositionMs(playback, elapsedSinceMessageMs) {
  const positionMs = finiteNonNegative(playback?.positionMs);
  const elapsedMs = finiteNonNegative(elapsedSinceMessageMs);
  return finiteNonNegative(positionMs + (playback?.isPlaying ? elapsedMs : 0));
}

export function decideVideoSync({ isHost, isPlaying, targetMs, currentMs, paused, readyState, playbackRate }) {
  const target = finiteNonNegative(targetMs);
  const current = finiteNonNegative(currentMs);
  const rate = finiteNonNegative(playbackRate);
  const drift = target - current;
  const absDrift = Math.abs(drift);
  const ready = finiteNonNegative(readyState);
  let seekToMs = null;
  let nextRate = rate || 1;

  if (!isPlaying) {
    if (absDrift > VIDEO_SYNC.PAUSED_SEEK_MS) seekToMs = target;
    return { shouldPause: !paused, shouldPlay: false, seekToMs, playbackRate: nextRate };
  }

  if (isHost) {
    nextRate = 1;
    if (absDrift > VIDEO_SYNC.RATE_ADJUST_MS) seekToMs = target;
  } else if (absDrift > VIDEO_SYNC.HARD_SEEK_MS) {
    seekToMs = target;
    nextRate = 1;
  } else if (absDrift >= VIDEO_SYNC.RATE_ADJUST_MS) {
    nextRate = Math.min(VIDEO_SYNC.MAX_PLAYBACK_RATE, Math.max(VIDEO_SYNC.MIN_PLAYBACK_RATE, 1 + drift / 10000));
  } else {
    nextRate = 1;
  }

  return {
    shouldPause: false,
    shouldPlay: Boolean(paused && ready >= 2),
    seekToMs,
    playbackRate: nextRate,
  };
}
