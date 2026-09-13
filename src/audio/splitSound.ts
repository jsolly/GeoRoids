import type { Position } from '../../shared-types';
import { soundIsOn } from '../constants/user-preferences';
import { playExplosionSound } from './explosionSound';
import { randomPlaybackRate } from './pitch';
import { registerSoundStopHook } from './Sound';
import { planBoundPlayback } from './spatialAudio';

type WebAudioWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

let sharedContext: AudioContext | null = null;
const activeMasters = new Set<GainNode>();
registerSoundStopHook(() => {
  for (const master of activeMasters) {
    master.disconnect();
  }
  activeMasters.clear();
});

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const view = window as WebAudioWindow;
  const Ctor = view.AudioContext ?? view.webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  if (!sharedContext) {
    sharedContext = new Ctor();
  }
  return sharedContext;
}

function startTone(
  ctx: AudioContext,
  destination: GainNode,
  options: {
    type: OscillatorType;
    startHz: number;
    endHz: number;
    start: number;
    duration: number;
    peak: number;
  }
): OscillatorNode {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = options.type;
  osc.frequency.setValueAtTime(options.startHz, options.start);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(40, options.endHz),
    options.start + options.duration
  );
  gain.gain.setValueAtTime(0.0001, options.start);
  gain.gain.exponentialRampToValueAtTime(options.peak, options.start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, options.start + options.duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(options.start);
  osc.stop(options.start + options.duration + 0.02);
  return osc;
}

/**
 * Phosphor crack + descending split whoosh. Layered on the existing explosion
 * so the collab break still reads as an impact.
 */
export function synthesizeSplitCrack(volumeScale: number, ctx = getAudioContext()): boolean {
  if (!ctx || !(volumeScale > 0)) {
    return false;
  }

  const now = ctx.currentTime;
  const pitch = randomPlaybackRate();
  const master = ctx.createGain();
  master.gain.value = 0.22 * volumeScale;
  master.connect(ctx.destination);
  activeMasters.add(master);

  const noiseDuration = 0.055;
  const noiseBuffer = ctx.createBuffer(
    1,
    Math.floor(ctx.sampleRate * noiseDuration),
    ctx.sampleRate
  );
  const channel = noiseBuffer.getChannelData(0);
  for (let i = 0; i < channel.length; i++) {
    channel[i] = (Math.random() * 2 - 1) * (1 - i / channel.length);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.playbackRate.value = pitch;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'highpass';
  noiseFilter.frequency.value = 1400;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.9, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + noiseDuration);
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(master);
  noise.start(now);

  startTone(ctx, master, {
    type: 'sawtooth',
    startHz: 880 * pitch,
    endHz: 220 * pitch,
    start: now,
    duration: 0.16,
    peak: 0.35,
  });
  const tail = startTone(ctx, master, {
    type: 'sine',
    startHz: 180 * pitch,
    endHz: 70 * pitch,
    start: now + 0.07,
    duration: 0.28,
    peak: 0.55,
  });

  tail.addEventListener(
    'ended',
    () => {
      master.disconnect();
      activeMasters.delete(master);
    },
    { once: true }
  );
  return true;
}

export function playSplitSound(position?: Position): void {
  const plan = planBoundPlayback(position, { requireViewport: true });
  if (!plan.shouldPlay || !soundIsOn()) {
    return;
  }
  playExplosionSound(position);
  synthesizeSplitCrack(plan.volumeScale);
}
