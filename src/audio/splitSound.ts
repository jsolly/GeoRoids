import type { Position } from '../../shared-types';
import { soundIsOn } from '../constants/user-preferences';
import { getRunningAudioContext, registerSoundStopHook } from './audioRuntime';
import { playExplosionSound } from './explosionSound';
import { randomPlaybackRate } from './pitch';
import { planBoundPlayback } from './spatialAudio';

const MAX_SPLIT_VOICES = 4;
const activeSources = new Map<GainNode, { sources: AudioScheduledSourceNode[]; pan: PannerNode }>();
registerSoundStopHook(() => {
  for (const [master, { sources, pan }] of activeSources) {
    for (const source of sources) {
      source.stop();
    }
    master.disconnect();
    pan.disconnect();
  }
  activeSources.clear();
});

function startTone(
  ctx: BaseAudioContext,
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
 * Rounded low impact and a soft crystal tail. Layered on the existing explosion
 * so the collab break still reads as an impact.
 */
export function synthesizeSplitCrack(
  volumeScale: number,
  ctx: BaseAudioContext | null = getRunningAudioContext(),
  offset?: Position
): boolean {
  if (!ctx || !(volumeScale > 0) || activeSources.size >= MAX_SPLIT_VOICES) {
    return false;
  }

  const now = ctx.currentTime;
  const pitch = randomPlaybackRate();
  const master = ctx.createGain();
  master.gain.value = 0.075 * volumeScale;
  const pan = ctx.createPanner();
  pan.panningModel = 'HRTF';
  pan.rolloffFactor = 0;
  pan.positionX.value = offset ? offset.x / 100 : 0;
  pan.positionZ.value = offset ? offset.y / 100 : -1;
  master.connect(pan);
  pan.connect(ctx.destination);

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
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 500;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.12, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + noiseDuration);
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(master);
  noise.start(now);

  const crack = startTone(ctx, master, {
    type: 'sine',
    startHz: 196,
    endHz: 130.8128,
    start: now,
    duration: 0.16,
    peak: 0.3,
  });
  const tail = startTone(ctx, master, {
    type: 'sine',
    startHz: 130.8128,
    endHz: 65.4064,
    start: now + 0.07,
    duration: 0.28,
    peak: 0.45,
  });

  activeSources.set(master, { sources: [noise, crack, tail], pan });

  tail.addEventListener(
    'ended',
    () => {
      master.disconnect();
      pan.disconnect();
      activeSources.delete(master);
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
  synthesizeSplitCrack(plan.volumeScale, getRunningAudioContext(), plan.offset);
}
