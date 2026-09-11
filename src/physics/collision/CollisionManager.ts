import {
  findNearestShieldImpact,
  reflectProjectileVelocity,
} from '../../../shared/shieldReflection';
import { DAMAGE } from '../../constants';
import type { Laser } from '../../entities/laser/Laser';
import type { Player } from '../../entities/player/Player';
import { PlayerManager } from '../../entities/player/PlayerManager';
import { canDealCombatDamage } from '../../entities/player/softFactions';
import type { Satellite } from '../../entities/satellite/Satellite';
import type { Ship } from '../../entities/ship/Ship';
import {
  isReadableShieldUp,
  laserCollisionRadius,
  noteReadableShieldLaserHit,
} from '../../entities/ship/shipShield';
import { applyShipBoundaryDeath, isShipCollisionImmune } from '../../entities/ship/shipUtils';
import { NetworkManager } from '../../network/networkManager';
import { logger } from '../../utils/Logger';
import {
  checkBoundaryCollision,
  checkLaserShipCollision,
  checkShipCollision,
} from './collisionDetection';

function reflectSatelliteLaserFromShield(
  laser: Laser,
  ship: Ship,
  impact: ReturnType<typeof findNearestShieldImpact>
): void {
  const start = laser.prevPosition;
  const end = laser.position;
  const segmentDistance = Math.hypot(end.x - start.x, end.y - start.y);
  if (impact && segmentDistance > 0) {
    const remainingDistance = Math.max(0, segmentDistance - impact.distance);
    laser.prevPosition = { ...impact.point };
    laser.velocity = reflectProjectileVelocity(laser.velocity, impact.normal);
    const speed = Math.hypot(laser.velocity.x, laser.velocity.y);
    if (speed > 0) {
      laser.position = {
        x: impact.point.x + (laser.velocity.x / speed) * remainingDistance,
        y: impact.point.y + (laser.velocity.y / speed) * remainingDistance,
      };
    } else {
      laser.position = { ...impact.point };
    }
    laser.lastShieldId = ship.id;
    laser.bounceCount += 1;
    return;
  }

  // A snapshot can land a visual bolt exactly on a shield surface without a
  // swept segment. Nudge it out along the radial normal while preserving speed.
  const dx = laser.position.x - ship.position.x;
  const dy = laser.position.y - ship.position.y;
  const distance = Math.hypot(dx, dy);
  const normal =
    distance > 0
      ? { x: dx / distance, y: dy / distance }
      : {
          x: -laser.velocity.x,
          y: -laser.velocity.y,
        };
  const normalLength = Math.hypot(normal.x, normal.y);
  if (normalLength <= 0) {
    return;
  }
  const unitNormal = { x: normal.x / normalLength, y: normal.y / normalLength };
  laser.velocity = reflectProjectileVelocity(laser.velocity, unitNormal);
  laser.position = {
    x: ship.position.x + unitNormal.x * (laserCollisionRadius(ship.r, ship) + 0.01),
    y: ship.position.y + unitNormal.y * (laserCollisionRadius(ship.r, ship) + 0.01),
  };
  laser.prevPosition = { ...laser.position };
  laser.lastShieldId = ship.id;
  laser.bounceCount += 1;
}

export class CollisionManager {
  private static instance: CollisionManager;
  private networkManager: NetworkManager;

  private constructor() {
    this.networkManager = NetworkManager.getInstance();
  }

  static getInstance(): CollisionManager {
    if (!CollisionManager.instance) {
      CollisionManager.instance = new CollisionManager();
    }
    return CollisionManager.instance;
  }

  /**
   * Check boundary collisions for ships
   */
  checkBoundaryCollisions(ships: Ship[], localPlayerId: string): void {
    for (const ship of ships) {
      // Same immunity as asteroid / ship-ship: exploding, dead, or blinking.
      // Boundary previously skipped only exploding, so a dead or freshly
      // respawned hull kept sending 100-damage collisionDamage at 60 Hz.
      if (isShipCollisionImmune(ship)) {
        continue;
      }

      if (checkBoundaryCollision(ship.position, ship.r)) {
        this.handleBoundaryCollision(ship, localPlayerId);
      }
    }
  }

