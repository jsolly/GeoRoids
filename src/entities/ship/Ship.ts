import { v4 as uuidv4 } from 'uuid';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../../shared/constants/health';
import { createFuelTank } from '../../../shared/fuel';
import { GROWTH, radiusFromMass } from '../../../shared/shipGrowth';
import type {
  AsteroidMotionState,
  Position,
  ShipKitId,
  SoftFactionId,
  Velocity,
} from '../../../shared-types';
import { playExplosionSound } from '../../audio/explosionSound';
import { getThrustSound } from '../../audio/gameSounds';
import type { Sound } from '../../audio/Sound';
import { DAMAGE, FUEL, GAME, PALETTE, SHIP } from '../../constants';
import { NetworkManager } from '../../network/networkManager';
import { applySharedShipSlope } from '../../physics/terrain/applyShipSlope';
import { isGenericDeathCause } from '../../utils/deathCause';
import { logger } from '../../utils/Logger';
import { addPositionAndVelocity } from '../../utils/mathUtils';
import { AuthoritativeProjectileField } from '../laser/AuthoritativeProjectileField';
import type { Laser } from '../laser/Laser';
import { createLaser, createLaserAtAngle } from '../laser/laserUtils';
import { getHarpoonFieldCanvas, getHarpoonFieldScale } from './harpoonField';
import {
  type AbilityWorld,
  activateAbilityOnHost,
  canActivateAbility,
  tickAbilityHost,
} from './shipAbilities';
import { applyShipKitToShip, DEFAULT_SHIP_KIT_ID, getShipKit } from './shipKits';

import {
  activateShield,
  clearShield,
  deactivateShield,
  isShieldBlockingLasers,
  noteReadableShieldLaserHit,
  noteShieldLaserHit,
  updateShield,
} from './shipShield';
import {
  applyShipSpawnProtection,
  applyThrustOrFriction,
  calculateHealthAfterDamage,
  calculateHealthAfterHeal,
  canTakeCollisionDamage,
  shouldStartHealthRegeneration,
  tickShipImpactFlash,
} from './shipUtils';

class Ship {
  id: string = uuidv4(); // Unique identifier for event handling
  position: Position = { x: 0, y: 0 };
  velocity: Velocity = { x: 0, y: 0 };
  r: number = radiusFromMass(GROWTH.BASE_MASS);
  mass: number = GROWTH.BASE_MASS;
  angle: number = (90 / 180) * Math.PI;
  blinkCount: number = 0;
  spawnProtectionTimer: number = 0;
  canShoot = true;
  /** Constrained/released/handoff transforms are advanced by the negotiated predictor. */
  serverOwnsMotion = false;
  asteroidMotion?: AsteroidMotionState;

  exploding = false;
  lasers: Laser[] = [];
  explodeTime = 0;
  angularVelocity = 0;
  thrusting = false;
  shieldActive = false;
  shieldTime = 0;
  shieldCooldown = 0;
  shieldFlashTime = 0;
  health: number = SHIP.MAX_HEALTH;
  maxHealth: number = SHIP.MAX_HEALTH;
  fuel: number = FUEL.START;
  maxFuel: number = FUEL.MAX;
  lastLocalFuelWriteMs: number = 0;
  lastDamageTime: number = 0;
  healthRegenTimer: number = 0;
  lastCollisionTime: number = 0;
  impactFlashFrames: number = 0;
  blinkOn: boolean; // Will be set in constructor based on blinkCount
  lastShotTime: number = 0;
  shotCooldown: number = 250;
  color: string = PALETTE.LOCAL;
  factionId?: SoftFactionId;
  isBot: boolean = false; // Flag to identify if this ship belongs to a bot
  frictionCoefficient: number = GAME.FRICTION; // Player-specific friction coefficient
  isLocalPlayer: boolean = false; // Track if this is the local player
  kitId: ShipKitId = DEFAULT_SHIP_KIT_ID;
  thrust: number = SHIP.THRUST;
  maxVelocity: number = SHIP.MAX_VELOCITY;
  turnSpeed: number = SHIP.TURN_SPEED;
  abilityCooldownFrames: number = 0;
  abilityActiveFrames: number = 0;
  shieldTimer: number = 0;
  harpoonTimer: number = 0;
  harpoonTargetId?: string;
  harpoonLatchPos?: Position;

