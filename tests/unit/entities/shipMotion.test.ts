import { afterEach, describe, expect, test, vi } from 'vitest';
import { GAME, LASER, SHIP } from '../../../src/constants';
import { createLaser } from '../../../src/entities/laser/laserUtils';
import { Ship } from '../../../src/entities/ship/Ship';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { applyThrustOrFriction } from '../../../src/entities/ship/shipUtils';
import { canvasManager } from '../../../src/rendering/canvas';

afterEach(() => vi.restoreAllMocks());

describe('shared ship motion helper', () => {
  test('automatic thrust accelerates at the existing pace and shots keep their speed', () => {
    expect(GAME.MOTION_SCALE).toBe(0.5625);
    expect(GAME.FPS).toBe(60);
    const laserStep = LASER.SPEED / GAME.FPS;
    const ship = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true });
    ship.angle = 0;
    ship.angularVelocity = 0;
    ship.velocity = { x: 0, y: 0 };
    ship.thrusting = true;
    ship.exploding = false;
    ship.update();
    expect(ship.velocity.x).toBeCloseTo(SHIP.THRUST / GAME.FPS);
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
    expect(SHIP.MAX_VELOCITY).toBe(1.125);
    expect(speed).toBeCloseTo(SHIP.MAX_VELOCITY);
  });

  test.each([
    ['surveyor', 1.125],
    ['hauler', 0.984375],
  ] as const)('%s cruises at one-quarter of its former speed', (kitId, cap) => {
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

  test('cruise discards sideways momentum and follows every turn without coasting', () => {
    const ship = new Ship({ isLocalPlayer: true });
    ship.position = { x: 0, y: 0 };
    ship.angle = 0;
    ship.velocity = { x: 0, y: 0.5 };
    ship.update();
    expect(ship.velocity.x).toBeCloseTo(0.5 + SHIP.THRUST / GAME.FPS);
    expect(ship.velocity.y).toBeCloseTo(0);
    ship.angle = Math.PI / 2;
    ship.update();
    expect(ship.position.x).toBeCloseTo(0.5 + SHIP.THRUST / GAME.FPS);
    expect(ship.position.y).toBeCloseTo(-(0.5 + (2 * SHIP.THRUST) / GAME.FPS));
  });

  test('grown ships cruise at the existing mass-adjusted speed', () => {
    const ship = new Ship({ kitId: 'hauler', isLocalPlayer: true });
    ship.mass = 8;
    ship.velocity = { x: 10, y: 0 };
    ship.angle = 0;
    ship.update();
    expect(ship.velocity.x).toBeCloseTo(0.590625);
    expect(ship.velocity.y).toBeCloseTo(0);
  });

  test('an authoritative blast pushes the pilot before cruise regains the heading', () => {
    const ship = new Ship({ isLocalPlayer: true });
    ship.angle = 0;
    ship.velocity = { x: 0, y: 12 };
    ship.knockbackVelocityLimit = 12;
    ship.thrusting = true;
    ship.update();
    expect(ship.position.y).toBeGreaterThan(4.5);
    expect(ship.velocity.y).toBeGreaterThan(ship.velocity.x);
    for (let frame = 0; frame < 60; frame++) {
      ship.update();
    }
    expect(ship.velocity.x).toBeCloseTo(1.125);
    // Terrain can still deflect travel slightly after the blast has decayed.
    expect(Math.abs(Math.atan2(-ship.velocity.y, ship.velocity.x) - ship.angle)).toBeLessThan(
      Math.PI / 180
    );
  });

  test('cruise cannot advance a dead ship or a server-owned handoff', () => {
    const ship = new Ship({ isLocalPlayer: true });
    ship.serverOwnsMotion = true;
    ship.update();
    expect(ship.position).toEqual({ x: 0, y: 0 });
    ship.serverOwnsMotion = false;
    ship.health = 0;
    ship.update();
    expect(ship.position).toEqual({ x: 0, y: 0 });
  });
});
