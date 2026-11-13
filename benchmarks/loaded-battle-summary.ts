import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { allocationAttribution, cpuAttribution } from './profile-attribution';

const directory = process.argv[2];
assert(directory && process.argv.length === 3, 'Expected one loaded-battle artifact directory');
const cpu = await readFile(join(directory, 'server.cpuprofile'));
const heap = await readFile(join(directory, 'server.heapprofile'));
const cpuValue: unknown = JSON.parse(cpu.toString());
const heapValue: unknown = JSON.parse(heap.toString());
await writeFile(
  join(directory, 'attribution.json'),
  JSON.stringify(
    {
      cpuSha256: createHash('sha256').update(cpu).digest('hex'),
      heapSha256: createHash('sha256').update(heap).digest('hex'),
      cpu: cpuAttribution(cpuValue),
      allocation: allocationAttribution(heapValue),
      limitations:
        'Main-isolate sample attribution; not exact allocation counts or worker CPU. Inclusive rows overlap and must not be summed. Profiles include diagnostics and fixture observation; no timing-comparison qualification.',
    },
    null,
    2
  )
);
process.stdout.write(`Saved attribution: ${join(directory, 'attribution.json')}\n`);
