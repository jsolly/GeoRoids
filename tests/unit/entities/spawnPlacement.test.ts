import { assert, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { SPAWN } from '../../../src/constants';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { getAsteroidFieldRadius } from '../../../src/physics/asteroidMotion';
import { resolveSpawnPosition } from '../../../src/utils/spawnPosition';

// Regression test for the live-multiplayer bug where two players joining the
// same server could never see each other: players used to spawn anywhere inside
// the ~3100px arena radius, so they landed thousands of px apart — permanently
// off each other's viewport even though the leaderboard listed everyone.
//
// The default spawn now clusters players near the arena center (world origin)
// so co-players appear within view. Assumes the near-center/near-boundary DEBUG
// placement flags are off (their default), which is the shipped behavior.
test('local players spawn near the arena center so co-players are in view', () => {
  for (let i = 0; i < 100; i++) {
    const player = entityFactory.createLocalPlayer('Tester');
    const distanceFromCenter = Math.hypot(player.ship.position.x, player.ship.position.y);
    expect(distanceFromCenter).toBeLessThanOrEqual(SPAWN.NEAR_CENTER_RADIUS);
  }
});

test('local players and client bot ships share the same near-center spawn', () => {
  for (let i = 0; i < 40; i++) {
    const viaEntity = entityFactory.createLocalPlayer('ViaEntity');
    const viaBot = entityFactory.createBotPlayer('ViaBot');
    expect(Math.hypot(viaEntity.ship.position.x, viaEntity.ship.position.y)).toBeLessThanOrEqual(
      SPAWN.NEAR_CENTER_RADIUS
    );
    expect(Math.hypot(viaBot.ship.position.x, viaBot.ship.position.y)).toBeLessThanOrEqual(
      SPAWN.NEAR_CENTER_RADIUS
    );
  }
});

test('resolveSpawnPosition keeps an explicit late-join pose', () => {
  expect(resolveSpawnPosition({ x: 80, y: -12 })).toEqual({ x: 80, y: -12 });
});

test('client bots spawn on the same near-center path as humans', () => {
  const bots = [0, 1, 2].map((i) => entityFactory.createBotPlayer(`Bot ${i}`));
  expect(bots).toHaveLength(3);
  for (const bot of bots) {
    expect(Math.hypot(bot.ship.position.x, bot.ship.position.y)).toBeLessThanOrEqual(
      SPAWN.NEAR_CENTER_RADIUS
    );
  }
});

test('server bots spawn and bounce inside the shared asteroid field', () => {
  const engine = new GameEngine(3);
  const bots = engine.entityManager.createBots(2);
  const field = getAsteroidFieldRadius();
  expect(bots.length).toBeGreaterThan(0);
  for (const bot of bots) {
    expect(Math.hypot(bot.position.x, bot.position.y)).toBeLessThanOrEqual(field + 1);
  }
  const wanderer = bots[0];
  assert.exists(wanderer);
  wanderer.position = { x: 3000, y: 0 };
  wanderer.velocity = { x: 8, y: 0 };
  engine.entityManager.updateBotMovement();
  const after = engine.getBot(wanderer.id);
  assert.exists(after);
  expect(Math.hypot(after.position.x, after.position.y)).toBeLessThanOrEqual(field + 1);
  engine.stopGameLoop();
});

test('two freshly spawned players are close enough to share a viewport', () => {
  // Max separation is bounded by 2x the spawn radius; keep it well under a
  // typical viewport half-height so the remote ship renders on the local screen.
  const a = entityFactory.createLocalPlayer('A');
  const b = entityFactory.createLocalPlayer('B');
  const separation = Math.hypot(
    a.ship.position.x - b.ship.position.x,
    a.ship.position.y - b.ship.position.y
  );
  expect(separation).toBeLessThanOrEqual(2 * SPAWN.NEAR_CENTER_RADIUS);
});
