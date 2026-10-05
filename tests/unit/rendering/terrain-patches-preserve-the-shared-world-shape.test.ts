import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { WORLD } from '../../../shared/world';
import { type ContourLevel, extractIsoContours } from '../../../src/physics/terrain/contours';
import {
  createHeightfield,
  createHeightGrid,
  type Heightfield,
  sampleGradient,
  sampleGradientInto,
  sampleHeight,
} from '../../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';

type Bounds = Pick<Heightfield, 'cx' | 'cy' | 'radius'>;
type TerrainCase = {
  name: string;
  seed: number;
  world: Bounds;
  gridSize: number;
  bounds: Bounds;
};
type GridCase = TerrainCase & {
  geometry:
    | { kind: 'patch' }
    | { kind: 'rim' }
    | { kind: 'outside' }
    | { kind: 'landmark'; landmark: Heightfield['landmarks'][number] };
};

const world: Bounds = { cx: 0, cy: 0, radius: WORLD.radius };
const smallWorld: Bounds = { cx: 0, cy: 0, radius: 8000 };
const fractionalWorld: Bounds = { cx: 0.1, cy: -0.2, radius: 8000 };
const fractionalBounds: Bounds = { cx: -11.3, cy: 52.7, radius: 1536.2 };
const translatedWorld: Bounds = { cx: -1000, cy: 2000, radius: WORLD.radius };

function gridCases(): GridCase[] {
  const cases: GridCase[] = [];
  for (const seed of [42, TERRAIN.DEFAULT_SEED, 123456789]) {
    for (const [name, cx, cy, radius] of [
      ['spawn', 0, 0, 2048],
      ['neighboring patch', 1024, -1024, 2048],
      ['scan-sized patch', 4096, 2048, 4096],
    ] satisfies [string, number, number, number][]) {
      cases.push({
        name: `${name}, seed ${seed}`,
        seed,
        world,
        gridSize: 96,
        bounds: { cx, cy, radius },
        geometry: { kind: 'patch' },
      });
    }
    const diagonal = Math.round(WORLD.radius / Math.SQRT2 / 1024) * 1024;
    for (const [name, cx, cy] of [
      ['axis rim', 59392, 0],
      ['diagonal rim', diagonal, diagonal],
    ] satisfies [string, number, number][]) {
      cases.push({
        name: `${name}, seed ${seed}`,
        seed,
        world,
        gridSize: 96,
        bounds: { cx, cy, radius: 2048 },
        geometry: { kind: 'rim' },
      });
    }
    const field = createHeightfield(seed, world);
    const landmarks = [...field.landmarks]
      .sort((left, right) => Math.abs(right.amp) - Math.abs(left.amp))
      .slice(0, 2);
    for (const [index, landmark] of landmarks.entries()) {
      cases.push({
        name: `generated landmark ${index}, seed ${seed}`,
        seed,
        world,
        gridSize: 96,
        bounds: { cx: landmark.x, cy: landmark.y, radius: 2048 },
        geometry: { kind: 'landmark', landmark },
      });
    }
  }
  cases.push(
    {
      name: 'translated world with unsigned seed',
      seed: 0xffffffff,
      world: translatedWorld,
      gridSize: 96,
      bounds: { cx: 1024, cy: -1024, radius: 2048 },
      geometry: { kind: 'patch' },
    },
    {
      name: 'fractional world and patch on a small grid',
      seed: 0,
      world: fractionalWorld,
      gridSize: 7,
      bounds: fractionalBounds,
      geometry: { kind: 'patch' },
    },
    {
      name: 'eager extraction across the small world',
      seed: 42,
      world: smallWorld,
      gridSize: 224,
      bounds: smallWorld,
      geometry: { kind: 'rim' },
    },
    {
      name: 'patch entirely outside the world',
      seed: 42,
      world,
      gridSize: 96,
      bounds: { cx: 90000, cy: 90000, radius: 2048 },
      geometry: { kind: 'outside' },
    }
  );
  return cases;
}

