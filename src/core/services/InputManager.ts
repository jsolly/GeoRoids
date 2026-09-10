import { PlayerManager } from '../../entities/player/PlayerManager';
import { resetControlSources } from '../../input/controlSources';
import {
  getPressedKeysForPlayer,
  keyDown,
  keys,
  keyUp,
  reconcilePlayerInput,
} from '../../input/keybindings';
import {
  handleMouseDown,
  handleMouseMove,
  handleMouseUp,
  preventContextMenu,
} from '../../input/mouse';
import { initializeTouchControls } from '../../input/touchControls';
import { logger } from '../../utils/Logger';
import { GameStateManager } from './GameStateManager';

export class InputManager {
  private static instance: InputManager;
  private gameStateManager: GameStateManager;
  private listenersInitialized = false;

  private constructor() {
    this.gameStateManager = GameStateManager.getInstance();
  }

  static getInstance(): InputManager {
    if (!InputManager.instance) {
      InputManager.instance = new InputManager();
    }
    return InputManager.instance;
  }

  initializeListeners(): void {
    if (this.listenersInitialized) {
      return;
    }

    logger.debug('INPUT', 'Initializing InputManager listeners');

    const getLocalPlayer = () => PlayerManager.getInstance().getLocalPlayer();

    // Keyboard listeners
    document.addEventListener('keydown', (ev) => {
      const localPlayer = getLocalPlayer();
      if (!localPlayer) {
        return;
      }
      logger.debug('INPUT', 'Key down event', {
        key: ev.code,
        gameRunning: this.gameStateManager.getIsGameRunning(),
      });
      if (this.gameStateManager.getIsGameRunning()) {
        keyDown(ev, localPlayer);
      } else {
        logger.warn('INPUT', 'Key down ignored - game not running', { key: ev.code });
      }
    });

    document.addEventListener('keyup', (ev) => {
      const localPlayer = getLocalPlayer();
      if (!localPlayer) {
        return;
      }
      logger.debug('INPUT', 'Key up event', {
        key: ev.code,
        gameRunning: this.gameStateManager.getIsGameRunning(),
      });
      // Always handle keyup events regardless of game state to prevent stuck keys
      keyUp(ev, localPlayer);
    });

    // Mouse listeners on canvas
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;
    if (canvas) {
      canvas.addEventListener('mousemove', (ev) => {
        const localPlayer = getLocalPlayer();
        if (localPlayer && this.gameStateManager.getIsGameRunning()) {
          handleMouseMove(ev, localPlayer);
        }
      });
      canvas.addEventListener('mousedown', (ev) => {
        const localPlayer = getLocalPlayer();
        if (localPlayer && this.gameStateManager.getIsGameRunning()) {
          handleMouseDown(ev, localPlayer);
        }
      });
      canvas.addEventListener('mouseup', (ev) => {
        const localPlayer = getLocalPlayer();
        if (localPlayer && this.gameStateManager.getIsGameRunning()) {
          handleMouseUp(ev, localPlayer);
        }
      });
      // Prevent default context menu for right-click thrust
      canvas.addEventListener('contextmenu', preventContextMenu);
      canvas.addEventListener(
        'touchstart',
        (ev) => {
          if (ev.cancelable) {
            ev.preventDefault();
          }
        },
        { passive: false }
      );
    }

    // Reset shoot cooldown if the mouse is released outside the canvas
    document.addEventListener('mouseup', (ev) => {
      const localPlayer = getLocalPlayer();
      if (localPlayer && ev.button === 0) {
        localPlayer.ship.canShoot = true;
      }
    });

    const releaseInput = () => {
      const localPlayer = getLocalPlayer();
      resetControlSources();
      for (const key of Object.keys(keys)) {
        keys[key] = false;
      }
      if (localPlayer) {
        getPressedKeysForPlayer(localPlayer).clear();
        localPlayer.ship.canShoot = true;
        reconcilePlayerInput(localPlayer);
      }
    };
    window.addEventListener('blur', releaseInput);
    window.addEventListener('pagehide', releaseInput);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        releaseInput();
      }
    });
    initializeTouchControls();

    this.listenersInitialized = true;
  }

  resetButtonText(): void {
    const gameBtn = document.getElementById('start-game') as HTMLButtonElement;

    if (gameBtn) {
      gameBtn.innerText = 'Enter Game';
    }
  }
}
