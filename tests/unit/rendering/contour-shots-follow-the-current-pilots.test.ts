import { afterEach, expect, test, vi } from 'vitest';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { Laser } from '../../../src/entities/laser/Laser';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { RoidBelt } from '../../../src/entities/roid/Roid';
import { NetworkManager } from '../../../src/network/networkManager';
import { canvasManager } from '../../../src/rendering/canvas';
import * as contourLasers from '../../../src/rendering/contourLaserRenderer';

afterEach(() => {
  canvasManager.destroy();
  vi.restoreAllMocks();
});

test('successive frames reuse shot sources and remove a departed pilot without retaining their lasers', () => {
  canvasManager.initialize();
  const local = PlayerManager.getInstance().createLocalPlayer();
  local.id = 'local-pilot';
  local.ship.position = { x: 0, y: 0 };
  const first = entityFactory.createRemotePlayer('first-pilot', 'First', { x: 100, y: 0 });
  const second = entityFactory.createRemotePlayer('second-pilot', 'Second', { x: 200, y: 0 });
  const shot = (x: number) => new Laser({ x, y: 40 }, { x: 1, y: 0 }, 0, 0);
  local.ship.lasers = [shot(10)];
  first.ship.lasers = [shot(110)];
  second.ship.lasers = [shot(210)];
  let players = [local, first, second];
  const network = NetworkManager.getInstance();
  vi.spyOn(network, 'getLocalPlayerId').mockReturnValue(local.id);
  vi.spyOn(network, 'getAllPlayers').mockImplementation(() => players);
  const collect = vi.spyOn(contourLasers, 'liveLaserPositions');
  const paint = vi.spyOn(contourLasers, 'drawContourLaserTicks');
  const belt = new RoidBelt(false);
  const draw = () => canvasManager.drawGame(local, belt, 0, 0, '', local.lives, players);
  const observedPositions = () => paint.mock.calls.at(-1)?.[1].map(({ x, y }) => ({ x, y }));

  draw();
  const sources = [...(collect.mock.calls.at(-1)?.[0] ?? [])];
  expect(sources).toHaveLength(3);
  expect(observedPositions()).toEqual([
    { x: 10, y: 40 },
    { x: 110, y: 40 },
    { x: 210, y: 40 },
  ]);

  second.ship.lasers = [shot(220)];
  draw();
  expect(collect.mock.calls.at(-1)?.[0][1]).toBe(sources[1]);
  expect(collect.mock.calls.at(-1)?.[0][2]).toBe(sources[2]);
  expect(observedPositions()).toEqual([
    { x: 10, y: 40 },
    { x: 110, y: 40 },
    { x: 220, y: 40 },
  ]);

  players = [local, second];
  draw();
  expect(collect.mock.calls.at(-1)?.[0]).toHaveLength(2);
  expect(observedPositions()).toEqual([
    { x: 10, y: 40 },
    { x: 220, y: 40 },
  ]);
});
