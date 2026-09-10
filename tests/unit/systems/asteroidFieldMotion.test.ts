import { afterEach, assert, describe, expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import {
  containAsteroidPosition,
  containAsteroidPositionInto,
  getAsteroidFieldRadius,
  isOnPlayfieldCanvas,
  stepAsteroidMotion,
  stepAsteroidMotionInto,
} from '../../../src/physics/asteroidMotion';

describe('authoritative asteroid motion', () => {
  let engine: GameEngine | undefined;

  afterEach(() => {
    engine?.stopGameLoop();
    engine = undefined;
  });

  test('a server tick translates an asteroid by its velocity and rotates it', () => {
    const manager = new AsteroidManager(new RNGService(1));
    manager.createAsteroids(3);
    const asteroid = manager.getAllAsteroids()[0];
    assert.exists(asteroid);
    const id = asteroid.id;

    manager.updateAsteroid(id, {
      position: { x: 10, y: 20 },
      velocity: { x: 3, y: -4 },
      rotation: 0.5,
      angularVelocity: 0.01,
    });

    manager.updateMotion();

    const moved = manager.getAsteroid(id);
    expect(moved?.position).toEqual({ x: 13, y: 16 });
    expect(moved?.rotation).toBeCloseTo(0.51);
  });

  test('asteroids move over time on the running server loop', async () => {
    engine = new GameEngine(1);
    engine.startGameLoop();
    engine.createAsteroids(5);

    const tracked = engine.getAllAsteroids()[0];
    assert.exists(tracked);
    engine.updateAsteroid(tracked.id, {
      position: { x: 0, y: 0 },
      velocity: { x: 2, y: 0 },
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const after = engine.getAsteroid(tracked.id);
    assert.exists(after);
    expect(after.position.x).toBeGreaterThan(2);
  });

  test('an escaped asteroid is pulled back along the same ray, not the opposite rim', () => {
    const fieldRadius = getAsteroidFieldRadius();
    const contained = containAsteroidPosition(10000, 8000);
    expect(Math.hypot(contained.x, contained.y)).toBeLessThanOrEqual(fieldRadius);
    expect(contained.x).toBeGreaterThan(0);
    expect(contained.y).toBeGreaterThan(0);
  });

  test('a server tick contains an escaped asteroid instead of leaving the camera', () => {
    const manager = new AsteroidManager(new RNGService(1));
    manager.createAsteroids(1);
    const asteroid = manager.getAllAsteroids()[0];
    assert.exists(asteroid);
    manager.updateAsteroid(asteroid.id, {
      position: { x: 12000, y: 0 },
      velocity: { x: 2, y: 0 },
    });
    manager.updateMotion();
    const after = manager.getAsteroid(asteroid.id);
    assert.exists(after);
    const fieldRadius = getAsteroidFieldRadius();
    expect(Math.hypot(after.position.x, after.position.y)).toBeLessThanOrEqual(fieldRadius);
    expect(after.position.x).toBeGreaterThan(0);
    expect(after.velocity.x).toBeLessThan(0);
  });

  test('bouncing at the field edge does not teleport to the opposite side', () => {
    const fieldRadius = getAsteroidFieldRadius();
    const stepped = stepAsteroidMotion({ x: fieldRadius + 40, y: 0 }, { x: 8, y: 0 });
    expect(stepped.position.x).toBeGreaterThan(0);
    expect(stepped.position.x).toBeLessThanOrEqual(fieldRadius);
    expect(stepped.velocity.x).toBeLessThan(0);
    expect(Math.abs(stepped.position.x - -(fieldRadius * 0.96))).toBeGreaterThan(500);
  });

  test('after 60s of ticks the belt stays in-field and on a 1080p canvas from origin', () => {
    const manager = new AsteroidManager(new RNGService(7));
    manager.createAsteroids(20);
    const fieldRadius = getAsteroidFieldRadius();
    const origin = { x: 0, y: 0 };

    for (let i = 0; i < 3600; i++) {
      manager.updateMotion();
    }

    const after = manager.getAllAsteroids();
    expect(after.length).toBeGreaterThan(0);
    for (const asteroid of after) {
      expect(Math.hypot(asteroid.position.x, asteroid.position.y)).toBeLessThanOrEqual(
        fieldRadius + 1
      );
    }

    const onCanvas = after.filter((asteroid) => isOnPlayfieldCanvas(asteroid.position, origin));
    expect(onCanvas.length).toBeGreaterThan(0);
  });

  test('two interpolators stay aligned across a bounce when they share snapshots', () => {
    const start = { position: { x: getAsteroidFieldRadius() - 6, y: 0 }, velocity: { x: 4, y: 0 } };
    let server = { ...start, position: { ...start.position }, velocity: { ...start.velocity } };
    let clientA = { ...start, position: { ...start.position }, velocity: { ...start.velocity } };
    let clientB = { ...start, position: { ...start.position }, velocity: { ...start.velocity } };

    for (let tick = 0; tick < 30; tick++) {
      server = stepAsteroidMotion(server.position, server.velocity);
      clientA = stepAsteroidMotion(clientA.position, clientA.velocity);
      // 120 Hz tab: two half-ticks per server tick
      clientB = stepAsteroidMotion(clientB.position, clientB.velocity, 0.5);
      clientB = stepAsteroidMotion(clientB.position, clientB.velocity, 0.5);

      if (tick % 2 === 1) {
        clientA = { position: { ...server.position }, velocity: { ...server.velocity } };
        clientB = { position: { ...server.position }, velocity: { ...server.velocity } };
      }
    }

    expect(Math.abs(clientA.position.x - clientB.position.x)).toBeLessThan(8);
    expect(Math.abs(clientA.position.y - clientB.position.y)).toBeLessThan(8);
    expect(clientA.position.x).toBeGreaterThan(0);
    expect(clientB.position.x).toBeGreaterThan(0);
  });

  test('two interpolators stay aligned over 30s of 60 Hz ticks with 30 Hz snapshots', () => {
    const start = { position: { x: 40, y: -15 }, velocity: { x: 2.5, y: 1.25 } };
    let server = { position: { ...start.position }, velocity: { ...start.velocity } };
    let clientA = { position: { ...start.position }, velocity: { ...start.velocity } };
    let clientB = { position: { ...start.position }, velocity: { ...start.velocity } };
    const fieldRadius = getAsteroidFieldRadius();

    for (let tick = 0; tick < 1800; tick++) {
      server = stepAsteroidMotion(server.position, server.velocity);
      clientA = stepAsteroidMotion(clientA.position, clientA.velocity);
      clientB = stepAsteroidMotion(clientB.position, clientB.velocity, 0.5);
      clientB = stepAsteroidMotion(clientB.position, clientB.velocity, 0.5);

      if (tick % 2 === 1) {
        clientA = { position: { ...server.position }, velocity: { ...server.velocity } };
        clientB = { position: { ...server.position }, velocity: { ...server.velocity } };
      }
    }

    expect(Math.abs(clientA.position.x - clientB.position.x)).toBeLessThan(1);
    expect(Math.abs(clientA.position.y - clientB.position.y)).toBeLessThan(1);
    expect(Math.hypot(clientA.position.x, clientA.position.y)).toBeLessThanOrEqual(fieldRadius + 1);
    expect(Math.hypot(clientB.position.x, clientB.position.y)).toBeLessThanOrEqual(fieldRadius + 1);
  });

  test('stepAsteroidMotionInto writes into the provided vectors', () => {
    const position = { x: 10, y: 20 };
    const velocity = { x: 3, y: -4 };
    stepAsteroidMotionInto(position, velocity, 1, position, velocity);
    expect(position).toEqual({ x: 13, y: 16 });
    expect(velocity).toEqual({ x: 3, y: -4 });
  });

  test('containAsteroidPositionInto reuses the destination object', () => {
    const dest = { x: 0, y: 0 };
    const same = containAsteroidPositionInto(dest, 40, -15);
    expect(same).toBe(dest);
    expect(dest).toEqual({ x: 40, y: -15 });
  });
});
