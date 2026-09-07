import { TERRAIN } from './terrainConfig';

export interface Landmark {
  x: number;
  y: number;
  amp: number;
  sigma: number;
}

export interface Heightfield {
  seed: number;
  cx: number;
  cy: number;
  radius: number;
  landmarks: Landmark[];
}

export interface HeightfieldBounds {
  cx?: number;
  cy?: number;
  radius: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + (seed | 0);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);
  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy) * 2 - 1;
}

function fbm(x: number, y: number, seed: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < TERRAIN.OCTAVES; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= TERRAIN.PERSISTENCE;
    freq *= TERRAIN.LACUNARITY;
  }
  return norm > 0 ? sum / norm : 0;
}

function buildLandmarks(seed: number, radius: number): Landmark[] {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const landmarks: Landmark[] = [];
  const span = TERRAIN.LANDMARK_MAX_RADIUS - TERRAIN.LANDMARK_MIN_RADIUS;
  const sigmaSpan = TERRAIN.LANDMARK_SIGMA_MAX - TERRAIN.LANDMARK_SIGMA_MIN;
  for (let i = 0; i < TERRAIN.LANDMARK_COUNT; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = (TERRAIN.LANDMARK_MIN_RADIUS + rng() * span) * radius;
    landmarks.push({
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      amp: (rng() * 2 - 1) * TERRAIN.LANDMARK_AMP,
      sigma: TERRAIN.LANDMARK_SIGMA_MIN + rng() * sigmaSpan,
    });
  }
  return landmarks;
}

export function createHeightfield(seed: number, bounds: HeightfieldBounds): Heightfield {
  return {
    seed,
    cx: bounds.cx ?? 0,
    cy: bounds.cy ?? 0,
    radius: bounds.radius,
    landmarks: buildLandmarks(seed, bounds.radius),
  };
}

/**
 * Elevation in abstract units. Origin is a flat saddle (zero derivative) so
 * spawn does not slide; landmarks sit in the mid-ring.
 */
export function sampleHeight(field: Heightfield, x: number, y: number): number {
  const lx = x - field.cx;
  const ly = y - field.cy;
  const r2 = lx * lx + ly * ly;
  const radius = field.radius;
  if (r2 > radius * radius) {
    return 0;
  }

  let h = fbm(lx / TERRAIN.FEATURE_SCALE, ly / TERRAIN.FEATURE_SCALE, field.seed);
  for (const landmark of field.landmarks) {
    const dx = lx - landmark.x;
    const dy = ly - landmark.y;
    const q = (dx * dx + dy * dy) / (2 * landmark.sigma * landmark.sigma);
    if (q < 12) {
      h += landmark.amp * Math.exp(-q);
    }
  }

  const flatten = 1 - Math.exp(-r2 / (2 * TERRAIN.FLATTEN_SIGMA * TERRAIN.FLATTEN_SIGMA));
  return h * flatten;
}

export function sampleGradientInto(
  out: { x: number; y: number },
  field: Heightfield,
  x: number,
  y: number
): { x: number; y: number } {
  const e = TERRAIN.GRADIENT_EPS;
  out.x = (sampleHeight(field, x + e, y) - sampleHeight(field, x - e, y)) / (2 * e);
  out.y = (sampleHeight(field, x, y + e) - sampleHeight(field, x, y - e)) / (2 * e);
  return out;
}

export function sampleGradient(field: Heightfield, x: number, y: number): { x: number; y: number } {
  return sampleGradientInto({ x: 0, y: 0 }, field, x, y);
}
