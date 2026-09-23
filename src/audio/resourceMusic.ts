import type { Position } from '../../shared-types';
import { AUDIO } from '../constants';
import { soundIsOn } from '../constants/user-preferences';
import { logger } from '../utils/Logger';
import { registerSoundStopHook } from './audioRuntime';
import { Sound } from './Sound';
import { planBoundPlayback } from './spatialAudio';

// C-major pentatonic: composed three-note answers, all compatible with the
// lower extraction ostinato. A shared clock keeps both parts in one phrase.
const PICKUP_NOTES = [4, 7, 12, 2, 4, 9, 7, 9, 16, 7, 4, 12];
const EXTRACTION_NOTES = [0, 7, 4, 12];
const PHRASE_GAP_MS = 1400;
const extraction = new Sound(...AUDIO.TAP_EJECT);
const pickup = new Sound(...AUDIO.LOOT_PICKUP);
let lastNoteAt = Number.NEGATIVE_INFINITY;
let pickupStep = 0;
let extractionStep = 0;

/** New flights, reconnects, mute and hidden tabs must not retain a half-phrase. */
export function resetResourceMusic(): void {
  lastNoteAt = Number.NEGATIVE_INFINITY;
  pickupStep = 0;
  extractionStep = 0;
  extraction.stop();
  pickup.stop();
}
registerSoundStopHook(resetResourceMusic);

function playResourceNote(part: 'extraction' | 'pickup', sound: Sound, position?: Position): void {
  if (!soundIsOn()) {
    return;
  }
  const plan = planBoundPlayback(position, { requireViewport: true });
  if (!plan.shouldPlay) {
    return;
  }
  const now = performance.now();
  if (now - lastNoteAt > PHRASE_GAP_MS) {
    pickupStep = 0;
    extractionStep = 0;
  }
  const semitones =
    part === 'extraction'
      ? (EXTRACTION_NOTES[extractionStep] ?? 0)
      : (PICKUP_NOTES[pickupStep] ?? 4);
  try {
    if (!sound.playNote(plan.volumeScale, semitones, plan.offset)) {
      return;
    }
    lastNoteAt = now;
    if (part === 'extraction') {
      extractionStep = (extractionStep + 1) % EXTRACTION_NOTES.length;
    } else {
      pickupStep = (pickupStep + 1) % PICKUP_NOTES.length;
    }
  } catch (error: unknown) {
    logger.error(
      'SOUND',
      'Resource note playback failed',
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

export function playTapEjection(position: Position): void {
  playResourceNote('extraction', extraction, position);
}

export function playLootPickup(position?: Position): void {
  playResourceNote('pickup', pickup, position);
}
