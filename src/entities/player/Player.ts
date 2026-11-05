import { canEquipUtility } from '../../../shared/equipment';
import { applyShipKitToShip } from '../../../shared/shipKits';
import { DEFAULT_HAULER_UTILITY, DEFAULT_SCOUT_UTILITY } from '../../../shared/shipUtilities';
import { purchasedHullColor } from '../../../shared/townStore';
import type {
  BotRole,
  ContourLockState,
  CrewSignal,
  EquipmentId,
  FurnaceTransit,
  HaulerUtilityId,
  Position,
  RescueState,
  ScoutUtilityId,
  ShipKitId,
} from '../../../shared-types';
import {
  playHarpoonLatch,
  playHarpoonLaunch,
  playHarpoonRelease,
  playRespawn,
} from '../../audio/interactionSounds';
import { playLocalHaptic } from '../../fx/haptics';
import { getPlayerColor } from '../../utils/colorUtils';
import { logger } from '../../utils/Logger';
import { recordAsteroidLatch } from '../roid/roidRenderer';
import { applySharedHarpoonLatch } from '../ship/harpoonField';
import { Ship } from '../ship/Ship';
import type { ShipCombatNetwork } from '../ship/shipCombatNetwork';
import {
  applySharedShipExplodingFlag,
  applySharedShipRespawnCue,
  isServerRespawnActive,
} from '../ship/shipUtils';

function copyVec2(dest: { x: number; y: number }, src: { x: number; y: number }): void {
  dest.x = src.x;
  dest.y = src.y;
}

export class Player {
  botRole?: BotRole;
  id: string;
  name: string;
  type: 'local' | 'remote';
  ship: Ship;
  score: number = 0;
  silk = 0;
  get cargo(): number {
    return this.ship.cargo;
  }
  set cargo(value: number) {
    this.ship.cargo = value;
  }

  bankedCargo = 0;
  purchases: string[] = [];
  get color(): string {
    return this.ship.color;
  }
  set color(value: string) {
    this.ship.color = value;
  }

  // For the local player: from the moment it dies until it is confirmed alive
  // again, trust the server for position (so the respawn point is adopted).
  // While alive it predicts locally and ignores the lagging server echo.
  private adoptServerPosition = false;
  private observedAuthoritativePose = false;

  /** Ship position when death forced server-authoritative movement (respawn latch). */
  private respawnLatchOrigin: Position | null = null;

  // Remember heard transitions independently of predicted death clearing the ship.
  private soundedTowOutbound = false;
  private soundedHarpoonTarget: string | null = null;

  // Server-authoritative spawn-protection countdown (frames). While > 0 the
  // server ignores all incoming damage. Mirrored from the authoritative snapshot so callers
  // (notably tests) can tell exactly when the player becomes vulnerable.
  serverSpawnProtectionTimer = 0;

  private readonly networkState: {
    position: Position;
    velocity: Position;
    angle: number;
    thrusting: boolean;
    overlayHold: boolean;
  };

  constructor(params: {
    id: string;
    name: string;
    type: 'local' | 'remote';
    kitId?: ShipKitId;
    combatNetwork?: ShipCombatNetwork;
  }) {
    this.id = params.id;
    this.name = params.name;
    this.type = params.type;

    this.ship = new Ship({
      ...(params.combatNetwork !== undefined ? { combatNetwork: params.combatNetwork } : {}),
      color: getPlayerColor(this.type),
      isLocalPlayer: this.type === 'local',
      frictionCoefficient: 0.01,
      ...(params.kitId !== undefined ? { kitId: params.kitId } : {}),
    });
    this.networkState = {
      position: this.ship.position,
      velocity: this.ship.velocity,
      angle: this.ship.angle,
      thrusting: this.ship.thrusting,
      overlayHold: false,
    };
  }

