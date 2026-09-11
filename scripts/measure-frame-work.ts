import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { runClientSample } from '../benchmarks/client';
import { evaluateFrameWorkBudget } from '../benchmarks/frame-work-budget';
import { collectLiveReportMetadata } from '../benchmarks/live-report';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    budget: { type: 'string' },
    viewport: { type: 'string', default: 'touch-portrait' },
  },
});
assert(values.output, 'Supply --output <report.json>');
assert(
  values.viewport === 'desktop' ||
    values.viewport === 'touch-portrait' ||
    values.viewport === 'touch-landscape',
  'Unknown viewport'
);
const metadata = collectLiveReportMetadata();
const result = await runClientSample({
  seed: 42,
  viewport: values.viewport,
  warmupFrames: 30,
  measuredFrames: 120,
});
const finalMetadata = collectLiveReportMetadata();
assert.deepEqual(finalMetadata.git, metadata.git, 'Source changed during observation');
assert.equal(result.frameWork.length, 120, 'Incomplete frame work ledger');
assert(result.frameImageSha256, 'Missing rendered image witness');
await mkdir(dirname(values.output), { recursive: true });
await writeFile(
  values.output,
  `${JSON.stringify({ kind: 'frame-work', metadata, result }, null, 2)}\n`
);
if (values.budget) {
  const budget: unknown = JSON.parse(await readFile(values.budget, 'utf8'));
  const observations = evaluateFrameWorkBudget(budget, values.viewport, result.frameWork);
  await writeFile(
    values.output,
    `${JSON.stringify(
      {
        kind: 'frame-work',
        metadata,
        result,
        performanceBudget: { policy: 'report-only', observations },
      },
      null,
      2
    )}\n`
  );
}
process.stdout.write(`Recorded 120 frame work vectors: ${values.output}\n`);
