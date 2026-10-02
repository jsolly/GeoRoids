// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const script = fileURLToPath(
  new URL('../../../scripts/compare-mobile-sessions.ts', import.meta.url)
);

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixtureManifest = { seed: 42, scenario: 'combat' };
const fixtureHash = hash(fixtureManifest);
const quality = { maxDpr: 'native', glow: 'full' };
async function fixture(directory: string, kind: 'quality' | 'product' | 'renderer' = 'quality') {
  const aa: string[][] = [];
  const ab: string[][] = [];
  for (let index = 0; index < 12; index++) {
    const candidate = index >= 6 && index % 2 === 1;
    const arm = candidate && kind === 'product' ? 'candidate' : 'baseline';
    const graphics = candidate && kind === 'quality' ? { ...quality, maxDpr: 2 } : quality;
    const renderer = candidate && kind === 'renderer' ? 'webgl2' : 'canvas';
    const frames = Array.from({ length: 18750 }, (_, frame) =>
      frame < (candidate ? 94 : 375) ? 31 : 16
    );
    const metric = (values: number[]) => ({ values, count: values.length, omittedSamples: 0 });
    const git = {
      sourceSha256: hash(arm),
      productSha256: hash(`product-${arm}`),
      harnessSha256: hash('harness'),
      lockfileSha256: hash('lock'),
      buildSha256: hash(`build-${arm}`),
    };
    const order =
      index >= 6 && Math.floor((index - 6) / 2) % 2 === 1
        ? index + (index % 2 === 0 ? 1 : -1)
        : index;
    const report = {
      kind: 'realtime-client',
      status: 'passed',
      metadata: {
        git,
        environment: {
          nodeVersion: 'v24',
          os: 'fixture',
          osRelease: '1',
          arch: 'arm64',
          cpuModel: 'fixture',
          browser: { name: 'chromium', version: '1', launchFlags: [], headed: false },
          physicalDevice: false,
          measurementSource: 'emulated-touch',
          gpu: {
            supported: true,
            ...(kind === 'renderer'
              ? {
                  renderer: { glRenderer: 'fixture GPU' },
                  devices: [{ vendorId: 1, deviceId: 2 }],
                  featureStatus: { webgl2: 'enabled' },
                }
              : {}),
          },
        },
      },
      finalHashes: git,
      measurement: {
        parameters: {
          workload: 'combat',
          profileRecorded: false,
          seed: 42,
          cpuSlowdown: 1,
          network: 'clean',
          headed: false,
          ...(kind === 'renderer' ? { renderer } : {}),
        },
      },
      details: {
        scenarios: [
          {
            status: 'passed',
            departure: { confirmedEmpty: true },
            metadata: { userAgent: 'test-agent', dpr: 3, css: { width: 390, height: 844 } },
            fixtures: [{ hash: fixtureHash, manifest: fixtureManifest }],
            inputSteps: 400,
            inputSchedule: Array.from({ length: 300 }, (_, i) => ({
              measured: true,
              scheduledAt: i * 1000,
              startedAt: i * 1000 + 1,
              missedSlots: 0,
            })),
            inputActions: Array.from({ length: 300 }, (_, i) => ({
              startedAt: i * 1000,
              completedAt: i * 1000 + 20,
              measured: true,
            })),
            acknowledgedMotionStates: 500,
            observedProjectiles: 10,
            serverMeasurement: {
              startedAt: new Date(1700000000000 + order * 400000).toISOString(),
              endedAt: new Date(1700000000000 + order * 400000 + 300000).toISOString(),
            },
            restarts: [],
            health: [{ measured: true, data: { releaseId: arm } }],
            peers: Array.from({ length: 4 }, () => ({
              joined: true,
              completedScenario: true,
              acknowledgedMotionStates: 300,
              measuredMotionCommands: 300,
              measuredStates: 9000,
              observedMeasuredServerProjectiles: 10,
              measuredPings: 1,
              omittedSnapshotHandlingSamples: 0,
              unansweredMeasuredPings: 0,
              stateIntervalMs: Array(9000).fill(1000 / 30),
            })),
            populationSamples: [
              {
                measured: true,
                counts: Object.fromEntries(
                  ['players', 'asteroids', 'pickups', 'projectiles'].map((entity) => [
                    entity,
                    { total: 5, visibleCenters: 3 },
                  ])
                ),
              },
            ],
            intervals: [
              {
                sessionWitness: index,
                durationMs: 300_000,
                phaseDurationsMs: { play: 300_000 },
                clientReleaseId: arm,
                serverReleaseId: arm,
                graphicsSettings: { deviceDpr: 3, cssWidth: 390, cssHeight: 844, ...graphics },
                ...(kind === 'renderer'
                  ? {
                      renderer: {
                        requested: renderer,
                        backend: renderer,
                        frames: {
                          canvas: renderer === 'canvas' ? 18750 : 0,
                          webgl2: renderer === 'webgl2' ? 18750 : 0,
                        },
                        gpuStats: renderer === 'webgl2' ? { frames: 18750 } : null,
                      },
                    }
                  : {}),
                counters: {},
                metrics: {
                  'play.frameIntervalMs': metric(frames),
                  'play.frameCpuMs': metric(Array(18750).fill(2)),
                  'play.inputToRenderMs': metric(Array(300).fill(5)),
                },
              },
            ],
          },
        ],
      },
    };
    const path = `session-${index}.json`;
    await writeFile(join(directory, path), JSON.stringify(report));
    if (index % 2 === 0) {
      (index < 6 ? aa : ab).push([path, `session-${index + 1}.json`]);
    }
  }
  const manifest = join(directory, 'pairs.json');
  await writeFile(
    manifest,
    JSON.stringify({
      cohort: 'test cohort',
      scenario: 'combat',
      experiment: {
        kind,
        harnessSha256: hash('harness'),
        lockfileSha256: hash('lock'),
        fixtureHash,
        baseline: {
          sourceSha256: hash('baseline'),
          productSha256: hash('product-baseline'),
          quality,
          ...(kind === 'renderer' ? { renderer: 'canvas' } : {}),
        },
        candidate: {
          sourceSha256: hash(kind === 'product' ? 'candidate' : 'baseline'),
          productSha256: hash(kind === 'product' ? 'product-candidate' : 'product-baseline'),
          quality: kind === 'quality' ? { ...quality, maxDpr: 2 } : quality,
          ...(kind === 'renderer' ? { renderer: 'webgl2' } : {}),
        },
      },
      aa,
      ab,
    })
  );
  return manifest;
}
function run(manifest: string, output: string) {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', script, '--manifest', manifest, '--output', output],
    { encoding: 'utf8', stdio: 'pipe' }
  );
}

