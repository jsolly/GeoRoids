import { GAME, SHIP } from '../../../shared/constants/gameplay';
import { CONTOUR_BRIDGE, contourDraftMultiplier } from '../../../shared/contourBridge';
import {
  acceleratedContourVelocity,
  canReachContour,
  contourLockVelocity,
} from '../../../shared/contourLock';
import { onDarkFurnaceFootprint } from '../../../shared/furnaceField';
import { furnaceTravelPose } from '../../../shared/furnaceTravel';
import { navigationCaptureRadius } from '../../../shared/navigationSalvage';
import { PLAYER_MOTION } from '../../../shared/playerMotion';
import {
  type AbilityWorld,
  abilityCooldownFramesFor,
  activateAbilityOnHost,
  canActivateAbility,
  predictAbilityOnHost,
  tickAbilityHost,
  tickTowLine,
} from '../../../shared/shipAbilities';
import { GROWTH } from '../../../shared/shipGrowth';
import {
  applyShipKitToShip,
  DEFAULT_SHIP_KIT_ID,
  hullRadiusForKit,
  SHIP_ABILITY,
} from '../../../shared/shipKits';
import { scoutUtilityOf } from '../../../shared/shipUtilities';
import { terrainCruiseVelocity, terrainSpeedLimit } from '../../../shared/terrainTravel';
import type {
  ContourLockState,
  CrewSignal,
  EquipmentId,
  FurnaceTransit,
  HaulerUtilityId,
  PlayerMotionState,
  Position,
  RescueState,
  ScoutUtilityId,
  ShipKitId,
  Velocity,
} from '../../../shared-types';
import { playExplosionSound } from '../../audio/explosionSound';
import { playFeedback } from '../../audio/feedbackSounds';
import { PALETTE } from '../../constants';
import { playLocalHaptic } from '../../fx/haptics';
import { worldFurnaces } from '../../network/worldExploration';
import { findContourCapture, findContourHop } from '../../physics/terrain/contourCapture';
import { logger } from '../../utils/Logger';
import { addPositionAndVelocity } from '../../utils/mathUtils';
import { AuthoritativeProjectileField } from '../laser/AuthoritativeProjectileField';
import type { Laser } from '../laser/Laser';
import { createLaser } from '../laser/laserUtils';
import { advanceCruiseVelocity } from './cruiseMotion';
import { getHarpoonField, syncHarpoonFieldFromPlay } from './harpoonField';
import type { ShipCombatNetwork } from './shipCombatNetwork';
import {
  applyShipSpawnProtection,
  applyThrustOrFriction,
  calculateHealthAfterDamage,
  tickShipImpactFlash,
} from './shipUtils';

class Ship {
  id: string = crypto.randomUUID(); // Unique identifier for event handling
  position: Position = { x: 0, y: 0 };
  velocity: Velocity = { x: 0, y: 0 };
  /** Granted only by an authoritative motion rebase after an external impulse. */
  knockbackVelocityLimit = 0;
  r: number = hullRadiusForKit(DEFAULT_SHIP_KIT_ID);
  mass: number = GROWTH.BASE_MASS;
  angle: number = (90 / 180) * Math.PI;
  weaponChargeStartedAt: number | null = null;
  weaponChargeFrames = 0;
  navigationAssistFrames = 0;
  contourDraftFrames = 0;
  private contourHopCount = 0;
  private contourHopAt = -Infinity;

  beginWeaponCharge(): void {
    if (
      this.weaponChargeStartedAt !== null ||
      this.health <= 0 ||
      this.exploding ||
      this.furnaceTransit
    ) {
      return;
    }
    if (this.combatNetwork?.sendCharge('start') === true) {
      this.weaponChargeStartedAt = performance.now();
    }
  }

  finishWeaponCharge(release: boolean): void {
    const wasCharging = this.weaponChargeStartedAt !== null;
    this.weaponChargeStartedAt = null;
    this.weaponChargeFrames = 0;
    if (!wasCharging) {
      return;
    }
    this.combatNetwork?.sendCharge(
      release && this.health > 0 && !this.exploding ? 'release' : 'cancel'
    );
  }

  /** Presentation clock only; authoritative flight remains active during assembly. */
  hullAssemblyStartedAt = Number.NEGATIVE_INFINITY;

  beginHullAssembly(): void {
    this.hullAssemblyStartedAt = performance.now();
  }

  blinkCount: number = 0;
  spawnProtectionTimer: number = 0;
  canShoot: boolean = true;
  /** Constrained/released/handoff transforms are advanced by the negotiated predictor. */
  serverOwnsMotion: boolean = false;
  playerMotion?: PlayerMotionState;

