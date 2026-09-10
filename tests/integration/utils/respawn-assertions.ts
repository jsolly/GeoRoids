import { expect } from 'vitest';

/** Circular world boundary radius (must match server/client). */
const BOUNDARY_RADIUS = 3100;

/** Server respawns within 80% of the boundary radius. */
const RESPAWN_MAX_RADIUS = BOUNDARY_RADIUS * 0.8;

/** Respawn must land noticeably away from the death location. */
const MIN_RESPAWN_DISTANCE_FROM_DEATH = 75;

/**
 * Assert the server respawned the ship at a new random location inside the
 * playfield — not at the spot where it died.
 */
export function expectRandomRespawnPlacement(
  deathPosition: { x: number; y: number },
  respawnPosition: { x: number; y: number }
): void {
  const fromCenter = Math.hypot(respawnPosition.x, respawnPosition.y);
  expect(fromCenter, 'respawn should be inside the boundary').toBeLessThan(BOUNDARY_RADIUS);
  expect(fromCenter, 'respawn should be within the server respawn disk').toBeLessThanOrEqual(
    RESPAWN_MAX_RADIUS + 1
  );

  const fromDeath = Math.hypot(
    respawnPosition.x - deathPosition.x,
    respawnPosition.y - deathPosition.y
  );
  expect(fromDeath, 'respawn should not be at the death location').toBeGreaterThan(
    MIN_RESPAWN_DISTANCE_FROM_DEATH
  );
}
