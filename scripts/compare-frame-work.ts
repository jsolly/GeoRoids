import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
const { values } = parseArgs({
  options: {
    baseline: { type: 'string', multiple: true },
    candidate: { type: 'string', multiple: true },
    output: { type: 'string' },
    'allow-visual-change': { type: 'boolean', default: false },
  },
});
assert(values.output, 'Supply --output');
const identities = new Set<string>();
async function arm(paths: string[] | undefined) {
  assert(paths && paths.length >= 2, 'Require two independent observations per arm');
  const reports = [];
  for (const path of paths) {
    const raw = await readFile(path, 'utf8');
    const report = record(JSON.parse(raw));
    assert.equal(report['kind'], 'frame-work');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    assert(!identities.has(sha256), 'Reused observation artifact');
    identities.add(sha256);
    const metadata = record(report['metadata']);
    const git = record(metadata['git']);
    for (const key of ['sourceSha256', 'productSha256', 'harnessSha256', 'lockfileSha256']) {
      assert(typeof git[key] === 'string' && /^[a-f0-9]{64}$/.test(git[key]), `Missing ${key}`);
    }
    const result = record(report['result']);
    assert.equal(result['cleanup'], 'complete');
    assert(
      typeof result['frameImageSha256'] === 'string' &&
        /^[a-f0-9]{64}$/.test(result['frameImageSha256']),
      'Missing pixel witness'
    );
    const frames = result['frameWork'];
    assert(Array.isArray(frames) && frames.length === 120, 'Incomplete work ledger');
    const totals: Record<string, number> = {};
    for (const frame of frames) {
      assert.equal(record(frame)['update.calls'], 1);
      assert.equal(record(frame)['render.calls'], 1);
      for (const [key, count] of Object.entries(record(frame))) {
        assert(/^(update|render)\./.test(key), 'Use phase counts, not aggregate aliases');
        assert(typeof count === 'number' && Number.isInteger(count) && count >= 0);
        totals[key] = (totals[key] ?? 0) + count;
      }
    }
    const counts = record(result['counts']);
    for (const [key, count] of Object.entries(totals)) {
      assert.equal(counts[key], count, 'Frame ledger disagrees with aggregate');
    }
    assert.equal(totals['update.calls'], 120);
    assert.equal(totals['render.calls'], 120);
    reports.push({
      path,
      sha256,
      git,
      environment: metadata['environment'],
      result,
      totals,
    });
  }
  const first = reports[0];
  assert(first);
  for (const next of reports.slice(1)) {
    assert.notEqual(next.path, first.path, 'Repeat observations, not file references');
    for (const key of ['frameWork', 'counts', 'witness', 'frameImageSha256', 'parameters']) {
      assert.deepEqual(next.result[key], first.result[key], `Nonrepeatable ${key}`);
    }
    assert.equal(next.git['sourceSha256'], first.git['sourceSha256']);
    assert.deepEqual(next.environment, first.environment);
  }
  return { first, reports };
}
const baseline = await arm(values.baseline);
const candidate = await arm(values.candidate);
assert.equal(baseline.first.git['harnessSha256'], candidate.first.git['harnessSha256']);
assert.equal(baseline.first.git['lockfileSha256'], candidate.first.git['lockfileSha256']);
assert.deepEqual(baseline.first.environment, candidate.first.environment);
assert.deepEqual(baseline.first.result['parameters'], candidate.first.result['parameters']);
for (const key of ['before', 'after']) {
  assert.deepEqual(
    record(baseline.first.result['witness'])[key],
    record(candidate.first.result['witness'])[key],
    'Game outcome changed'
  );
}
const samePixels =
  baseline.first.result['frameImageSha256'] === candidate.first.result['frameImageSha256'];
assert(samePixels || values['allow-visual-change'], 'Rendered pixels changed');
const keys = new Set([
  ...Object.keys(baseline.first.totals),
  ...Object.keys(candidate.first.totals),
]);
const changes = Object.fromEntries(
  [...keys].sort().map((key) => {
    const before = (baseline.first.totals[key] ?? 0) / 120;
    const after = (candidate.first.totals[key] ?? 0) / 120;
    return [
      key,
      { baselinePerFrame: before, candidatePerFrame: after, deltaPerFrame: after - before },
    ];
  })
);
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      exactRepeats: true,
      sameGameOutcome: true,
      sameFinalFramePixels: samePixels,
      changes,
      sources: [...baseline.reports, ...candidate.reports].map(({ path, sha256, git }) => ({
        path,
        sha256,
        git,
      })),
      interpretation:
        'Exact work counts, not weighted CPU cost or proof of faster presentation. Pixel equality covers the final fixture frame.',
    },
    null,
    2
  )}\n`
);
process.stdout.write(`Exact work comparison saved: ${values.output}\n`);