  /**
   * Handle ship hitting the boundary
   */
  private handleBoundaryCollision(ship: Ship, localPlayerId: string): void {
    logger.debug('COLLISION', 'Ship hit boundary', {
      shipPos: ship.position,
      shipId: ship.id,
      localPlayerId,
    });

    // Shared player+bot path: visible wall flash + explode, then the server
    // confirms the life loss. Waiting for the packet alone looked like a silent reset.
    applyShipBoundaryDeath(ship, 'boundary');

    const serverPlayerId = this.networkManager.getLocalPlayerId();
    this.networkManager.sendMessage({
      type: 'collisionDamage',
      data: {
        targetPlayerId: serverPlayerId,
        attackerId: 'boundary',
        damage: DAMAGE.BOUNDARY_COLLISION,
      },
    });
  }

  /**
   * Check ship collisions with other ships (players/bots)
   */
  checkShipShipCollisions(
    localShip: Ship,
    otherShips: { ship: Ship; id: string }[],
    localPlayerId: string
  ): void {
    // Skip if local ship cannot collide: exploding, dead, or under spawn protection
    if (!localShip || isShipCollisionImmune(localShip)) {
      return;
    }

    let isColliding = false;

    for (const other of otherShips) {
      const otherShip = other.ship;
      if (isShipCollisionImmune(otherShip)) {
        continue;
      }

      if (
        canDealCombatDamage(this.factionForId(localPlayerId), this.factionForShip(otherShip)) &&
        checkShipCollision(localShip.position, localShip.r, otherShip.position, otherShip.r)
      ) {
        this.handleShipShipCollision(localShip, otherShip, other.id, localPlayerId);
        isColliding = true;
        break;
      }
    }

    // If not colliding with any ship, stop collision damage
    if (!isColliding && localShip.isCollidingWithPlayer) {
      localShip.stopPlayerCollision();
    }
  }

  private factionForId(playerId: string): Player['factionId'] {
    if (!playerId) {
      return undefined;
    }
    const fromNet = this.networkManager.getPlayer(playerId);
    if (fromNet) {
      return fromNet.factionId;
    }
    const local = PlayerManager.getInstance().getLocalPlayer();
    if (local && (local.id === playerId || this.networkManager.getLocalPlayerId() === playerId)) {
      return local.factionId;
    }
    return undefined;
  }

  private factionForShip(ship: Ship): Player['factionId'] {
    const match = this.networkManager.getAllPlayers().find((player) => player.ship === ship);
    return match?.factionId;
  }

  checkSatelliteLaserCollisions(
    satellites: Satellite[],
    localShip: Ship,
    _localPlayerId?: string
  ): void {
    if (!localShip || isShipCollisionImmune(localShip)) {
      return;
    }

    for (const satellite of satellites) {
      for (const laser of satellite.lasers) {
        if (laser.hasExploded) {
          continue;
        }
        if (isReadableShieldUp(localShip)) {
          const impact = findNearestShieldImpact(
            laser.prevPosition,
            laser.position,
            [
              {
                id: localShip.id,
                position: localShip.position,
                radius: laserCollisionRadius(localShip.r, localShip),
              },
            ],
            laser.lastShieldId
          );
          const overlapping = checkLaserShipCollision(
            laser.position,
            localShip.position,
            laserCollisionRadius(localShip.r, localShip)
          );
          if (impact || overlapping) {
            noteReadableShieldLaserHit(localShip);
            reflectSatelliteLaserFromShield(laser, localShip, impact);
            laser.playHitSound();
            return;
          }
        }
        if (
          checkLaserShipCollision(
            laser.position,
            localShip.position,
            laserCollisionRadius(localShip.r, localShip)
          )
        ) {
          // The server simulates EO projectiles and owns the damage result.
          // This local overlap only removes the visual bolt at the same time.
          laser.updateExplodeTime();
          laser.playHitSound();
          return;
        }
      }
    }
  }

  /**
   * Handle ship hitting another ship
   */
  private handleShipShipCollision(
    localShip: Ship,
    otherShip: Ship,
    otherPlayerId: string,
    localPlayerId: string
  ): void {
    logger.debug('COLLISION', 'Ship hit ship', {
      localShipPos: localShip.position,
      otherShipPos: otherShip.position,
      localShipId: localShip.id,
      otherShipId: otherShip.id,
      otherPlayerId,
      localPlayerId,
    });

    // Visual / offline overlap only. Ship↔ship DOT is applied on the server
    // from last-known positions so both tabs share one health timeline.
    localShip.startPlayerCollision(otherPlayerId);
  }
}
