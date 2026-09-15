import { v4 as uuidv4 } from 'uuid';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../../shared/constants/health';
import { PLAYER_MOTION } from '../../../shared/playerMotion';
import { containBodyOutOfCompletedSectors } from '../../../shared/sectors';
import { cruiseSpeed } from '../../../shared/shipFlight';
import { GROWTH, radiusFromMass } from '../../../shared/shipGrowth';
import type {
  LaserUpgrade,
  PlayerMotionState,
  Position,
  ShipKitId,
  Velocity,
} from '../../../shared-types';
import { playExplosionSound } from '../../audio/explosionSound';
import { GAME, PALETTE, SHIP } from '../../constants';
import { NetworkManager } from '../../network/networkManager';
import { getCompletedSectors } from '../../network/worldExploration';
import { applySharedShipSlope } from '../../physics/terrain/applyShipSlope';
import { isGenericDeathCause } from '../../utils/deathCause';
import { logger } from '../../utils/Logger';
import { addPositionAndVelocity } from '../../utils/mathUtils';
import { AuthoritativeProjectileField } from '../laser/AuthoritativeProjectileField';
import type { Laser } from '../laser/Laser';
import { createLaser } from '../laser/laserUtils';
import { advanceCruiseVelocity } from './cruiseMotion';
import {
  type AbilityWorld,
  activateAbilityOnHost,
  canActivateAbility,
  tickAbilityHost,
} from './shipAbilities';
import { applyShipKitToShip, DEFAULT_SHIP_KIT_ID, getShipKit } from './shipKits';
import {
  applyShipSpawnProtection,
  applyThrustOrFriction,
  calculateHealthAfterDamage,
  calculateHealthAfterHeal,
  shouldStartHealthRegeneration,
  tickShipImpactFlash,
} from './shipUtils';

class Ship {
  id: string = uuidv4(); // Unique identifier for event handling
  position: Position = { x: 0, y: 0 };
  velocity: Velocity = { x: 0, y: 0 };
  /** Granted only by an authoritative motion rebase after an external impulse. */
  knockbackVelocityLimit = 0;
  r: number = radiusFromMass(GROWTH.BASE_MASS);
  mass: number = GROWTH.BASE_MASS;
  angle: number = (90 / 180) * Math.PI;
  blinkCount: number = 0;
  spawnProtectionTimer: number = 0;
  canShoot = true;
  /** Constrained/released/handoff transforms are advanced by the negotiated predictor. */
  serverOwnsMotion = false;
  playerMotion?: PlayerMotionState;
  laserUpgrade?: LaserUpgrade;

  exploding = false;
  lasers: Laser[] = [];
  explodeTime = 0;
  angularVelocity = 0;
  thrusting = false;
  boosting = false;
  health: number = SHIP.MAX_HEALTH;
  maxHealth: number = SHIP.MAX_HEALTH;

  lastDamageTime: number = 0;
  healthRegenTimer: number = 0;
  impactFlashFrames: number = 0;
  blinkOn: boolean; // Will be set in constructor based on blinkCount
  lastShotTime: number = 0;
  shotCooldown: number = 250;
  color: string = PALETTE.LOCAL;
  frictionCoefficient: number = GAME.FRICTION; // Player-specific friction coefficient
  isLocalPlayer: boolean = false; // Track if this is the local player
  kitId: ShipKitId = DEFAULT_SHIP_KIT_ID;
  thrust: number = SHIP.THRUST;
  maxVelocity: number = SHIP.MAX_VELOCITY;
  turnSpeed: number = SHIP.TURN_SPEED;
  abilityCooldownFrames: number = 0;
  abilityActiveFrames: number = 0;

  harpoonTargetId: string | null = null;
  harpoonLatchPos?: Position;
  /** Last specific environmental cause (boundary, asteroid, or ricochet). */
  lastExplodeCause?: string;

  constructor(options?: {
    position?: Position;
    shotCooldown?: number;
    color?: string;
    isLocalPlayer?: boolean;
    frictionCoefficient?: number;
    kitId?: ShipKitId;
  }) {
    // Set initial spawn protection for local players to prevent immediate collisions
    if (options?.isLocalPlayer) {
      applyShipSpawnProtection(this);

      logger.debug('SPAWN_PROTECTION', 'Initial spawn protection set for local player', {
        shipId: this.id,
        blinkCount: this.blinkCount,
        spawnProtectionTimer: this.spawnProtectionTimer,
        position: this.position,
      });
    }

    // Initialize blinkOn based on initial blinkCount
    this.blinkOn = this.blinkCount % 2 === 0;

    // Apply optional overrides
    if (options?.position) {
      this.position = options.position;
    }
    if (options?.shotCooldown !== undefined) {
      this.shotCooldown = options.shotCooldown;
    }
    if (options?.color) {
      this.color = options.color;
    }
    if (options?.isLocalPlayer !== undefined) {
      this.isLocalPlayer = options.isLocalPlayer;
    }
    if (options?.frictionCoefficient !== undefined) {
      this.frictionCoefficient = options.frictionCoefficient;
    }

    applyShipKitToShip(this, options?.kitId ?? DEFAULT_SHIP_KIT_ID);
    if (options?.shotCooldown !== undefined) {
      this.shotCooldown = options.shotCooldown;
    }
    if (options?.color) {
      this.color = options.color;
    }
  }

