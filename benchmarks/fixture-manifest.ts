import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

/** Capture live rows before yielding; the digest always describes the retained bytes. */
export async function writeFixtureManifest(path: string, value: object): Promise<string> {
  const text = JSON.stringify(value);
  assert(typeof text === 'string');
  const hash = createHash('sha256').update(text).digest('hex');
  await writeFile(path, text);
  return hash;
}
