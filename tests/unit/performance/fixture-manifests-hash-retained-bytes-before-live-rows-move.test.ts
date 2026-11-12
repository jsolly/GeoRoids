import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { writeFixtureManifest } from '../../../benchmarks/fixture-manifest';

test('a live rock can move during the write without changing the retained fixture digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-fixture-manifest-'));
  try {
    const path = join(directory, 'fixture.json');
    const rock = { position: { x: 5, y: 10 } };
    const written = writeFixtureManifest(path, rock);
    rock.position.x = 999;
    const hash = await written;
    const bytes = await readFile(path);
    expect(bytes.toString()).toBe('{"position":{"x":5,"y":10}}');
    expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(hash).not.toBe(createHash('sha256').update(JSON.stringify(rock)).digest('hex'));
  } finally {
    await rm(directory, { recursive: true });
  }
});
