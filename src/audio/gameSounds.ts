import type { Position } from '../../shared-types';
import { AUDIO } from '../constants';
import { soundIsOn } from '../constants/user-preferences';
import { playSound, Sound } from './Sound';
import { planBoundPlayback, playWorldSound, registerAudioResetHook } from './spatialAudio';

interface ThrustSource {
  id: string;
  thrusting: boolean;
  position: Position;
}

const fxLaser = new Sound(AUDIO.LASER_PATH, AUDIO.LASER_MAX_STREAMS, AUDIO.LASER_VOLUME);
const fxHit = new Sound(AUDIO.HIT_PATH, AUDIO.HIT_MAX_STREAMS, AUDIO.HIT_VOLUME);
const fxThrust = new Sound(AUDIO.THRUST_PATH, AUDIO.THRUST_MAX_STREAMS, AUDIO.THRUST_VOLUME, {
  loop: true,
});

const thrustSources = new Map<string, ThrustSource>();

export function getLaserSound(): Sound {
  return fxLaser;
}

export function getHitSound(): Sound {
  return fxHit;
}

export function getThrustSound(): Sound {
  return fxThrust;
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

export function upsertThrustSource(source: ThrustSource): void {
  thrustSources.set(source.id, source);
  applyThrustPlayback();
}

export function replaceThrustSources(sources: readonly ThrustSource[]): void {
  thrustSources.clear();
  for (const source of sources) {
    thrustSources.set(source.id, source);
  }
  applyThrustPlayback();
}

export function resetThrustSources(): void {
  thrustSources.clear();
  fxThrust.stop();
}

const thrustSourceScratch: ThrustSource[] = [];
const thrustSeenIds = new Set<string>();

export function thrustSourcesFromPlayers(
  players: readonly {
    id: string;
    ship: { thrusting: boolean; exploding: boolean; position: Position };
  }[]
): ThrustSource[] {
  thrustSeenIds.clear();
  let count = 0;
  for (const player of players) {
    if (thrustSeenIds.has(player.id)) {
      continue;
    }
    thrustSeenIds.add(player.id);
    const thrusting = player.ship.thrusting && !player.ship.exploding;
    const existing = thrustSourceScratch[count];
    if (existing) {
      existing.id = player.id;
      existing.thrusting = thrusting;
      existing.position = player.ship.position;
    } else {
      thrustSourceScratch[count] = {
        id: player.id,
        thrusting,
        position: player.ship.position,
      };
    }
    count += 1;
  }
  thrustSourceScratch.length = count;
  return thrustSourceScratch;
}

function applyThrustPlayback(): void {
  let bestScale = 0;
  for (const source of thrustSources.values()) {
    if (!source.thrusting) {
      continue;
    }
    const plan = planBoundPlayback(source.position);
    if (plan.shouldPlay) {
      bestScale = Math.max(bestScale, plan.volumeScale);
    }
  }

  if (!soundIsOn() || bestScale <= 0) {
    fxThrust.stop();
    return;
  }

  if (fxThrust.isPlaying()) {
    fxThrust.setVolumeScale(bestScale);
    return;
  }
  playSound(fxThrust, bestScale);
}

registerAudioResetHook(resetThrustSources);
