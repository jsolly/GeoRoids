import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { prepareFixture } from '../../../benchmarks/fixture-control';

async function invalidFixtureResponse(baseline: Record<string, unknown>): Promise<void> {
  const directory = await mkdtemp('/tmp/georoids-invalid-fixture-');
  const path = join(directory, 'fixture.sock');
  const manifest = {};
  const connections = new Set<Socket>();
  const control = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.setTimeout(1_000, () => socket.destroy());
    let request = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) {
        return;
      }
      request += chunk.toString();
      if (!request.includes('\n')) {
        return;
      }
      handled = true;
      socket.end(
        `${JSON.stringify({
          manifest,
          hash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
          epoch: 1,
          gameTime: 0,
          baselines: [baseline],
          participants: ['pilot'],
        })}\n`
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(path, resolve);
  });
  try {
    await expect(
      prepareFixture(path, { scenario: 'traversal', participants: ['pilot'] })
    ).rejects.toThrow();
  } finally {
    for (const connection of connections) {
      connection.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Fixture control cleanup timed out')),
        1_000
      );
      timeout.unref();
      control.close((error) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    await rm(directory, { recursive: true, force: true });
  }
}

test.each([
  { id: 'pilot', sequence: 1 },
  { id: 'pilot', sequence: 1, motionEpoch: null },
  { id: 'pilot', sequence: 1, motionEpoch: 0 },
  { id: 'pilot', sequence: 1, motionEpoch: 1.5 },
  { id: 'pilot', sequence: 1, motionEpoch: Number.MAX_SAFE_INTEGER + 1 },
])('fixture IPC rejects an unknown or invalid motion epoch', invalidFixtureResponse);