test.each(gridCases())('$name preserves every shared height and both extrema', (scenario) => {
  const field = createHeightfield(scenario.seed, scenario.world);
  const dim = scenario.gridSize + 1;
  const step = (2 * scenario.bounds.radius) / scenario.gridSize;
  const originX = scenario.bounds.cx - scenario.bounds.radius;
  const originY = scenario.bounds.cy - scenario.bounds.radius;
  const expected = new Float64Array(dim * dim);
  let minH = Number.POSITIVE_INFINITY;
  let maxH = Number.NEGATIVE_INFINITY;
  let insideSamples = 0;
  let landmarkSamples = 0;
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      const x = originX + column * step;
      const y = originY + row * step;
      const height = sampleHeight(field, x, y);
      expected[row * dim + column] = height;
      if (height < minH) {
        minH = height;
      }
      if (height > maxH) {
        maxH = height;
      }
      const lx = x - field.cx;
      const ly = y - field.cy;
      if (lx * lx + ly * ly <= field.radius * field.radius) {
        insideSamples++;
        if (scenario.geometry.kind === 'landmark') {
          const { landmark } = scenario.geometry;
          const dx = lx - landmark.x;
          const dy = ly - landmark.y;
          if ((dx * dx + dy * dy) / (2 * landmark.sigma * landmark.sigma) < 12) {
            landmarkSamples++;
          }
        }
      }
    }
  }

  const actual = createHeightGrid(field, scenario.gridSize, scenario.bounds);
  expect(
    new Uint8Array(actual.heights.buffer, actual.heights.byteOffset, actual.heights.byteLength)
  ).toEqual(new Uint8Array(expected.buffer));
  expect(Object.is(actual.minH, minH)).toBe(true);
  expect(Object.is(actual.maxH, maxH)).toBe(true);
  if (scenario.geometry.kind === 'rim') {
    expect(insideSamples).toBeGreaterThan(0);
    expect(insideSamples).toBeLessThan(expected.length);
  }
  if (scenario.geometry.kind === 'landmark') {
    expect(landmarkSamples).toBeGreaterThan(0);
  }
  if (scenario.geometry.kind === 'outside') {
    expect(insideSamples).toBe(0);
    expect(
      extractIsoContours(field, scenario.gridSize, TERRAIN.CONTOUR_INTERVAL, scenario.bounds)
    ).toEqual([]);
  }
});

