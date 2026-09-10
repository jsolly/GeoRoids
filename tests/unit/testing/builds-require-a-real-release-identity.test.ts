/* @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import config from '../../../vite.config';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

beforeEach(() => {
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', undefined);
  vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function buildConfig() {
  if (typeof config !== 'function') {
    throw new Error('Expected a Vite config factory');
  }
  return config({ command: 'build', mode: 'production' });
}

test.each(['VERCEL_GIT_COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA'])(
  'hosted builds retain %s when the Git checkout is absent',
  async (variable) => {
    const release = 'a'.repeat(40);
    vi.stubEnv(variable, release);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('Git checkout unavailable');
    });

    const built = await buildConfig();
    expect(built.define?.['import.meta.env.VITE_COMMIT_HASH']).toBe(
      JSON.stringify(release.slice(0, 7))
    );
    expect(execFileSync).not.toHaveBeenCalled();
  }
);

test('local builds embed their Git identity and bound the lookup', async () => {
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', undefined);
  const release = 'b'.repeat(40);
  vi.mocked(execFileSync).mockReturnValue(`${release}\n`);

  const built = await buildConfig();
  expect(built.define?.['import.meta.env.VITE_COMMIT_HASH']).toBe(
    JSON.stringify(release.slice(0, 7))
  );
  expect(execFileSync).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 5000,
  });
});

test('a failed Git lookup stops the build instead of disabling release refresh', () => {
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', undefined);
  const failure = new Error('Git identity lookup timed out');
  vi.mocked(execFileSync).mockImplementation(() => {
    throw failure;
  });

  expect(buildConfig).toThrow(failure);
});

test.each(['', 'unknown', 'abc1234', 'x'.repeat(40)])(
  'an invalid hosted release %j stops the build',
  (release) => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', release);
    expect(buildConfig).toThrow('Cannot build client without a valid Git commit SHA');
  }
);
