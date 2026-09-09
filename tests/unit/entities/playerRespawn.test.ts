import { beforeEach, describe, expect, test } from 'vitest';
import { SHIP } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

describe('Player Respawn System', () => {
  let player: Player;
  let ship: Player['ship'];

  beforeEach(() => {
    player = new Player({
      id: 'test-player',
      name: 'Test Player',
      type: 'local',
      input: new MockPlayerInput(),
    });
    ship = player.ship;
  });

  test('player starts with full health', () => {
    expect(ship.health).toBe(ship.maxHealth);
    expect(ship.exploding).toBe(false);
  });

  test('player can take damage', () => {
    const initialHealth = ship.health;
    ship.takeDamage(25);
    expect(ship.health).toBe(initialHealth - 25);
  });

  test('player explodes when health reaches zero', () => {
    ship.takeDamage(ship.maxHealth);
    expect(ship.health).toBe(0);
    expect(ship.exploding).toBe(true);
  });

  test('a living local ship displays gradual authoritative healing and subsequent damage', () => {
    player.updateFromServer({ health: 50, exploding: false });
    expect(ship.health).toBe(50);

    player.updateFromServer({ health: 50 + 1 / 60, exploding: false });
    expect(ship.health).toBeCloseTo(50 + 1 / 60);
    player.updateFromServer({ health: 50 + 2 / 60, exploding: false });
    expect(ship.health).toBeCloseTo(50 + 2 / 60);

    // Repeated snapshots must not add healing locally, and actual damage
    // following regeneration must still be reflected immediately.
    player.updateFromServer({ health: 50 + 2 / 60, exploding: false });
    expect(ship.health).toBeCloseTo(50 + 2 / 60);
    player.updateFromServer({ health: 47 + 2 / 60, exploding: false });
    expect(ship.health).toBeCloseTo(47 + 2 / 60);
  });

  test('a delayed healing echo cannot revive a locally predicted death', () => {
    player.updateFromServer({ health: 50, exploding: false });
    ship.health = 0;
    ship.exploding = true;
    ship.blinkCount = 0;

    player.updateFromServer({ health: 50 + 1 / 60, exploding: false });
    expect(ship.health).toBe(0);
    expect(ship.blinkCount).toBe(0);

    // A complete authoritative respawn still restores health and its cue.
    player.updateFromServer({
      health: ship.maxHealth,
      exploding: false,
      respawnTimer: 0,
    });
    expect(ship.health).toBe(ship.maxHealth);
    expect(ship.blinkCount).toBeGreaterThan(0);
  });

  test('player respawns with full health when health updates from server', () => {
    // Simulate death
    ship.health = 0;
    ship.exploding = true;

    // Simulate server sending respawn data
    const respawnData = {
      health: ship.maxHealth,
      exploding: false,
      respawnTimer: 0,
    };

    // Update from server
    player.updateFromServer(respawnData);

    // Should have full health and not be exploding
    expect(ship.health).toBe(ship.maxHealth);
    expect(ship.exploding).toBe(false);
  });

  test('player gets spawn protection when respawning', () => {
    // Simulate death
    ship.health = 0;
    ship.exploding = true;

    // Simulate server sending respawn data
    const respawnData = {
      health: ship.maxHealth,
      exploding: false,
      respawnTimer: 0,
    };

    // Update from server
    player.updateFromServer(respawnData);

    // Should have spawn protection (blinking)
    expect(ship.blinkCount).toBeGreaterThan(0);
    expect(ship.spawnProtectionTimer).toBeGreaterThan(0);
    expect(ship.blinkOn).toBe(true);
  });

  test('spawn protection values are correct', () => {
    // Simulate death and respawn
    ship.health = 0;
    ship.exploding = true;

    const respawnData = {
      health: ship.maxHealth,
      exploding: false,
      respawnTimer: 0,
    };

    player.updateFromServer(respawnData);

    // Check that spawn protection values match constants
    const expectedBlinkCount = Math.ceil(
      SHIP.INVINCIBILITY_DURATION_FRAMES / SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES
    );
    const expectedSpawnProtectionTimer = SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES;

    expect(ship.blinkCount).toBe(expectedBlinkCount);
    expect(ship.spawnProtectionTimer).toBe(expectedSpawnProtectionTimer);
  });

  test('spawn protection updates over time', () => {
    // Simulate death and respawn
    ship.health = 0;
    ship.exploding = true;

    const respawnData = {
      health: ship.maxHealth,
      exploding: false,
      respawnTimer: 0,
    };

    player.updateFromServer(respawnData);

    const initialSpawnProtectionTimer = ship.spawnProtectionTimer;

    // Update invincibility (simulate game loop)
    ship.updateInvincibility();

    // Should have decremented
    expect(ship.spawnProtectionTimer).toBeLessThan(initialSpawnProtectionTimer);
  });

  test('spawn protection expires after all blinks', () => {
    // Simulate death and respawn
    ship.health = 0;
    ship.exploding = true;

    const respawnData = {
      health: ship.maxHealth,
      exploding: false,
      respawnTimer: 0,
    };

    player.updateFromServer(respawnData);

    // Run through all invincibility frames (180 frames total)
    const totalFrames = SHIP.INVINCIBILITY_DURATION_FRAMES;
    for (let i = 0; i < totalFrames; i++) {
      ship.updateInvincibility();
    }

    // Should have no more spawn protection
    expect(ship.blinkCount).toBe(0);
    // The timer should be at its initial value (6) when blinkCount reaches 0
    expect(ship.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES);
  });
});
