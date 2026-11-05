import { afterEach, expect, test, vi } from 'vitest';
import {
  disposeGlobalErrorLogging,
  installGlobalErrorLogging,
} from '../../../src/utils/globalErrorLogging';
import { logger } from '../../../src/utils/Logger';

afterEach(() => {
  disposeGlobalErrorLogging();
  vi.restoreAllMocks();
});

test('page-level errors retain a bounded cause without serializing rejection objects', () => {
  const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  installGlobalErrorLogging();

  const source = new Error(
    `request failed https://example.test/play?resumeToken=private#state${'x'.repeat(3000)}`
  );
  window.dispatchEvent(new ErrorEvent('error', { error: source, message: source.message }));
  const rejection = new Event('unhandledrejection');
  Object.defineProperty(rejection, 'reason', {
    value: { resumeToken: 'must-not-serialize' },
  });
  window.dispatchEvent(rejection);

  const reportedError = log.mock.calls[0]?.[2];
  expect(reportedError).toBeInstanceOf(Error);
  expect(reportedError?.message).toBe('request failed https://example.test/play');
  expect(reportedError?.stack?.length).toBeLessThanOrEqual(2048);
  expect(log.mock.calls[1]?.[2]?.message).toBe('Unhandled non-Error rejection');
  expect(JSON.stringify(log.mock.calls)).not.toContain('must-not-serialize');
});

test('a ResizeObserver loop notice is a warning, not an uncaught page error', () => {
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  installGlobalErrorLogging();

  // Browsers dispatch this notice with no Error object attached.
  window.dispatchEvent(
    new ErrorEvent('error', {
      message: 'ResizeObserver loop completed with undelivered notifications.',
    })
  );
  // Older browsers word the same notice without a trailing period.
  window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded' }));
  expect(error).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    'STATE',
    'resize_observer_loop',
    expect.objectContaining({
      message: 'ResizeObserver loop completed with undelivered notifications.',
    })
  );
  expect(warn).toHaveBeenCalledWith(
    'STATE',
    'resize_observer_loop',
    expect.objectContaining({ message: 'ResizeObserver loop limit exceeded' })
  );
  warn.mockClear();

  // Other page errors without an Error object, such as a muted cross-origin script, still report.
  window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
  expect(warn).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    'STATE',
    'global_error',
    expect.anything(),
    expect.objectContaining({ eventType: 'error' })
  );
  error.mockClear();

  // A thrown error that merely mentions ResizeObserver is still a real failure.
  const thrown = new Error('ResizeObserver loop completed with undelivered notifications.');
  window.dispatchEvent(new ErrorEvent('error', { error: thrown, message: thrown.message }));
  expect(error).toHaveBeenCalledWith(
    'STATE',
    'global_error',
    expect.any(Error),
    expect.objectContaining({ eventType: 'error' })
  );
});
