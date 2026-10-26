import { checkBoundaryCollision } from '../../shared/boundary';
import type { Ship } from '../entities/ship/Ship';
import { applyShipImpactFlash, isShipCollisionImmune } from '../entities/ship/shipUtils';

import { logger } from '../utils/Logger';

export class CollisionManager {
  private static instance: CollisionManager;

  static getInstance(): CollisionManager {
    if (!CollisionManager.instance) {
      CollisionManager.instance = new CollisionManager();
    }
    return CollisionManager.instance;
  }

  /**
   * Local wall feedback only: a flash, never a death. The server owns wall
   * death and reads it by running this same `checkBoundaryCollision` on the
   * pose the hull reports.
   *
   * Predicting the death here is what the lethal rule cannot survive. A locally
   * dead hull freezes (`Ship.update` returns before `updateMovement`) and arms
   * the respawn latch in `Player.updateFromServer`, and the next snapshot then
   * overwrites position and velocity with the server's row — which is always
   * inside the wall, because the server refuses the overlapping pose. That
   * erases the contact before any pose can carry it. A hull that stays alive
   * keeps flying outward instead, so it re-reports the overlap until the server
   * acts on it.
   *
   * For the same reason the reported position must reach the socket unclamped:
   * rounding or clamping a hull back inside the wall anywhere between here and
   * `ConnectionManager.sendPlayerState` would mean the server never sees a
   * contact, and the wall would silently stop being lethal.
   * `tests/unit/network/wall-contact-reaches-the-server.test.ts` fails if it is.
   *
   * Returns true when a hull registered contact, so the caller can report that
   * frame's position at once — see `GameController.reportBoundaryContact`.
   */
  checkBoundaryCollisions(ships: Ship[]): boolean {
    let contact = false;
    for (const ship of ships) {
      if (ship.contourLocked && checkBoundaryCollision(ship.position, ship.r)) {
        ship.releaseContourLock();
      }
      // Same immunity as asteroid impacts: exploding, dead, or blinking.
      if (isShipCollisionImmune(ship)) {
        continue;
      }

      if (checkBoundaryCollision(ship.position, ship.r)) {
        logger.debug('COLLISION', 'Ship hit boundary', {
          shipPos: ship.position,
          shipId: ship.id,
        });
        applyShipImpactFlash(ship);
        contact = true;
      }
    }
    return contact;
  }
}
