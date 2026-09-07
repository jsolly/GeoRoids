import { describe, expect, test } from 'vitest';
import { GAME, SHIP } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';
import { applyThrustOrFriction, moveFrictionForShip } from '../../../src/entities/ship/shipUtils';

describe('shared ship motion helper', () => {
  test('move() friction stays bot-aware; live tick keeps frictionCoefficient', () => {
    expect(moveFrictionForShip(true)).toBe(SHIP.BOT_FRICTION);
    expect(moveFrictionForShip(false)).toBe(GAME.FRICTION);
  });

  test('thrust step matches the previous inline formula and caps at MAX_VELOCITY', () => {
    const angle = Math.PI / 2;
    const next = applyThrustOrFriction({ x: 0, y: 0 }, angle, true, GAME.FRICTION);
    expect(next.x).toBeCloseTo((Math.cos(angle) * SHIP.THRUST) / GAME.FPS);
    expect(next.y).toBeCloseTo((-Math.sin(angle) * SHIP.THRUST) / GAME.FPS);

    const capped = applyThrustOrFriction({ x: 20, y: 0 }, 0, true, GAME.FRICTION);
    const speed = Math.sqrt(capped.x * capped.x + capped.y * capped.y);
    expect(speed).toBeCloseTo(SHIP.MAX_VELOCITY);
  });

  test('friction step scales velocity by 1 - coeff / FPS', () => {
    const next = applyThrustOrFriction({ x: 4, y: -2 }, 0, false, 0.6);
    expect(next.x).toBeCloseTo(4 * (1 - 0.6 / GAME.FPS));
    expect(next.y).toBeCloseTo(-2 * (1 - 0.6 / GAME.FPS));
  });

  test('Ship.move uses the shared helper with move-path friction', () => {
    const ship = new Ship({ isBot: false });
    ship.position = { x: 0, y: 0 };
    ship.velocity = { x: 3, y: 1 };
    ship.thrusting = false;
    ship.move();
    const expected = applyThrustOrFriction(
      { x: 3, y: 1 },
      ship.angle,
      false,
      moveFrictionForShip(false),
      ship.thrust,
      ship.mass,
      ship.maxVelocity
    );
    expect(ship.velocity).toEqual(expected);
  });

  test('Ship.update uses frictionCoefficient for non-bot ships', () => {
    const ship = new Ship({ isBot: false, frictionCoefficient: 0.01 });
    ship.position = { x: 0, y: 0 };
    ship.velocity = { x: 3, y: 1 };
    ship.thrusting = false;
    ship.exploding = false;
    ship.update();
    const expected = applyThrustOrFriction(
      { x: 3, y: 1 },
      ship.angle,
      false,
      0.01,
      ship.thrust,
      ship.mass,
      ship.maxVelocity
    );
    expect(ship.velocity).toEqual(expected);
  });
});
