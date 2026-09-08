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
window.addEventListener('gameStart', () => {
  if (gameLoopScheduled) {
    return;
  }
  gameLoopScheduled = true;
  let lastTime = performance.now();

  function gameLoop(now: number): void {
    if (!gameController.getIsGameRunning()) {
      gameLoopScheduled = false;
      return;
    }

    try {
      const dtMs = now - lastTime;
      lastTime = now;
      gameController.updateGame(dtMs);

      // Then render the current game state
      gameController.renderGame();
      window.requestAnimationFrame(gameLoop);
    } catch (error) {
      gameLoopScheduled = false;
      gameController.stopAfterFrameFailure();
      reportRenderError(error);
    }
  }

  window.requestAnimationFrame(gameLoop);
});
