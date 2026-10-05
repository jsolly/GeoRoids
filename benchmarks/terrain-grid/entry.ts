import { WORLD } from '../../shared/world';
import { type ContourLevel, extractIsoContours } from '../../src/physics/terrain/contours';
import {
  createHeightfield,
  createHeightGrid,
  type Heightfield,
  type sampleHeight,
} from '../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../src/physics/terrain/terrainConfig';
import {
  contourSpatialIndexIsCached,
  createContourQuery,
  warmContourSpatialIndex,
} from '../../src/rendering/contourSpatialIndex';

type Variant = 'baseline' | 'candidate';
type Scenario = {
  id: string;
  seed: number;
  grid: number;
  group: 'normal-patch-kernel' | 'scan-radius-kernel';
  expectRimIntersection: boolean;
  generatedLandmark?: Heightfield['landmarks'][number];
  world: { cx: number; cy: number; radius: number };
  bounds: { cx: number; cy: number; radius: number };
};
type TimingOptions = { pairs: number; warmups: number; calls: number };
/** Baseline code is supplied by the generated, source-bound bootstrap. */
function installTerrainGridBenchmark(baseline: {
  createHeightfield: typeof createHeightfield;
  sampleHeight: typeof sampleHeight;
  extractIsoContours: typeof extractIsoContours;
  contourInterval: number;
}): void {
  const scenarios: Scenario[] = [];
  for (const seed of [42, TERRAIN.DEFAULT_SEED, 123456789]) {
    for (const [cx, cy, radius, label] of [
      [0, 0, 2048, 'spawn'],
      [1024, -1024, 2048, 'crossing'],
      [4096, 2048, 4096, 'wide-scan'],
      [59392, 0, 2048, 'rim'],
    ] as const) {
      scenarios.push({
        id: `${label}-${seed}`,
        seed,
        grid: 96,
        group: label === 'wide-scan' ? 'scan-radius-kernel' : 'normal-patch-kernel',
        expectRimIntersection: label === 'rim',
        world: { cx: 0, cy: 0, radius: WORLD.radius },
        bounds: { cx, cy, radius },
      });
    }
    const generated = createHeightfield(seed, { cx: 0, cy: 0, radius: WORLD.radius });
    const landmarks = generated.landmarks
      .map((landmark, ordinal) => ({ ...landmark, ordinal }))
      .sort((a, b) => Math.abs(b.amp) - Math.abs(a.amp))
      .slice(0, 2);
    for (const landmark of landmarks) {
      scenarios.push({
        id: `landmark-${seed}-${landmark.ordinal}`,
        seed,
        grid: 96,
        group: 'normal-patch-kernel',
        expectRimIntersection: false,
        generatedLandmark: landmark,
        world: { cx: 0, cy: 0, radius: WORLD.radius },
        bounds: {
          cx: Math.round(landmark.x / 1024) * 1024,
          cy: Math.round(landmark.y / 1024) * 1024,
          radius: 2048,
        },
      });
    }
    const diagonal = Math.round(WORLD.radius / Math.sqrt(2) / 1024) * 1024;
    scenarios.push({
      id: `diagonal-rim-${seed}`,
      seed,
      grid: 96,
      group: 'normal-patch-kernel',
      expectRimIntersection: true,
      world: { cx: 0, cy: 0, radius: WORLD.radius },
      bounds: { cx: diagonal, cy: diagonal, radius: 2048 },
    });
  }
  const nativeNow = performance.now.bind(performance);
  const visibilityEvents: { at: number; visibilityState: DocumentVisibilityState }[] = [];
  document.addEventListener('visibilitychange', () => {
    visibilityEvents.push({ at: nativeNow(), visibilityState: document.visibilityState });
  });
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
      throw new Error(message);
    }
  }
  function scenarioAt(index: number): Scenario {
    const scenario = scenarios[index];
    assert(Number.isInteger(index) && scenario, 'Invalid scenario index');
    return scenario;
  }
  function frameState() {
    return {
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      visibilityEvents: [...visibilityEvents],
      devicePixelRatio,
      innerWidth,
      innerHeight,
      crossOriginIsolated,
    };
  }
  function heapObservation() {
    const memory: unknown = Reflect.get(performance, 'memory');
    if (memory && typeof memory === 'object') {
      return {
        source: 'nonstandard performance.memory, coarse JS heap only',
        usedJSHeapSize: Reflect.get(memory, 'usedJSHeapSize'),
        totalJSHeapSize: Reflect.get(memory, 'totalJSHeapSize'),
        jsHeapSizeLimit: Reflect.get(memory, 'jsHeapSizeLimit'),
        externalBuffersAndTotalProcessMemory: 'not measured',
      };
    }
    return { source: 'unavailable', externalBuffersAndTotalProcessMemory: 'not measured' };
  }
  const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
  async function runtimeStatus() {
    const deltas: number[] = [];
    let previous = nativeNow();
    for (let i = 0; i < 20_000; i++) {
      const current = nativeNow();
      if (current > previous) {
        deltas.push(current - previous);
      }
      previous = current;
    }
    const timestamps: number[] = [];
    for (let i = 0; i < 12; i++) {
      timestamps.push(await nextFrame());
    }
    return {
      frame: frameState(),
      heap: heapObservation(),
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      clock: {
        source: 'unmodified native performance.now',
        positiveDeltaCount: deltas.length,
        minimumObservedPositiveDeltaMs: deltas.length ? Math.min(...deltas) : null,
        calibrationIterations: 20_000,
      },
      idleRafTimestamps: timestamps,
      idleRafIntervalsMs: timestamps.slice(1).map((v, i) => v - (timestamps[i] ?? v)),
    };
  }
  function baselineGrid(field: Heightfield, scenario: Scenario) {
    const n = scenario.grid,
      dim = n + 1,
      step = (2 * scenario.bounds.radius) / n;
    const ox = scenario.bounds.cx - scenario.bounds.radius;
    const oy = scenario.bounds.cy - scenario.bounds.radius;
    const heights = new Float64Array(dim * dim);
    let minH = Infinity,
      maxH = -Infinity;
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const height = baseline.sampleHeight(field, ox + i * step, oy + j * step);
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
  function sameFloat64(a: Float64Array, b: Float64Array, name: string): void {
    assert(a.length === b.length, `${name}: float count differs`);
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < left.length; i++) {
      assert(left[i] === right[i], `${name}: byte ${i} differs`);
    }
    for (const value of a) {
      assert(Number.isFinite(value), `${name}: nonfinite value`);
    }
  }
  async function digest(values: Float64Array) {
    const bytes = new Uint8Array(values.byteLength);
    bytes.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return {
      float64Count: values.length,
      byteLength: values.byteLength,
      sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(
        ''
      ),
    };
  }
  function flattenLevels(levels: readonly ContourLevel[]) {
    const values: number[] = [levels.length];
    for (const level of levels) {
      values.push(level.index, level.height, level.segments.length);
      for (const segment of level.segments) {
        values.push(segment.ax, segment.ay, segment.bx, segment.by);
      }
    }
    return new Float64Array(values);
  }
  function runJob(field: Heightfield, scenario: Scenario, variant: Variant): ContourLevel[] {
    const levels =
      variant === 'baseline'
        ? baseline.extractIsoContours(
            field,
            scenario.grid,
            baseline.contourInterval,
            scenario.bounds
          )
        : extractIsoContours(field, scenario.grid, TERRAIN.CONTOUR_INTERVAL, scenario.bounds);
    warmContourSpatialIndex(levels);
    return levels;
  }
  function coverage(field: Heightfield, scenario: Scenario) {
    const n = scenario.grid,
      dim = n + 1,
      step = (2 * scenario.bounds.radius) / n;
    let inside = 0,
      landmarkSamples = 0;
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const x = scenario.bounds.cx - scenario.bounds.radius + i * step - field.cx;
        const y = scenario.bounds.cy - scenario.bounds.radius + j * step - field.cy;
        if (x * x + y * y <= field.radius * field.radius) {
          inside++;
          const landmark = scenario.generatedLandmark;
          if (landmark) {
            const dx = x - landmark.x,
              dy = y - landmark.y;
            if ((dx * dx + dy * dy) / (2 * landmark.sigma * landmark.sigma) < 12) {
              landmarkSamples++;
            }
          }
        }
      }
    }
    if (scenario.expectRimIntersection) {
      assert(inside > 0 && inside < dim * dim, 'Rim case must cross boundary');
    }
    if (scenario.generatedLandmark) {
      assert(landmarkSamples > 0, 'Landmark case must sample landmark');
    }
    return {
      sampledHeights: dim * dim,
      insideWorldSamples: inside,
      outsideWorldSamples: dim * dim - inside,
      landmarkContributionSamples: landmarkSamples,
      returnedHeightBufferBytes: dim * dim * Float64Array.BYTES_PER_ELEMENT,
      candidateAxisBufferBytesDerived:
        (6 + 4 * TERRAIN.OCTAVES) * dim * Float64Array.BYTES_PER_ELEMENT,
      allocationBytes: 'Total heap, Map, arrays, objects and transient allocations not measured',
    };
  }
  async function observeScenario(index: number) {
    const scenario = scenarioAt(index),
      field = createHeightfield(scenario.seed, scenario.world);
    const baselineField = baseline.createHeightfield(scenario.seed, scenario.world);
    const fieldValues = (value: Heightfield) =>
      new Float64Array([
        value.seed,
        value.cx,
        value.cy,
        value.radius,
        value.landmarks.length,
        ...value.landmarks.flatMap((landmark) => [
          landmark.x,
          landmark.y,
          landmark.amp,
          landmark.sigma,
        ]),
      ]);
    sameFloat64(fieldValues(baselineField), fieldValues(field), 'Heightfield construction');
    const aGrid = baselineGrid(baselineField, scenario),
      bGrid = createHeightGrid(field, scenario.grid, scenario.bounds);
    sameFloat64(aGrid.heights, bGrid.heights, `${scenario.id} heights`);
    sameFloat64(
      new Float64Array([aGrid.minH, aGrid.maxH]),
      new Float64Array([bGrid.minH, bGrid.maxH]),
      'min/max'
    );
    const original = runJob(baselineField, scenario, 'baseline'),
      candidate = runJob(field, scenario, 'candidate');
    assert(
      contourSpatialIndexIsCached(original) && contourSpatialIndexIsCached(candidate),
      'Index not built'
    );
    const aLevels = flattenLevels(original),
      bLevels = flattenLevels(candidate);
    sameFloat64(aLevels, bLevels, `${scenario.id} complete ordered contours`);
    const aQuery = createContourQuery(),
      bQuery = createContourQuery();
    const queryReceipts: (Awaited<ReturnType<typeof digest>> & {
      view: Parameters<ReturnType<typeof createContourQuery>>[2];
      exactFloat64BitsAndOrder: boolean;
    })[] = [];
    for (const [dx, dy, width, height, scale, pad] of [
      [0, 0, 390, 844, 1, 0],
      [255, -255, 390, 844, 0.25, 32],
      [-512, 512, 1920, 1080, 1, 64],
      [2048, 2048, 844, 390, 0.5, 8],
    ] as const) {
      const view = {
        x: scenario.bounds.cx + dx,
        y: scenario.bounds.cy + dy,
        width,
        height,
        scale,
        pad,
      };
      const left: ContourLevel[] = [],
        right: ContourLevel[] = [];
      for (const [ordinal, level] of original.entries()) {
        const other = candidate[ordinal];
        assert(other, 'Missing candidate level');
        left.push({
          index: level.index,
          height: level.height,
          segments: [...aQuery(original, ordinal, view)],
        });
        right.push({
          index: other.index,
          height: other.height,
          segments: [...bQuery(candidate, ordinal, view)],
        });
      }
      const a = flattenLevels(left),
        b = flattenLevels(right);
      sameFloat64(a, b, 'Ordered spatial query');
      queryReceipts.push({ view, exactFloat64BitsAndOrder: true, ...(await digest(a)) });
    }
    return {
      scenario,
      exactHeightFloat64Bits: true,
      exactMinMaxFloat64Bits: true,
      exactOrderedContourFloat64Bits: true,
      bothSpatialIndexesBuilt: true,
      heights: await digest(aGrid.heights),
      contours: await digest(aLevels),
      contourLevels: original.length,
      contourSegments: original.reduce((sum, level) => sum + level.segments.length, 0),
      queries: queryReceipts,
      coverage: coverage(field, scenario),
      frame: frameState(),
    };
  }
  async function timeScenario(index: number, options: TimingOptions) {
    for (const [key, count] of Object.entries(options)) {
      assert(Number.isInteger(count) && count >= 1 && count <= 100, `Invalid ${key}`);
    }
    assert(options.calls >= 10, 'At least ten calls per arm required');
    const scenario = scenarioAt(index),
      field = createHeightfield(scenario.seed, scenario.world);
    const baselineField = baseline.createHeightfield(scenario.seed, scenario.world);
    const seen = new WeakSet<ContourLevel[]>();
    let blackhole = 0,
      operationCount = 0;
    const inspect = (result: ContourLevel[]) => {
      assert(!seen.has(result), 'An extraction reused its contour array');
      seen.add(result);
      assert(contourSpatialIndexIsCached(result), 'Missing spatial index after operation');
      blackhole += result.length + (result[0]?.segments.length ?? 0);
      operationCount++;
    };
    // Train both implementations before the bracketing controls, then warm each arm.
    for (let warmup = 0; warmup < options.warmups; warmup++) {
      inspect(runJob(baselineField, scenario, 'baseline'));
      inspect(runJob(field, scenario, 'candidate'));
    }
    const arms: {
      kind: 'aa-before' | 'ab' | 'aa-after';
      pair: number;
      position: number;
      variant: Variant;
      samplesMs: number[];
      armWallMs: number;
      frameBefore: ReturnType<typeof frameState>;
      frameAfter: ReturnType<typeof frameState>;
      heapBefore: ReturnType<typeof heapObservation>;
      heapAfter: ReturnType<typeof heapObservation>;
    }[] = [];
    for (const kind of ['aa-before', 'ab', 'aa-after'] as const) {
      for (let pair = 0; pair < options.pairs; pair++) {
        const variants: Variant[] =
          kind !== 'ab'
            ? ['baseline', 'baseline']
            : pair % 2
              ? ['candidate', 'baseline']
              : ['baseline', 'candidate'];
        for (const [position, variant] of variants.entries()) {
          await nextFrame();
          await nextFrame();
          assert(!document.hidden, 'Timing context became hidden');
          const before = frameState(),
            heapBefore = heapObservation();
          for (let warmup = 0; warmup < options.warmups; warmup++) {
            inspect(runJob(variant === 'baseline' ? baselineField : field, scenario, variant));
          }
          const samplesMs: number[] = [];
          const armStarted = nativeNow();
          for (let call = 0; call < options.calls; call++) {
            const started = nativeNow();
            const result = runJob(
              variant === 'baseline' ? baselineField : field,
              scenario,
              variant
            );
            const elapsed = nativeNow() - started;
            assert(Number.isFinite(elapsed) && elapsed > 0, 'Nonpositive or invalid timer sample');
            samplesMs.push(elapsed);
            inspect(result);
          }
          const armWallMs = nativeNow() - armStarted;
          arms.push({
            kind,
            pair,
            position,
            variant,
            samplesMs,
            armWallMs,
            frameBefore: before,
            frameAfter: frameState(),
            heapBefore,
            heapAfter: heapObservation(),
          });
        }
      }
    }
    assert(
      !visibilityEvents.some((event) => event.visibilityState !== 'visible'),
      'Context visibility changed'
    );
    return {
      scenario,
      options,
      arms,
      blackhole,
      operationCount,
      freshContourArrayEveryOperation: true,
      indexedEveryOperation: true,
      frame: frameState(),
      heap: heapObservation(),
    };
  }
  Object.assign(window, {
    terrainScenarios: scenarios,
    observeTerrainScenario: observeScenario,
    timeTerrainScenario: timeScenario,
    terrainRuntimeStatus: runtimeStatus,
  });
}

declare global {
  interface Window {
    installTerrainGridBenchmark: typeof installTerrainGridBenchmark;
  }
}

// The generated bootstrap loads this real module, then supplies its frozen provider.
window.installTerrainGridBenchmark = installTerrainGridBenchmark;
