import type { SatellitePickupData } from '../../shared-types';
import { logger } from '../utils/Logger';
import { getRunningAudioContext, registerSoundStopHook } from './audioRuntime';

interface OrbitVoice {
  id: string;
  tones: [OscillatorNode, OscillatorNode];
  overtoneGain: GainNode;
  gain: GainNode;
  pan: PannerNode;
  started: Set<OscillatorNode>;
  orbitCycle: number;
}
let voice: OrbitVoice | undefined;

/** One local chime voice, silent between passes; no per-frame source allocation. */
export function stopSatelliteOrbit(): void {
  if (!voice) {
    return;
  }
  for (const tone of voice.tones) {
    if (voice.started.has(tone)) {
      tone.stop();
    }
    tone.disconnect();
  }
  voice.overtoneGain.disconnect();
  voice.gain.disconnect();
  voice.pan.disconnect();
  voice = undefined;
}
registerSoundStopHook(stopSatelliteOrbit);

/** Snapshot angle is the authoritative orbit phase, not the ship heading. */
export function syncSatelliteOrbit(
  pickup: Pick<SatellitePickupData, 'id' | 'angle'> | undefined
): void {
  const ctx = getRunningAudioContext();
  if (!ctx || !pickup) {
    stopSatelliteOrbit();
    return;
  }
  try {
    if (voice?.id !== pickup.id) {
      stopSatelliteOrbit();
      const fundamental = ctx.createOscillator();
      const overtone = ctx.createOscillator();
      const overtoneGain = ctx.createGain();
      const gain = ctx.createGain();
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.rolloffFactor = 0;
      voice = {
        id: pickup.id,
        tones: [fundamental, overtone],
        overtoneGain,
        gain,
        pan,
        started: new Set(),
        orbitCycle: Math.floor(pickup.angle / (2 * Math.PI)),
      };
      fundamental.type = 'sine';
      overtone.type = 'sine';
      fundamental.frequency.value = 261.625565;
      overtone.frequency.value = 523.25113;
      overtoneGain.gain.value = 0.18;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      fundamental.connect(gain);
      overtone.connect(overtoneGain);
      overtoneGain.connect(gain);
      gain.connect(pan);
      pan.connect(ctx.destination);
      fundamental.start();
      voice.started.add(fundamental);
      overtone.start();
      voice.started.add(overtone);
    }
    if (!voice) {
      return;
    }
    // Chime once per revolution, with a rounded attack and a fully silent gap.
    // Joining or unmuting waits for the next pass; skipped cycles never queue.
    const orbitCycle = Math.floor(pickup.angle / (2 * Math.PI));
    if (orbitCycle > voice.orbitCycle) {
      const now = ctx.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(0, now);
      voice.gain.gain.linearRampToValueAtTime(0.006, now + 0.04);
      voice.gain.gain.exponentialRampToValueAtTime(0.00001, now + 0.55);
      voice.gain.gain.linearRampToValueAtTime(0, now + 0.65);
    }
    voice.orbitCycle = orbitCycle;
    // A gentle Doppler-like movement follows the satellite during the chime.
    const passing = Math.sin(pickup.angle);
    voice.pan.positionX.setTargetAtTime(Math.cos(pickup.angle), ctx.currentTime, 0.08);
    voice.pan.positionZ.setTargetAtTime(-Math.sin(pickup.angle), ctx.currentTime, 0.08);
    for (const tone of voice.tones) {
      tone.detune.setTargetAtTime(18 * passing, ctx.currentTime, 0.08);
    }
  } catch (error: unknown) {
    stopSatelliteOrbit();
    logger.error(
      'SOUND',
      'Satellite orbit playback failed',
      error instanceof Error ? error : new Error(String(error))
    );
  }
}