// Witnesses generated from the complete frozen terrain graph before this refactor.
// Revision: 5cdaeedad8db22f5925dd4cdc176caa606bfc5be, Node 24.16.0.
// Original SHA-256 source identities:
// heightfield.ts: f4136f2e44fe4d85585886ab31a144e84ee87694c4d177b21f7bbc89f32d2afe
// passages.ts: 192ae113372181868e6e558667f998bbfbc639bcca2416ffe87ab6d028f13108
// terrainConfig.ts: 716c4521339f2ae42b21d77bd94c8abc72f85855cded69ab5e41403301b60934
// contours.ts: 963e9c9cc165f90bfdf1815f8f702b42d7cd84230a94210d3c542a326912df86
// Encode every number as little-endian Float64, retaining order and signed zero.
function numericDigest(values: readonly number[]): string {
  const bytes = Buffer.alloc(values.length * Float64Array.BYTES_PER_ELEMENT);
  for (const [index, value] of values.entries()) {
    bytes.writeDoubleLE(value, index * Float64Array.BYTES_PER_ELEMENT);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function orderedContourNumbers(levels: readonly ContourLevel[]): number[] {
  const values = [levels.length];
  for (const level of levels) {
    values.push(level.index, level.height, level.segments.length);
    for (const segment of level.segments) {
      values.push(segment.ax, segment.ay, segment.bx, segment.by);
    }
  }
  return values;
}

const contourWitnesses: (TerrainCase & { digest: string })[] = [
  {
    name: 'normal spawn',
    seed: 42,
    world,
    gridSize: 96,
    bounds: { cx: 0, cy: 0, radius: 2048 },
    digest: 'c95b9631d23a4f9a01a1d4e7c926b0368e7d1284d3785ebc6bd0f3ace0edd643',
  },
  {
    name: 'scan-sized patch',
    seed: TERRAIN.DEFAULT_SEED,
    world,
    gridSize: 96,
    bounds: { cx: 4096, cy: 2048, radius: 4096 },
    digest: 'fec6a17ea8706963396186b3c9583c3f6cc1433eaa4682bdb4a7aa60a22b42d1',
  },
  {
    name: 'axis rim',
    seed: 42,
    world,
    gridSize: 96,
    bounds: { cx: 59392, cy: 0, radius: 2048 },
    digest: '5eae9c69a403976b1e480a4279e706a7adff0497a925485d7a1641ef6a6fe671',
  },
  {
    name: 'diagonal rim',
    seed: TERRAIN.DEFAULT_SEED,
    world,
    gridSize: 96,
    bounds: { cx: 41984, cy: 41984, radius: 2048 },
    digest: '45fb034759645a15e75a662016c45b24419b1380ca402285056dd1ebb64f7637',
  },
  {
    name: 'fractional small grid',
    seed: 0,
    world: fractionalWorld,
    gridSize: 7,
    bounds: fractionalBounds,
    digest: '61fff4cef460878b0b7724732a4a53a0716e776f53b19c857c5099e25a8a121c',
  },
  {
    name: 'eager small world',
    seed: 42,
    world: smallWorld,
    gridSize: 224,
    bounds: smallWorld,
    digest: '1d4e66fa2eb9bf1c53d8af37ef7308fefc579f4784c8dba9bbd548e3d174666f',
  },
  {
    name: 'generated landmark',
    seed: 123456789,
    world,
    gridSize: 96,
    bounds: { cx: 36633.19401067944, cy: 1916.79792298872, radius: 2048 },
    digest: '14fbdc1c52b1302fa64e1963b25329611bec4527036843ae9bae04390b5e139b',
  },
];

test.each(contourWitnesses)('$name retains the original ordered contour geometry', (scenario) => {
  const field = createHeightfield(scenario.seed, scenario.world);
  const levels = extractIsoContours(
    field,
    scenario.gridSize,
    TERRAIN.CONTOUR_INTERVAL,
    scenario.bounds
  );
  expect(numericDigest(orderedContourNumbers(levels))).toBe(scenario.digest);
});

const pointWitnesses = [
  { seed: 42, world, digest: '9e529bdcbcb631556b3f1b013ba3e237b8f39a4682ff5f0d69921b532a0f542d' },
  {
    seed: TERRAIN.DEFAULT_SEED,
    world,
    digest: 'dbb477212d0e46f9fe87f51be161c73334999755c552cd2822a8fd91eb4a1d68',
  },
  {
    seed: 123456789,
    world,
    digest: '7eef3f75f523313ef020616e01b67a91618bc7505daee8cb60e8aa1a1eaf21eb',
  },
  {
    seed: 0xffffffff,
    world: translatedWorld,
    digest: 'd7f8532e0e39dca9186cb658b1745944d68e2bd527f23a178d88185ff4308ec4',
  },
  {
    seed: 0,
    world: fractionalWorld,
    digest: '7c7f75504332707646f0b83161c3a4248b406299b99bcfe514f948e7604d8cb1',
  },
];

test.each(pointWitnesses)(
  'seed $seed retains original off-grid heights and gradients',
  (scenario) => {
    const field = createHeightfield(scenario.seed, scenario.world);
    // Arbitrary coordinates, noise lattice lines, passage bands, spawn and the rim.
    const points = [
      { x: 0, y: 0 },
      { x: -1300.25, y: -700.75 },
      { x: 1550.125, y: 430.25 },
      { x: -650, y: 1300 },
      { x: 450, y: 0 },
      { x: 800, y: 0 },
      { x: field.radius - 6, y: 0 },
      { x: field.radius - 1, y: 0 },
      { x: field.radius, y: 0 },
      { x: field.radius + 1, y: 0 },
      ...field.landmarks.map(({ x, y }) => ({ x, y })),
    ];
    const values: number[] = [];
    for (const point of points) {
      const x = field.cx + point.x;
      const y = field.cy + point.y;
      const gradient = sampleGradient(field, x, y);
      const out = { x: Number.NaN, y: Number.NaN };
      expect(sampleGradientInto(out, field, x, y)).toBe(out);
      expect(Object.is(out.x, gradient.x)).toBe(true);
      expect(Object.is(out.y, gradient.y)).toBe(true);
      values.push(x, y, sampleHeight(field, x, y), gradient.x, gradient.y);
    }
    expect(numericDigest(values)).toBe(scenario.digest);
  }
);
