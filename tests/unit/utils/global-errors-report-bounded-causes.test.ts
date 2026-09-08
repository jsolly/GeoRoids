import { afterEach, expect, test, vi } from 'vitest';
import { installGlobalErrorLogging } from '../../../src/utils/globalErrorLogging';
import { logger } from '../../../src/utils/Logger';

afterEach(() => {
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
