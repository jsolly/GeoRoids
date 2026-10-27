import { describe, expect, test } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { beginNavigation, stopNavigation } from '../../../src/entities/ship/navigation';
import { Ship } from '../../../src/entities/ship/Ship';
import { keyDown, keyUp } from '../../../src/input/keybindings';

describe('intentional flight', () => {
  test.each(['scout', 'hauler'] as const)(
    '%s stays still until ordered, then settles at the destination',
    (kitId) => {
      const ship = new Ship({ kitId, position: { x: 2000, y: 0 } });
      ship.angle = 0;
      for (let tick = 0; tick < 60; tick++) {
        ship.update();
      }
      expect(ship.position).toEqual({ x: 2000, y: 0 });
      beginNavigation(ship, { x: 2100, y: 0 });
      for (let tick = 0; tick < 300; tick++) {
        ship.update();
      }
      expect(ship.navigation).toBeNull();
      expect(Math.abs(ship.position.x - 2100)).toBeLessThanOrEqual(ship.r);
      const arrived = { ...ship.position };
      for (let tick = 0; tick < 60; tick++) {
        ship.update();
      }
      expect(ship.position).toEqual(arrived);
      expect(ship.velocity).toEqual({ x: 0, y: 0 });
    }
  );
  test('redirection turns at the existing rate and Stop brakes to rest', () => {
    const ship = new Ship({ position: { x: 2000, y: 0 } });
    ship.angle = 0;
    beginNavigation(ship, { x: 2200, y: 0 });
    for (let tick = 0; tick < 30; tick++) {
      ship.update();
    }
    beginNavigation(ship, { x: 2000, y: -200 });
    ship.update();
    expect(ship.angularVelocity).toBeGreaterThan(0);
    expect(ship.angle).toBeLessThan(Math.PI / 2);
    stopNavigation(ship);
    for (let tick = 0; tick < 60; tick++) {
      ship.update();
    }
    expect(ship.velocity).toEqual({ x: 0, y: 0 });
    expect(ship.navigation).toBeNull();
  });
  test('a blocked route cancels after sustained lack of progress, but a shove does not', () => {
    const ship = new Ship({ position: { x: 2000, y: 0 } });
    ship.angle = 0;
    beginNavigation(ship, { x: 2200, y: 0 });
    for (let tick = 0; tick < 70; tick++) {
      ship.position = { x: 2000, y: 0 };
      ship.update();
    }
    expect(ship.navigation).toBeNull();
    expect(ship.navigationStatus).toBe('Route blocked');
    beginNavigation(ship, { x: 2300, y: 0 });
    ship.velocity = { x: 0, y: 12 };
    ship.knockbackVelocityLimit = 12;
    ship.update();
    expect(ship.navigation).not.toBeNull();
    expect(ship.position.y).toBeGreaterThan(1);
  });
  test('W supplies thrust and releasing it brakes without changing keyboard steering', () => {
    const p = new Player({ id: 'pilot', name: 'Pilot', type: 'local' });
    p.ship.position = { x: 2000, y: 0 };
    p.ship.angle = 0;
    keyDown(new KeyboardEvent('keydown', { code: 'KeyW' }), p);
    p.ship.update();
    expect(p.ship.velocity.x).toBeGreaterThan(0);
    keyUp(new KeyboardEvent('keyup', { code: 'KeyW' }), p);
    for (let tick = 0; tick < 60; tick++) {
      p.ship.update();
    }
    expect(p.ship.velocity).toEqual({ x: 0, y: 0 });
  });
});
