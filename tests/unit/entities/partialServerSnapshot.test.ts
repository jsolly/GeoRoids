import { expect, test } from 'vitest';
import { EXTRA_LIFE_COST, shipPaintById } from '../../../shared/townStore';
import { GAME, PALETTE } from '../../../src/constants';
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

test('omitted lives and score do not reset the HUD', () => {
  const player = localPilot();
  player.lives = 2;
  player.score = 210;

  player.updateFromServer({ position: { x: 10, y: 20 } });

  expect(player.lives).toBe(2);
  expect(player.score).toBe(210);
});

test('spending the exact furnace price updates a five-life pilot to zero score', () => {
  const player = localPilot();
  player.lives = GAME.START_LIVES;
  player.score = 1500;
  player.updateFromServer({ lives: GAME.START_LIVES, score: 0, health: 100, exploding: false });
  expect(player.lives).toBe(GAME.START_LIVES);
  expect(player.score).toBe(0);
});

test('buying the fifth life with the last score accepts both authoritative changes', () => {
  const player = localPilot();
  player.lives = GAME.START_LIVES - 1;
  player.score = EXTRA_LIFE_COST;
  player.updateFromServer({ lives: GAME.START_LIVES, score: 0, health: 100, exploding: false });
  expect(player.lives).toBe(GAME.START_LIVES);
  expect(player.score).toBe(0);
});

test('a stale healthy game-over row cannot clear current progress', () => {
  const player = localPilot();
  player.lives = GAME.START_LIVES;
  player.score = 1500;
  player.updateFromServer({ lives: 0, score: 0, health: 100, exploding: false });
  expect(player.lives).toBe(GAME.START_LIVES);
  expect(player.score).toBe(1500);
});

test('last-life death removes purchased paint while keeping the local default hull color', () => {
  const player = localPilot();
  const paint = shipPaintById('ember');
  if (!paint) {
    throw new Error('Missing store paint');
  }
  player.updateFromServer({ color: paint.color });
  expect(player.color).toBe(paint.color);
  player.lives = 1;
  player.updateFromServer({
    lives: 0,
    score: 0,
    color: PALETTE.REMOTE,
    health: 0,
    exploding: true,
  });
  expect(player.lives).toBe(0);
  expect(player.color).toBe(PALETTE.LOCAL);
  expect(player.ship.color).toBe(PALETTE.LOCAL);
});

test('game-over HUD may accept a new flight', () => {
  const player = localPilot();
  player.lives = 0;
  player.score = 210;

  player.updateFromServer({ lives: GAME.START_LIVES, score: GAME.STARTING_SCORE });

  expect(player.lives).toBe(GAME.START_LIVES);
  expect(player.score).toBe(GAME.STARTING_SCORE);
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
