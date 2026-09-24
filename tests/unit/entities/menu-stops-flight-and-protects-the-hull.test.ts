import { expect, test } from 'vitest';
import { SHIP } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';
import { applyLocalOverlayHold, isShipCollisionImmune } from '../../../src/entities/ship/shipUtils';

test('a menu stops momentum and collisions, then blinks when flight returns', () => {
  const ship = new Ship({ isLocalPlayer: true, position: { x: 200, y: 100 } });
  ship.spawnProtectionTimer = 0;
  ship.abilityCooldownFrames = 120;
  ship.velocity = { x: 8, y: -4 };
  ship.angularVelocity = 0.1;
  ship.thrusting = true;
  ship.toggleBoost();
  expect(applyLocalOverlayHold(ship, true)).toBe(true);
  expect(applyLocalOverlayHold(ship, true)).toBe(false);
  const angle = ship.angle;
  const health = ship.health;
  for (let frame = 0; frame < 60; frame++) {
    ship.update();
  }
  expect(ship.position).toEqual({ x: 200, y: 100 });
  expect(ship.velocity).toEqual({ x: 0, y: 0 });
  expect(ship.angle).toBe(angle);
  expect(ship.thrusting).toBe(false);
  expect(ship.abilityCooldownFrames).toBe(60);
  expect(isShipCollisionImmune(ship)).toBe(true);
  ship.takeDamage(25, 'asteroid');
  expect(ship.health).toBe(health);
  expect(applyLocalOverlayHold(ship, false)).toBe(true);
  expect(ship.blinkCount).toBeGreaterThan(0);
  expect(ship.spawnProtectionTimer).toBeGreaterThan(0);
  expect(ship.blinkCount).toBe(
    Math.ceil(SHIP.INVINCIBILITY_DURATION_FRAMES / SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES)
  );
  ship.thrusting = true;
  ship.update();
  expect(ship.position).not.toEqual({ x: 200, y: 100 });
});
