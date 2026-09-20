import { getRunningAudioContext, registerSoundStopHook } from './audioRuntime';
import { clearMusicThreat, pushMusicThreat } from './musicThreat';

export type SpiderDanger = 'quiet' | 'nearby' | 'hunted';
const MAX_VOICES = 8;
let previous: SpiderDanger = 'quiet';
let ownsMusicThreat = false;
let nextBeat = 0;
let beat = 0;
const voices = new Map<OscillatorNode, GainNode>();

function silence(): void {
  for (const [oscillator, gain] of voices) {
    oscillator.stop();
    oscillator.disconnect();
    gain.disconnect();
  }
  voices.clear();
  previous = 'quiet';
  nextBeat = 0;
  beat = 0;
}
registerSoundStopHook(silence);

function syncThreat(hunted: boolean): void {
  if (hunted === ownsMusicThreat) {
    return;
  }
  ownsMusicThreat = hunted;
  if (hunted) {
    pushMusicThreat();
  } else {
    clearMusicThreat();
  }
}

/** Release this hazard even when disconnecting stops the renderer. */
export function resetSpiderScore(): void {
  syncThreat(false);
  silence();
}

window.addEventListener('playViewOff', () => {
  // Music beds reset the complete count on this event; discard our old ownership.
  ownsMusicThreat = false;
  silence();
});

function tone(
  context: AudioContext,
  frequency: number,
  end: number,
  duration: number,
  volume: number
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(end, now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  voices.set(oscillator, gain);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
    voices.delete(oscillator);
  };
  oscillator.start();
  oscillator.stop(now + duration + 0.01);
}

/** A sparse ominous motif turns into a rapid dissonant pulse on being hunted. */
export function updateSpiderScore(danger: SpiderDanger): void {
  syncThreat(danger === 'hunted');
  const context = getRunningAudioContext();
  if (!context || danger === 'quiet') {
    if (previous !== 'quiet' || voices.size > 0) {
      silence();
    }
    return;
  }
  if (danger === 'hunted' && previous !== 'hunted' && voices.size < MAX_VOICES) {
    tone(context, 330, 55, 0.65, 0.12);
    nextBeat = 0;
  }
  previous = danger;
  if (context.currentTime < nextBeat || voices.size >= MAX_VOICES) {
    return;
  }
  const hunted = danger === 'hunted';
  const notes = hunted ? [73.42, 77.78, 110, 77.78] : [73.42, 110, 77.78, 110];
  const frequency = notes[beat % notes.length] ?? 73.42;
  tone(context, frequency, frequency * 0.99, hunted ? 0.22 : 0.7, hunted ? 0.075 : 0.035);
  nextBeat = context.currentTime + (hunted ? 0.23 : 0.85);
  beat++;
}
