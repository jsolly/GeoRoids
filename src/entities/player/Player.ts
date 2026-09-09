import { applyFuelSnapshot } from '../../../shared/fuel';
import { radiusFromMass } from '../../../shared/shipGrowth';
import type { Position, ShipKitId, SoftFactionId } from '../../../shared-types';
import { GAME } from '../../constants';
import type { PlayerInput } from '../../input/PlayerInput';
import { getFactionColor } from '../../utils/colorUtils';
import { isStaleGameOverSnapshot, preferDeathCause } from '../../utils/deathCause';
import { logger } from '../../utils/Logger';
import { Ship } from '../ship/Ship';
import { applySharedHarpoonLatch } from '../ship/shipAbilities';
import { applyShipKitToShip } from '../ship/shipKits';
import { applyShieldSnapshot, clearShield } from '../ship/shipShield';
import {
  applySharedShipExplodingFlag,
  applySharedShipRespawnCue,
  applyShipSpawnProtection,
  isServerRespawnActive,
  isSilentHudReset,
  resolveCombatDeathCause,
} from '../ship/shipUtils';
import { parseSoftFactionId } from './softFactions';

function copyVec2(dest: { x: number; y: number }, src: { x: number; y: number }): void {
  dest.x = src.x;
  dest.y = src.y;
}

export class Player {
  id: string;
  name: string;
  type: 'local' | 'remote' | 'bot';
  ship: Ship;
  score: number = 0;
  lastUpdate: number = Date.now();
  lives: number = GAME.START_LIVES;
  color: string; // Player's unique color for lasers and other visual elements
  deathCause?: string; // What killed the player (asteroid, boundary, player name, etc.)
  input: PlayerInput; // Unified input system for all player types
  factionId?: SoftFactionId;

  // For the local player: from the moment it dies until it is confirmed alive
  // again, trust the server for position (so the respawn point is adopted).
  // While alive it predicts locally and ignores the lagging server echo.
  private adoptServerPosition = false;

  /** Ship position when death forced server-authoritative movement (respawn latch). */
  private respawnLatchOrigin: Position | null = null;

  // Server-authoritative spawn-protection countdown (frames). While > 0 the
  // server ignores all incoming damage. Mirrored from the gameState so callers
  // (notably tests) can tell exactly when the player becomes vulnerable.
  serverSpawnProtectionTimer = 0;

  private readonly networkState: {
    position: Position;
    velocity: Position;
    r: number;
    angle: number;
    lives: number;
    score: number;
    exploding: boolean;
    thrusting: boolean;
    health: number;
    maxHealth: number;
    mass: number;
  };

  // Interpolation state for smooth movement (disabled for now to fix popping issue)
  // private targetPosition?: Position;
  // private targetVelocity?: Position;
  // private targetAngle?: number;
  // private interpolationStartTime?: number;
  // private interpolationDuration: number = 100; // 100ms interpolation

  constructor(params: {
    id: string;
    name: string;
    type: 'local' | 'remote' | 'bot';
    input: PlayerInput;
    kitId?: ShipKitId;
    factionId?: SoftFactionId;
  }) {
    this.id = params.id;
    this.name = params.name;
    this.type = params.type;
    this.input = params.input;
    const factionIdValue = parseSoftFactionId(params.factionId);
    if (factionIdValue !== undefined) {
      this.factionId = factionIdValue;
    } else {
      delete this.factionId;
    }

    this.color = getFactionColor(this.type);

    // Create ship with player's color and friction coefficient
    this.ship = new Ship({
      color: this.color,
      isBot: this.type === 'bot',
      isLocalPlayer: this.type === 'local',
      frictionCoefficient: this.getFrictionCoefficient(),
      ...(params.kitId !== undefined ? { kitId: params.kitId } : {}),
    });
    if (this.factionId !== undefined) {
      this.ship.factionId = this.factionId;
    } else {
      delete this.ship.factionId;
    }
    this.networkState = {
      position: this.ship.position,
      velocity: this.ship.velocity,
      r: this.ship.r,
      angle: this.ship.angle,
      lives: this.lives,
      score: this.score,
      exploding: this.ship.exploding,
      thrusting: this.ship.thrusting,
      health: this.ship.health,
      maxHealth: this.ship.maxHealth,
      mass: this.ship.mass,
    };
  }

