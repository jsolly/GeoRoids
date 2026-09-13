import type { LootKind, Position } from '../../shared-types';
import { AUDIO } from '../constants';
import type { ShipAbilityId } from '../entities/ship/shipKits';
import { Sound } from './Sound';
import { playWorldSound } from './spatialAudio';

/**
 * One-shot cues for meaningful world interactions. The event handlers that
 * call these functions are responsible for deduplicating network events;
 * this module only applies the shared mute, viewport, and distance rules.
 */

const fxHarpoonLaunch = new Sound(...AUDIO.HARPOON_LAUNCH);
const fxHarpoonLatch = new Sound(...AUDIO.HARPOON_LATCH);
const fxHarpoonRelease = new Sound(...AUDIO.HARPOON_RELEASE);
const fxOrbitalFire = new Sound(...AUDIO.ORBITAL_FIRE);
const fxOrbitalPickup = new Sound(...AUDIO.ORBITAL_PICKUP);
const fxLootPickup = new Sound(...AUDIO.LOOT_PICKUP);
const fxFuelPickup = new Sound(...AUDIO.FUEL_PICKUP);
const fxCorePickup = new Sound(...AUDIO.CORE_PICKUP);
const fxAbilityBoost = new Sound(...AUDIO.ABILITY_BOOST);
const fxAbilityShield = new Sound(...AUDIO.ABILITY_SHIELD);
const fxAbilityRing = new Sound(...AUDIO.ABILITY_RING);
const fxAbilityPulse = new Sound(...AUDIO.ABILITY_PULSE);
const fxRespawn = new Sound(...AUDIO.RESPAWN);

type NonHarpoonAbilityId = Exclude<ShipAbilityId, 'harpoon'>;

const abilitySounds: Record<NonHarpoonAbilityId, Sound> = {
  boostDash: fxAbilityBoost,
  shieldFocus: fxAbilityShield,
  ringFire: fxAbilityRing,
  shockPulse: fxAbilityPulse,
};

function playInteraction(sound: Sound, position?: Position): void {
  playWorldSound(sound, position, { requireViewport: true });
}

export function playHarpoonLaunch(position?: Position): void {
  playInteraction(fxHarpoonLaunch, position);
}

export function playHarpoonLatch(position?: Position): void {
  playInteraction(fxHarpoonLatch, position);
}

export function playHarpoonRelease(position?: Position): void {
  playInteraction(fxHarpoonRelease, position);
}

/** Play the regular Q shield activation cue. */
export function playShieldActivation(position?: Position): void {
  playInteraction(fxAbilityShield, position);
}

export function playOrbitalFire(position?: Position): void {
  playInteraction(fxOrbitalFire, position);
}

export function playOrbitalPickup(position?: Position): void {
  playInteraction(fxOrbitalPickup, position);
}

export function playLootPickup(kind: LootKind, position?: Position): void {
  switch (kind) {
    case 'fuel':
      playInteraction(fxFuelPickup, position);
      return;
    case 'laserCore':
      playInteraction(fxCorePickup, position);
      return;
    case 'shard':
    case 'wreckage':
      playInteraction(fxLootPickup, position);
      return;
  }
}

export function playRespawn(position?: Position): void {
  playInteraction(fxRespawn, position);
}

/** Play the kit-specific E ability cue once the server accepts the ability. */
export function playAbilityActivation(abilityId: ShipAbilityId, position?: Position): void {
  if (abilityId === 'harpoon') {
    playHarpoonLaunch(position);
    return;
  }
  playInteraction(abilitySounds[abilityId], position);
}
