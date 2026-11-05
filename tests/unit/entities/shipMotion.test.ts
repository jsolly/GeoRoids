import { afterEach, describe, expect, test, vi } from 'vitest';
import { GAME, LASER, SHIP } from '../../../shared/constants/gameplay';
import { cargoCapacity } from '../../../shared/economy';
import { TERRAIN } from '../../../shared/terrainConfig';
import { createLaser } from '../../../src/entities/laser/laserUtils';
import { Ship } from '../../../src/entities/ship/Ship';
import { applyThrustOrFriction } from '../../../src/entities/ship/shipUtils';
import { resetWorldExploration } from '../../../src/network/worldExploration';
import { canvasManager } from '../../../src/rendering/canvasSurface';

afterEach(() => {
  vi.restoreAllMocks();
  resetWorldExploration();
});

describe('shared ship motion helper', () => {
  test('requested thrust accelerates at the existing pace and shots keep their speed', () => {
    expect(GAME.MOTION_SCALE).toBe(0.5625);
    expect(GAME.PLAYER_SPEED_SCALE).toBe(1.25);
    expect(LASER.SPEED).toBe(300 * GAME.MOTION_SCALE);
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

  test.each([
    { screen: 'a 390-wide phone', viewport: { width: 390, height: 844 } },
    { screen: 'a 1280-wide desktop', viewport: { width: 1280, height: 900 } },
    { screen: 'no canvas', viewport: null },
  ])('a shot reaches 800 world units on $screen, as the server enforces', ({ viewport }) => {
    if (viewport) {
      vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(document.createElement('canvas'));
      vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue(viewport);
    } else {
      vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(null);
    }
    const ship = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true });
    ship.angle = 0;
    // Inherited drift turns the 2.8125-unit bolt step into exactly 4 units per frame.
    ship.velocity = { x: 1.1875, y: 0 };
    const laser = createLaser(ship);
    ship.lasers = [laser];
    expect(LASER.MAX_TRAVEL_DISTANCE).toBe(800);
    expect(laser.velocity).toEqual({ x: 4, y: 0 });
    // 199 steps of 4 = 796 units, still in flight; step 200 lands on 800, which the
    // former 800.6 reach would still have allowed.
    for (let frame = 0; frame < 199; frame += 1) {
      ship.moveLasers();
    }
    expect(ship.lasers).toEqual([laser]);
    expect(laser.distTraveled).toBe(796);
    ship.moveLasers();
    expect(laser.distTraveled).toBe(800);
    expect(ship.lasers).toEqual([]);
  });

  test('ships keep the 250 millisecond fire cooldown', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const ship = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true });
    ship.angle = 0;
    ship.velocity = { x: 0, y: 0 };
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
    const speed = Math.hypot(capped.x, capped.y);
    expect(SHIP.THRUST).toBe(5 * GAME.MOTION_SCALE * GAME.PLAYER_SPEED_SCALE);
    expect(SHIP.MAX_VELOCITY).toBe(2 * GAME.MOTION_SCALE * GAME.PLAYER_SPEED_SCALE);
    expect(speed).toBeCloseTo(SHIP.MAX_VELOCITY);
  });

  test.each(['scout', 'hauler'] as const)('%s cruises at the shared velocity cap', (kitId) => {
    const cap = SHIP.MAX_VELOCITY;
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
    ship.thrusting = true;
    ship.update();
    expect(ship.velocity.x).toBeCloseTo(0.5 + SHIP.THRUST / GAME.FPS);
    expect(ship.velocity.y).toBeCloseTo(0);
    ship.angle = Math.PI / 2;
    ship.update();
    expect(ship.position.x).toBeCloseTo(0.5 + SHIP.THRUST / GAME.FPS);
    expect(ship.position.y).toBeCloseTo(-(0.5 + (2 * SHIP.THRUST) / GAME.FPS));
  });

  test('saved high-mass ships retain the shared cruise speed', () => {
    const ship = new Ship({ kitId: 'hauler', isLocalPlayer: true });
    ship.mass = 8;
    ship.velocity = { x: 10, y: 0 };
    ship.angle = 0;
    ship.thrusting = true;
    ship.update();
    expect(ship.velocity.x).toBeCloseTo(SHIP.MAX_VELOCITY);
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
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeLessThanOrEqual(
      SHIP.MAX_VELOCITY * (1 + TERRAIN.CONTOUR_SPEED_BONUS)
    );
    expect(ship.velocity.x).toBeGreaterThan(SHIP.MAX_VELOCITY * 0.24);
    // After the blast decays, cruise follows the nose exactly.
    expect(Math.atan2(-ship.velocity.y, ship.velocity.x)).toBeCloseTo(ship.angle, 10);
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

test.each(['scout', 'hauler'] as const)(
  'a %s accelerates at Scout pace for every saved mass and cargo load',
  (kitId) => {
    for (const mass of [1, 8]) {
      for (const load of [0, 0.5, 1]) {
        const ship = new Ship({ kitId, isLocalPlayer: true });
        ship.mass = mass;
        ship.cargo = cargoCapacity(kitId) * load;
        ship.angle = 0;
        ship.velocity = { x: 0, y: 0 };
        ship.thrusting = true;
        ship.update();
        expect(ship.velocity.x).toBeCloseTo((5 * 0.5625 * 1.25) / 60, 10);
        expect(ship.velocity.y).toBeCloseTo(0, 10);
        for (let frame = 0; frame < 60; frame++) {
          ship.position = { x: 0, y: 0 };
          ship.update();
        }
        expect(ship.velocity.x).toBeCloseTo(2 * 0.5625 * 1.25, 10);
        expect(ship.mass).toBe(mass);
        expect(ship.cargo).toBe(cargoCapacity(kitId) * load);
      }
    }
  }
);
