import { GAME, SHIP } from '../../src/constants';

/** Health restored by one authoritative or predicted 60 Hz frame. */
export function calculateHealthRegenPerFrame(): number {
  return SHIP.HEALTH_REGEN_RATE / GAME.FPS;
}

/** Frames to wait after real damage before healing. */
export function calculateHealthRegenDelayFrames(): number {
  return Math.ceil(SHIP.HEALTH_REGEN_DELAY * GAME.FPS);
}
