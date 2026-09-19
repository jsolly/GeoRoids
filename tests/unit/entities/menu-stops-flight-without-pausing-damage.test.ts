import { expect, test } from 'vitest';
import { Ship } from '../../../src/entities/ship/Ship';

test('a menu stops momentum and steering while damage and ability timers keep running', () => {
  const ship = new Ship({ isLocalPlayer: true, position: { x: 200, y: 100 } });
  ship.spawnProtectionTimer = 0;
  ship.abilityCooldownFrames = 120;
  ship.velocity = { x: 8, y: -4 };
  ship.angularVelocity = 0.1;
  ship.thrusting = true;
  ship.toggleBoost();
  ship.movementLocked = true;
  const angle = ship.angle;
  for (let frame = 0; frame < 60; frame++) {
    ship.update();
  }
  expect(ship.position).toEqual({ x: 200, y: 100 });
  expect(ship.velocity).toEqual({ x: 0, y: 0 });
  expect(ship.angle).toBe(angle);
  expect(ship.thrusting).toBe(false);
  expect(ship.abilityCooldownFrames).toBe(60);
  const health = ship.health;
  ship.takeDamage(25, 'asteroid');
  expect(ship.health).toBe(health - 25);
  ship.movementLocked = false;
  ship.update();
  expect(ship.position).not.toEqual({ x: 200, y: 100 });
});
