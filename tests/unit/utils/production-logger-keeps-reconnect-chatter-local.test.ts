import { expect, test, vi } from 'vitest';

const forwarding = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('../../../src/utils/logForwarder', () => ({
  startClientLogForwarder: vi.fn(),
  forwardLogToServer: forwarding.send,
}));

vi.mock('../../../src/utils/logForwardPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logForwardPolicy')>();
  return {
    shouldForwardClientLog: (
      level: 'debug' | 'info' | 'warn' | 'error',
      category: string,
      _production: boolean,
      message = ''
    ) => actual.shouldForwardClientLog(level, category, true, message),
  };
});

vi.mock('../../../src/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants')>();
  return {
    ...actual,
    LOGGING: { ...actual.LOGGING, WRITE_TO_CONSOLE: false, FORWARD_TO_SERVER: true },
  };
});

import { logger } from '../../../src/utils/Logger';

test('the production logger keeps reconnect chatter off the log socket', async () => {
  for (const message of [
    'reconnect_scheduled',
    'transport_closed',
    'transport_connected',
    'player_joined',
    'snapshot_applied',
    'damage_applied',
  ]) {
    logger.info('STATE', message);
  }
  await Promise.resolve();
  expect(forwarding.send).not.toHaveBeenCalled();

  logger.info('STATE', 'player_died');
  logger.info('STATE', 'player_respawned');
  logger.warn('NETWORK', 'WebSocket connection closed');
  await vi.waitFor(() => expect(forwarding.send).toHaveBeenCalledTimes(3));
  const forwarded = forwarding.send.mock.calls.map((call) => String(call[0]));
  expect(forwarded.some((line) => line.includes('player_died'))).toBe(true);
  expect(forwarded.some((line) => line.includes('player_respawned'))).toBe(true);
  expect(forwarded.some((line) => line.includes('WebSocket connection closed'))).toBe(true);
  expect(forwarded.some((line) => line.includes('reconnect_scheduled'))).toBe(false);
});