  exploding: boolean = false;
  lasers: Laser[] = [];
  explodeTime = 0;
  angularVelocity = 0;
  thrusting: boolean = false;
  private contourLockState: ContourLockState | null = null;

  get contourLock(): ContourLockState | null {
    return this.contourLockState;
  }

  set contourLock(state: ContourLockState | null) {
    const wasLocked = this.contourLockState !== null;
    this.contourLockState = state;
    // Predicted input and authoritative reconciliation share this transition.
    // Changing rails stays locked; repeated snapshots never replay the cue.
    if (this.isLocalPlayer && wasLocked !== (state !== null)) {
      playFeedback(state ? 'contourLockAcquired' : 'contourLockReleased');
    }
  }
  /** Local input revision prevents lagging snapshots from undoing a new toggle. */
  contourLockInputVersion = 0;

  get contourLocked(): boolean {
    return this.contourLock !== null;
  }
  health: number = SHIP.MAX_HEALTH;
  maxHealth: number = SHIP.MAX_HEALTH;

  impactFlashFrames: number = 0;
  blinkOn: boolean; // Will be set in constructor based on blinkCount
  lastShotTime: number = 0;
  shotCooldown: number = 250;
  color: string = PALETTE.LOCAL;
  frictionCoefficient: number = GAME.FRICTION; // Player-specific friction coefficient
  /** In-flight menus stop navigation without pausing combat or lifecycle timers. */
  movementLocked = false;
  /** Automatic cargo stop, released by steering; grants no damage immunity. */
  cargoHover = false;
  cargo = 0;
  downedUntil: number | null = null;
  rescue: RescueState | null = null;
  crewSignal: CrewSignal | null = null;
  isLocalPlayer: boolean = false; // Track if this is the local player
  kitId: ShipKitId = DEFAULT_SHIP_KIT_ID;
  abilityCooldownFrames: number = 0;
  abilityActiveFrames: number = 0;

  utilityFlight: import('../../../shared-types').UtilityFlight | null = null;
  harpoonTargetId: string | null = null;
  harpoonLatchPos?: Position;
  furnaceTransit: FurnaceTransit | null = null;
  furnaceClockOffsetMs = 0;
  equipment: EquipmentId[] = [];
  haulerUtility?: HaulerUtilityId;
  scoutUtility?: ScoutUtilityId;
  tapExtractFrames?: number;
  tapExtractCompleted?: boolean;

  private readonly combatNetwork: ShipCombatNetwork | undefined;