  // Update player state from server data
  updateFromServer(data: {
    position?: Position;
    velocity?: Position;
    angle?: number;
    lives?: number;
    score?: number;
    exploding?: boolean;
    thrusting?: boolean;
    color?: string;
    deathCause?: string;
    health?: number;
    maxHealth?: number;
    fuel?: number;
    maxFuel?: number;
    mass?: number;
    respawnTimer?: number;
    spawnProtectionTimer?: number;
    kitId?: ShipKitId;
    factionId?: SoftFactionId;
    abilityCooldownFrames?: number;
    abilityActiveFrames?: number;
    shieldTimer?: number;
    harpoonTimer?: number;
    harpoonTargetId?: string;
    harpoonLatchPos?: { x: number; y: number };
    shieldActive?: boolean;
    shieldTime?: number;
    shieldCooldown?: number;
    shieldFlashTime?: number;
  }): void {
    // Local kit is client-owned. A stale Railway dart echo must not strip
    // a selected Hauler (and clear the latch on the next snapshot).
    if (data.kitId && data.kitId !== this.ship.kitId && this.type !== 'local') {
      const color = this.ship.color;
      applyShipKitToShip(this.ship, data.kitId);
      this.ship.color = color;
    }
    if (data.factionId !== undefined) {
      const factionIdValue = parseSoftFactionId(data.factionId);
      if (factionIdValue !== undefined) {
        this.factionId = factionIdValue;
      } else {
        delete this.factionId;
      }
      if (this.factionId !== undefined) {
        this.ship.factionId = this.factionId;
      } else {
        delete this.ship.factionId;
      }
    }
    if (data.spawnProtectionTimer !== undefined) {
      this.serverSpawnProtectionTimer = data.spawnProtectionTimer;
    }
    // The local player predicts its own ship for responsiveness: while alive it
    // owns its position/velocity/angle and must NOT snap to the (lagging) server
    // echo. Remote players and bots are always server-driven.
    //
    // The exception is the death→respawn window: once the local player dies we
    // latch `adoptServerPosition` so every server update (including the respawn
    // reposition) is adopted, and only release the latch after we've adopted a
    // position while alive again. This makes respawn placement deterministic
    // regardless of the exact ordering of health/position broadcasts.
    const isLocal = this.type === 'local';
    if (isLocal) {
      const deadOrExploding =
        this.ship.health <= 0 || this.ship.exploding || isServerRespawnActive(data.respawnTimer);
      if (deadOrExploding) {
        if (!this.adoptServerPosition) {
          this.respawnLatchOrigin = data.position
            ? { ...data.position }
            : { ...this.ship.position };
        }
        this.adoptServerPosition = true;
      }
    }
    const acceptServerTransform = !isLocal || this.adoptServerPosition;

    // Infer wall from the pre-echo pose. Adopting a lagged inside position
    // first is what turned last-life wall GO into a generic overlay.
    const inferenceShip = {
      position: { x: this.ship.position.x, y: this.ship.position.y },
      r: this.ship.r,
    };

    if (data.position && acceptServerTransform) {
      copyVec2(this.ship.position, data.position);
    }
    if (data.velocity && acceptServerTransform) {
      copyVec2(this.ship.velocity, data.velocity);
    }
    if (data.angle !== undefined && acceptServerTransform) {
      this.ship.angle = data.angle;
    }

    if (data.mass !== undefined) {
      this.ship.mass = data.mass;
      this.ship.r = radiusFromMass(data.mass);
    }

    if (data.deathCause) {
      this.deathCause = preferDeathCause(data.deathCause, this.deathCause) ?? data.deathCause;
    }
    const knownCause = preferDeathCause(
      this.deathCause,
      data.deathCause,
      this.ship.lastExplodeCause
    );
    const explodeCause = resolveCombatDeathCause(knownCause, inferenceShip);
    applySharedShipExplodingFlag(this.ship, data.exploding, explodeCause);
    if (data.exploding === true || data.health === 0) {
      this.deathCause = preferDeathCause(explodeCause, this.deathCause) ?? explodeCause;
    }

    const skipHudReset = isSilentHudReset(this.lives, this.score, data.lives, data.score);
    const snapshotDeathCause = this.deathCause ?? data.deathCause;
    const staleSnapshot =
      isLocal &&
      data.lives !== undefined &&
      isStaleGameOverSnapshot({
        prevLives: this.lives,
        nextLives: data.lives,
        ...(snapshotDeathCause !== undefined ? { deathCause: snapshotDeathCause } : {}),
        health: data.health ?? this.ship.health,
        exploding: data.exploding ?? this.ship.exploding,
      });
    if (data.lives !== undefined && !skipHudReset && !staleSnapshot) {
      const prevLives = this.lives;
      this.lives = data.lives;
      if (isLocal && prevLives > this.lives) {
        window.dispatchEvent(
          new CustomEvent('playerDied', {
            detail: {
              playerId: this.id,
              deathCause: resolveCombatDeathCause(
                preferDeathCause(this.deathCause, data.deathCause, this.ship.lastExplodeCause),
                inferenceShip
              ),
              isGameOver: this.lives <= 0,
            },
          })
        );
      }
    }
    if (data.score !== undefined && !skipHudReset) {
      this.score = data.score;
    }
    // Thrusting is client-owned for the local player (keyboard/mouse input).
    // The server echo lacks thrusting when updates omit it, which flickers the flame.
    if (data.thrusting !== undefined && this.type !== 'local') {
      this.ship.thrusting = data.thrusting;
    }
    if (data.color !== undefined && this.type !== 'local') {
      this.color = data.color;
      this.ship.color = data.color;
    }
    if (data.health !== undefined) {
      if (isLocal && this.lives <= 0) {
        this.ship.health = 0;
      } else {
        const wasDead = this.ship.health <= 0;
        const wasExploding = this.ship.exploding;
        const oldHealth = this.ship.health;
        const serverHealth = data.health;

        // Health, including gradual regeneration, is server-owned. Living
        // ships accept each ordered echo exactly. A partial healing echo must
        // not revive a locally predicted death before the full respawn arrives.
        if (
          !isLocal ||
          (!wasDead && !wasExploding) ||
          serverHealth <= 0 ||
          (serverHealth >= (data.maxHealth ?? this.ship.maxHealth) &&
            data.exploding !== true &&
            !isServerRespawnActive(data.respawnTimer))
        ) {
          this.ship.health = serverHealth;
        }

        const newHealth = this.ship.health;

        if (oldHealth !== newHealth) {
          logger.debug('HEALTH_UPDATE', 'Health changed', {
            playerId: this.id,
            oldHealth,
            newHealth,
            wasDead,
            wasExploding,
            exploding: this.ship.exploding,
            type: this.type,
          });
        }

        if (this.ship.health <= 0 && oldHealth > 0) {
          logger.debug('HEALTH_UPDATE', 'Health reached 0, triggering explosion', {
            playerId: this.id,
            oldHealth,
            newHealth: this.ship.health,
            type: this.type,
          });
          this.ship.explode(explodeCause);
        }

        applySharedShipRespawnCue(this.ship, wasDead || wasExploding, data.spawnProtectionTimer);
        if (
          (wasDead || wasExploding) &&
          this.ship.health > 0 &&
          (data.health === undefined || data.health > 0)
        ) {
          delete this.ship.lastExplodeCause;
          delete this.deathCause;
        }
        if (
          this.ship.health > 0 &&
          this.ship.blinkCount <= 0 &&
          (data.spawnProtectionTimer === undefined || data.spawnProtectionTimer <= 0) &&
          this.type === 'local'
        ) {
          logger.debug(
            'HEALTH_UPDATE_LOCAL',
            'Local player health update without respawn protection',
            {
              playerId: this.id,
              oldHealth,
              newHealth: data.health,
              wasDead,
              wasExploding,
              exploding: this.ship.exploding,
              condition: `wasDead: ${wasDead}, wasExploding: ${wasExploding}, health > 0: ${this.ship.health > 0}`,
            }
          );
        }
      }
    }
    if (data.maxHealth !== undefined) {
      this.ship.maxHealth = data.maxHealth;
    }
    applyFuelSnapshot(this.ship, data);
    if (this.type !== 'local') {
      if (data.abilityCooldownFrames !== undefined) {
        this.ship.abilityCooldownFrames = data.abilityCooldownFrames;
      }
      if (data.abilityActiveFrames !== undefined) {
        this.ship.abilityActiveFrames = data.abilityActiveFrames;
      }
      if (data.shieldTimer !== undefined) {
        this.ship.shieldTimer = data.shieldTimer;
      }
    }
    applyShieldSnapshot(this.ship, data);
    applySharedHarpoonLatch(
      this.ship,
      {
        ...(data.harpoonTimer !== undefined ? { harpoonTimer: data.harpoonTimer } : {}),
        ...(data.harpoonTargetId !== undefined ? { harpoonTargetId: data.harpoonTargetId } : {}),
        ...(data.harpoonLatchPos !== undefined ? { harpoonLatchPos: data.harpoonLatchPos } : {}),
      },
      this.type === 'local' ? 'predicting' : 'authoritative'
    );
    // Handle respawn timer from server
    if (data.respawnTimer !== undefined) {
      // When respawnTimer is 0, the server has finished the countdown. Remote
      // entities still need local visual reset; the local player must wait for
      // authoritative health + position in gameState (calling respawn() here
      // would mark the ship alive at the death location before reposition).
      if (data.respawnTimer === 0 && this.ship.health <= 0 && !isLocal) {
        logger.debug('RESPAWN', 'Player respawned by server', {
          playerId: this.id,
          newHealth: data.health,
          newPosition: data.position,
        });
        this.respawn();
      }
    }

    // Resume local prediction after adopting a live server transform.
    // Nearby respawns stay inside 75px of the death pose — spawn protection
    // on this snapshot means we already wrote the new spawn, so release.
    if (
      isLocal &&
      this.adoptServerPosition &&
      this.ship.health > 0 &&
      !this.ship.exploding &&
      !isServerRespawnActive(data.respawnTimer) &&
      data.position
    ) {
      const origin = this.respawnLatchOrigin;
      const movedFromDeath = origin
        ? Math.hypot(data.position.x - origin.x, data.position.y - origin.y) > 75
        : true;
      const adoptedRespawn = (data.spawnProtectionTimer ?? 0) > 0;
      if (movedFromDeath || adoptedRespawn) {
        this.adoptServerPosition = false;
        this.respawnLatchOrigin = null;
      }
    }

    this.lastUpdate = Date.now();
  }

