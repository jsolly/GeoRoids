import { expect, test, vi } from 'vitest';
import { logger } from '../../../src/utils/Logger';
import { LogLevel } from '../../../src/utils/logLevel';

test('the shared logger suppresses debug at the default info threshold', () => {
  const previous = logger.getLogLevel();
  logger.setLogLevel(LogLevel.INFO);
  const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  try {
    logger.debug('TEST', 'per-frame pose must not print at info');
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    logger.setLogLevel(previous);
  }
});

test('the shared logger keeps cyclic diagnostic context from crashing callers', () => {
  const previous = logger.getLogLevel();
  logger.setLogLevel(LogLevel.WARN);
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const context: Record<string, unknown> = {};
  context['self'] = context;

  try {
    expect(() => logger.warn('LOG_FORWARD', 'cyclic context', context)).not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[circular]'));
  } finally {
    spy.mockRestore();
    logger.setLogLevel(previous);
  }
});

test('page log sessions are distinct while connection identity is explicitly replaced', async () => {
  vi.resetModules();
  const first = await import('../../../src/utils/clientLogContext');
  const firstSession = first.getClientLogContext().sessionId;
  first.setClientLogContext({ playerId: 'old-player', connectionId: 'socket-1' });
  first.setClientLogContext({ connectionId: 'socket-2' });
  expect(first.getClientLogContext()).toEqual({
    sessionId: firstSession,
    connectionId: 'socket-2',
  });

  vi.resetModules();
  const second = await import('../../../src/utils/clientLogContext');
  expect(second.getClientLogContext().sessionId).not.toBe(firstSession);
});
