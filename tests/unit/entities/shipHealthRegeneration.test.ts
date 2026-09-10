import { beforeEach, describe, expect, test } from 'vitest';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../../shared/constants/health';
import { GAME, SHIP } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { Ship } from '../../../src/entities/ship/Ship';
import { shouldStartHealthRegeneration } from '../../../src/entities/ship/shipUtils';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

function tickShip(ship: Ship, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    ship.updateHealth();
  }
}

describe('client ship health regeneration', () => {
  let ship: Ship;

  beforeEach(() => {
    ship = new Ship({
      position: { x: 400, y: 300 },
    });
  });

  test('a damaged ship waits for the full cooldown before its first regeneration tick', () => {
    ship.takeDamage(20);
    const healthAfterDamage = ship.health;

    tickShip(ship, GAME.FPS + calculateHealthRegenDelayFrames() - 1);

    expect(ship.lastDamageTime).toBe(0);
    expect(ship.healthRegenTimer).toBe(0);
    expect(ship.health).toBe(healthAfterDamage);

    tickShip(ship, 1);
    expect(ship.health).toBeCloseTo(healthAfterDamage + calculateHealthRegenPerFrame());
  });

  test('a second hit restarts the cooldown before regeneration can resume', () => {
    ship.takeDamage(20);
    tickShip(ship, GAME.FPS);
    ship.takeDamage(15);
    const healthAfterSecondHit = ship.health;

    expect(ship.lastDamageTime).toBe(GAME.FPS);
    expect(ship.healthRegenTimer).toBe(calculateHealthRegenDelayFrames());

    tickShip(ship, GAME.FPS + calculateHealthRegenDelayFrames() - 1);
    expect(ship.health).toBe(healthAfterSecondHit);
    tickShip(ship, 1);
    expect(ship.health).toBeCloseTo(healthAfterSecondHit + calculateHealthRegenPerFrame());
  });

  test.each([false, true])('player and bot hulls cap regeneration at max health (%s)', (isBot) => {
    const testedShip = new Ship({ isBot });
    testedShip.health = testedShip.maxHealth - calculateHealthRegenPerFrame() / 2;
    testedShip.lastDamageTime = 0;
    testedShip.healthRegenTimer = 0;

    testedShip.updateHealth();

    expect(testedShip.health).toBe(testedShip.maxHealth);
  });

  test('exploding and dead hulls do not regenerate before a server respawn', () => {
    ship.takeDamage(ship.maxHealth);
    const explodingHealth = ship.health;
    tickShip(ship, GAME.FPS + calculateHealthRegenDelayFrames() + 1);
    expect(ship.exploding).toBe(true);
    expect(ship.health).toBe(explodingHealth);

    ship.exploding = false;
    ship.lastDamageTime = 0;
    ship.healthRegenTimer = 0;
    tickShip(ship, GAME.FPS + 1);
    expect(ship.health).toBe(0);
  });

  test('the regeneration gate stays closed for full, dead, and cooling-down hulls', () => {
    expect(shouldStartHealthRegeneration(GAME.FPS, 50, SHIP.MAX_HEALTH)).toBe(false);
    expect(shouldStartHealthRegeneration(0, SHIP.MAX_HEALTH, SHIP.MAX_HEALTH)).toBe(false);
    expect(shouldStartHealthRegeneration(0, 0, SHIP.MAX_HEALTH)).toBe(false);
    expect(shouldStartHealthRegeneration(0, 50, SHIP.MAX_HEALTH)).toBe(true);
  });

  test('a remote bot accepts ordered server health echoes through Player.updateFromServer', () => {
    const player = new Player({
      id: 'bot-player',
      name: 'Bot Player',
      type: 'bot',
      input: new MockPlayerInput(),
    });
    player.ship.health = 80;

    player.updateFromServer({ health: 75, maxHealth: player.ship.maxHealth, exploding: false });
    expect(player.ship.health).toBe(75);

    player.updateFromServer({ health: 76, maxHealth: player.ship.maxHealth, exploding: false });
    expect(player.ship.health).toBe(76);
  });
});
