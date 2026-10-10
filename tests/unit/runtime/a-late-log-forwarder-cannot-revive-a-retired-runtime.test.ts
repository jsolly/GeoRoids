import { expect, test, vi } from 'vitest';

const forwarding = vi.hoisted(() => {
  let accept: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    accept = resolve;
  });
  return { ready, accept: () => accept(), start: vi.fn(), stop: vi.fn(), send: vi.fn() };
});

vi.mock('../../../src/utils/logForwarder', async () => {
  await forwarding.ready;
  return {
    startClientLogForwarder: forwarding.start,
    stopClientLogForwarder: forwarding.stop,
    forwardLogToServer: forwarding.send,
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

test('a deferred log import serves only the currently mounted runtime and stops on disposal', async () => {
  logger.attachRuntime();
  logger.warn('NETWORK', 'Retired pilot event');
  logger.detachRuntime();
  logger.attachRuntime();
  logger.warn('NETWORK', 'Current pilot event');
  forwarding.accept();
  await vi.waitFor(() => expect(forwarding.send).toHaveBeenCalledOnce());
  expect(forwarding.start).toHaveBeenCalledOnce();
  expect(forwarding.send.mock.calls[0]?.[0]).toContain('Current pilot event');
  expect(forwarding.send.mock.calls[0]?.[0]).not.toContain('Retired pilot event');
  logger.detachRuntime();
  expect(forwarding.stop).toHaveBeenCalledOnce();
  logger.warn('NETWORK', 'Unmounted event');
  await Promise.resolve();
  expect(forwarding.send).toHaveBeenCalledOnce();
  logger.attachRuntime();
  logger.warn('NETWORK', 'Remounted event');
  await vi.waitFor(() => expect(forwarding.send).toHaveBeenCalledTimes(2));
  expect(forwarding.start).toHaveBeenCalledTimes(2);
  logger.detachRuntime();
  expect(forwarding.stop).toHaveBeenCalledTimes(2);
});
