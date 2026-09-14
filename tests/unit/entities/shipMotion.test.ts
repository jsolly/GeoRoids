import { afterEach, describe, expect, test, vi } from 'vitest';
import { GAME, LASER, SHIP } from '../../../src/constants';
import { createLaser } from '../../../src/entities/laser/laserUtils';
import { Ship } from '../../../src/entities/ship/Ship';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { applyThrustOrFriction } from '../../../src/entities/ship/shipUtils';
import { canvasManager } from '../../../src/rendering/canvas';

afterEach(() => vi.restoreAllMocks());

describe('shared ship motion helper', () => {
  test('thrust and fired shots move another 25 percent slower', () => {
    expect(GAME.MOTION_SCALE).toBe(0.5625);
    expect(GAME.FPS).toBe(60);
    const thrustStep = SHIP.THRUST / GAME.FPS;
    const laserStep = LASER.SPEED / GAME.FPS;
    const ship = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true });
    ship.angle = 0;
    ship.angularVelocity = 0;
    ship.velocity = { x: 0, y: 0 };
    ship.thrusting = true;
    ship.exploding = false;
    ship.update();
    expect(ship.velocity.x).toBeCloseTo(thrustStep);
    expect(ship.velocity.y).toBeCloseTo(0);

    const firingShip = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true });
    firingShip.angle = 0;
    firingShip.velocity = { x: 0, y: 0 };
    const laser = createLaser(firingShip);
    const start = { ...laser.position };
    laser.move();
    expect(laser.position.x - start.x).toBeCloseTo(laserStep);
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
    const step = LASER.SPEED / GAME.FPS;
    const reach = LASER.TRAVEL_DISTANCE_RATIO + 390;
    const framesBeforeExpiry = Math.floor((reach - 1e-9) / step);
    for (let frame = 0; frame < framesBeforeExpiry; frame += 1) {
      laser.move();
    }
    expect(laser.distTraveled).toBeCloseTo(framesBeforeExpiry * step);
    expect(laser.isExpired()).toBe(false);
    laser.move();
    expect(laser.distTraveled).toBeCloseTo((framesBeforeExpiry + 1) * step);
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

  test('thrust step matches the previous inline formula and caps at the scaled max', () => {
    const angle = Math.PI / 2;
    const next = applyThrustOrFriction({ x: 0, y: 0 }, angle, true, GAME.FRICTION);
    expect(next.x).toBeCloseTo((Math.cos(angle) * SHIP.THRUST) / GAME.FPS);
    expect(next.y).toBeCloseTo((-Math.sin(angle) * SHIP.THRUST) / GAME.FPS);

    const capped = applyThrustOrFriction({ x: 20, y: 0 }, 0, true, GAME.FRICTION);
    const speed = Math.sqrt(capped.x * capped.x + capped.y * capped.y);
    expect(SHIP.MAX_VELOCITY).toBe(8 * GAME.MOTION_SCALE);
    expect(speed).toBeCloseTo(SHIP.MAX_VELOCITY);
  });

  test.each([
    ['dart', 8 * GAME.MOTION_SCALE],
    ['hauler', 7 * GAME.MOTION_SCALE],
    ['warden', 7 * GAME.MOTION_SCALE],
    ['skirmisher', 8.5 * GAME.MOTION_SCALE],
    ['quake', 8 * GAME.MOTION_SCALE],
  ] as const)('%s keeps its extra 25 percent slower cruising speed cap', (kitId, cap) => {
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
