import { beforeEach, describe, expect, test, vi } from 'vitest';
import { WORLD } from '../../../shared/world';
import { Ship } from '../../../src/entities/ship/Ship';
import { CollisionManager } from '../../../src/physics/CollisionManager';

vi.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

/** Scout hull radius; the wall rule adds it to the floored distance from centre. */
const HULL_RADIUS = 15;
/** `floor(59_990) + 15` clears the 60,000 wall, so this hull is touching it. */
const WALL_CONTACT = { x: WORLD.radius - 10, y: 0 };
/** `floor(59_985) + 15` lands exactly on the wall: the last legal position. */
const LAST_LEGAL = { x: WORLD.radius - HULL_RADIUS, y: 0 };
/** Legal only because the rule floors the distance first: `59_985.9` would otherwise clear it. */
const LAST_LEGAL_FRACTIONAL = { x: WORLD.radius - HULL_RADIUS + 0.9, y: 0 };
/** Same contact and clearance on the diagonal, where a square arena would differ. */
const DIAGONAL_CONTACT = { x: 42_419, y: 42_419 };
const DIAGONAL_LAST_LEGAL = { x: 42_415, y: 42_415 };

function vulnerableHull(position: { x: number; y: number }): Ship {
  const ship = new Ship({ isLocalPlayer: false });
  ship.health = 100;
  ship.blinkCount = 0;
  ship.exploding = false;
  ship.position = { ...position };
  return ship;
}

describe('Boundary collision', () => {
  let collisionManager: CollisionManager;

  beforeEach(() => {
    collisionManager = CollisionManager.getInstance();
  });

  test('the hull radius this arrangement relies on is the live scout radius', () => {
    expect(new Ship({ isLocalPlayer: false }).r).toBe(HULL_RADIUS);
    expect(WORLD.radius).toBe(60_000);
  });

  test('a vulnerable hull touching the wall flashes and is never killed locally', () => {
    const ship = vulnerableHull(WALL_CONTACT);

    collisionManager.checkBoundaryCollisions([ship]);

    // The flash is local feedback; the kill is the server's, read from the pose
    // this hull reports. Killing it here would freeze it, which arms the
    // respawn latch in `Player.updateFromServer` and lets the next snapshot
    // overwrite the overlapping position with the server's always-inside row —
    // erasing the contact before any pose can carry it.
    expect(ship.impactFlashFrames).toBeGreaterThan(0);
    expect(ship.health).toBe(100);
    expect(ship.exploding).toBe(false);
  });

  test('a hull whose edge sits exactly on the wall is left completely alone', () => {
    const ship = vulnerableHull(LAST_LEGAL);

    collisionManager.checkBoundaryCollisions([ship]);

    expect(ship.health).toBe(100);
    expect(ship.exploding).toBe(false);
    expect(ship.impactFlashFrames).toBe(0);
  });

  test('the wall rule floors the distance, so a fractional overhang is still legal', () => {
    const ship = vulnerableHull(LAST_LEGAL_FRACTIONAL);

    collisionManager.checkBoundaryCollisions([ship]);

    expect(ship.health).toBe(100);
    expect(ship.exploding).toBe(false);
    expect(ship.impactFlashFrames).toBe(0);
  });

  test('the wall is a circle, so the diagonal registers at the same distance from centre', () => {
    const touching = vulnerableHull(DIAGONAL_CONTACT);
    const clear = vulnerableHull(DIAGONAL_LAST_LEGAL);

    collisionManager.checkBoundaryCollisions([touching, clear]);

    expect(touching.impactFlashFrames).toBeGreaterThan(0);
    expect(clear.impactFlashFrames).toBe(0);
    expect(clear.health).toBe(100);
  });

  test('wall contact drops a contour lock even when the hull cannot be damaged', () => {
    const ship = vulnerableHull(WALL_CONTACT);
    ship.contourLock = { height: 40, direction: 1 };
    ship.blinkCount = 12;

    collisionManager.checkBoundaryCollisions([ship]);

    expect(ship.contourLocked).toBe(false);
    expect(ship.health).toBe(100);
    expect(ship.exploding).toBe(false);
  });

  test('a blinking hull at the wall registers nothing', () => {
    const ship = vulnerableHull(WALL_CONTACT);
    ship.blinkCount = 12;

    collisionManager.checkBoundaryCollisions([ship]);

    expect(ship.health).toBe(100);
    expect(ship.exploding).toBe(false);
    expect(ship.impactFlashFrames).toBe(0);
  });

  test('a hull a menu holds still at the wall registers nothing', () => {
    const ship = vulnerableHull(WALL_CONTACT);
    ship.movementLocked = true;

    collisionManager.checkBoundaryCollisions([ship]);

    expect(ship.health).toBe(100);
    expect(ship.exploding).toBe(false);
    expect(ship.impactFlashFrames).toBe(0);
  });

  test('a dead or already exploding hull at the wall registers nothing again', () => {
    const dead = vulnerableHull(WALL_CONTACT);
    dead.health = 0;
    const exploding = vulnerableHull(WALL_CONTACT);
    exploding.exploding = true;
    // Last in the list, so skipping an immune hull must not skip the rest.
    const vulnerable = vulnerableHull(WALL_CONTACT);

    collisionManager.checkBoundaryCollisions([dead, exploding, vulnerable]);

    expect(dead.impactFlashFrames).toBe(0);
    expect(exploding.health).toBe(100);
    expect(exploding.impactFlashFrames).toBe(0);
    expect(vulnerable.impactFlashFrames).toBeGreaterThan(0);
  });
});
