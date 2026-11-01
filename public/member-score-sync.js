export class MemberScoreSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemberScoreSyncError';
  }
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function requirePositionOutput(player) {
  if (typeof player.output?.updatePosition !== 'function') {
    throw new MemberScoreSyncError('Member score sync requires player.output.updatePosition(ms)');
  }
  return player.output;
}

function mute(api) {
  api.masterVolume = 0;
  api.player.masterVolume = 0;
}

export function attachSilentExternalMedia(api, durationMs) {
  if (!api?.player) return false;
  requirePositionOutput(api.player);
  mute(api);
  api.player.handler = {
    backingTrackDuration: finiteNonNegative(durationMs),
    playbackRate: 1,
    get masterVolume() { return 0; },
    set masterVolume(value) {},
    play() {},
    pause() {},
    seekTo(positionMs) {},
  };
  return true;
}

export function applyMemberScorePlayback(api, playback, previousPlaying) {
  if (!api?.player || !api.isReadyForPlayback) {
    return { applied: false, isPlaying: previousPlaying };
  }
  const output = requirePositionOutput(api.player);
  mute(api);
  output.updatePosition(finiteNonNegative(playback?.positionMs));
  const isPlaying = Boolean(playback?.isPlaying);
  if (isPlaying !== previousPlaying) {
    if (isPlaying) api.play();
    else api.pause();
  }
  return { applied: true, isPlaying };
}
