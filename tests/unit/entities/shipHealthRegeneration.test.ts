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

    tickShip(ship, calculateHealthRegenDelayFrames());

    expect(ship.healthRegenTimer).toBe(0);
    expect(ship.health).toBe(healthAfterDamage);

    tickShip(ship, 1);
    expect(ship.health).toBeCloseTo(
      healthAfterDamage + calculateHealthRegenPerFrame(ship.maxHealth)
    );
  });

  test('a second hit restarts the cooldown before regeneration can resume', () => {
    ship.takeDamage(20);
    tickShip(ship, GAME.FPS);
    ship.takeDamage(15);
    const healthAfterSecondHit = ship.health;

    expect(ship.healthRegenTimer).toBe(calculateHealthRegenDelayFrames());

    tickShip(ship, calculateHealthRegenDelayFrames());
    expect(ship.health).toBe(healthAfterSecondHit);
    tickShip(ship, 1);
    expect(ship.health).toBeCloseTo(
      healthAfterSecondHit + calculateHealthRegenPerFrame(ship.maxHealth)
    );
  });

  test.each([100, 140, 220])(
    'a client hull with %s max health predicts two percent recovery per second',
    (maxHealth) => {
      ship.maxHealth = maxHealth;
      ship.health = maxHealth;
      ship.takeDamage(20);
      tickShip(ship, 5 * GAME.FPS);
      expect(ship.health).toBe(maxHealth - 20);
      tickShip(ship, GAME.FPS);
      expect(ship.health).toBeCloseTo(maxHealth - 20 + maxHealth * 0.02, 8);
    }
  );

  test('hulls cap regeneration at max health', () => {
    const testedShip = new Ship();
    testedShip.health =
      testedShip.maxHealth - calculateHealthRegenPerFrame(testedShip.maxHealth) / 2;
    testedShip.healthRegenTimer = 0;

    testedShip.updateHealth();

    expect(testedShip.health).toBe(testedShip.maxHealth);
  });

  test('exploding and dead hulls do not regenerate before a server respawn', () => {
    ship.takeDamage(ship.maxHealth);
    const explodingHealth = ship.health;
    tickShip(ship, calculateHealthRegenDelayFrames() + 1);
    expect(ship.exploding).toBe(true);
    expect(ship.health).toBe(explodingHealth);

    ship.exploding = false;
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

  test.each(['local', 'remote'] as const)(
    '%s multiplayer hulls wait for authoritative recovery snapshots',
    (type) => {
      const player = new Player({
        id: 'remote-player',
        name: 'Remote Player',
        type,
        input: new MockPlayerInput(),
      });
      player.ship.health = 80;

      player.updateFromServer({ health: 75, maxHealth: player.ship.maxHealth, exploding: false });
      expect(player.ship.health).toBe(75);
      tickShip(player.ship, calculateHealthRegenDelayFrames() + 10 * GAME.FPS);
      expect(player.ship.health).toBe(75);

      player.updateFromServer({ health: 76, maxHealth: player.ship.maxHealth, exploding: false });
      expect(player.ship.health).toBe(76);
    }
  );
});
