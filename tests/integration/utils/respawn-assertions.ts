import { expect } from 'vitest';
import { FURNACES } from '../../../shared/furnaces';
import { WORLD } from '../../../shared/world';

/** Circular world boundary radius (must match server/client). */
const BOUNDARY_RADIUS = WORLD.radius;

/** Server respawns 180 units from the nearest furnace before live motion resumes. */
const RESPAWN_FURNACE_OFFSET = 180;
/** Allow a short interval of automatic thrust after the authoritative placement. */
const RESPAWN_MOTION_TOLERANCE = 120;

/** Respawn must land noticeably away from the death location. */
const MIN_RESPAWN_DISTANCE_FROM_DEATH = 75;

/**
 * Assert the server respawned the ship near the furnace selected from its death
 * location — not at the spot where it died.
 */
export function expectFurnaceRespawnPlacement(
  deathPosition: { x: number; y: number },
  respawnPosition: { x: number; y: number }
): void {
  const fromCenter = Math.hypot(respawnPosition.x, respawnPosition.y);
  expect(fromCenter, 'respawn should be inside the boundary').toBeLessThan(BOUNDARY_RADIUS);

  const nearestFurnace = FURNACES.reduce((nearest, furnace) =>
    !nearest ||
    Math.hypot(furnace.position.x - deathPosition.x, furnace.position.y - deathPosition.y) <
      Math.hypot(nearest.position.x - deathPosition.x, nearest.position.y - deathPosition.y)
      ? furnace
      : nearest
  );
  const fromFurnace = Math.hypot(
    respawnPosition.x - nearestFurnace.position.x,
    respawnPosition.y - nearestFurnace.position.y
  );
  expect(fromFurnace, 'respawn should be near the nearest furnace').toBeLessThanOrEqual(
    RESPAWN_FURNACE_OFFSET + RESPAWN_MOTION_TOLERANCE
  );

  const fromDeath = Math.hypot(
    respawnPosition.x - deathPosition.x,
    respawnPosition.y - deathPosition.y
  );
  expect(fromDeath, 'respawn should not be at the death location').toBeGreaterThan(
    MIN_RESPAWN_DISTANCE_FROM_DEATH
  );
}
