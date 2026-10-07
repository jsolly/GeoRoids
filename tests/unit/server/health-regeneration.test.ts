/* @vitest-environment node */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../../shared/constants/health';
import { DAMAGE, GAME, SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';
import { GameServerWorld, type Pilot } from '../scenarios/support/gameServerWorld';

describe('server-authoritative health regeneration', () => {
  let world: GameServerWorld;
  let pilot: Pilot;

  beforeEach(() => {
    world = new GameServerWorld(90210);
    pilot = world.join('Pilot', { x: 0, y: 0 });
    world.wearOffJoinInvulnerability();
  });

  afterEach(() => {
    world.dispose();
    vi.restoreAllMocks();
  });

  test('uses the ship tuning for one-frame rate and post-damage delay', () => {
    expect(calculateHealthRegenPerFrame(SHIP.MAX_HEALTH)).toBe(
      (SHIP.MAX_HEALTH * SHIP.HEALTH_REGEN_FRACTION_PER_SECOND) / GAME.FPS
    );
    expect(calculateHealthRegenDelayFrames()).toBe(Math.ceil(SHIP.HEALTH_REGEN_DELAY * GAME.FPS));
  });

  test('player damage waits for the delay, then heals and caps at max health', () => {
    const ship = world.entity(pilot);
    world.engine.handleShipDamage(pilot.id, 'asteroid', DAMAGE.LASER_HIT);
    expect(ship.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);
    expect(ship.healthRegenTimer).toBe(calculateHealthRegenDelayFrames());

    world.tick(calculateHealthRegenDelayFrames());
    expect(ship.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);

    world.tick(1);
    expect(ship.health).toBeCloseTo(
      SHIP.MAX_HEALTH - DAMAGE.LASER_HIT + calculateHealthRegenPerFrame(SHIP.MAX_HEALTH)
    );

    ship.health = ship.maxHealth - calculateHealthRegenPerFrame(SHIP.MAX_HEALTH) / 2;
    ship.healthRegenTimer = 0;
    world.tick(1);
    expect(ship.health).toBe(ship.maxHealth);
  });

  test.each([100, 140, 220])(
    'a hull with %s max health recovers two percent in one damage-free second',
    (maxHealth) => {
      const ship = world.entity(pilot);
      world.engine.updatePlayer(pilot.id, { maxHealth, health: maxHealth });
      world.engine.handleShipDamage(pilot.id, 'asteroid', 20);
      world.tick(5 * GAME.FPS);
      expect(ship.health).toBe(maxHealth - 20);
      world.tick(GAME.FPS);
      expect(ship.health).toBeCloseTo(maxHealth - 20 + maxHealth * 0.02, 8);
    }
  );

  test('a repeated hit resets the same regeneration timer', () => {
    const ship = world.entity(pilot);
    world.engine.handleShipDamage(pilot.id, 'asteroid', DAMAGE.LASER_HIT);
    world.tick(calculateHealthRegenDelayFrames() - 1);
    const healthBeforeSecondHit = ship.health;

    world.engine.handleShipDamage(pilot.id, 'asteroid', 1);
    expect(ship.health).toBe(healthBeforeSecondHit - 1);
    expect(ship.healthRegenTimer).toBe(calculateHealthRegenDelayFrames());

    world.tick(calculateHealthRegenDelayFrames());
    expect(ship.health).toBe(healthBeforeSecondHit - 1);
    world.tick(1);
    expect(ship.health).toBeCloseTo(
      healthBeforeSecondHit - 1 + calculateHealthRegenPerFrame(SHIP.MAX_HEALTH)
    );
  });

  test('a client update cannot clear the server timer and the dead ship waits for respawn', () => {
    const ship = world.entity(pilot);
    world.engine.handleShipDamage(pilot.id, 'asteroid', DAMAGE.LASER_HIT);
    const delay = ship.healthRegenTimer;

    world.send(pilot, {
      type: 'update',
      id: pilot.id,
      data: { healthRegenTimer: 0 },
    });
    expect(ship.healthRegenTimer).toBe(delay);

    world.engine.handleShipDamage(pilot.id, 'asteroid', ship.health);
    expect(ship.health).toBe(0);
    world.tick(SHIP.EXPLODE_DURATION_FRAMES + SHIP.RESPAWN_DELAY_FRAMES + 1);
    expect(ship.health).toBe(SHIP.MAX_HEALTH);
    expect(ship.respawnTimer).toBeUndefined();
  });
  test('a pilot returning after transport grace keeps the remaining recovery wait', () => {
    const now = world.engine.getServerTime();
    vi.spyOn(world.engine, 'getServerTime').mockReturnValue(now);
    const ship = world.entity(pilot);
    world.engine.handleShipDamage(pilot.id, 'asteroid', 20);
    world.tick(2 * GAME.FPS);
    const damagedHealth = ship.health;
    const timer = ship.healthRegenTimer;
    world.engine.removePlayer(pilot.id);
    const resumed = world.engine.resumePilot(pilot.resumeToken, new RecordingSocket());
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) {
      throw new Error('Expected resumed pilot');
    }
    expect(resumed.actor.healthRegenTimer).toBe(timer);
    world.tick(timer);
    expect(resumed.actor.health).toBe(damagedHealth);
    world.tick(1);
    expect(resumed.actor.health).toBeGreaterThan(damagedHealth);
  });

  test('time offline counts toward the saved recovery wait without granting offline healing', () => {
    const clock = vi.spyOn(world.engine, 'getServerTime');
    const now = world.engine.getServerTime();
    clock.mockReturnValue(now);
    const ship = world.entity(pilot);
    world.engine.handleShipDamage(pilot.id, 'asteroid', 20);
    world.engine.removePlayer(pilot.id);
    clock.mockReturnValue(now + 3000);
    const resumed = world.engine.resumePilot(pilot.resumeToken, new RecordingSocket());
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) {
      throw new Error('Expected resumed pilot');
    }
    expect(resumed.actor.health).toBe(ship.health);
    expect(resumed.actor.healthRegenTimer).toBe(2 * GAME.FPS);
    clock.mockRestore();
  });
});
