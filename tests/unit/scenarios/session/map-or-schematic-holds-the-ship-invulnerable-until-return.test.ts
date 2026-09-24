import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DAMAGE, SHIP } from '../../../../src/constants';
import {
  EXPLOSION_FRAMES,
  GameServerWorld,
  type Pilot,
  SPAWN_PROTECTION_FRAMES,
  useQuietServerConsole,
} from '../support/gameServerWorld';

useQuietServerConsole();

describe('Map or schematic holds the ship invulnerable until return', () => {
  let world: GameServerWorld;
  let ace: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    ace = world.join('Ace', { x: 120, y: -40 });
    world.clearAsteroids();
    world.wearOffJoinInvulnerability();
  });

  afterEach(() => {
    world.dispose();
  });

  function sendHold(held: boolean, position = world.entity(ace).position): void {
    const entity = world.entity(ace);
    const motion = entity.playerMotion;
    if (!motion) {
      throw new Error('Ace has no current motion session');
    }
    world.send(ace, {
      type: 'update',
      id: ace.id,
      data: {
        position,
        velocity: { x: 4, y: 0 },
        angle: entity.angle,
        thrusting: true,
        overlayHold: held,
        motionEpoch: motion.epoch,
        motionSequence: motion.ack + 1,
      },
    });
  }

  test('an overlay pins the hull, ignores rocks, then blinks when flight resumes', () => {
    const origin = { ...world.entity(ace).position };
    sendHold(true, { x: origin.x + 400, y: origin.y });
    const held = world.entity(ace);
    expect(held.position).toEqual(origin);
    expect(held.velocity).toEqual({ x: 0, y: 0 });
    expect(held.thrusting).toBe(false);
    expect(held.overlayHold).toBe(true);

    const parkedPickup = world.engine.getAllSatellitePickups()[0];
    if (!parkedPickup) {
      throw new Error('Ace joined without a loose satellite pickup');
    }
    world.engine.parkSatellitePickups(origin);
    world.engine.tickSatellitePickups();
    expect(world.entity(ace).score).toBe(0);
    expect(world.engine.getSatellitePickup(parkedPickup.id)?.state).toBe('loose');

    const health = held.health;
    world.hitAsteroid(ace);
    expect(world.entity(ace).health).toBe(health);
    expect(world.engine.handleShipDamage(ace.id, 'ricochet', 25).applied).toBe(false);
    expect(world.engine.handleShipDamage(ace.id, 'boundary', health).applied).toBe(false);
    world.clearAsteroids();

    sendHold(false);
    const released = world.entity(ace);
    expect(released.overlayHold).toBe(false);
    expect(released.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_DURATION_FRAMES);

    world.hitAsteroid(ace);
    expect(world.entity(ace).health).toBe(health);
    expect(world.entity(ace).exploding).toBe(false);
    world.clearAsteroids();

    const consumed = 30;
    world.tick(consumed);
    sendHold(false);
    sendHold(false);
    sendHold(false);
    expect(world.entity(ace).spawnProtectionTimer).toBe(
      SHIP.INVINCIBILITY_DURATION_FRAMES - consumed
    );

    world.hitAsteroid(ace);
    expect(world.entity(ace).health).toBe(health);
    world.clearAsteroids();

    world.tick(SPAWN_PROTECTION_FRAMES - consumed);
    world.hitAsteroid(ace);
    expect(world.entity(ace).health).toBe(health - DAMAGE.ASTEROID_COLLISION);
  });

  test('a hold latched during explosion does not freeze or extra-blink the next life', () => {
    world.hitBoundary(ace);
    expect(world.entity(ace).exploding).toBe(true);
    sendHold(true);
    expect(world.entity(ace).overlayHold).toBe(true);

    sendHold(false);
    expect(world.entity(ace).overlayHold).toBe(false);
    expect(world.entity(ace).spawnProtectionTimer).toBeUndefined();

    sendHold(true);
    expect(world.entity(ace).overlayHold).toBe(true);

    world.tick(EXPLOSION_FRAMES);
    const revived = world.entity(ace);
    expect(revived.exploding).toBe(false);
    expect(revived.overlayHold).toBeUndefined();
    expect(revived.health).toBe(revived.maxHealth);
    expect(revived.spawnProtectionTimer).toBeGreaterThanOrEqual(SPAWN_PROTECTION_FRAMES - 2);
    expect(revived.spawnProtectionTimer).toBeLessThanOrEqual(SPAWN_PROTECTION_FRAMES);
  });
});
