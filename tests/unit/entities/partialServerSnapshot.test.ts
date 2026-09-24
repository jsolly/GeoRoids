import { expect, test } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

function localPilot(): Player {
  return new Player({
    id: 'local',
    name: 'Local',
    type: 'local',
    input: new MockPlayerInput(),
  });
}

test('omitting spawnProtectionTimer from a snapshot does not clear it', () => {
  const player = localPilot();
  player.ship.health = 100;
  player.updateFromServer({ spawnProtectionTimer: 180, health: 100 });
  expect(player.serverSpawnProtectionTimer).toBe(180);

  player.updateFromServer({ position: { x: 10, y: 20 } });
  expect(player.serverSpawnProtectionTimer).toBe(180);
});

test('omitted bank and cargo do not reset the HUD', () => {
  const player = localPilot();
  player.score = 210;

  player.updateFromServer({ position: { x: 10, y: 20 } });

  expect(player.score).toBe(210);
});

test('death to alive without spawnProtectionTimer still arms blink', () => {
  const player = localPilot();
  player.ship.health = 0;
  player.ship.exploding = true;
  player.ship.blinkCount = 0;

  player.updateFromServer({ health: 100, exploding: false });

  expect(player.ship.health).toBe(100);
  expect(player.ship.exploding).toBe(false);
  expect(player.ship.blinkCount).toBeGreaterThan(0);
});

test('respawnTimer 0 does not latch the local ship as dead', () => {
  const player = localPilot();
  player.ship.health = 100;
  player.ship.exploding = false;
  const origin = { x: 40, y: 50 };
  player.ship.position = origin;

  player.updateFromServer({
    respawnTimer: 0,
    position: { x: 40, y: 50 },
    health: 100,
  });
  player.updateFromServer({
    position: { x: 400, y: 10 },
    health: 100,
  });

  expect(player.ship.position).toEqual(origin);
});
