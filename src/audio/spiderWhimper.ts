import type { Position } from '../../shared-types';
import { getRunningAudioContext, registerSoundStopHook } from './audioRuntime';
import { planBoundPlayback } from './spatialAudio';

const voices = new Map<OscillatorNode, GainNode>();

export function stopSpiderWhimpers(): void {
  for (const [oscillator, gain] of voices) {
    oscillator.stop();
    oscillator.disconnect();
    gain.disconnect();
  }
  voices.clear();
}
registerSoundStopHook(stopSpiderWhimpers);
window.addEventListener('playViewOff', stopSpiderWhimpers);

/** A small descending minor melody bends into a fading, creature-like whimper. */
export function playSpiderWhimper(position: Position): void {
  const context = getRunningAudioContext();
  const plan = planBoundPlayback(position, { requireViewport: true });
  if (!context || !plan.shouldPlay || voices.size >= 12) {
    return;
  }
  for (const [index, frequency] of [659.25, 587.33, 493.88].entries()) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + index * 0.14;
    const duration = 0.38 + index * 0.08;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.72, start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.09 * plan.volumeScale, start + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    voices.set(oscillator, gain);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      voices.delete(oscillator);
    };
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  }
}