  // Player collision damage-over-time tracking
  isCollidingWithPlayer: boolean = false;
  playerCollisionStartTime: number = 0;
  lastPlayerCollisionDamageTime: number = 0;
  collidingPlayerId?: string;
  /** Last non-generic explode token (boundary, asteroid, attacker id). */
  lastExplodeCause?: string;

  static get fxThrust(): Sound {
    return getThrustSound();
  }

  constructor(options?: {
    position?: Position;
    shotCooldown?: number;
    color?: string;
    isBot?: boolean;
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

    // Apply optional overrides for bot-specific configuration
    if (options?.position) {
      this.position = options.position;
    }
    if (options?.shotCooldown !== undefined) {
      this.shotCooldown = options.shotCooldown;
    }
    if (options?.color) {
      this.color = options.color;
    }
    if (options?.isBot !== undefined) {
      this.isBot = options.isBot;
    }
    if (options?.isLocalPlayer !== undefined) {
      this.isLocalPlayer = options.isLocalPlayer;
    }
    if (options?.frictionCoefficient !== undefined) {
      this.frictionCoefficient = options.frictionCoefficient;
    }
    const tank = createFuelTank();
    this.fuel = tank.fuel;
    this.maxFuel = tank.maxFuel;
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

  explode(cause?: string, killerName?: string): void {
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
    this.angularVelocity = 0;
    clearShield(this);
    playExplosionSound(this.position);

    // Dispatch event to notify that ship has exploded with cause information
    window.dispatchEvent(
      new CustomEvent('shipExploded', {
        detail: {
          shipId: this.id,
          position: { x: this.position.x, y: this.position.y },
          cause,
          killerName,
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

  fireBurst(count: number, spread: number): void {
    const mid = (count - 1) / 2;
    for (let i = 0; i < count; i++) {
      if (this.lasers.length >= SHIP.MAX_LASERS) {
        break;
      }
      const angle = this.angle + (i - mid) * spread;
      const laser = createLaserAtAngle(this, angle);
      this.lasers.push(laser);
      if (i === 0) {
        laser.playLaserSound();
      }
      this.sendShootEvent(laser);
    }
    this.canShoot = false;
    this.lastShotTime = Date.now();
  }

  activateAbility(world?: AbilityWorld): boolean {
    if (this.exploding) {
      return false;
    }
    const kit = getShipKit(this.kitId);
    const canTry = canActivateAbility(this);
    const result = activateAbilityOnHost(this, world);
    if (result.activated && result.abilityId === 'shockPulse') {
      this.lastLocalFuelWriteMs = Date.now();
    }
    if (result.abilityId === 'burstFire') {
      this.fireBurst(kit.burstCount, 0.12);
    }
    // Always tell the server on a legal E. Do not start the Hauler cooldown
    // on a miss — that 3s lock was why a later in-range tap stayed dead.
    if (this.isLocalPlayer && !this.isBot && canTry) {
      const networkManager = NetworkManager.getInstance();
      if (networkManager.isConnected) {
        const canvas = getHarpoonFieldCanvas();
        networkManager.sendMessage({
          type: 'useAbility',
          id: networkManager.getLocalPlayerId(),
          data: {
            kitId: this.kitId,
            abilityId: result.abilityId ?? kit.abilityId,
            playfieldScale: getHarpoonFieldScale(),
            canvasWidth: canvas?.width,
            canvasHeight: canvas?.height,
          },
        });
      }
    }
    return result.activated;
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
    // Only send shooting events for non-bot ships
    if (!this.isBot) {
      const networkManager = NetworkManager.getInstance();
      if (networkManager.isConnected) {
        // Send dedicated shoot event to server
        logger.debug('SHIP', 'Sending shoot event', {
          position: laser.position,
          velocity: laser.velocity,
        });
        networkManager.sendShootEvent(laser);
      } else {
        logger.debug('SHIP', 'Network not connected, cannot send shoot event');
      }
    } else {
      logger.debug('SHIP', 'Bot ship, not sending shoot event');
    }
  }

  requestShieldToggle(): boolean {
    if (this.exploding) {
      return false;
    }
    if (this.shieldActive) {
      deactivateShield(this);
      this.sendShieldEvent(false);
      return true;
    }
    if (!activateShield(this, this.exploding)) {
      return false;
    }
    this.sendShieldEvent(true);
    return true;
  }

  private sendShieldEvent(active: boolean): void {
    if (this.isBot) {
      return;
    }
    const networkManager = NetworkManager.getInstance();
    if (!networkManager.isConnected) {
      return;
    }
    const id = networkManager.getLocalPlayerId();
    if (!id) {
      return;
    }
    networkManager.sendMessage({
      type: 'shield',
      id,
      data: { active },
    });
  }

  takeDamage(amount: number, cause?: string, killerName?: string): void {
    if (this.exploding) {
      return;
    }
    if (this.shieldTimer > 0) {
      if (cause === 'laser') {
        noteReadableShieldLaserHit(this);
      }
      return;
    }

    if (cause === 'laser' && isShieldBlockingLasers(this)) {
      noteShieldLaserHit(this);
      return;
    }

    this.health = calculateHealthAfterDamage(this.health, amount, this.maxHealth);
    this.lastDamageTime = GAME.FPS;
    this.healthRegenTimer = calculateHealthRegenDelayFrames();

    if (this.health <= 0) {
      this.health = 0;
      this.explode(cause, killerName);
    }
  }

  canTakeCollisionDamage(cooldownMs: number = 500): boolean {
    return canTakeCollisionDamage(this.lastCollisionTime, cooldownMs);
  }

  startPlayerCollision(collidingPlayerId?: string): void {
    if (!this.isCollidingWithPlayer) {
      this.isCollidingWithPlayer = true;
      this.playerCollisionStartTime = Date.now();
      this.lastPlayerCollisionDamageTime = Date.now();
    }
    if (collidingPlayerId) {
      this.collidingPlayerId = collidingPlayerId;
    }
  }

  stopPlayerCollision(): void {
    this.isCollidingWithPlayer = false;
    this.playerCollisionStartTime = 0;
    this.lastPlayerCollisionDamageTime = 0;
    delete this.collidingPlayerId;
  }

  updatePlayerCollisionDamage(): void {
    if (!this.isCollidingWithPlayer || this.exploding) {
      return;
    }

    const now = Date.now();
    const timeSinceLastDamage = now - this.lastPlayerCollisionDamageTime;
    const damageInterval = DAMAGE.PLAYER_COLLISION_INTERVAL_MS;

    if (timeSinceLastDamage >= damageInterval) {
      const networkManager = NetworkManager.getInstance();
      if (!networkManager.isConnected) {
        logger.debug('COLLISION', 'Applying local collision damage', { damage: 1 });
        this.takeDamage(1, 'player');
      }
      this.lastPlayerCollisionDamageTime = now;
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
        const healthBefore = this.health;
        this.heal(calculateHealthRegenPerFrame());
        const healthAfter = this.health;

        if (healthBefore !== healthAfter) {
          // Health regenerated
          if (this.isBot) {
            logger.debug('SHIP', 'Bot health regenerated', {
              healthBefore,
              healthAfter,
              lastDamageTime: this.lastDamageTime,
              healthRegenTimer: this.healthRegenTimer,
            });
          }
        }
      } else {
        this.healthRegenTimer--;
      }
    }

    // Update player collision damage-over-time
    this.updatePlayerCollisionDamage();
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
   * 60 Hz explode / blink / regen. Shared by local, remote, and bot ships.
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
    updateShield(this);
    this.updateShootCooldown();
    this.moveLasers();
  }

  // Update ship movement (position, velocity, rotation)
  private updateMovement(): void {
    // Bot poses are supplied by the server.
    if (this.isBot) {
      return;
    }

    this.angle += this.angularVelocity;
    this.velocity = applyThrustOrFriction(
      this.velocity,
      this.angle,
      this.thrusting,
      this.frictionCoefficient,
      this.thrust,
      this.mass,
      this.maxVelocity
    );
    applySharedShipSlope(this.velocity, this.position);
    this.capVelocity();
    this.position = addPositionAndVelocity(this.position, this.velocity);
  }

  private capVelocity(): void {
    const currentSpeed = Math.hypot(this.velocity.x, this.velocity.y);
    if (currentSpeed > this.maxVelocity) {
      const scale = this.maxVelocity / currentSpeed;
      this.velocity.x *= scale;
      this.velocity.y *= scale;
    }
  }
}

export { Ship };
