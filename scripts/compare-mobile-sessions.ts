import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectInputCadence } from '../benchmarks/input-cadence';
import { compareMobileSessions } from '../benchmarks/mobile-comparison';
import { inspectReleaseEvidence } from '../benchmarks/release-evidence';
import { canonicalJson } from '../benchmarks/results';

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  return Object.fromEntries(Object.entries(value));
}
function number(value: unknown) {
  assert(
    typeof value === 'number' && Number.isFinite(value) && value >= 0,
    'Invalid numeric sample'
  );
  return value;
}
function percentile(samples: number[], fraction: number) {
  assert(samples.length > 0, 'Missing raw timing samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const value = sorted[Math.ceil(sorted.length * fraction) - 1];
  assert(value !== undefined);
  return value;
}
const { values } = parseArgs({
  options: { manifest: { type: 'string' }, output: { type: 'string' } },
});
assert(
  values.manifest && values.output,
  'Usage: --manifest <session-pairs.json> --output <comparison.json>'
);
const manifestPath = resolve(values.manifest);
const manifest = record(JSON.parse(await readFile(manifestPath, 'utf8')));
const cohort = manifest['cohort'];
const scenario = manifest['scenario'];
assert(
  typeof cohort === 'string' && cohort.length > 0,
  'Name the exact device/browser/OS/settings cohort'
);
assert(scenario === 'traversal' || scenario === 'combat', 'Declare traversal or combat');
const experiment = record(manifest['experiment']);
assert(
  experiment['kind'] === 'quality' || experiment['kind'] === 'product',
  'Declare quality or product experiment'
);
function hash(value: unknown) {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Missing SHA-256 provenance');
  return value;
}
const harnessHash = hash(experiment['harnessSha256']);
const lockfileHash = hash(experiment['lockfileSha256']);
const fixtureHash = hash(experiment['fixtureHash']);
function parseQuality(value: unknown) {
  const quality = record(value);
  assert(
    quality['maxDpr'] === 'native' || quality['maxDpr'] === 2 || quality['maxDpr'] === 1.5,
    'Declare maxDpr native, 2 or 1.5'
  );
  assert(quality['glow'] === 'full' || quality['glow'] === 'off', 'Declare glow full or off');
  return { maxDpr: quality['maxDpr'], glow: quality['glow'] };
}
function parseArm(value: unknown) {
  const arm = record(value);
  return {
    sourceSha256: hash(arm['sourceSha256']),
    productSha256: hash(arm['productSha256']),
    quality: parseQuality(arm['quality']),
  };
}
const baseline = parseArm(experiment['baseline']);
const candidate = parseArm(experiment['candidate']);
if (experiment['kind'] === 'quality') {
  assert.equal(baseline.sourceSha256, candidate.sourceSha256, 'Quality comparison changed source');
  assert.equal(
    baseline.productSha256,
    candidate.productSha256,
    'Quality comparison changed product'
  );
  assert(
    Number(baseline.quality.maxDpr !== candidate.quality.maxDpr) +
      Number(baseline.quality.glow !== candidate.quality.glow) ===
      1,
    'A quality experiment changes exactly one setting'
  );
} else {
  assert.notEqual(
    baseline.productSha256,
    candidate.productSha256,
    'Product comparison needs changed product'
  );
  assert.notEqual(
    baseline.sourceSha256,
    candidate.sourceSha256,
    'Product comparison needs changed source'
  );
  assert.deepEqual(
    baseline.quality,
    candidate.quality,
    'Product comparison changed graphics quality'
  );
}
const sources: Array<{
  path: string;
  sha256: string;
  sessionId: unknown;
  device: string;
  summary: object;
  provenance: object;
  workload: object;
  measuredAt: { start: number; end: number };
}> = [];
const paths = new Set<string>();
const identities = new Set<string>();
async function summarize(path: unknown, arm: ReturnType<typeof parseArm>) {
  const quality = arm.quality;
  assert(typeof path === 'string', 'Pairs must contain raw report file paths');
  const absolute = resolve(dirname(manifestPath), path);
  assert(!paths.has(absolute), 'A raw session cannot be reused in multiple pairs');
  paths.add(absolute);
  const raw = await readFile(absolute, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  assert(!identities.has(sha256), 'Duplicate raw session contents');
  identities.add(sha256);
  const report = record(JSON.parse(raw));
  assert(
    !('content' in report),
    'Phone exports are validation evidence; controlled browser comparisons require automated source and fixture provenance'
  );
  let measuredAt = { start: 0, end: 0 };
  let intervals: unknown;
  let health: unknown;
  let device: string;
  let sessionId: unknown;
  const metadataRoot = record(report['metadata']);
  const provenance = record(metadataRoot['git']);
  const finalHashes = record(report['finalHashes']);
  for (const [name, expected] of Object.entries({
    sourceSha256: arm.sourceSha256,
    productSha256: arm.productSha256,
    harnessSha256: harnessHash,
    lockfileSha256: lockfileHash,
  })) {
    assert.equal(provenance[name], expected, `Unexpected ${name} for experiment arm`);
    if (name !== 'lockfileSha256') {
      assert.equal(finalHashes[name], expected, `${name} changed during session`);
    }
  }
  assert.equal(
    hash(finalHashes['buildSha256']),
    hash(provenance['buildSha256']),
    'Build changed during session'
  );
  const environment = record(metadataRoot['environment']);
  for (const key of ['nodeVersion', 'os', 'osRelease', 'arch', 'cpuModel']) {
    assert(
      typeof environment[key] === 'string' &&
        environment[key] !== 'unknown' &&
        environment[key] !== '',
      `Missing environment ${key}`
    );
  }
  const browserIdentity = record(environment['browser']);
  assert(
    typeof browserIdentity['name'] === 'string' &&
      typeof browserIdentity['version'] === 'string' &&
      Array.isArray(browserIdentity['launchFlags']),
    'Missing browser environment'
  );
  assert(typeof record(environment['gpu'])['supported'] === 'boolean', 'Missing GPU observation');
  assert.equal(
    environment['physicalDevice'],
    false,
    'This gate compares automated browser sessions'
  );
  assert(
    ['host', 'emulated-touch'].includes(String(environment['measurementSource'])),
    'Unsupported measurement source'
  );
  let workloadEvidence: object;
  {
    assert.equal(report['kind'], 'realtime-client', 'Expected a real-time client report');
    assert.equal(report['status'], 'passed', 'Benchmark session failed');
    const parameters = record(record(report['measurement'])['parameters']);
    assert.equal(parameters['workload'], scenario, 'Benchmark workload differs from manifest');
    assert.equal(
      parameters['profileRecorded'],
      false,
      'CPU profiling disqualifies timing comparisons'
    );
    const details = record(report['details']);
    assert(
      Array.isArray(details['scenarios']) && details['scenarios'].length === 1,
      'Record one viewport per comparison report'
    );
    const run = record(details['scenarios'][0]);
    const window = record(run['serverMeasurement']);
    assert(
      typeof window['startedAt'] === 'string' && typeof window['endedAt'] === 'string',
      'Missing measurement chronology'
    );
    measuredAt = { start: Date.parse(window['startedAt']), end: Date.parse(window['endedAt']) };
    assert(
      Number.isFinite(measuredAt.start) && measuredAt.end > measuredAt.start,
      'Invalid measurement chronology'
    );
    assert.equal(run['status'], 'passed');
    assert.equal(
      record(run['departure'])['confirmedEmpty'],
      true,
      'Scenario departure not confirmed'
    );
    const fixtures = run['fixtures'];
    assert(Array.isArray(fixtures) && fixtures.length > 0, 'Missing prepared fixture');
    for (const rawFixture of fixtures) {
      const fixture = record(rawFixture);
      assert.equal(fixture['hash'], fixtureHash, 'Workload fixture differs from manifest');
      assert.equal(
        createHash('sha256').update(JSON.stringify(fixture['manifest'])).digest('hex'),
        fixtureHash,
        'Fixture content hash mismatch'
      );
    }
    const population = run['populationSamples'];
    assert(Array.isArray(population), 'Missing population evidence');
    const measuredPopulation = population
      .map(record)
      .filter((sample) => sample['measured'] === true);
    assert(measuredPopulation.length > 0, 'Missing measured population evidence');
    const distributions: Record<string, object> = {};
    for (const entity of ['humans', 'bots', 'asteroids', 'satellites', 'pickups', 'projectiles']) {
      for (const count of ['total', 'visibleCenters']) {
        const values = measuredPopulation.map((sample) =>
          number(record(record(sample['counts'])[entity])[count])
        );
        distributions[`${entity}.${count}`] = {
          min: Math.min(...values),
          median: percentile(values, 0.5),
          max: Math.max(...values),
        };
      }
    }
    assert(Array.isArray(run['peers']), 'Missing protocol peer evidence');
    assert.equal(
      run['peers'].length,
      scenario === 'combat' ? 4 : 0,
      'Wrong protocol peer population'
    );
    const peers = run['peers'].map(record);
    for (const peer of peers) {
      assert.equal(peer['joined'], true, 'Peer did not finish joined');
      assert.equal(peer['completedScenario'], true, 'Peer scenario incomplete');
      for (const key of [
        'acknowledgedMotionStates',
        'measuredMotionCommands',
        'measuredStates',
        'observedMeasuredServerProjectiles',
        'measuredPings',
      ]) {
        assert(number(peer[key]) > 0, `Missing peer ${key}`);
      }
      assert.equal(number(peer['omittedDecodeSamples']), 0, 'Peer decode samples omitted');
      assert.equal(number(peer['unansweredMeasuredPings']), 0, 'Peer RTT probe unanswered');
      assert(
        Array.isArray(peer['stateIntervalMs']) &&
          peer['stateIntervalMs'].length === peer['measuredStates'],
        'Peer state coverage incomplete'
      );
    }
    assert(number(run['acknowledgedMotionStates']) > 0, 'Missing authoritative motion witness');
    assert(number(run['observedProjectiles']) > 0, 'Missing authoritative shot witness');
    assert(number(run['inputSteps']) >= 300, 'Missing repeated trusted inputs');
    assert(Array.isArray(run['restarts']), 'Missing rejoin ledger');
    assert(Array.isArray(run['inputActions']), 'Missing offered input cadence');
    const actions = run['inputActions'].map(record).filter((action) => action['measured'] === true);
    assert(actions.length >= 300, 'Missing 300 measured input actions');
    const actionGaps: number[] = [];
    let previousStart: number | undefined;
    for (const action of actions) {
      const start = number(action['startedAt']);
      assert(number(action['completedAt']) >= start, 'Input action did not complete');
      if (previousStart !== undefined) {
        assert(start > previousStart, 'Input cadence is not monotonic');
        actionGaps.push(start - previousStart);
      }
      previousStart = start;
    }
    const { lateness, recoverySkippedSlots } = inspectInputCadence(
      run['inputSchedule'],
      run['restarts']
    );
    workloadEvidence = {
      fixtureHash,
      peers,
      distributions,
      populationSamples: measuredPopulation,
      restarts: run['restarts'],
      acknowledgedMotionStates: run['acknowledgedMotionStates'],
      observedProjectiles: run['observedProjectiles'],
      inputSteps: run['inputSteps'],
      inputActions: actions,
      inputSchedule: run['inputSchedule'],
      recoverySkippedSlots,
      inputSlotLatenessMs: { p95: percentile(lateness, 0.95), max: Math.max(...lateness) },
      inputCadenceMs: {
        min: Math.min(...actionGaps),
        median: percentile(actionGaps, 0.5),
        p95: percentile(actionGaps, 0.95),
        max: Math.max(...actionGaps),
      },
    };

    const metadata = record(run['metadata']);
    assert(
      typeof metadata['userAgent'] === 'string' && metadata['userAgent'].length > 0,
      'Missing browser identity'
    );
    device = JSON.stringify({
      source: 'automated',
      environment,
      parameters: Object.fromEntries(
        Object.entries(parameters).filter(([key]) => !['renderDpr', 'renderGlow'].includes(key))
      ),
      userAgent: metadata['userAgent'],
      css: metadata['css'],
      dpr: metadata['dpr'],
      cpuSlowdown: parameters['cpuSlowdown'],
      network: parameters['network'],
      seed: parameters['seed'],
    });
    intervals = run['intervals'];
    health = run['health'];
    sessionId = sha256;
  }
  assert(Array.isArray(intervals) && intervals.length > 0, 'Missing raw intervals');
  const samples: Record<string, number[]> = {
    frameIntervalMs: [],
    frameCpuMs: [],
    inputToRenderMs: [],
  };
  let wallSeconds = 0;
  const phaseDurationsMs: Record<string, number> = {};
  const geometry = new Set<string>();
  const releaseEvidence = inspectReleaseEvidence(intervals, health);
  for (const rawInterval of intervals) {
    const interval = record(rawInterval);
    const duration = number(interval['durationMs']);
    wallSeconds += duration / 1000;
    const phases = record(interval['phaseDurationsMs']);
    let phaseTotal = 0;
    for (const [phase, value] of Object.entries(phases)) {
      const milliseconds = number(value);
      phaseTotal += milliseconds;
      phaseDurationsMs[phase] = (phaseDurationsMs[phase] ?? 0) + milliseconds;
    }
    assert(Math.abs(phaseTotal - duration) < 10, 'Incomplete phase duration ledger');
    const graphics = record(interval['graphicsSettings']);
    assert.deepEqual(
      { maxDpr: graphics['maxDpr'], glow: graphics['glow'] },
      quality,
      'Graphics settings differ from declared comparison arm'
    );
    const deviceDpr = number(graphics['deviceDpr']);
    const cssWidth = number(graphics['cssWidth']);
    const cssHeight = number(graphics['cssHeight']);
    assert(deviceDpr > 0 && cssWidth > 0 && cssHeight > 0, 'Missing viewport or device DPR');
    geometry.add(
      JSON.stringify({ deviceDpr, cssWidth, cssHeight, touchControls: graphics['touchControls'] })
    );
    const counters = record(interval['counters']);
    for (const name of [
      'invalidSamples',
      'messageFailures',
      'joinFailures',
      'frameFailures',
      'recoveryFailures',
    ]) {
      assert.equal(counters[name] ?? 0, 0, `Session recorded ${name}`);
    }
    for (const [name, rawMetric] of Object.entries(record(interval['metrics']))) {
      const metric = record(rawMetric);
      assert.equal(metric['omittedSamples'], 0, `Omitted ${name} samples`);
      const [phase, suffix] = name.split('.');
      if ((phase !== 'play' && phase !== 'respawn') || !suffix || !(suffix in samples)) {
        continue;
      }
      const destination = samples[suffix];
      assert(destination && Array.isArray(metric['values']));
      assert.equal(metric['values'].length, metric['count'], `Missing raw ${name} values`);
      for (const value of metric['values']) {
        destination.push(number(value));
      }
    }
  }
  const frames = samples['frameIntervalMs'];
  const cpu = samples['frameCpuMs'];
  const input = samples['inputToRenderMs'];
  assert(frames?.length && cpu && input);
  assert(geometry.size === 1, 'Viewport/DPR changed during timing session');
  device = canonicalJson({ identity: JSON.parse(device), geometry: [...geometry] });
  // Product arms may deliberately change release; source/build hashes identify their actual code.
  const releaseIdentity = [
    JSON.stringify({
      clientRelease: releaseEvidence.clientRelease,
      serverRelease: releaseEvidence.serverRelease,
    }),
  ];
  const measuredSeconds =
    ((phaseDurationsMs['play'] ?? 0) + (phaseDurationsMs['respawn'] ?? 0)) / 1000;
  assert(
    measuredSeconds / wallSeconds >= 0.95,
    'Controlled timing requires at least95% foreground gameplay; use separate lifecycle recordings'
  );
  assert(Math.abs(cpu.length - frames.length) <= 2, 'Frame CPU and interval sample counts differ');
  assert(input.length <= cpu.length, 'Input latency samples exceed rendered frame count');
  const frameCoverage = frames.reduce((sum, value) => sum + value, 0) / (measuredSeconds * 1000);
  assert(
    frameCoverage >= 0.95 && frameCoverage <= 1.05,
    'Frame intervals do not cover foreground duration'
  );
  const summary = {
    cohort,
    scenario,
    measuredSeconds,
    wallSeconds,
    phaseDurationsMs,
    quality,
    frameOver25Ratio: frames.filter((value) => value > 25).length / frames.length,
    frameP99Ms: percentile(frames, 0.99),
    cpuP95Ms: percentile(cpu, 0.95),
    inputP95Ms: percentile(input, 0.95),
    inputCount: input.length,
  };
  sources.push({
    path: absolute,
    sha256,
    sessionId,
    device,
    summary,
    provenance: { ...provenance, releases: releaseIdentity, releaseEvidence },
    workload: workloadEvidence,
    measuredAt,
  });
  return summary;
}
const candidateArm = candidate;
async function loadPairs(value: unknown, candidate: boolean) {
  assert(Array.isArray(value) && value.length >= 3, 'At least three pairs are required');
  const pairs = [];
  for (const pair of value) {
    assert(Array.isArray(pair) && pair.length === 2, 'Each pair contains exactly two report paths');
    pairs.push([
      await summarize(pair[0], baseline),
      await summarize(pair[1], candidate ? candidateArm : baseline),
    ]);
  }
  return pairs;
}
const aa = await loadPairs(manifest['aa'], false);
const ab = await loadPairs(manifest['ab'], true);
// Pairs are normalized baseline/candidate in JSON; validate actual alternating execution.
const aaSources = sources.slice(0, aa.length * 2);
const chronological = [...aaSources];
for (let index = 0; index < ab.length; index++) {
  const a = sources[aaSources.length + index * 2];
  const b = sources[aaSources.length + index * 2 + 1];
  assert(a && b);
  chronological.push(...(index % 2 === 0 ? [a, b] : [b, a]));
}
for (let index = 1; index < chronological.length; index++) {
  const previous = chronological[index - 1];
  const next = chronological[index];
  assert(
    previous && next && next.measuredAt.start >= previous.measuredAt.end,
    'Sessions overlap or A/B order did not alternate'
  );
}
assert(
  new Set(sources.map((source) => source.device)).size === 1,
  'Device, viewport, CPU, network or seed changed across pairs'
);
assert(
  new Set(sources.map((source) => source.sessionId)).size === sources.length,
  'Duplicate session IDs'
);
for (const sourceHash of new Set(
  sources.map((source) => record(source.provenance)['sourceSha256'])
)) {
  const releases = sources
    .filter((source) => record(source.provenance)['sourceSha256'] === sourceHash)
    .map((source) => canonicalJson(record(source.provenance)['releases']));
  assert(new Set(releases).size === 1, 'Release identity changed within one source arm');
}
const result = compareMobileSessions({ aa, ab });
await writeFile(
  values.output,
  `${JSON.stringify({ ...result, experiment, workloadReviewRequired: true, sources }, null, 2)}\n`
);
process.stdout.write(`${result.relativeResult}: ${values.output}\n`);
