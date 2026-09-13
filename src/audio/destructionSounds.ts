import type { Position } from '../../shared-types';
import { AUDIO } from '../constants';
import { Sound } from './Sound';
import { playWorldSound } from './spatialAudio';

const sounds = {
  asteroid: new Sound(...AUDIO.ASTEROID_EXPLODE),
  satellite: new Sound(...AUDIO.SATELLITE_EXPLODE),
  loot: new Sound(...AUDIO.LOOT_EXPLODE),
};

export function playDestructionSound(kind: keyof typeof sounds, position: Position): void {
  playWorldSound(sounds[kind], position, { requireViewport: true });
}
