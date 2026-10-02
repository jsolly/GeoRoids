import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  readSimulationClock,
  SimulationClockProbeError,
} from '../../../benchmarks/fixture-control';

test('a private clock probe retains bounded malformed reply evidence before failing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-clock-reply-'));
  const path = join(directory, 'clock.sock');
  let reply = '{"gameTime":-1,"serverTime":"old"}\n';
  const requests: string[] = [];
  const control = createServer((socket) => {
    socket.on('data', (data) => {
      requests.push(data.toString());
      socket.end(reply);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(path, resolve);
    });
    for (const malformed of [reply, 'null\n', `bad-clock-${'x'.repeat(4096)}\n`]) {
      reply = malformed;
      const result: unknown = await readSimulationClock(path).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(SimulationClockProbeError);
      if (!(result instanceof SimulationClockProbeError)) {
        throw new Error('Malformed clock reply was accepted');
      }
      expect(result.response).toEqual({
        text: malformed.slice(0, 2048),
        characters: malformed.length,
        truncated: malformed.length > 2048,
        parsedType:
          malformed === 'null\n'
            ? 'null'
            : malformed.startsWith('{')
              ? 'object'
              : 'unparsed-truncated',
      });
      expect(result.cause).toBeInstanceOf(Error);
    }
    expect(requests).toEqual(Array(3).fill('{"operation":"readSimulationClock"}\n'));
  } finally {
    try {
      if (control.listening) {
        await new Promise<void>((resolve, reject) =>
          control.close((error) => (error ? reject(error) : resolve()))
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
