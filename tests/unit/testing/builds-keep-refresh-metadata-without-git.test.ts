/* @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clientViteConfig } from '../../../scripts/client-build';

const buildTokenBytes = vi.hoisted(() => vi.fn<(size: number) => Buffer>());
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:crypto', () => ({ randomBytes: buildTokenBytes }));

beforeEach(() => {
  buildTokenBytes.mockReturnValue(Buffer.from('d'.repeat(40), 'hex'));
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', undefined);
  vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

const buildConfig = clientViteConfig;

test.each(['VERCEL_GIT_COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA'])(
  'hosted builds retain %s when the Git checkout is absent',
  (variable) => {
    const release = 'a'.repeat(40);
    vi.stubEnv(variable, release);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('Git checkout unavailable');
    });

    const built = buildConfig();
    expect(built.define?.['import.meta.env.VITE_COMMIT_HASH']).toBe(
      JSON.stringify(release.slice(0, 7))
    );
    expect(built.define?.['import.meta.env.VITE_COMMIT_SHA']).toBe(JSON.stringify(release));
    expect(execFileSync).not.toHaveBeenCalled();
  }
);

test('local builds embed their Git identity and bound the lookup', () => {
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', undefined);
  const release = 'b'.repeat(40);
  vi.mocked(execFileSync).mockReturnValue(`${release}\n`);

  const built = buildConfig();
  expect(built.define?.['import.meta.env.VITE_COMMIT_HASH']).toBe(
    JSON.stringify(release.slice(0, 7))
  );
  expect(built.define?.['import.meta.env.VITE_COMMIT_SHA']).toBe(JSON.stringify(release));
  expect(execFileSync).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});

test('a failed Git lookup still builds with one token shared by client and refresh metadata', () => {
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', undefined);
  const failure = new Error('Git identity lookup timed out');
  vi.mocked(execFileSync).mockImplementation(() => {
    throw failure;
  });

  const built = buildConfig();
  expect(built.define?.['import.meta.env.VITE_COMMIT_SHA']).toBe(JSON.stringify('d'.repeat(40)));
  expect(built.define?.['import.meta.env.VITE_COMMIT_HASH']).toBe(JSON.stringify('d'.repeat(7)));
  expect(randomBytes).toHaveBeenCalledWith(20);
  const plugin = built.plugins.find((candidate) => candidate.name === 'client-release-manifest');
  if (!plugin || typeof plugin.generateBundle !== 'function') {
    throw new Error('Missing release manifest emission');
  }
  const emitted: unknown[] = [];
  Reflect.apply(plugin.generateBundle, { emitFile: (asset: unknown) => emitted.push(asset) }, [
    {},
    {},
  ]);
  expect(emitted).toEqual([
    {
      type: 'asset',
      fileName: 'release.json',
      source: JSON.stringify({ releaseSha: 'd'.repeat(40) }),
    },
  ]);
});

test('empty VERCEL_GIT_COMMIT_SHA still uses a valid RAILWAY_GIT_COMMIT_SHA', () => {
  const release = 'c'.repeat(40);
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
  vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', release);
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('Git checkout unavailable');
  });

  const built = buildConfig();
  expect(built.define?.['import.meta.env.VITE_COMMIT_HASH']).toBe(
    JSON.stringify(release.slice(0, 7))
  );
  expect(built.define?.['import.meta.env.VITE_COMMIT_SHA']).toBe(JSON.stringify(release));
  expect(execFileSync).not.toHaveBeenCalled();
});

test.each(['', 'unknown', 'abc1234', 'x'.repeat(40)])(
  'an invalid hosted release %j falls through to Git',
  (release) => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', release);
    const gitSha = 'b'.repeat(40);
    vi.mocked(execFileSync).mockReturnValue(`${gitSha}\n`);

    const built = buildConfig();
    expect(built.define?.['import.meta.env.VITE_COMMIT_SHA']).toBe(JSON.stringify(gitSha));
    expect(execFileSync).toHaveBeenCalled();
  }
);

test('invalid Git metadata falls back to a build token', () => {
  vi.mocked(execFileSync).mockReturnValue('not-a-sha\n');
  expect(buildConfig().define?.['import.meta.env.VITE_COMMIT_SHA']).toBe(
    JSON.stringify('d'.repeat(40))
  );
});
