import { boundedDiagnosticError } from '../../shared/stateDiagnostics';
import { logger } from '../utils/Logger';

/** Report a failed frame and retain the existing restart notice. */
export function reportRenderError(cause: unknown): void {
  const error = boundedDiagnosticError(cause, 'Unknown game-loop failure');
  logger.error('STATE', 'game_loop_failed', error, { observedAt: Date.now() });

  let notice = document.getElementById('game-error-message');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'game-error-message';
    notice.setAttribute('role', 'alert');
    notice.style.cssText = `
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      background: rgba(255, 0, 0, 0.9); color: white; padding: 10px 20px;
      border-radius: 5px; z-index: 10000; font-family: Arial, sans-serif;
      font-size: 14px; max-width: 400px; text-align: center;
    `;
    document.body.appendChild(notice);
  }
  notice.textContent = 'An unexpected error occurred. Please restart the game.';
  notice.style.display = 'block';
}
