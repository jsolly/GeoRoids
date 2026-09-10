import { clientPerformance } from '../diagnostics/performanceMetrics';
import { canvasManager } from '../rendering/canvas';
import '../ui/mainMenu'; // wires nickname + Enter Game listeners
import { reportRenderError } from '../rendering/renderError';
import { initNetworkStatusUI } from '../ui/networkStatus';
import { installGlobalErrorLogging } from '../utils/globalErrorLogging';
import { GameController } from './gameController';

const gameController = GameController.getInstance();
installGlobalErrorLogging();

// Surface a visible banner whenever the game-server connection drops.
initNetworkStatusUI();

// Initialize canvas with proper scaling after DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => canvasManager.initialize());
} else {
  canvasManager.initialize();
}

// Game loop with updates and rendering
let gameLoopScheduled = false;
let presentationReset = false;
let hiddenAt: number | undefined;
document.addEventListener('visibilitychange', () => {
  presentationReset = true;
  if (document.hidden) {
    hiddenAt = performance.now();
    clientPerformance.setPhase('hidden');
    clientPerformance.count('hiddenPeriods');
  } else if (gameController.getIsGameRunning()) {
    if (hiddenAt !== undefined) {
      clientPerformance.record('hiddenDurationMs', performance.now() - hiddenAt);
    }
    hiddenAt = undefined;
    gameController.resetPresentationClock();
    clientPerformance.recover(performance.now());
    const network = gameController.getNetworkManager();
    if (network.isConnected) {
      if (network.sendMessage({ type: 'snapshotResync', data: {} })) {
        clientPerformance.count('resyncs');
      }
    }
  }
});
window.addEventListener('gameStart', () => {
  if (gameLoopScheduled) {
    return;
  }
  gameLoopScheduled = true;
  let lastTime = performance.now();

  function gameLoop(now: number): void {
    if (!gameController.getIsGameRunning()) {
      clientPerformance.setPhase('menu');
      gameLoopScheduled = false;
      return;
    }

    try {
      const dtMs = presentationReset ? 0 : now - lastTime;
      presentationReset = false;
      lastTime = now;
      if (document.hidden) {
        window.requestAnimationFrame(gameLoop);
        return;
      }
      const observing = clientPerformance.enabled;
      if (observing) {
        clientPerformance.setPhase(
          document.hidden
            ? 'hidden'
            : gameController.getCurrPlayer()?.ship.exploding
              ? 'respawn'
              : 'play'
        );
        clientPerformance.record('frameIntervalMs', dtMs);
      }
      const started = observing ? performance.now() : 0;
      gameController.updateGame(dtMs);
      const updated = observing ? performance.now() : 0;

      // Then render the current game state
      gameController.renderGame();
      if (observing) {
        const rendered = performance.now();
        clientPerformance.record('updateMs', updated - started);
        clientPerformance.record('renderMs', rendered - updated);
        clientPerformance.record('frameCpuMs', rendered - started);
        clientPerformance.rendered(rendered);
        clientPerformance.exportIfDue(rendered);
      }
      window.requestAnimationFrame(gameLoop);
    } catch (error) {
      gameLoopScheduled = false;
      clientPerformance.count('frameFailures');
      gameController.stopAfterFrameFailure();
      reportRenderError(error);
    }
  }

  window.requestAnimationFrame(gameLoop);
});