  // Update player state from server data
  updateFromServer(data: {
    position?: Position;
    velocity?: Position;
    angle?: number;
    cargo?: number;
    bankedCargo?: number;
    shieldFrames?: number;
    shieldCooldownFrames?: number;
    weaponChargeFrames?: number;
    navigationAssistFrames?: number;
    contourDraftFrames?: number;
    purchases?: string[];
    score?: number;
    silk?: number;
    equipment?: EquipmentId[];
    furnaceTransit?: FurnaceTransit | null;
    downedUntil?: number | null;
    rescue?: RescueState | null;
    crewSignal?: CrewSignal | null;
    exploding?: boolean;
    thrusting?: boolean;
    contourLock?: ContourLockState;
    color?: string;
    health?: number;
    maxHealth?: number;

    mass?: number;
    respawnTimer?: number;
    spawnProtectionTimer?: number;
    kitId?: ShipKitId;
    abilityCooldownFrames?: number;
    abilityActiveFrames?: number;

    utilityFlight?: import('../../../shared-types').UtilityFlight | null;
    harpoonTargetId?: string | null;
    harpoonLatchPos?: { x: number; y: number };
    haulerUtility?: HaulerUtilityId;
    scoutUtility?: ScoutUtilityId;
  }): void {
    const wasDowned = this.ship.downedUntil !== null;
    if (data.downedUntil !== undefined) {
      this.ship.downedUntil = data.downedUntil;
    }
    if (data.rescue !== undefined) {
      this.ship.rescue = data.rescue;
    }
    if (data.crewSignal !== undefined) {
      this.ship.crewSignal = data.crewSignal;
    }
    if (
      wasDowned ||
      (this.ship.downedUntil != null &&
        this.ship.downedUntil !== 0 &&
        !Number.isNaN(this.ship.downedUntil))
    ) {
      this.ship.exploding = false;
    }
    const wasInTransit = this.ship.furnaceTransit !== null;
    if (data.furnaceTransit !== undefined) {
      if (data.furnaceTransit) {
        this.ship.releaseContourLock();
      }
      this.ship.furnaceTransit = data.furnaceTransit;
    }
    // Local selection is established at join. Preserve it during runtime reconciliation.
    if (data.kitId && data.kitId !== this.ship.kitId && this.type !== 'local') {
      applyShipKitToShip(this.ship, data.kitId);
    }
    if (data.equipment !== undefined) {
      this.ship.equipment = [...data.equipment];
      if (!canEquipUtility(this.ship, this.ship.haulerUtility)) {
        this.ship.haulerUtility = DEFAULT_HAULER_UTILITY;
      }
      if (!canEquipUtility(this.ship, this.ship.scoutUtility)) {
        this.ship.scoutUtility = DEFAULT_SCOUT_UTILITY;
      }
    }
    if (data.silk !== undefined) {
      this.silk = data.silk;
    }
    if (!this.observedAuthoritativePose && data.position && data.health !== undefined) {
      this.observedAuthoritativePose = true;
      if (data.health > 0 && (data.spawnProtectionTimer ?? 0) > 0) {
        this.ship.beginHullAssembly();
      }
    }
    if (data.spawnProtectionTimer !== undefined) {
      this.serverSpawnProtectionTimer = data.spawnProtectionTimer;
    }
    // The local player predicts its own ship for responsiveness: while alive it
    // owns its position/velocity/angle and must NOT snap to the (lagging) server
    // echo. Remote players are always server-driven.
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
    const acceptServerTransform =
      !isLocal || this.adoptServerPosition || wasInTransit || this.ship.furnaceTransit !== null;

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
    }

    applySharedShipExplodingFlag(this.ship, data.exploding);

