import { afterEach, expect, test, vi } from 'vitest';
import { PlayerNetwork } from '../../../src/entities/player/playerNetwork';

afterEach(() => {
  PlayerNetwork.getInstance().stopNetworkUpdates();
  vi.restoreAllMocks();
});

test('pose reports follow simulated frames instead of an independent 16ms timer', () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  const network = PlayerNetwork.getInstance();
  const tick = vi.fn();
  network.bindTick(tick);

  network.startNetworkUpdates();
  expect(interval).not.toHaveBeenCalled();

  network.notifySimulationFrames(0);
  expect(tick).not.toHaveBeenCalled();

  network.notifySimulationFrames(2);
  expect(tick).toHaveBeenCalledOnce();

  network.stopNetworkUpdates();
  network.notifySimulationFrames(1);
  expect(tick).toHaveBeenCalledOnce();
});
