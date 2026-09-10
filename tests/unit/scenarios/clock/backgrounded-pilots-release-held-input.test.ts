import { afterEach, expect, test, vi } from 'vitest';
import { GameController } from '../../../../src/core/gameController';
import { GameStateManager } from '../../../../src/core/services/GameStateManager';
import { InputManager } from '../../../../src/core/services/InputManager';
import { PlayerManager } from '../../../../src/entities/player/PlayerManager';
import { controlSources } from '../../../../src/input/controlSources';
import { getPressedKeysForPlayer, keys } from '../../../../src/input/keybindings';
import { NetworkManager } from '../../../../src/network/networkManager';
import { canvasManager } from '../../../../src/rendering/canvas';

afterEach(() => {
  canvasManager.destroy();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'requestAnimationFrame');
});

test('hiding a pilot with held movement releases the controls and resumes without stale steps', async () => {
  const player = PlayerManager.getInstance().createLocalPlayer();
  GameStateManager.getInstance().setIsGameRunning(true);
  InputManager.getInstance().initializeListeners();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'ArrowLeft', bubbles: true }));
  expect(player.ship.thrusting).toBe(true);
  expect(player.ship.angularVelocity).not.toBe(0);
  controlSources.mouseThrust = true;
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const frames: FrameRequestCallback[] = [];
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  const controller = GameController.getInstance();
  const updates = vi.spyOn(controller, 'updateGame').mockImplementation(() => undefined);
  vi.spyOn(controller, 'renderGame').mockImplementation(() => undefined);
  vi.spyOn(NetworkManager.getInstance(), 'isConnected', 'get').mockReturnValue(false);
  await import('../../../../src/core/eventLoop');
  window.dispatchEvent(new Event('gameStart'));
  const initial = performance.now();
  frames.shift()?.(initial);
  visible.mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(player.ship.thrusting).toBe(false);
  expect(player.ship.angularVelocity).toBe(0);
  expect(getPressedKeysForPlayer(player).size).toBe(0);
  expect(keys.ArrowUp).toBe(false);
  expect(controlSources.mouseThrust).toBe(false);
  frames.shift()?.(initial + 60_000);
  expect(updates).toHaveBeenCalledTimes(1);
  visible.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  frames.shift()?.(initial + 60_017);
  expect(updates).toHaveBeenLastCalledWith(0);
});
