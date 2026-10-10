import {
  PASSAGES,
  passageAxis,
  passageBand,
  passageEnvelope,
  passagePhase,
  passageStrength,
} from './passages';
import { TERRAIN } from './terrainConfig';

interface Landmark {
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

interface HeightfieldBounds {
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

function latticeNoise(ix: number, iy: number, fx: number, fy: number, seed: number): number {
  const v00 = hash2(ix, iy, seed);
  const v10 = hash2(ix + 1, iy, seed);
  const v01 = hash2(ix, iy + 1, seed);
  const v11 = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy) * 2 - 1;
}

interface NoiseOctave {
  amplitude: number;
  frequency: number;
  seedOffset: number;
}

function noiseOctaves(): {
  octaves: NoiseOctave[];
  normalization: number;
} {
  const octaves: NoiseOctave[] = [];
  let amplitude = 1;
  let frequency = 1;
  let normalization = 0;
  for (let i = 0; i < TERRAIN.OCTAVES; i++) {
    octaves.push({ amplitude, frequency, seedOffset: i * 1013 });
    normalization += amplitude;
    amplitude *= TERRAIN.PERSISTENCE;
    frequency *= TERRAIN.LACUNARITY;
  }
  return { octaves, normalization };
}

const NOISE = noiseOctaves();

function fbm(x: number, y: number, seed: number): number {
  let sum = 0;
  for (const octave of NOISE.octaves) {
    const nx = x * octave.frequency;
    const ny = y * octave.frequency;
    const ix = Math.floor(nx);
    const iy = Math.floor(ny);
    sum +=
      octave.amplitude *
      latticeNoise(ix, iy, fade(nx - ix), fade(ny - iy), seed + octave.seedOffset);
  }
  return NOISE.normalization > 0 ? sum / NOISE.normalization : 0;
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
 * Scalar field shaping the contours. The origin has zero gradient so
 * spawn keeps ordinary cruise; landmarks sit in the mid-ring.
 */
export function sampleHeight(field: Heightfield, x: number, y: number): number {
  const lx = x - field.cx;
  const ly = y - field.cy;
  const r2 = lx * lx + ly * ly;
  const radius = field.radius;
  if (r2 > radius * radius) {
    return 0;
  }

  return shapeHeight(
    field,
    lx,
    ly,
    r2,
    fbm(lx / TERRAIN.FEATURE_SCALE, ly / TERRAIN.FEATURE_SCALE, field.seed),
    passageStrength(field, x, y)
  );
}

function shapeHeight(
  field: Heightfield,
  lx: number,
  ly: number,
  r2: number,
  noise: number,
  passages: number
): number {
  let h = noise;
  for (const landmark of field.landmarks) {
    const dx = lx - landmark.x;
    const dy = ly - landmark.y;
    const q = (dx * dx + dy * dy) / (2 * landmark.sigma * landmark.sigma);
    if (q < 12) {
      h += landmark.amp * Math.exp(-q);
    }
  }
  const flatten = 1 - Math.exp(-r2 / (2 * TERRAIN.FLATTEN_SIGMA * TERRAIN.FLATTEN_SIGMA));
  // Preserve sqrt for the rim and hypot for passage fading: their rounding can differ.
  const rim = Math.min(1, Math.max(0, (field.radius - Math.sqrt(r2)) / TERRAIN.RIM_FADE_WIDTH));
  const cut = 1 - (1 - PASSAGES.RELIEF_RETAINED) * passages;
  return h * flatten * fade(rim) * cut;
}

/** Build one bounded row-major grid, reusing calculations shared by each axis. */
export function createHeightGrid(
  field: Heightfield,
  gridSize: number,
  bounds: Pick<Heightfield, 'cx' | 'cy' | 'radius'>
): { heights: Float64Array; minH: number; maxH: number } {
  const dim = gridSize + 1;
  const cell = (2 * bounds.radius) / gridSize;
  const originX = bounds.cx - bounds.radius;
  const originY = bounds.cy - bounds.radius;
  const octaves = NOISE.octaves.length;
  const xs = new Float64Array(dim);
  const ys = new Float64Array(dim);
  const xIndex = new Float64Array(dim * octaves);
  const yIndex = new Float64Array(dim * octaves);
  const xFade = new Float64Array(dim * octaves);
  const yFade = new Float64Array(dim * octaves);
  const xPassageOffset = new Float64Array(dim);
  const yPassageOffset = new Float64Array(dim);
  const xPassageWidth = new Float64Array(dim);
  const yPassageWidth = new Float64Array(dim);
  const phase = passagePhase(field.seed);
  for (let index = 0; index < dim; index++) {
    const lx = originX + index * cell - field.cx;
    const ly = originY + index * cell - field.cy;
    xs[index] = lx;
    ys[index] = ly;
    const x = lx / TERRAIN.FEATURE_SCALE;
    const y = ly / TERRAIN.FEATURE_SCALE;
    for (let octave = 0; octave < octaves; octave++) {
      const frequency = NOISE.octaves[octave]?.frequency ?? 0;
      const nx = x * frequency;
      const ny = y * frequency;
      const ix = Math.floor(nx);
      const iy = Math.floor(ny);
      const offset = index * octaves + octave;
      xIndex[offset] = ix;
      yIndex[offset] = iy;
      xFade[offset] = fade(nx - ix);
      yFade[offset] = fade(ny - iy);
    }
    const horizontal = passageAxis(lx, phase);
    const vertical = passageAxis(ly, phase + PASSAGES.VERTICAL_PHASE);
    xPassageOffset[index] = horizontal.offset;
    yPassageOffset[index] = vertical.offset;
    xPassageWidth[index] = horizontal.width;
    yPassageWidth[index] = vertical.width;
  }

  const heights = new Float64Array(dim * dim);
  let minH = Number.POSITIVE_INFINITY;
  let maxH = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < dim; j++) {
    const ly = ys[j] ?? 0;
    const yBase = j * octaves;
    for (let i = 0; i < dim; i++) {
      const lx = xs[i] ?? 0;
      const r2 = lx * lx + ly * ly;
      let height = 0;
      if (!(r2 > field.radius * field.radius)) {
        let sum = 0;
        let octaveIndex = 0;
        for (const octave of NOISE.octaves) {
          const xOffset = i * octaves + octaveIndex;
          const yOffset = yBase + octaveIndex;
          sum +=
            octave.amplitude *
            latticeNoise(
              xIndex[xOffset] ?? 0,
              yIndex[yOffset] ?? 0,
              xFade[xOffset] ?? 0,
              yFade[yOffset] ?? 0,
              field.seed + octave.seedOffset
            );
          octaveIndex++;
        }
        const noise = NOISE.normalization > 0 ? sum / NOISE.normalization : 0;
        const envelope = passageEnvelope(lx, ly, field.radius);
        const passages = Math.max(
          passageBand(
            ly - (xPassageOffset[i] ?? 0) - PASSAGES.HORIZONTAL_OFFSET,
            xPassageWidth[i] ?? 0,
            envelope
          ),
          passageBand(
            lx - (yPassageOffset[j] ?? 0) - PASSAGES.VERTICAL_OFFSET,
            yPassageWidth[j] ?? 0,
            envelope
          )
        );
        height = shapeHeight(field, lx, ly, r2, noise, passages);
      }
      heights[j * dim + i] = height;
      if (height < minH) {
        minH = height;
      }
      if (height > maxH) {
        maxH = height;
      }
    }
  }
  return { heights, minH, maxH };
}

export function sampleGradientInto(
  out: { x: number; y: number },
  field: Heightfield,
  x: number,
  y: number,
  epsilon: number = TERRAIN.GRADIENT_EPS
): { x: number; y: number } {
  if (Math.hypot(x - field.cx, y - field.cy) >= field.radius) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const e = epsilon;
  out.x = (sampleHeight(field, x + e, y) - sampleHeight(field, x - e, y)) / (2 * e);
  out.y = (sampleHeight(field, x, y + e) - sampleHeight(field, x, y - e)) / (2 * e);
  return out;
}

export function sampleGradient(
  field: Heightfield,
  x: number,
  y: number,
  epsilon: number = TERRAIN.GRADIENT_EPS
): { x: number; y: number } {
  return sampleGradientInto({ x: 0, y: 0 }, field, x, y, epsilon);
}
