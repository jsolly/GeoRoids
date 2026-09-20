import type { Position } from '../../shared-types';
import { Sound } from './Sound';
import { playWorldSound } from './spatialAudio';

// Sparse acknowledgements. No loops or periodic alarm; continuous flight stays quiet.
const feedback = {
  connectionLost: new Sound('/sounds/connection-lost.m4a', 1, 0.055),
  boostStart: new Sound('/sounds/boost-start.m4a', 2, 0.04),
  boostEnd: new Sound('/sounds/boost-end.m4a', 2, 0.035),
  boostIgnite: new Sound('/sounds/boost-ignite.m4a', 3, 0.05),
  hullDamage: new Sound('/sounds/hull-damage.m4a', 2, 0.065),
  delivery: new Sound('/sounds/delivery.m4a', 2, 0.075),
  gameOver: new Sound('/sounds/game-over.m4a', 1, 0.07),
  interface: new Sound('/sounds/interface.m4a', 2, 0.025),
  satelliteEquip: new Sound('/sounds/satellite-equip.m4a', 2, 0.05),
};

export function playFeedback(cue: keyof typeof feedback, position?: Position): void {
  playWorldSound(feedback[cue], position, { requireViewport: true });
}