  constructor(options?: {
    combatNetwork?: ShipCombatNetwork;
    position?: Position;
    color?: string;
    isLocalPlayer?: boolean;
    frictionCoefficient?: number;
    kitId?: ShipKitId;
  }) {
    this.combatNetwork = options?.combatNetwork;
    // Set initial spawn protection for local players to prevent immediate collisions
    if (options?.isLocalPlayer === true) {
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
    if (options?.isLocalPlayer !== undefined) {
      this.isLocalPlayer = options.isLocalPlayer;
    }
    if (options?.frictionCoefficient !== undefined) {
      this.frictionCoefficient = options.frictionCoefficient;
    }

    applyShipKitToShip(this, options?.kitId ?? DEFAULT_SHIP_KIT_ID);
    if (options?.color != null && options?.color !== '') {
      this.color = options.color;
    }
  }

  setBlinkOn(): void {
    this.blinkOn = this.blinkCount % 2 === 0;
  }

  explode(): void {
    this.finishWeaponCharge(false);

    this.utilityFlight = null;
    if (this.exploding) {
      return;
    }

    this.explodeTime = SHIP.EXPLODE_DURATION_FRAMES;
    this.exploding = true; // Set exploding flag when explosion starts
    this.thrusting = false;
    this.releaseContourLock();
    this.angularVelocity = 0;
    playExplosionSound(this.position);
    playLocalHaptic(this.isLocalPlayer, 'boom');
  }

  private canShootAgain(): boolean {
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
    if (this.furnaceTransit || this.weaponChargeStartedAt !== null) {
      return;
    }

    if (this.canShootAgain()) {
      this.fireLaser();
    }
  }

  fireLaser(): void {
    if (this.furnaceTransit) {
      return;
    }
    const laser = this.generateLaser();
    this.lasers.push(laser);
    laser.playLaserSound();
    playLocalHaptic(this.isLocalPlayer, 'shot');

    // Set canShoot to false to prevent rapid firing
    this.canShoot = false;
    this.lastShotTime = Date.now();

    // Send shooting event to network system
    this.sendShootEvent(laser);
  }

  releaseContourLock(): void {
    if (this.contourLock === null) {
      return;
    }
    this.contourLock = null;
    this.contourLockInputVersion++;
    const speed = SHIP.MAX_VELOCITY;
    if (this.knockbackVelocityLimit <= speed) {
      const target = terrainCruiseVelocity(this.position, this.angle, speed);
      this.capVelocity(Math.hypot(target.x, target.y));
    }
  }

  canLockContour(): boolean {
    return (
      !this.furnaceTransit &&
      !this.serverOwnsMotion &&
      !this.exploding &&
      this.health > 0 &&
      !this.movementLocked &&
      this.knockbackVelocityLimit <= SHIP.MAX_VELOCITY &&
      findContourCapture(
        this.position,
        this.angle,
        navigationCaptureRadius(this.navigationAssistFrames)
      ) !== null
    );
  }

  toggleContourLock(): boolean {
    if (this.contourLocked) {
      this.releaseContourLock();
      return false;
    }
    if (!this.canLockContour()) {
      return false;
    }
    const capture = findContourCapture(
      this.position,
      this.angle,
      navigationCaptureRadius(this.navigationAssistFrames)
    );
    return capture ? this.acquireContour(capture) : false;
  }

  hopContour(flick: Position, preserveDirection = false): boolean {
    if (!this.contourLock || !this.canLockContour()) {
      return false;
    }
    const now = performance.now();
    const capture = findContourHop(this.position, this.contourLock, flick);
    if (capture && preserveDirection) {
      capture.direction = this.contourLock.direction;
    }
    if (
      capture?.height !== this.contourLock.height &&
      this.contourHopCount >= CONTOUR_BRIDGE.hopLimit &&
      now - this.contourHopAt < CONTOUR_BRIDGE.comboWindowMs
    ) {
      return false;
    }
    const cruise = SHIP.MAX_VELOCITY;

    const acceleration = SHIP.THRUST / GAME.FPS;
    if (
      !capture ||
      !canReachContour(
        this.position,
        capture,
        cruise,
        Math.hypot(this.velocity.x, this.velocity.y),
        acceleration
      )
    ) {
      return false;
    }
    const changedRail = capture.height !== this.contourLock.height;
    const accepted = this.acquireContour(capture);
    if (accepted && changedRail) {
      this.contourHopCount =
        now - this.contourHopAt < CONTOUR_BRIDGE.comboWindowMs ? this.contourHopCount + 1 : 1;
      this.contourHopAt = now;
    }
    return accepted;
  }

  private acquireContour(capture: ContourLockState): boolean {
    const target = contourLockVelocity(this.position, capture, SHIP.MAX_VELOCITY);
    if (!target) {
      return false;
    }
    // Input can publish a pose before the next movement tick. Capture intent
    // and its rail-aligned velocity must therefore become visible together.
    const targetSpeed = Math.hypot(target.x, target.y);
    const speed = Math.min(Math.hypot(this.velocity.x, this.velocity.y), targetSpeed);
    this.velocity = {
      x: (target.x * speed) / targetSpeed,
      y: (target.y * speed) / targetSpeed,
    };
    this.angle = Math.atan2(-target.y, target.x);
    this.contourLock = capture;
    this.contourLockInputVersion++;
    this.angularVelocity = 0;
    return this.contourLocked;
  }

  /** Returns request submission when connected, or activation in offline play. */
  activateAbility(world?: AbilityWorld): boolean {
    const building =
      this.kitId === 'scout' &&
      onDarkFurnaceFootprint(this.position, (id) => worldFurnaces.isLit(id));
    if (
      this.furnaceTransit ||
      this.exploding ||
      this.health <= 0 ||
      (!building && !canActivateAbility(this))
    ) {
      return false;
    }
    if (this.isLocalPlayer) {
      const network = this.combatNetwork;
      if (network?.isConnected === true) {
        // The server owns the ability result and cooldown. An optimistic toggle
        // can be undone by an older snapshot or disagree about eligible cargo.
        const sent = network.sendAbility();
        if (!sent) {
          return false;
        }
        if (this.kitId === 'scout' && !building) {
          // Scout tools share the same request, but the probe has no local
          // world effect. Predict only the user-facing timer; asteroid
          // attachment and mineral classification remain server-owned. Near a
          // dark furnace the server builds instead, so skip local scan timing.
          this.abilityCooldownFrames = abilityCooldownFramesFor(this);
          this.abilityActiveFrames =
            scoutUtilityOf(this) === 'mineral_scan' ? SHIP_ABILITY.SCAN_FRAMES : 0;
        }
        return true;
      }
    }
    return (
      world
        ? activateAbilityOnHost(this, world)
        : predictAbilityOnHost(this, syncHarpoonFieldFromPlay())
    ).activated;
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
    const network = this.combatNetwork;
    if (network?.isConnected === true) {
      network.sendShoot(laser);
    }
  }

  takeDamage(amount: number): void {
    this.releaseContourLock();
    if (this.exploding || this.movementLocked) {
      return;
    }

    this.health = calculateHealthAfterDamage(this.health, amount, this.maxHealth);

    if (this.health <= 0) {
      this.health = 0;
      this.explode();
    }
  }

  private updateExplosion(): void {
    if (this.exploding && this.explodeTime > 0) {
      this.explodeTime--;
      // Stay exploding at t=0 so a late exploding=true snapshot cannot
      // restart the FX, and the dead hull does not resume movement.
    }
  }

  private updateInvincibility(): void {
    if (this.blinkCount > 0) {
      this.spawnProtectionTimer--;
      if (this.spawnProtectionTimer <= 0) {
        this.blinkCount--;
        this.spawnProtectionTimer = SHIP.INVINCIBILITY_BLINK_DURATION_FRAMES;
        this.setBlinkOn();
      }
    }
  }

  /**
   * 60 Hz explode / blink / regen. Shared by local and remote ships.
   * Movement is not applied here so remotes can tick death FX without predicting pose.
   */
  updateLifecycle(lifecycleFrames = 1): void {
    const steps = Math.max(0, Math.floor(lifecycleFrames));
    if (this.exploding) {
      this.utilityFlight = null;
      for (let i = 0; i < steps; i++) {
        this.updateExplosion();
      }
      return;
    }
    if (this.health <= 0) {
      this.utilityFlight = null;
      return;
    }

    for (let i = 0; i < steps; i++) {
      this.updateInvincibility();
      tickShipImpactFlash(this);
      tickAbilityHost(this);
      if (this.combatNetwork?.isConnected !== true) {
        tickTowLine(this, getHarpoonField());
      }
    }
  }

  /** Advance one 60 Hz simulation step, including movement and combat timers. */
  update(): void {
    if (
      (this.downedUntil != null && this.downedUntil !== 0 && !Number.isNaN(this.downedUntil)) ||
      this.rescue
    ) {
      this.velocity = { x: 0, y: 0 };
      this.thrusting = false;
      this.releaseContourLock();
      return;
    }
    if (this.furnaceTransit) {
      this.releaseContourLock();
      const pose = furnaceTravelPose(this.furnaceTransit, Date.now() + this.furnaceClockOffsetMs);
      this.position = { ...pose.position };
      this.angle = pose.angle;
      this.velocity = { x: 0, y: 0 };
      this.angularVelocity = 0;
      this.thrusting = false;
      this.updateShootCooldown();
      this.moveLasers();
      return;
    }
    if (this.isLocalPlayer) {
      AuthoritativeProjectileField.getInstance().expirePendingShots();
    }
    if (this.furnaceTransit || this.exploding || this.health <= 0 || this.movementLocked) {
      this.releaseContourLock();
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
    if (this.cargoHover && !this.movementLocked) {
      this.releaseContourLock();
      this.velocity = { x: 0, y: 0 };
      this.thrusting = false;
      return;
    }
    if (this.movementLocked) {
      this.velocity = { x: 0, y: 0 };
      this.angularVelocity = 0;
      this.thrusting = false;
      this.knockbackVelocityLimit = 0;
      return;
    }
    this.navigationAssistFrames = Math.max(0, this.navigationAssistFrames - 1);
    this.contourDraftFrames = Math.max(0, this.contourDraftFrames - 1);
    this.angle += this.angularVelocity;
    const speed = SHIP.MAX_VELOCITY;
    if (this.knockbackVelocityLimit > speed) {
      this.releaseContourLock();
    }
    if (this.contourLock) {
      const target = acceleratedContourVelocity(
        this.position,
        this.contourLock,
        speed * contourDraftMultiplier(this.contourDraftFrames),
        Math.hypot(this.velocity.x, this.velocity.y),
        SHIP.THRUST / GAME.FPS
      );
      if (target) {
        this.velocity = target;
        this.angle = Math.atan2(-target.y, target.x);
        this.position = addPositionAndVelocity(this.position, this.velocity);
        return;
      }
      this.releaseContourLock();
    }
    const velocityLimit = Math.max(
      terrainSpeedLimit(this.position, speed),
      this.knockbackVelocityLimit
    );
    if (this.knockbackVelocityLimit <= speed) {
      // Contour alignment adds speed while cruise continues to follow the nose.
      // A server-granted blast keeps its motion until the excess speed decays.
      advanceCruiseVelocity(this, speed);
    } else {
      this.velocity = applyThrustOrFriction(
        this.velocity,
        this.angle,
        this.thrusting,
        this.frictionCoefficient,
        velocityLimit
      );
    }
    this.capVelocity(velocityLimit);
    this.knockbackVelocityLimit *= PLAYER_MOTION.knockbackRetention;
    this.position = addPositionAndVelocity(this.position, this.velocity);
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