  setBlinkOn(): void {
    this.blinkOn = this.blinkCount % 2 === 0;
  }

  explode(cause?: string): void {
    if (this.exploding) {
      return;
    }

    if (cause && !isGenericDeathCause(cause)) {
      this.lastExplodeCause = cause;
    } else if (cause && !this.lastExplodeCause) {
      this.lastExplodeCause = cause;
    }

    this.explodeTime = SHIP.EXPLODE_DURATION_FRAMES;
    this.exploding = true; // Set exploding flag when explosion starts
    this.thrusting = false;
    this.boosting = false;
    this.angularVelocity = 0;
    playExplosionSound(this.position);

    // Dispatch event to notify that ship has exploded with cause information
    window.dispatchEvent(
      new CustomEvent('shipExploded', {
        detail: {
          shipId: this.id,
          position: { x: this.position.x, y: this.position.y },
          cause,
        },
      })
    );
  }

  canShootAgain(): boolean {
    this.updateShootCooldown();
    if (this.canShoot && this.lasers.length < SHIP.MAX_LASERS) {
      return true;
    }
    this.canShoot = false;
    return false;
  }

  private updateShootCooldown(): void {
    if (!this.canShoot && Date.now() - this.lastShotTime >= this.shotCooldown) {
      this.canShoot = true;
    }
  }

  shoot(): void {
    logger.debug('SHIP', 'Shoot method called', {
      canShoot: this.canShoot,
      laserCount: this.lasers.length,
    });
    if (this.canShootAgain()) {
      this.fireLaser();
    } else {
      logger.debug('SHIP', 'Cannot shoot - cooldown or max lasers reached', {
        canShoot: this.canShoot,
        laserCount: this.lasers.length,
      });
    }
  }

  fireLaser(): void {
    const laser = this.generateLaser();
    this.lasers.push(laser);
    laser.playLaserSound();

    // Set canShoot to false to prevent rapid firing
    this.canShoot = false;
    this.lastShotTime = Date.now();

    // Send shooting event to network system
    this.sendShootEvent(laser);
  }

  /** Tap or Shift toggles a stronger cruise; a dead hull always drops boost. */
  toggleBoost(): boolean {
    if (this.exploding || this.health <= 0) {
      this.boosting = false;
      return false;
    }
    this.boosting = !this.boosting;
    return this.boosting;
  }

  /** Returns request submission when connected, or activation in offline play. */
  activateAbility(world?: AbilityWorld): boolean {
    if (!canActivateAbility(this)) {
      return false;
    }
    const kit = getShipKit(this.kitId);
    if (this.isLocalPlayer) {
      const networkManager = NetworkManager.getInstance();
      if (networkManager.isConnected) {
        // The server owns the ability result and cooldown. An optimistic toggle
        // can be undone by an older snapshot or disagree about eligible cargo.
        return networkManager.sendMessage({
          type: 'useAbility',
          id: networkManager.getLocalPlayerId(),
          data: {
            kitId: this.kitId,
            abilityId: kit.abilityId,
          },
        });
      }
    }
    return activateAbilityOnHost(this, world).activated;
  }

