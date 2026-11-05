import { describe, expect, test } from 'vitest';
import { WORLD_BOUNDARY } from '../../../../shared/boundary';

import { Player } from '../../../../src/entities/player/Player';
import { isShipCollisionImmune } from '../../../../src/entities/ship/shipUtils';
import { CollisionManager } from '../../../../src/physics/CollisionManager';

function localPilot(): Player {
  return new Player({ id: 'local', name: 'PilotB', type: 'local' });
}

describe('Boundary death and respawn cues', () => {
  test('wall contact flashes without dying, then adopts the authoritative death and respawn', () => {
    const player = localPilot();
    player.ship.blinkCount = 0;
    const startingHealth = player.ship.health;
    player.ship.position = { x: WORLD_BOUNDARY.radius + 100, y: 0 };

    CollisionManager.getInstance().checkBoundaryCollisions([player.ship]);

    // Local prediction stops at the flash. This is the defect that made two
    // earlier designs non-functional: a locally dead hull latches
    // `adoptServerPosition` below, and the next live snapshot then overwrites
    // the overlapping position with the server's always-inside row, so no pose
    // ever carries the contact the server kills on.
    expect(player.ship.impactFlashFrames).toBeGreaterThan(0);
    expect(player.ship.health).toBe(startingHealth);
    expect(player.ship.exploding).toBe(false);

    // A live echo arriving while the hull overlaps must not reposition it.
    player.updateFromServer({
      health: startingHealth,
      exploding: false,
      position: { x: 0, y: 0 },
    });
    expect(player.ship.position).toEqual({ x: WORLD_BOUNDARY.radius + 100, y: 0 });

    // The server's own kill is what ends the life, and the respawn is adopted.
    player.updateFromServer({ health: 0, exploding: true, position: { x: 0, y: 0 } });
    expect(player.ship.exploding).toBe(true);
    player.updateFromServer({ health: 100, exploding: false, position: { x: 200, y: 40 } });
    expect(player.ship.position).toEqual({ x: 200, y: 40 });
    expect(player.ship.health).toBe(100);
    expect(player.ship.blinkCount).toBeGreaterThan(0);
    expect(isShipCollisionImmune(player.ship)).toBe(true);
  });
});
