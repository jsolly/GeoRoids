let listenerScope: AbortController | null = null;

import { boundedDiagnosticError } from '../../shared/stateDiagnostics';
import { logger } from './Logger';

const RESIZE_OBSERVER_LOOP =
  /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)\.?$/u;

/** Install one bounded page-level capture for errors outside local subsystem guards. */
export function installGlobalErrorLogging(): void {
  if (listenerScope !== null || typeof window === 'undefined') {
    return;
  }
  listenerScope = new AbortController();
  const { signal } = listenerScope;
  window.addEventListener(
    'error',
    (event) => {
      // Browsers report a ResizeObserver callback that resized its own targets as a page error,
      // then deliver the skipped notifications next frame. Nothing failed, so keep it visible as
      // a warning instead of letting it read as an uncaught exception in production error counts.
      if (event.error == null && RESIZE_OBSERVER_LOOP.test(event.message)) {
        logger.warn('STATE', 'resize_observer_loop', {
          observedAt: Date.now(),
          message: event.message,
        });
        return;
      }
      logger.error(
        'STATE',
        'global_error',
        boundedDiagnosticError(event.error ?? event.message, 'Unknown global error'),
        { observedAt: Date.now(), eventType: 'error' }
      );
    },
    { signal }
  );
  window.addEventListener(
    'unhandledrejection',
    (event) => {
      logger.error(
        'STATE',
        'unhandled_rejection',
        boundedDiagnosticError(event.reason, 'Unhandled non-Error rejection'),
        { observedAt: Date.now(), eventType: 'unhandledrejection' }
      );
    },
    { signal }
  );
}

export function disposeGlobalErrorLogging(): void {
  listenerScope?.abort();
  listenerScope = null;
}
