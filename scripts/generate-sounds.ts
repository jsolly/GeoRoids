/** Original GeoRoids sound palette. Run with npm run sounds:generate on macOS. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const SAMPLE_RATE = 48000;
const C4 = 261.625565;
const hz = (semitones: number) => C4 * 2 ** (semitones / 12);

type Tone = {
  at: number;
  duration: number;
  hz: number;
  endHz: number;
  gain: number;
  shimmer: number;
};
type Recipe = { duration: number; tones: Tone[]; dust?: number };

function bell(note: number, at = 0, duration = 0.4, gain = 0.5, shimmer = 0.18): Tone {
  return { at, duration, hz: hz(note), endHz: hz(note), gain, shimmer };
}
function body(note: number, duration: number, gain = 0.6): Tone {
  return { ...bell(note, 0, duration, gain, 0.025), hz: hz(note + 7) };
}

// Shared sine partials, soft attacks and C-major pentatonic notes. Different
// registers, contours and envelopes identify actions without unrelated timbres.
const recipes: Record<string, Recipe> = {
  'connection-lost': { duration: 0.58, tones: [bell(2, 0, 0.32, 0.36), bell(-5, 0.15, 0.42, 0.4)] },
  'boost-start': { duration: 0.32, tones: [bell(-12, 0, 0.24, 0.46), bell(-5, 0.06, 0.25, 0.32)] },
  'boost-end': { duration: 0.25, tones: [bell(-5, 0, 0.18, 0.3), bell(-12, 0.07, 0.18, 0.35)] },
  'boost-ignite': {
    duration: 0.48,
    tones: [body(-24, 0.35, 0.5), bell(0, 0.04, 0.36, 0.28), bell(7, 0.1, 0.36, 0.2)],
  },
  'hull-damage': {
    duration: 0.2,
    tones: [body(-17, 0.18, 0.6), bell(-5, 0.015, 0.16, 0.22, 0.08)],
    dust: 0.05,
  },
  delivery: {
    duration: 0.9,
    tones: [bell(4, 0, 0.5, 0.4), bell(7, 0.11, 0.5, 0.38), bell(12, 0.22, 0.65, 0.45)],
  },
  'game-over': {
    duration: 0.95,
    tones: [bell(-5, 0, 0.5, 0.42), bell(-8, 0.15, 0.5, 0.36), bell(-12, 0.3, 0.65, 0.45)],
  },
  interface: { duration: 0.16, tones: [bell(12, 0, 0.16, 0.38, 0.08)] },
  'satellite-equip': { duration: 0.44, tones: [bell(0, 0, 0.3, 0.35), bell(7, 0.08, 0.34, 0.38)] },
  'tap-eject': { duration: 0.36, tones: [bell(0, 0, 0.36, 0.6, 0.1), body(-24, 0.055, 0.22)] },
  'loot-pickup': { duration: 0.55, tones: [bell(12, 0, 0.55, 0.62, 0.22)] },
  'core-pickup': {
    duration: 0.65,
    tones: [bell(12, 0, 0.65, 0.55, 0.3), bell(24, 0.045, 0.4, 0.12)],
  },
  'orbital-pickup': { duration: 0.6, tones: [bell(7, 0, 0.42), bell(12, 0.09, 0.48, 0.38)] },
  'harpoon-launch': { duration: 0.24, tones: [body(-12, 0.18, 0.5), bell(0, 0.04, 0.2, 0.25)] },
  'harpoon-latch': { duration: 0.28, tones: [bell(-5, 0, 0.28, 0.6), body(-24, 0.09, 0.2)] },
  'harpoon-release': {
    duration: 0.24,
    tones: [bell(0, 0, 0.16, 0.38), bell(-5, 0.07, 0.16, 0.32)],
  },
  'survey-scan': {
    duration: 0.8,
    tones: [bell(0, 0, 0.5, 0.35), bell(7, 0.13, 0.5, 0.3), bell(14, 0.26, 0.5, 0.22)],
  },
  respawn: {
    duration: 0.85,
    tones: [
      bell(0, 0, 0.48, 0.4),
      bell(4, 0.13, 0.48, 0.36),
      bell(7, 0.26, 0.48, 0.3),
      bell(12, 0.39, 0.46, 0.3),
    ],
  },
  laser: { duration: 0.14, tones: [bell(7, 0, 0.14, 0.48, 0.08), bell(19, 0, 0.07, 0.08, 0)] },
  'orbital-fire': {
    duration: 0.18,
    tones: [bell(0, 0, 0.18, 0.48, 0.09), bell(12, 0, 0.07, 0.12, 0)],
  },
  hit: { duration: 0.15, tones: [body(-12, 0.12, 0.52), bell(0, 0, 0.15, 0.18, 0.06)], dust: 0.06 },
  'asteroid-explode': {
    duration: 0.52,
    tones: [
      body(-24, 0.42, 0.68),
      bell(-5, 0.025, 0.46, 0.22, 0.1),
      bell(4, 0.06, 0.36, 0.12, 0.08),
    ],
    dust: 0.1,
  },
  'satellite-explode': {
    duration: 0.5,
    tones: [body(-17, 0.38, 0.58), bell(7, 0.035, 0.43, 0.2, 0.12)],
    dust: 0.08,
  },
  'loot-explode': {
    duration: 0.3,
    tones: [body(-12, 0.24, 0.5), bell(12, 0.025, 0.26, 0.2, 0.1)],
    dust: 0.05,
  },
  explode: {
    duration: 0.62,
    tones: [
      body(-24, 0.58, 0.72),
      bell(-12, 0.03, 0.5, 0.25, 0.08),
      bell(-5, 0.08, 0.5, 0.18, 0.08),
    ],
    dust: 0.12,
  },
};

function envelope(time: number, duration: number): number {
  const attack = Math.min(1, time / 0.009);
  const release = Math.min(1, (duration - time) / 0.025);
  return attack * release * Math.exp((-5 * time) / duration);
}

function render(recipe: Recipe): Float32Array {
  const samples = new Float32Array(Math.ceil(recipe.duration * SAMPLE_RATE));
  let seed = 91;
  let dust = 0;
  let smoothDust = 0;
  for (let i = 0; i < samples.length; i++) {
    const time = i / SAMPLE_RATE;
    let sample = 0;
    for (const tone of recipe.tones) {
      const t = time - tone.at;
      if (t < 0 || t >= tone.duration) {
        continue;
      }
      // Integrated exponential glide lands gently into the tuned body note.
      const ratio = Math.log(tone.endHz / tone.hz) / tone.duration;
      const phase = 2 * Math.PI * tone.hz * (ratio === 0 ? t : Math.expm1(ratio * t) / ratio);
      const partials =
        Math.sin(phase) +
        tone.shimmer * Math.exp(-12 * t) * Math.sin(phase * 2) +
        tone.shimmer * 0.35 * Math.exp(-20 * t) * Math.sin(phase * 3);
      sample += tone.gain * envelope(t, tone.duration) * partials;
    }
    // Deterministic, twice-smoothed dust. No broadband crack or sharp transient.
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    dust += 0.055 * (seed / 2147483648 - 1 - dust);
    smoothDust += 0.055 * (dust - smoothDust);
    sample += smoothDust * (recipe.dust ?? 0) * envelope(time, recipe.duration);
    samples[i] = sample * 0.75;
  }
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (peak >= 0.95) {
    throw new Error(`Sound clips: ${peak}`);
  }
  return samples;
}

function wav(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => {
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  });
  return buffer;
}

const temporary = mkdtempSync(join(tmpdir(), 'georoids-sounds-'));
try {
  const reel = new Float32Array(SAMPLE_RATE * Object.keys(recipes).length * 1.2);
  let offset = 0;
  for (const [name, recipe] of Object.entries(recipes)) {
    const samples = render(recipe);
    const source = join(temporary, `${name}.wav`);
    writeFileSync(source, wav(samples));
    execFileSync('afconvert', [
      '-f',
      'm4af',
      '-d',
      'aac',
      '-b',
      '96000',
      source,
      `public/sounds/${name}.m4a`,
    ]);
    reel.set(samples, offset);
    offset += SAMPLE_RATE * 1.2;
    process.stdout.write(`${name}: ${recipe.duration}s\n`);
  }
  // Optional audition reel stays outside the shipped assets.
  const reelPath = process.argv[2];
  if (reelPath) {
    writeFileSync(reelPath, wav(reel));
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