  /**
   * Drop leftover death/invuln/latch flags before a new server session.
   * Health/pose come from the next snapshot so a reconnect is not a corpse.
   */
  resetCombatLifecycle(): void {
    this.adoptServerPosition = false;
    this.respawnLatchOrigin = null;
    this.serverSpawnProtectionTimer = 0;
    this.ship.exploding = false;
    this.ship.explodeTime = 0;
    this.ship.blinkCount = 0;
    this.ship.spawnProtectionTimer = 0;
    this.ship.velocity.x = 0;
    this.ship.velocity.y = 0;
  }

  // Respawn method implementation
  respawn(): void {
    logger.debug('RESPAWN', 'Player respawn method called', {
      playerId: this.id,
      currentHealth: this.ship.health,
      currentPosition: this.ship.position,
    });

    // Reset health to full
    this.ship.health = this.ship.maxHealth;

    // Reset explosion state
    this.ship.exploding = false;
    this.ship.explodeTime = 0;

    // Keep the existing velocity object so network aliases stay valid.
    this.ship.velocity.x = 0;
    this.ship.velocity.y = 0;

    delete this.deathCause;
    delete this.ship.lastExplodeCause;
    applyShipSpawnProtection(this.ship);
    clearShield(this.ship);

    logger.debug('RESPAWN', 'Player respawn completed', {
      playerId: this.id,
      newHealth: this.ship.health,
      spawnProtection: this.ship.blinkCount,
    });
  }

