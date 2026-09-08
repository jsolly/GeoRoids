import { expect, test } from 'vitest';
import { resolveServerLogLevel, ServerLogLevel } from '../../../setup/serverLogger';

test('production defaults to INFO so 30 Hz game-state debug stays off', () => {
  expect(resolveServerLogLevel({ NODE_ENV: 'production' })).toBe(ServerLogLevel.INFO);
});

test('non-production defaults to DEBUG and SERVER_LOG_LEVEL wins', () => {
  expect(resolveServerLogLevel({ NODE_ENV: 'development' })).toBe(ServerLogLevel.DEBUG);
  expect(resolveServerLogLevel({ NODE_ENV: 'production', SERVER_LOG_LEVEL: 'debug' })).toBe(
    ServerLogLevel.DEBUG
  );
  expect(resolveServerLogLevel({ NODE_ENV: 'development', SERVER_LOG_LEVEL: 'warn' })).toBe(
    ServerLogLevel.WARN
  );
});
