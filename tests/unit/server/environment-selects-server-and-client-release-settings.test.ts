import { afterEach, expect, test, vi } from 'vitest';
import { readServerConfiguration } from '../../../server/configuration';
import { getBuildInfoString } from '../../../src/utils/buildInfo';

afterEach(() => vi.unstubAllEnvs());

test('an unconfigured server uses production defaults and port 3001', () => {
  expect(readServerConfiguration({})).toEqual({
    port: 3001,
    nodeEnv: 'production',
    requireEnhancedClient: false,
  });
});

test('configured server values select the listener, environment and supported clients', () => {
  expect(
    readServerConfiguration({ PORT: '8080', NODE_ENV: 'development', REQUIRE_ASTEROID_CLIENT: '1' })
  ).toEqual({
    port: 8080,
    nodeEnv: 'development',
    requireEnhancedClient: true,
  });
  expect(readServerConfiguration({ PORT: '0', REQUIRE_ASTEROID_CLIENT: '0' }).port).toBe(0);
  expect(readServerConfiguration({ PORT: '', NODE_ENV: '' })).toMatchObject({
    port: 3001,
    nodeEnv: 'production',
  });
});

test.each(['broken', '-1', '65536', '80.5', 'Infinity'])(
  'an invalid listener port %s fails startup configuration',
  (port) => {
    expect(() => readServerConfiguration({ PORT: port })).toThrow(
      'PORT must be an integer between 0 and 65535'
    );
  }
);

test('deployed client build information uses the injected release identity', () => {
  vi.stubEnv('VITE_COMMIT_HASH', 'abc1234567890');
  vi.stubEnv('VITE_BUILD_TIME', '2026-09-07T00:00:00.000Z');
  vi.stubEnv('MODE', 'production');
  const label = getBuildInfoString();
  expect(label).toContain('abc1234567890');
  expect(label).toContain(new Date('2026-09-07T00:00:00.000Z').toLocaleDateString());
});

test('a local client without injected release metadata stays labeled dev', () => {
  vi.stubEnv('VITE_COMMIT_HASH', undefined);
  vi.stubEnv('VITE_BUILD_TIME', undefined);
  vi.stubEnv('MODE', 'development');
  expect(getBuildInfoString()).toBe('dev');
});