  // Getter for spawn protection status
  get spawnProtectedUntil(): number {
    return this.ship.spawnProtectionTimer;
  }

  // Getter for death status
  get isDead(): boolean {
    return this.ship.health <= 0;
  }

  // Handle ship explosion event
  onShipExploded(detail?: { cause?: string }): void {
    logger.debug('SHIP_EXPLODED', 'Player ship exploded', {
      playerId: this.id,
      cause: detail?.cause,
      health: this.ship.health,
    });

    if (detail?.cause) {
      this.deathCause = preferDeathCause(detail.cause, this.deathCause) ?? detail.cause;
    }

    // The respawn will be handled by the server
    // Client just needs to wait for server updates
  }

  /**
   * Update player state using unified input system
   */
  updateFromInput(): void {
    // Update thrusting state
    this.ship.thrusting = this.input.getThrusting();

    // Update angular velocity
    this.ship.angularVelocity = this.input.getAngularVelocity();

    // Update shooting state
    if (this.input.getShooting()) {
      this.ship.shoot();
    }

    if (this.input.getEmpPulse()) {
      this.ship.activateAbility();
    }
  }

  /**
   * Get friction coefficient based on player type
   */
  getFrictionCoefficient(): number {
    return this.type === 'bot' ? 0.02 : 0.01; // Bot-specific friction
  }

