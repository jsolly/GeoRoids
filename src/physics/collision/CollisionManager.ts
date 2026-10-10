import type { Ship } from '../../entities/ship/Ship';
import {
  applyShipBoundaryDeath,
  applyShipImpactFlash,
  isShipCollisionImmune,
} from '../../entities/ship/shipUtils';
import { NetworkManager } from '../../network/networkManager';
import { logger } from '../../utils/Logger';
import { checkBoundaryCollision } from './collisionDetection';

export class CollisionManager {
  private static instance: CollisionManager;
  constructor(
    private readonly networkManager: Pick<NetworkManager, 'getLocalPlayerId' | 'sendMessage'>
  ) {}

  static getInstance(): CollisionManager {
    if (!CollisionManager.instance) {
      CollisionManager.instance = new CollisionManager(NetworkManager.getInstance());
    }
    return CollisionManager.instance;
  }

  /**
   * Check boundary collisions for ships
   */
  checkBoundaryCollisions(ships: Ship[], localPlayerId: string, cargo: number): void {
    for (const ship of ships) {
      if (ship.contourLocked && checkBoundaryCollision(ship.position, ship.r)) {
        ship.releaseContourLock('boundary');
      }
      // Same immunity as asteroid impacts: exploding, dead, or blinking.
      // Boundary previously skipped only exploding, so a dead or freshly
      // respawned hull kept sending 100-damage collisionDamage at 60 Hz.
      if (isShipCollisionImmune(ship)) {
        continue;
      }

      if (checkBoundaryCollision(ship.position, ship.r)) {
        this.handleBoundaryCollision(ship, localPlayerId, cargo);
      }
    }
  }

  /**
   * Handle ship hitting the boundary
   */
  private handleBoundaryCollision(ship: Ship, localPlayerId: string, cargo: number): void {
    logger.debug('COLLISION', 'Ship hit boundary', {
      shipPos: ship.position,
      shipId: ship.id,
      localPlayerId,
    });

    // Show a wall flash immediately; cargo protection and residual damage come from the server.
    if (cargo > 0) {
      applyShipImpactFlash(ship);
    } else {
      applyShipBoundaryDeath(ship);
    }

    const serverPlayerId = this.networkManager.getLocalPlayerId();
    this.networkManager.sendMessage({
      type: 'collisionDamage',
      data: {
        targetPlayerId: serverPlayerId,
        attackerId: 'boundary',
      },
    });
  }
}
