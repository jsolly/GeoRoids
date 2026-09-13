import { AUDIO } from '../constants';

/** One pitch per trigger, shared by all layers of a cue. */
export function randomPlaybackRate(): number {
  return (
    AUDIO.MIN_PLAYBACK_RATE + Math.random() * (AUDIO.MAX_PLAYBACK_RATE - AUDIO.MIN_PLAYBACK_RATE)
  );
}