  // Update interpolation for smooth movement (disabled for now to fix popping issue)
  // updateInterpolation(): void {
  //   if (this.type === 'local' || !this.interpolationStartTime) {
  //     return;
  //   }
  //
  //   const now = Date.now();
  //   const elapsed = now - this.interpolationStartTime;
  //   const progress = Math.min(elapsed / this.interpolationDuration, 1);
  //
  //   // Interpolate position
  //   if (this.targetPosition) {
  //     this.ship.position.x += (this.targetPosition.x - this.ship.position.x) * progress;
  //     this.ship.position.y += (this.targetPosition.y - this.ship.position.y) * progress;
  //   }
  //
  //   // Interpolate velocity
  //   if (this.targetVelocity) {
  //     this.ship.velocity.x += (this.targetVelocity.x - this.ship.velocity.x) * progress;
  //     this.ship.velocity.y += (this.targetVelocity.y - this.ship.velocity.y) * progress;
  //   }
  //
  //   // Interpolate angle
  //   if (this.targetAngle !== undefined) {
  //     let angleDiff = this.targetAngle - this.ship.angle;
  //     // Handle angle wrapping
  //     if (angleDiff > Math.PI) {
  //       angleDiff -= 2 * Math.PI;
  //     }
  //     if (angleDiff < -Math.PI) {
  //       angleDiff += 2 * Math.PI;
  //     }
  //     this.ship.angle += angleDiff * progress;
  //   }
  //
  //   // If interpolation is complete, clear targets
  //   if (progress >= 1) {
  //     this.targetPosition = undefined;
  //     this.targetVelocity = undefined;
  //     this.targetAngle = undefined;
  //     this.interpolationStartTime = undefined;
  //   }
  // }

  // Get current state for network transmission
  getStateForNetwork() {
    this.networkState.position = this.ship.position;
    this.networkState.velocity = this.ship.velocity;
    this.networkState.r = this.ship.r;
    this.networkState.angle = this.ship.angle;
    this.networkState.lives = this.lives;
    this.networkState.score = this.score;
    this.networkState.exploding = this.ship.exploding;
    this.networkState.thrusting = this.ship.thrusting;
    this.networkState.health = this.ship.health;
    this.networkState.maxHealth = this.ship.maxHealth;
    this.networkState.mass = this.ship.mass;
    return this.networkState;
  }
}
