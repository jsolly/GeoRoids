import { afterEach, describe, expect, test, vi } from 'vitest';
import { GAME, SHIP } from '../../../src/constants';
import { createLaser } from '../../../src/entities/laser/laserUtils';
import { Ship } from '../../../src/entities/ship/Ship';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { applyThrustOrFriction } from '../../../src/entities/ship/shipUtils';
import { canvasManager } from '../../../src/rendering/canvas';

afterEach(() => vi.restoreAllMocks());

describe('shared ship motion helper', () => {
  test('thrust and fired shots move 25 percent slower', () => {
    expect(GAME.MOTION_SCALE).toBe(0.75);
    expect(GAME.FPS).toBe(60);
    const ship = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true });
    ship.angle = 0;
    ship.angularVelocity = 0;
    ship.velocity = { x: 0, y: 0 };
    ship.thrusting = true;
    ship.exploding = false;
    ship.update();
    expect(ship.velocity.x).toBeCloseTo(0.0625);
    expect(ship.velocity.y).toBeCloseTo(0);

    const firingShip = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true });
    firingShip.angle = 0;
    firingShip.velocity = { x: 0, y: 0 };
    const laser = createLaser(firingShip);
    const start = { ...laser.position };
    laser.move();
    expect(laser.position.x - start.x).toBeCloseTo(3.75);
    expect(laser.position.y - start.y).toBeCloseTo(0);
  });

  test('slower shots keep viewport reach and the 250 millisecond fire cooldown', () => {
    vi.spyOn(canvasManager, 'getCanvas').mockReturnValue({
      width: 390,
      height: 844,
    } as HTMLCanvasElement);
    vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 390, height: 844 });
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const ship = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true });
    ship.angle = 0;
    ship.velocity = { x: 0, y: 0 };
    const laser = createLaser(ship);
    for (let frame = 0; frame < 104; frame += 1) {
      laser.move();
    }
    expect(laser.distTraveled).toBe(390);
    expect(laser.isExpired()).toBe(false);
    laser.move();
    expect(laser.distTraveled).toBe(393.75);
    expect(laser.isExpired()).toBe(true);

    ship.shoot();
    expect(ship.lasers).toHaveLength(1);
    expect(ship.canShoot).toBe(false);
    now = 1249;
    ship.update();
    expect(ship.canShoot).toBe(false);
    now = 1250;
    ship.update();
    expect(ship.canShoot).toBe(true);
    ship.shoot();
    expect(ship.lasers).toHaveLength(2);
  });

  test('thrust step matches the previous inline formula and caps at six units per frame', () => {
    const angle = Math.PI / 2;
    const next = applyThrustOrFriction({ x: 0, y: 0 }, angle, true, GAME.FRICTION);
    expect(next.x).toBeCloseTo((Math.cos(angle) * SHIP.THRUST) / GAME.FPS);
    expect(next.y).toBeCloseTo((-Math.sin(angle) * SHIP.THRUST) / GAME.FPS);

    const capped = applyThrustOrFriction({ x: 20, y: 0 }, 0, true, GAME.FRICTION);
    const speed = Math.sqrt(capped.x * capped.x + capped.y * capped.y);
    expect(SHIP.MAX_VELOCITY).toBe(6);
    expect(speed).toBeCloseTo(6);
  });

  test.each([
    ['dart', 6],
    ['hauler', 4.5],
    ['warden', 5.25],
    ['skirmisher', 6.375],
    ['quake', 6],
  ] as const)('%s keeps its 25 percent slower cruising speed cap', (kitId, cap) => {
    expect(getShipKit(kitId).maxVelocity).toBe(cap);
    const ship = new Ship({ kitId, position: { x: 0, y: 0 }, isLocalPlayer: true });
    ship.angle = 0;
    ship.angularVelocity = 0;
    ship.velocity = { x: 20, y: 0 };
    ship.thrusting = true;
    ship.exploding = false;
    ship.update();
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeCloseTo(cap);
  });

  test('friction step scales velocity by 1 - coeff / FPS', () => {
    const next = applyThrustOrFriction({ x: 4, y: -2 }, 0, false, 0.6);
    expect(next.x).toBeCloseTo(4 * (1 - 0.6 / GAME.FPS));
    expect(next.y).toBeCloseTo(-2 * (1 - 0.6 / GAME.FPS));
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
