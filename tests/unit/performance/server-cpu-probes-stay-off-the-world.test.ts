// @vitest-environment node
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { expect, test, vi } from 'vitest';
import { readServerProcessUsage, startFixtureControl } from '../../../benchmarks/fixture-control';
import {
  captureServerProcessUsage,
  parseServerProcessUsage,
} from '../../../benchmarks/server-process-usage';
import { readBenchmarkCompression } from '../../../benchmarks/websocket-compression';
import { createServerInstance } from '../../../server/createServer';

test.each(['deflate-level1-no-context', 'deflate-level1-no-context-8k'] as const)(
  'CPU replies retain cumulative whole-process microseconds and the distinct %s mode',
  (mode) => {
    const cpu = vi.spyOn(process, 'cpuUsage').mockReturnValue({ user: 12345, system: 6789 });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100.25);
    try {
      expect(captureServerProcessUsage(mode)).toEqual({
        user: 12345,
        system: 6789,
        monotonicMs: 100.25,
        compression: mode,
      });
      expect(cpu).toHaveBeenCalledTimes(1);
      expect(clock).toHaveBeenCalledTimes(1);
    } finally {
      cpu.mockRestore();
      clock.mockRestore();
    }
  }
);

test('a malformed or ambiguous private CPU reply cannot enter a compression comparison', () => {
  const valid = { user: 12, system: 3, monotonicMs: 1.25, compression: 'none' };
  expect(parseServerProcessUsage(valid)).toEqual(valid);
  const wider = { ...valid, compression: 'deflate-level1-no-context-8k' };
  expect(parseServerProcessUsage(wider)).toEqual(wider);
  for (const malformed of [
    null,
    [],
    { ...valid, user: -1 },
    { ...valid, system: 0.5 },
    { ...valid, user: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, system: Number.POSITIVE_INFINITY },
    { ...valid, monotonicMs: Number.NaN },
    { ...valid, monotonicMs: -1 },
    { ...valid, compression: 'true' },
    { ...valid, compression: 'deflate-level1-no-context-8k ' },
    { ...valid, diagnostics: Array(100).fill('not a scalar probe') },
    { user: 12, system: 3, compression: 'none' },
  ]) {
    expect(() => parseServerProcessUsage(malformed)).toThrow('Invalid server process usage');
  }
});

test.each(['none', 'deflate-level1-no-context-8k'] as const)(
  'a private %s CPU request reads no world rows or simulation clock and retains its socket permission',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'georoids-server-cpu-'));
    const path = join(directory, 'fixture.sock');
    const tuning = readBenchmarkCompression(mode);
    const server = createServerInstance({
      port: 0,
      nodeEnv: 'test',
      seed: 42,
      perMessageDeflate: tuning.perMessageDeflate,
    });
    let closeControl: (() => Promise<void>) | undefined;
    const clock = vi.spyOn(server.gameEngine, 'getSimulationClock');
    const snapshot = vi.spyOn(server.gameEngine, 'getSnapshotState');
    const asteroids = vi.spyOn(server.gameEngine, 'getAllAsteroids');
    try {
      await server.listening;
      server.gameEngine.stopGameLoop();
      closeControl = await startFixtureControl(server, path, 42, mode);
      clock.mockClear();
      snapshot.mockClear();
      asteroids.mockClear();
      const first = await readServerProcessUsage(path);
      const second = await readServerProcessUsage(path);
      expect(first.compression).toBe(mode);
      expect(second.user).toBeGreaterThanOrEqual(first.user);
      expect(second.system).toBeGreaterThanOrEqual(first.system);
      expect(second.monotonicMs).toBeGreaterThanOrEqual(first.monotonicMs);
      expect(Buffer.byteLength(JSON.stringify(second), 'utf8')).toBeLessThanOrEqual(512);
      expect(clock).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(asteroids).not.toHaveBeenCalled();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      clock.mockRestore();
      snapshot.mockRestore();
      asteroids.mockRestore();
      try {
        await closeControl?.();
      } finally {
        try {
          await server.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
);
