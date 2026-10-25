import { checkBoundaryCollision } from '../../shared/boundary';
import type { Ship } from '../entities/ship/Ship';
import {
  applyShipBoundaryDeath,
  applyShipImpactFlash,
  isShipCollisionImmune,
} from '../entities/ship/shipUtils';
import { cooperativeActive } from '../network/worldCampaign';

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
   * Local boundary prediction only. The server owns wall death: it runs the same
   * `checkBoundaryCollision` on each reported pose and kills from its own
   * geometry, so nothing here is reported to it.
   */
  checkBoundaryCollisions(ships: Ship[], cargo: number): void {
    for (const ship of ships) {
      if (ship.contourLocked && checkBoundaryCollision(ship.position, ship.r)) {
        ship.releaseContourLock();
      }
      // Same immunity as asteroid impacts: exploding, dead, or blinking.
      if (isShipCollisionImmune(ship)) {
        continue;
      }

      if (checkBoundaryCollision(ship.position, ship.r)) {
        this.handleBoundaryCollision(ship, cargo);
      }
    }
  }

  /**
   * Predict the ship hitting the boundary
   */
  private handleBoundaryCollision(ship: Ship, cargo: number): void {
    logger.debug('COLLISION', 'Ship hit boundary', {
      shipPos: ship.position,
      shipId: ship.id,
    });

    // Show a wall flash immediately; cargo protection and residual damage come from the server.
    if (cargo > 0 || cooperativeActive()) {
      applyShipImpactFlash(ship);
    } else {
      applyShipBoundaryDeath(ship);
    }
  }
}
