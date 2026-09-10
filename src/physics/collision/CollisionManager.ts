import { DAMAGE } from '../../constants';
import type { Player } from '../../entities/player/Player';
import { PlayerManager } from '../../entities/player/PlayerManager';
import { canDealCombatDamage } from '../../entities/player/softFactions';
import type { Satellite } from '../../entities/satellite/Satellite';
import type { SatellitePickup } from '../../entities/satellitePickup/SatellitePickup';
import { SatellitePickupManager } from '../../entities/satellitePickup/SatellitePickupManager';
import { isWithinCollectRange } from '../../entities/satellitePickup/satellitePickupMath';
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

  /** Send a collection request for the locally-overlapped loose pickup. */
  checkPlayerSatellitePickupCollisions(
    player: { ship: Ship; id: string; type: 'local' | 'remote' | 'bot' },
    pickups: SatellitePickup[]
  ): void {
    if (
      player.type !== 'local' ||
      !player.ship ||
      player.ship.health <= 0 ||
      player.ship.exploding
    ) {
      return;
    }

    const pickupManager = SatellitePickupManager.getInstance();
    const collectorId = this.networkManager.getLocalPlayerId() || player.id;
    const now = Date.now();
    for (const pickup of pickups) {
      if (pickup.state !== 'loose' || pickupManager.shouldDebounceCollect(pickup.id, now)) {
        continue;
      }
      if (
        !isWithinCollectRange(
          player.ship.position,
          pickup.position,
          player.ship.r,
          pickup.radius,
          0
        )
      ) {
        continue;
      }
      pickupManager.markCollectAttempt(pickup.id, now);
      this.networkManager.sendMessage({
        type: 'satellitePickupCollected',
        data: { pickupId: pickup.id, playerId: collectorId },
      });
      break;
    }
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
        if (
          checkLaserShipCollision(
            laser.position,
            localShip.position,
            laserCollisionRadius(localShip.r, localShip)
          )
        ) {
          if (isReadableShieldUp(localShip)) {
            noteReadableShieldLaserHit(localShip);
            laser.updateExplodeTime();
            laser.playHitSound();
            return;
          }
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