test.each(['quality', 'product', 'renderer'] as const)(
  'controlled %s comparison verifies source arms and preserves workload evidence',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'mobile-comparison-'));
    try {
      const manifest = await fixture(directory, kind);
      const output = join(directory, 'comparison.json');
      expect(run(manifest, output)).toContain('improved');
      const result = JSON.parse(await readFile(output, 'utf8'));
      expect(result).toMatchObject({
        relativeResult: 'improved',
        workloadReviewRequired: true,
        physicalAcceptance: false,
      });
      expect(result.sources).toHaveLength(12);
      expect(result.sources[0]).toMatchObject({
        path: join(directory, 'session-0.json'),
        sha256: expect.stringMatching(SHA256_HEX_PATTERN),
        workload: { fixtureHash, distributions: expect.any(Object) },
      });
      const path = join(directory, 'session-7.json');
      const original = JSON.parse(await readFile(path, 'utf8'));
      for (const [mutation, error] of [
        [
          (r: typeof original) => {
            r.details.scenarios[0].peers[0].omittedSnapshotHandlingSamples = 1;
          },
          'Peer snapshot handling samples omitted',
        ],
        [
          (r: typeof original) => {
            r.metadata.git.harnessSha256 = hash('wrong');
          },
          'Unexpected harness',
        ],
        [
          (r: typeof original) => {
            r.metadata.git.productSha256 = hash('wrong');
          },
          'Unexpected product',
        ],
        [
          (r: typeof original) => {
            r.finalHashes.sourceSha256 = hash('wrong');
          },
          'changed during session',
        ],
        [
          (r: typeof original) => {
            r.details.scenarios[0].fixtures[0].hash = hash('wrong');
          },
          'Workload fixture differs',
        ],
        [
          (r: typeof original) => {
            r.measurement.parameters.profileRecorded = true;
          },
          'profiling disqualifies',
        ],
        [
          (r: typeof original) => {
            r.metadata.environment.gpu = { supported: false };
          },
          kind === 'renderer' ? 'requires an observed GPU environment' : 'Device, viewport',
        ],
        [
          (r: typeof original) => {
            r.measurement.parameters.headed = true;
            r.metadata.environment.browser.headed = true;
          },
          'Device, viewport',
        ],
        [
          (r: typeof original) => {
            r.details.scenarios[0].populationSamples = [];
          },
          'Missing measured population',
        ],
      ] as const) {
        const damaged = structuredClone(original);
        mutation(damaged);
        await writeFile(path, JSON.stringify(damaged));
        expect(() => run(manifest, output)).toThrow(error);
      }
      await writeFile(
        path,
        JSON.stringify({ content: '{}', checksumAlgorithm: 'SHA-256', checksum: hash({}) })
      );
      expect(() => run(manifest, output)).toThrow('Phone exports are validation evidence');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test('a GPU session cannot hide a Canvas fallback that recovered before collection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-comparison-'));
  try {
    const manifest = await fixture(directory, 'renderer');
    const output = join(directory, 'comparison.json');
    const path = join(directory, 'session-7.json');
    const original = JSON.parse(await readFile(path, 'utf8'));
    for (const [mutation, error] of [
      [
        (report: typeof original) => {
          const interval = report.details.scenarios[0].intervals[0];
          interval.renderer.frames = { canvas: 1, webgl2: 18749 };
        },
        'Renderer fell back or changed during measurement',
      ],
      [
        (report: typeof original) => {
          report.details.scenarios[0].intervals[0].renderer.backend = 'canvas';
        },
        'Observed renderer backend differs from experiment arm',
      ],
      [
        (report: typeof original) => {
          report.details.scenarios[0].intervals[0].renderer.frames.webgl2--;
        },
        'Renderer observations do not cover every timed frame',
      ],
      [
        (report: typeof original) => {
          report.measurement.parameters.renderer = 'canvas';
        },
        'Requested renderer differs from experiment arm',
      ],
      [
        (report: typeof original) => {
          report.details.scenarios[0].intervals[0].renderer.requested = 'canvas';
        },
        'Observed renderer request differs from experiment arm',
      ],
      [
        (report: typeof original) => {
          delete report.details.scenarios[0].intervals[0].renderer;
        },
        'Expected an object',
      ],
      [
        (report: typeof original) => {
          report.metadata.environment.gpu.renderer.glRenderer = 'different GPU';
        },
        'Device, viewport',
      ],
      [
        (report: typeof original) => {
          report.metadata.git.buildSha256 = hash('different built assets');
          report.finalHashes.buildSha256 = report.metadata.git.buildSha256;
        },
        'Renderer comparison changed built assets',
      ],
    ] as const) {
      const damaged = structuredClone(original);
      mutation(damaged);
      await writeFile(path, JSON.stringify(damaged));
      expect(() => run(manifest, output)).toThrow(error);
    }
    await writeFile(path, JSON.stringify(original));
    const originalManifest = JSON.parse(await readFile(manifest, 'utf8'));
    for (const [mutation, error] of [
      [
        (experiment: typeof originalManifest.experiment) => {
          experiment.candidate.sourceSha256 = hash('other source');
        },
        'Renderer comparison changed source',
      ],
      [
        (experiment: typeof originalManifest.experiment) => {
          experiment.candidate.productSha256 = hash('other product');
        },
        'Renderer comparison changed product',
      ],
      [
        (experiment: typeof originalManifest.experiment) => {
          experiment.candidate.quality.maxDpr = 2;
        },
        'Renderer comparison changed graphics quality',
      ],
      [
        (experiment: typeof originalManifest.experiment) => {
          experiment.candidate.renderer = 'canvas';
        },
        'A renderer experiment changes exactly one backend',
      ],
    ] as const) {
      const damaged = structuredClone(originalManifest);
      mutation(damaged.experiment);
      await writeFile(manifest, JSON.stringify(damaged));
      expect(() => run(manifest, output)).toThrow(error);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
