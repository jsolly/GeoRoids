import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const METRICS = [
  'firstKeyframeBytes',
  'snapshotPayloadBytes',
  'atlasFieldBytes',
  'snapshotFrames',
  'acknowledgementPayloadBytes',
  'framedDownstreamBytes',
  'framedAcknowledgementBytes',
];
const WINDOWS = ['initial-baseline', 'same-socket-unchanged-resync', 'same-socket-one-tile-resync'];
const HASH = /^[0-9a-f]{64}$/u;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function numeric(value: unknown): number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  return value;
}
function read(path: string) {
  const receipt: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert(object(receipt) && receipt['version'] === 1 && Array.isArray(receipt['windows']));
  const fixture = receipt['fixtureSha256'];
  const harness = receipt['harnessSha256'];
  const node = receipt['node'];
  assert(
    typeof fixture === 'string' &&
      HASH.test(fixture) &&
      typeof harness === 'string' &&
      HASH.test(harness) &&
      typeof node === 'string'
  );
  const windows = receipt['windows'].map((entry: unknown) => {
    assert(
      object(entry) &&
        typeof entry['name'] === 'string' &&
        typeof entry['completeWorldSha256'] === 'string' &&
        HASH.test(entry['completeWorldSha256'])
    );
    return {
      name: entry['name'],
      world: entry['completeWorldSha256'],
      metrics: Object.fromEntries(METRICS.map((name) => [name, numeric(entry[name])])),
    };
  });
  assert(
    windows.length === WINDOWS.length &&
      new Set(windows.map((entry) => entry.name)).size === WINDOWS.length
  );
  return { fixture, harness, node, windows };
}

/** Compare only the exact same fixture/harness/runtime. A smaller first frame
 * does not imply lower total cold-join traffic; both quantities remain explicit. */
export function compareAtlasResync(beforePath: string, afterPath: string) {
  const before = read(beforePath);
  const after = read(afterPath);
  assert.equal(before.fixture, after.fixture, 'Fixture changed');
  assert.equal(before.harness, after.harness, 'Common harness changed');
  assert.equal(before.node, after.node, 'Node runtime changed');
  return WINDOWS.map((name) => {
    const left = before.windows.find((entry) => entry.name === name);
    const right = after.windows.find((entry) => entry.name === name);
    assert(left && right, 'Missing measurement window');
    assert.equal(left.world, right.world, `Complete reconstructed world changed in ${name}`);
    if (name === 'same-socket-unchanged-resync') {
      assert.equal(right.metrics['atlasFieldBytes'], 0, 'Unchanged recovery repeated atlas');
    }
    return {
      name,
      completeWorldSha256: left.world,
      before: left.metrics,
      after: right.metrics,
      delta: Object.fromEntries(
        METRICS.map((metric) => [
          metric,
          numeric(right.metrics[metric]) - numeric(left.metrics[metric]),
        ])
      ),
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [before, after, output] = process.argv.slice(2);
  assert(
    before && after && output && process.argv.length === 5,
    'Expected before.json after.json comparison.json'
  );
  writeFileSync(
    output,
    `${JSON.stringify({ version: 1, windows: compareAtlasResync(before, after) }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 }
  );
}
