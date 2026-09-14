import type { Position } from '../../shared-types';
import { AUDIO } from '../constants';
import { Sound } from './Sound';
import { playWorldSound } from './spatialAudio';

const fxLaser = new Sound(AUDIO.LASER_PATH, AUDIO.LASER_MAX_STREAMS, AUDIO.LASER_VOLUME);
const fxHit = new Sound(AUDIO.HIT_PATH, AUDIO.HIT_MAX_STREAMS, AUDIO.HIT_VOLUME);
export function getLaserSound(): Sound {
  return fxLaser;
}

export function getHitSound(): Sound {
  return fxHit;
}

/**
 * Shared laser SFX for local, remote, and bot shots. Viewport-culled and
 * distance-attenuated from the local ship. Omit position for local / full volume.
 */
export function playLaserSound(position?: Position): void {
  playWorldSound(fxLaser, position, { requireViewport: true });
}

/**
 * Shared hit SFX for laser impacts (player and bot ships, asteroids).
 */
export function playHitSound(position?: Position): void {
  playWorldSound(fxHit, position, { requireViewport: true });
}
