import { afterEach, expect, test, vi } from 'vitest';
import { furnaceTravelPose } from '../../../shared/furnaceTravel';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

afterEach(() => vi.restoreAllMocks());

test('a furnace rocket follows server time despite clock skew and accepts its arrival position', () => {
  const player = new Player({
    id: 'pilot',
    name: 'Pilot',
    type: 'local',
    input: new MockPlayerInput(),
  });
  const transit = {
    sourceId: 'town-square',
    destinationId: 'street-1-0',
    startedAt: 1_000,
    durationMs: 600,
  };
  const now = vi.spyOn(Date, 'now').mockReturnValue(11_300);
  player.ship.furnaceClockOffsetMs = -10_000;
  player.updateFromServer({ furnaceTransit: transit });
  player.ship.angularVelocity = 5;
  player.ship.update();
  expect(player.ship.position).toEqual(furnaceTravelPose(transit, 1_300).position);
  expect(player.ship.angularVelocity).toBe(0);
  const lasers = player.ship.lasers.length;
  player.ship.shoot();
  player.ship.fireLaser();
  expect(player.ship.lasers).toHaveLength(lasers);
  expect(player.ship.activateAbility()).toBe(false);
  expect(player.ship.toggleBoost()).toBe(false);
  now.mockReturnValue(11_600);
  player.ship.update();
  const arrival = furnaceTravelPose(transit, 1_600).position;
  expect(player.ship.position).toEqual(arrival);
  player.updateFromServer({
    furnaceTransit: null,
    position: arrival,
    velocity: { x: 0, y: 0 },
    angle: 0,
  });
  expect(player.ship.furnaceTransit).toBeNull();
  expect(player.ship.position).toEqual(arrival);
  expect(player.ship.toggleBoost()).toBe(true);
});