  moveLasers(): void {
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const laser = this.lasers[i];
      if (laser === undefined) {
        continue;
      }

      laser.move();

      // Remove lasers that have traveled their maximum distance OR finished exploding
      if (laser.shouldBeRemoved()) {
        this.lasers.splice(i, 1);
      }
    }
  }

  generateLaser(): Laser {
    return createLaser(this);
  }

  private sendShootEvent(laser: Laser): void {
    const networkManager = NetworkManager.getInstance();
    if (networkManager.isConnected) {
      logger.debug('SHIP', 'Sending shoot event', {
        position: laser.position,
        velocity: laser.velocity,
      });
      networkManager.sendShootEvent(laser);
    } else {
      logger.debug('SHIP', 'Network not connected, cannot send shoot event');
    }
  }

  takeDamage(amount: number, cause?: string): void {
    if (this.exploding) {
      return;
    }

    this.health = calculateHealthAfterDamage(this.health, amount, this.maxHealth);
    this.lastDamageTime = GAME.FPS;
    this.healthRegenTimer = calculateHealthRegenDelayFrames();

    if (this.health <= 0) {
      this.health = 0;
      this.explode(cause);
    }
  }

  heal(amount: number): void {
    if (this.exploding) {
      return;
    }

    this.health = calculateHealthAfterHeal(this.health, amount, this.maxHealth);
  }

  updateHealth(): void {
    // Client-side health regeneration for better responsiveness
    if (this.exploding) {
      return;
    }

    if (this.lastDamageTime > 0) {
      this.lastDamageTime--;
    }

    if (shouldStartHealthRegeneration(this.lastDamageTime, this.health, this.maxHealth)) {
      if (this.healthRegenTimer <= 0) {
        this.heal(calculateHealthRegenPerFrame());
      } else {
        this.healthRegenTimer--;
      }
    }
  }

  updateExplosion(): void {
    if (this.exploding && this.explodeTime > 0) {
      this.explodeTime--;
      // Stay exploding at t=0 so a late exploding=true snapshot cannot
      // restart the FX, and the dead hull does not resume movement.
    }
  }

  updateInvincibility(): void {
    if (this.blinkCount > 0) {
      this.spawnProtectionTimer--;
      if (this.spawnProtectionTimer <= 0) {
        this.blinkCount--;
        this.spawnProtectionTimer = SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES;
        this.setBlinkOn();

        // Debug logging for blinking updates
        if (this.isLocalPlayer) {
          logger.debug('BLINK_UPDATE', 'Blinking state changed', {
            shipId: this.id,
            blinkCount: this.blinkCount,
            blinkOn: this.blinkOn,
            spawnProtectionTimer: this.spawnProtectionTimer,
          });
        }
      }
    } else if (this.isLocalPlayer) {
      // Debug logging when spawn protection is complete
      logger.debug('SPAWN_PROTECTION', 'Spawn protection complete', {
        shipId: this.id,
        blinkCount: this.blinkCount,
        canCollide: true,
      });
    }
  }

  /**
   * 60 Hz explode / blink / regen. Shared by local and remote ships.
   * Movement is not applied here so remotes can tick death FX without predicting pose.
   */
  updateLifecycle(lifecycleFrames = 1): void {
    const steps = Math.max(0, Math.floor(lifecycleFrames));
    if (this.exploding) {
      for (let i = 0; i < steps; i++) {
        this.updateExplosion();
      }
      return;
    }
    if (this.health <= 0) {
      return;
    }

    for (let i = 0; i < steps; i++) {
      this.updateInvincibility();
      tickShipImpactFlash(this);
      tickAbilityHost(this);
      this.updateHealth();
    }
  }

  /** Advance one 60 Hz simulation step, including movement and combat timers. */
  update(): void {
    if (this.isLocalPlayer) {
      AuthoritativeProjectileField.getInstance().expirePendingShots();
    }
    this.updateLifecycle();
    if (this.exploding || this.health <= 0) {
      return;
    }

    if (!this.serverOwnsMotion) {
      this.updateMovement();
    }
    this.updateShootCooldown();
    this.moveLasers();
  }

  // Update ship movement (position, velocity, rotation)
  private updateMovement(): void {
    this.angle += this.angularVelocity;
    const boost = this.boosting ? getShipKit(this.kitId).boostMultiplier : 1;
    const speed = cruiseSpeed(this.mass, this.maxVelocity, boost);
    const velocityLimit = Math.max(speed, this.knockbackVelocityLimit);
    if (this.knockbackVelocityLimit <= speed) {
      // Steering redirects normal momentum before thrust and terrain forces act.
      // A server-granted blast keeps its motion until the excess speed decays.
      advanceCruiseVelocity(this, speed, boost);
    } else {
      this.velocity = applyThrustOrFriction(
        this.velocity,
        this.angle,
        this.thrusting,
        this.frictionCoefficient,
        this.thrust * boost,
        this.mass,
        velocityLimit
      );
      applySharedShipSlope(this.velocity, this.position);
    }
    this.capVelocity(velocityLimit);
    this.knockbackVelocityLimit *= PLAYER_MOTION.knockbackRetention;
    this.position = addPositionAndVelocity(this.position, this.velocity);
    containBodyOutOfCompletedSectors(this, getCompletedSectors(), { radius: this.r });
  }

  private capVelocity(maximum: number): void {
    const currentSpeed = Math.hypot(this.velocity.x, this.velocity.y);
    if (currentSpeed > maximum) {
      const scale = maximum / currentSpeed;
      this.velocity.x *= scale;
      this.velocity.y *= scale;
    }
  }
}

export { Ship };
