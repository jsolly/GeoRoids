import { afterEach, expect, test, vi } from 'vitest';
import { GameController } from '../../../src/core/gameController';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { PlayerNetwork } from '../../../src/entities/player/playerNetwork';
import * as shipRenderer from '../../../src/entities/ship/shipRenderer';
import { NetworkManager } from '../../../src/network/networkManager';
import { canvasManager } from '../../../src/rendering/canvas';
import { logger } from '../../../src/utils/Logger';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'requestAnimationFrame');
  canvasManager.destroy();
  document.body.replaceChildren();
});

test('an actual game-loop frame failure stops work and offers one restart notice', async () => {
  vi.useFakeTimers();
  const scheduled: FrameRequestCallback[] = [];
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      scheduled.push(callback);
      return scheduled.length;
    }),
  });

  const canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  document.body.appendChild(canvas);
  canvasManager.initialize();
  const player = PlayerManager.getInstance().createLocalPlayer();
  player.id = 'local-pilot';
  const network = NetworkManager.getInstance();
  vi.spyOn(network, 'getLocalPlayerId').mockReturnValue(player.id);
  vi.spyOn(network, 'getAllPlayers').mockReturnValue([player]);

  const controller = GameController.getInstance();
  controller.getGameStateManager().setIsGameRunning(true);
  expect(controller.getIsGameRunning()).toBe(true);
  vi.spyOn(controller, 'updateGame').mockImplementation(() => undefined);
  const failure = new Error('Canvas clear failed');
  const drawHull = vi.spyOn(shipRenderer, 'drawShipAtPosition').mockImplementation(() => {
    throw failure;
  });
  const stop = vi.spyOn(controller, 'stopAfterFrameFailure');
  const stopNetwork = vi
    .spyOn(PlayerNetwork.getInstance(), 'stopNetworkUpdates')
    .mockImplementation(() => undefined);
  const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

  await import('../../../src/core/eventLoop');
  window.dispatchEvent(new CustomEvent('gameStart'));
  expect(scheduled).toHaveLength(1);
  scheduled.shift()?.(performance.now());

  expect(drawHull).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(stopNetwork).toHaveBeenCalledOnce();
  expect(controller.getIsGameRunning()).toBe(false);
  expect(log).toHaveBeenCalledWith(
    'STATE',
    'game_loop_failed',
    expect.objectContaining({
      name: 'Error',
      message: 'Canvas clear failed',
    }),
    {
      observedAt: expect.any(Number),
    }
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('restart the game');
  expect(scheduled).toHaveLength(0);
});