    if (data.score !== undefined) {
      this.score = data.score;
    }
    if (data.shieldFrames !== undefined) {
      this.ship.shieldFrames = data.shieldFrames;
    }
    if (data.shieldCooldownFrames !== undefined) {
      this.ship.shieldCooldownFrames = data.shieldCooldownFrames;
    }
    if (data.weaponChargeFrames !== undefined) {
      this.ship.weaponChargeFrames = data.weaponChargeFrames;
    }
    if (data.navigationAssistFrames !== undefined) {
      this.ship.navigationAssistFrames = data.navigationAssistFrames;
    }
    if (data.contourDraftFrames !== undefined) {
      this.ship.contourDraftFrames = data.contourDraftFrames;
    }
    if (data.bankedCargo !== undefined) {
      this.bankedCargo = data.bankedCargo;
    }
    if (data.cargo !== undefined) {
      this.cargo = data.cargo;
    }
    if (data.purchases !== undefined) {
      this.purchases = [...data.purchases];
    }
    // Thrusting is client-owned for the local player (keyboard/mouse input).
    // The server echo lacks thrusting when updates omit it, which flickers the flame.
    if (data.thrusting !== undefined && this.type !== 'local') {
      this.ship.thrusting = data.thrusting;
    }
    if (this.type !== 'local') {
      this.ship.contourLock = data.contourLock ? { ...data.contourLock } : null;
    }
    if (data.color !== undefined) {
      this.color =
        this.type === 'local' && !purchasedHullColor(data.color)
          ? getPlayerColor('local')
          : data.color;
    }
    if (data.health !== undefined) {
      {
        const wasDead = this.ship.health <= 0;
        const wasExploding = this.ship.exploding;
        const oldHealth = this.ship.health;
        const serverHealth = data.health;

        // Health, including gradual regeneration, is server-owned. Living
        // ships accept each ordered echo exactly. A partial healing echo must
        // not revive a locally predicted death before the full respawn arrives.
        if (
          !isLocal ||
          wasDowned ||
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

        if (
          this.ship.health <= 0 &&
          oldHealth > 0 &&
          (this.ship.downedUntil == null ||
            this.ship.downedUntil === 0 ||
            Number.isNaN(this.ship.downedUntil))
        ) {
          logger.debug('HEALTH_UPDATE', 'Health reached 0, triggering explosion', {
            playerId: this.id,
            oldHealth,
            newHealth: this.ship.health,
            type: this.type,
          });
          this.ship.explode();
        }

        applySharedShipRespawnCue(this.ship, wasDead || wasExploding, data.spawnProtectionTimer);
        if (
          (wasDead || wasExploding) &&
          this.ship.health > 0 &&
          (data.health === undefined || data.health > 0)
        ) {
          this.ship.beginHullAssembly();

          playRespawn(this.ship.position);
          playLocalHaptic(this.type === 'local', 'pickup');
        }
      }
    }
    if (data.maxHealth !== undefined) {
      this.ship.maxHealth = data.maxHealth;
    }

    if (this.type !== 'local') {
      if (data.abilityCooldownFrames !== undefined) {
        this.ship.abilityCooldownFrames = data.abilityCooldownFrames;
      }
      if (data.abilityActiveFrames !== undefined) {
        this.ship.abilityActiveFrames = data.abilityActiveFrames;
      }
    }
    if (data.utilityFlight !== undefined) {
      this.ship.utilityFlight = data.utilityFlight ? structuredClone(data.utilityFlight) : null;
    }
    applySharedHarpoonLatch(this.ship, {
      ...(data.harpoonTargetId !== undefined ? { harpoonTargetId: data.harpoonTargetId } : {}),
      ...(data.harpoonLatchPos !== undefined ? { harpoonLatchPos: data.harpoonLatchPos } : {}),
    });
    if (data.haulerUtility !== undefined && this.type !== 'local') {
      this.ship.haulerUtility = data.haulerUtility;
    }
    // A local tool choice survives stale snapshots while a remote Scout
    // follows the authoritative utility row.
    if (data.scoutUtility !== undefined && this.type !== 'local') {
      this.ship.scoutUtility = data.scoutUtility;
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

    const outgoingTow =
      this.ship.utilityFlight?.kind === 'tow' && this.ship.utilityFlight.phase === 'outbound';
    const target = this.ship.harpoonTargetId;
    if (outgoingTow && !this.soundedTowOutbound) {
      playHarpoonLaunch(this.ship.position);
    }
    if (target != null && target !== '' && target !== this.soundedHarpoonTarget) {
      playHarpoonLatch(this.ship.harpoonLatchPos ?? this.ship.position);
      recordAsteroidLatch(target);
    } else if (
      (this.soundedHarpoonTarget != null &&
        this.soundedHarpoonTarget !== '' &&
        (target == null || target === '')) ||
      (this.soundedTowOutbound && !outgoingTow && (target == null || target === ''))
    ) {
      playHarpoonRelease(this.ship.position);
    }
    this.soundedTowOutbound = outgoingTow;
    this.soundedHarpoonTarget = target;
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

  // Get current state for network transmission
  getStateForNetwork() {
    this.networkState.position = this.ship.position;
    this.networkState.velocity = this.ship.velocity;
    this.networkState.angle = this.ship.angle;
    this.networkState.thrusting = this.ship.thrusting;
    this.networkState.overlayHold = this.ship.movementLocked;
    return this.networkState;
  }
}
