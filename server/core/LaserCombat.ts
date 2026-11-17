import { randomUUID } from 'node:crypto';
import { inBotSanctuary } from '../../shared/aiShips';
import {
  ASTEROID_INTERACTIONS,
  advanceReflectionEnergy,
  segmentCircleContact,
} from '../../shared/asteroidPhenomena';
import { findNearestAsteroidImpact, reflectVector } from '../../shared/asteroidReflection';
import { pointsForRoidSize } from '../../shared/asteroidScale';
import { isCombatantImmune, laserDamagesShips } from '../../shared/combat';
import { DAMAGE, GAME, LASER, SHIP } from '../../shared/constants/gameplay';
import { isEquipmentId } from '../../shared/equipment';
import { GLOWTOY } from '../../shared/glowtoy';
import { findLaserSurfaceImpact } from '../../shared/laserSurface';
import { LOOT_BLAST } from '../../shared/lootBlast';
import { getShipKit, hullRadiusForKit } from '../../shared/shipKits';
import { SURVEY_PROBE } from '../../shared/surveyProbe';
import { WORLD } from '../../shared/world';
import type {
  AsteroidData,
  BotRole,
  PlayerProjectileState,
  PlayerShotFired,
  Position,
  Velocity,
} from '../../shared-types';
import { crawlerEvidence, FixtureCombatRecorder } from '../testing/FixtureCombatRecorder';
import type { GameEntity } from './EntityManager';
import type { AppliedAsteroidHit, LaserCombatInputs } from './types';

export interface ServerLaser {
  attackerRole?: BotRole;
  id: string;
  ownerId: string;
  miningDamage: number;
  charged?: boolean;
  position: Position;
  prevPosition: Position;
  velocity: Velocity;
  distTraveled: number;
  hasExploded: boolean;
  energy: number;
  bounces: number;
  age: number;
  lastAsteroidId?: string;
}

type LaserAuxiliaryTarget = {
  id: string;
  position: Position;
  radius: number;
} & (
  | { kind: 'surveyProbe'; hostId: string; ownerId: string }
  | { kind: 'ship' | 'satellitePickup' | 'loot' | 'encounter'; ownerId?: string }
);

/** 250 ms covers a delayed position packet at 30 Hz plus a brief browser/network hitch. */
export const PLAYER_SHOOT_POSE_ALLOWANCE_MS = 250;
/** Bounded positional rounding/muzzle disagreement in addition to the movement allowance. */
const PLAYER_SHOOT_MUZZLE_SLOP = 8;
/** Stationary/counter-thrust shots must not remain in the authoritative list forever. */
export const PLAYER_LASER_MAX_LIFETIME_MS = Math.ceil(5000 / GAME.MOTION_SCALE);

/** Authoritative shot admission, flight, contacts and delivery state. */
export class LaserCombat {
  private lasers: ServerLaser[] = [];
  private laserSeq = 0;
  private readonly laserNonce = randomUUID();
  private pendingLootBlasts: Array<{
    lootId: string;
    position: Position;
    radius: number;
    shooterId: string;
  }> = [];
  private pendingShotSounds: Array<{ laser: ServerLaser; position: Position }> = [];
  private readonly shootBudgets = new WeakMap<GameEntity, { tokens: number; at: number }>();
  private readonly laserExpiry = new WeakMap<ServerLaser, number>();
  private fixtureCombat: FixtureCombatRecorder | undefined;

  constructor(private readonly inputs: LaserCombatInputs) {}

  public observeFixtureShots(nodeEnv: string, owners: readonly string[]): void {
    if (!['test', 'development'].includes(nodeEnv)) {
      throw new Error('Combat fixture evidence is unavailable in production');
    }
    this.fixtureCombat = new FixtureCombatRecorder();
    this.fixtureCombat.start(owners);
  }

  public getFixtureCombatEvidence() {
    return this.fixtureCombat?.read() ?? { events: [], dropped: 0 };
  }

  private observeFixtureAdmission(
    ownerId: string,
    requestId: string | undefined,
    start: Position,
    velocity: Velocity,
    projectileId: string | null,
    rejectionReason: string | null
  ): void {
    if (this.fixtureCombat?.watches(ownerId) !== true) {
      return;
    }
    const shooter = this.inputs.actors.getEntity(ownerId);
    this.fixtureCombat.record(ownerId, this.inputs.frame(), {
      kind: 'admission',
      requestId: requestId ?? null,
      projectileId,
      rejectionReason,
      start,
      velocity,
      shooter: shooter
        ? {
            position: shooter.position,
            velocity: shooter.velocity,
            health: shooter.health,
            exploding: shooter.exploding,
            motionEpoch: shooter.playerMotion?.epoch,
            furnaceTransit: shooter.furnaceTransit,
          }
        : null,
    });
  }

  private observeFixtureTerminal(
    laser: ServerLaser,
    reason: string,
    targetId: string | null = null,
    targetBefore: unknown = null,
    targetAfter: unknown = null
  ): void {
    this.fixtureCombat?.record(laser.ownerId, this.inputs.frame(), {
      kind: 'terminal',
      projectileId: laser.id,
      reason,
      targetId,
      position: laser.position,
      targetBefore,
      targetAfter,
    });
  }

  public projectiles(): PlayerProjectileState[] {
    return this.lasers
      .filter((laser) => !laser.hasExploded)
      .map((laser) => ({
        id: laser.id,
        ownerId: laser.ownerId,

        position: { ...laser.position },
        prevPosition: { ...laser.prevPosition },
        velocity: { ...laser.velocity },
        energy: laser.energy,
        bounces: laser.bounces,
        age: laser.age,
      }));
  }

  public drainShotSounds(): PlayerShotFired[] {
    return this.pendingShotSounds.splice(0).map(({ laser, position }) => ({
      id: laser.id,
      ownerId: laser.ownerId,
      position,
      ...(laser.charged ? { charged: true } : {}),
    }));
  }

  public drainLootBlasts() {
    return this.pendingLootBlasts.splice(0);
  }

  /**
   * Untrusted player wire entry point. Tests use spawn for server-authored shots.
   * Aim remains client-predicted, but ownership alone is not proof of a valid muzzle.
   */
  public spawnPlayer(
    ownerId: string,
    start: Position,
    velocity: Velocity,
    now = this.inputs.now(),
    requestId?: string
  ): ServerLaser | null {
    const shooter = this.inputs.actors.getEntity(ownerId);
    if (
      !shooter ||
      this.inputs.charged.isCharging(shooter) ||
      shooter.furnaceTransit ||
      shooter.health <= 0 ||
      shooter.exploding ||
      shooter.respawnTimer !== undefined ||
      !Number.isFinite(now) ||
      !Number.isFinite(start?.x) ||
      !Number.isFinite(start?.y) ||
      !Number.isFinite(velocity?.x) ||
      !Number.isFinite(velocity?.y) ||
      !Number.isFinite(shooter.position.x) ||
      !Number.isFinite(shooter.position.y) ||
      !Number.isFinite(shooter.velocity.x) ||
      !Number.isFinite(shooter.velocity.y)
    ) {
      this.observeFixtureAdmission(
        ownerId,
        requestId,
        start,
        velocity,
        null,
        'invalid-pilot-or-request'
      );
      return null;
    }
    const kit = getShipKit(shooter.kitId);
    // Pose velocity is sampled before the client's final movement step. Use
    // that same current sample so a fast shot is not rejected after leaving a contour.
    const maxShipSpeed = Math.max(
      this.inputs.motion.legalSpeed(shooter, now),
      this.inputs.motion.legalSpeed(shooter, now, shooter.contourLock !== null, {
        x: shooter.position.x - shooter.velocity.x,
        y: shooter.position.y - shooter.velocity.y,
      })
    );
    const maxLaserSpeed = maxShipSpeed + LASER.SPEED / GAME.FPS;
    const muzzleRadius = (4 / 3) * hullRadiusForKit(shooter.kitId);
    const maxOriginDistance =
      muzzleRadius +
      PLAYER_SHOOT_MUZZLE_SLOP +
      maxShipSpeed * GAME.FPS * (PLAYER_SHOOT_POSE_ALLOWANCE_MS / 1000);
    if (
      Math.hypot(start.x - shooter.position.x, start.y - shooter.position.y) > maxOriginDistance ||
      // Match pose validation tolerance for floating-point mass-scaled caps.
      Math.hypot(velocity.x, velocity.y) > maxLaserSpeed + 1e-6 ||
      Math.hypot(shooter.velocity.x, shooter.velocity.y) > maxShipSpeed + 1e-6
    ) {
      this.observeFixtureAdmission(
        ownerId,
        requestId,
        start,
        velocity,
        null,
        'origin-or-speed-outside-budget'
      );
      return null;
    }
    // Sustained fire follows the kit cooldown.
    const previous = this.shootBudgets.get(shooter);
    const rate = 1 / kit.shotCooldown;
    const available = previous
      ? Math.min(SHIP.MAX_LASERS, previous.tokens + Math.max(0, now - previous.at) * rate)
      : SHIP.MAX_LASERS;
    if (available < 1) {
      this.observeFixtureAdmission(
        ownerId,
        requestId,
        start,
        velocity,
        null,
        'shoot-budget-exhausted'
      );
      return null;
    }
    const laser = this.spawn(ownerId, start, velocity);
    if (!laser) {
      this.observeFixtureAdmission(
        ownerId,
        requestId,
        start,
        velocity,
        null,
        'invalid-world-launch'
      );
      return null;
    }
    this.shootBudgets.set(shooter, { tokens: available - 1, at: now });
    this.laserExpiry.set(laser, now + PLAYER_LASER_MAX_LIFETIME_MS);
    this.observeFixtureAdmission(ownerId, requestId, start, velocity, laser.id, null);
    return laser;
  }

  /** Spawn a simulated shot for a player `shoot` or a server-authored test. */
  public spawn(ownerId: string, start: Position, velocity: Velocity): ServerLaser | null {
    const position = this.validatePosition(start);
    const vx = typeof velocity?.x === 'number' && Number.isFinite(velocity.x) ? velocity.x : NaN;
    const vy = typeof velocity?.y === 'number' && Number.isFinite(velocity.y) ? velocity.y : NaN;
    if (
      !position ||
      Math.hypot(position.x, position.y) > WORLD.radius ||
      !Number.isFinite(vx) ||
      !Number.isFinite(vy)
    ) {
      return null;
    }

    this.laserSeq += 1;
    const attackerRole = this.inputs.actors.getEntity(ownerId)?.botRole;
    const laser: ServerLaser = {
      id: `server-laser-${this.laserNonce}-${ownerId}-${this.laserSeq}`,
      ownerId,
      ...(attackerRole ? { attackerRole } : {}),
      miningDamage: this.inputs.mining.damageFor(ownerId),
      position: { x: position.x, y: position.y },
      prevPosition: { x: position.x, y: position.y },
      velocity: { x: vx, y: vy },
      distTraveled: 0,
      hasExploded: false,
      energy: 1,
      bounces: 0,
      age: 0,
    };
    this.lasers.push(laser);
    // Match bounded event queues; ability rings get their own single activation cue.
    if (this.pendingShotSounds.length >= 256) {
      this.pendingShotSounds.shift();
    }
    this.pendingShotSounds.push({ laser, position: { ...position } });
    return laser;
  }

  public shots(): readonly ServerLaser[] {
    return this.lasers;
  }

  /** Move live lasers and apply at most one break per asteroid / laser. */
  public advance(now = this.inputs.now()): AppliedAsteroidHit[] {
    const hits: AppliedAsteroidHit[] = [];
    if (this.lasers.length === 0) {
      return hits;
    }
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const laser = this.lasers[i];
      if (laser === undefined) {
        continue;
      }
      if (laser.hasExploded || now >= (this.laserExpiry.get(laser) ?? Infinity)) {
        this.observeFixtureTerminal(laser, laser.hasExploded ? 'already-exploded' : 'lifetime');
        this.lasers.splice(i, 1);
        continue;
      }

      laser.age++;
      if (laser.age > ASTEROID_INTERACTIONS.maxLaserFrames) {
        this.observeFixtureTerminal(laser, 'age-limit');
        this.lasers.splice(i, 1);
        continue;
      }
      laser.prevPosition = { x: laser.position.x, y: laser.position.y };
      laser.position = {
        x: laser.position.x + laser.velocity.x,
        y: laser.position.y + laser.velocity.y,
      };
      laser.distTraveled += Math.hypot(laser.velocity.x, laser.velocity.y);

      if (laser.distTraveled >= LASER.MAX_TRAVEL_DISTANCE) {
        this.observeFixtureTerminal(laser, 'distance-limit');
        this.lasers.splice(i, 1);
        continue;
      }

      // Powered cargo ignores ordinary laser traffic; fragments join the shared
      // index as they split, before the next shot resolves.
      const hit = this.resolveEnhancedLaser(laser, (rock) => rock.boost?.phase !== 'burning');
      if (hit) {
        hits.push(hit);
      }
      if (laser.hasExploded) {
        this.lasers.splice(i, 1);
      }
    }

    return hits;
  }

  /** Resolve only the new muzzle overlap, never replay an older shot's swept
   * path. After a reflection, its start/end chord is not its traveled path. */
  public resolveSpawned(laserId: string): AppliedAsteroidHit[] {
    const index = this.lasers.findIndex((candidateLaser) => candidateLaser.id === laserId);
    const laser = this.lasers[index];
    if (!laser || laser.hasExploded || laser.age !== 0) {
      return [];
    }
    const hit = this.resolveEnhancedLaser(laser);
    if (laser.hasExploded) {
      this.lasers.splice(index, 1);
    }
    return hit ? [hit] : [];
  }

  private laserSegmentTargets(
    target: LaserAuxiliaryTarget,
    segmentStart: Position,
    segmentEnd: Position,
    segmentDistance: number
  ) {
    const fraction = segmentCircleContact(segmentStart, segmentEnd, target.position, target.radius);
    return fraction === undefined ? [] : [{ ...target, distance: fraction * segmentDistance }];
  }

  /** Resolve mining shots against nearby world objects; unbounced shots ignore hulls. */
  private resolveEnhancedLaser(
    laser: ServerLaser,
    include: (rock: AsteroidData) => boolean = () => true
  ): AppliedAsteroidHit | null {
    const index = this.inputs.rocks.spatialIndex();
    let start = { ...laser.prevPosition };
    let end = { ...laser.position };
    const cargo = new Set(
      this.inputs.actors.getAllEntities().map((actor) => actor.harpoonTargetId)
    );
    for (let work = 0; work <= ASTEROID_INTERACTIONS.maxBounces; work++) {
      const nearbyRocks = index
        .query({
          minX: Math.min(start.x, end.x) - SURVEY_PROBE.RADIUS * 2,
          minY: Math.min(start.y, end.y) - SURVEY_PROBE.RADIUS * 2,
          maxX: Math.max(start.x, end.x) + SURVEY_PROBE.RADIUS * 2,
          maxY: Math.max(start.y, end.y) + SURVEY_PROBE.RADIUS * 2,
        })
        .filter(include);
      const rocks = nearbyRocks.filter((nearbyRock) => !cargo.has(nearbyRock.id));
      const impact = findNearestAsteroidImpact(start, end, rocks, laser.lastAsteroidId);
      const surface = findLaserSurfaceImpact(start, end);
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      const owner = this.inputs.actors.getEntity(laser.ownerId);
      const hulls = this.inputs.actors
        .getAllEntities()
        .filter(
          (entity) =>
            !isCombatantImmune(entity) &&
            laserDamagesShips(laser.bounces, laser.attackerRole, entity.botRole) &&
            !(laser.attackerRole === 'raider' && inBotSanctuary(entity.position))
        )
        .map((entity) => ({
          id: entity.id,
          position: entity.position,
          radius: hullRadiusForKit(entity.kitId) + LASER.HIT_RADIUS,
          kind: 'ship' as const,
        }));
      const probeTargets: LaserAuxiliaryTarget[] = this.inputs.probes
        .targetsIn([...nearbyRocks, ...this.inputs.terrain.getBodies()])
        .map((target) => ({ ...target, kind: 'surveyProbe' as const }));
      const auxiliaryTargets: LaserAuxiliaryTarget[] = [
        ...this.inputs.hives
          .targetsNear(start, distance)
          .map((target) => ({ ...target, kind: 'encounter' as const })),
        ...probeTargets,
        ...this.inputs.pickups
          .getAllPickups()
          .filter(
            (pickup) =>
              pickup.state === 'orbiting' && pickup.health > 0 && laserDamagesShips(laser.bounces)
          )
          .map((pickup) => ({
            id: pickup.id,
            position: pickup.position,
            radius: pickup.radius,
            ...(pickup.ownerId === null ? {} : { ownerId: pickup.ownerId }),
            kind: 'satellitePickup' as const,
          })),
        // The arm-range circle query is exact; handleLootExplode re-checks before any blast.
        ...(owner ? this.inputs.loot.queryCircle(owner.position, LOOT_BLAST.ARM_RANGE) : [])
          .filter((loot) => loot.kind !== 'points' && !isEquipmentId(loot.kind))
          .map((loot) => ({
            id: loot.id,
            position: loot.position,
            radius: loot.radius,
            kind: 'loot' as const,
          })),
        ...hulls,
      ];
      const auxiliaryHits: Array<LaserAuxiliaryTarget & { distance: number }> = [];
      for (const target of auxiliaryTargets) {
        auxiliaryHits.push(...this.laserSegmentTargets(target, start, end, distance));
      }
      const auxiliary = auxiliaryHits.sort(
        (a, b) => a.distance - b.distance || a.id.localeCompare(b.id)
      )[0];
      const terrainHit = this.inputs.terrain.findLaserHit(start, end);
      const crawlerHit = this.inputs.crawlers.findLaserHit(start, end);
      const spiderHit =
        crawlerHit && (!terrainHit || crawlerHit.distance < terrainHit.distance)
          ? crawlerHit
          : terrainHit;
      this.fixtureCombat?.record(laser.ownerId, this.inputs.frame(), {
        kind: 'segment',
        projectileId: laser.id,
        start,
        end,
        candidates: {
          asteroid: impact,
          surface,
          auxiliary,
          terrainSpider: terrainHit,
          crawler: crawlerHit,
          crawlerBody: crawlerEvidence(
            crawlerHit ? this.inputs.crawlers.getBody(crawlerHit.spiderId) : undefined
          ),
        },
      });
      if (
        auxiliary &&
        (!spiderHit || auxiliary.distance <= spiderHit.distance) &&
        (!impact ||
          auxiliary.distance < impact.distance ||
          (auxiliary.distance === impact.distance && auxiliary.kind === 'surveyProbe')) &&
        (!surface || auxiliary.distance < surface.distance)
      ) {
        laser.hasExploded = true;
        const targetBefore =
          this.fixtureCombat?.watches(laser.ownerId) === true && auxiliary.kind === 'ship'
            ? { health: this.inputs.actors.getEntity(auxiliary.id)?.health ?? null }
            : null;
        if (auxiliary.kind === 'encounter') {
          if (owner) {
            this.inputs.hives.hit(
              auxiliary.id,
              owner,
              DAMAGE.LASER_HIT * laser.energy,
              this.inputs.now()
            );
          }
        } else if (auxiliary.kind === 'satellitePickup') {
          this.inputs.pickups.damage(auxiliary.id, DAMAGE.LASER_HIT * laser.energy);
        } else if (auxiliary.kind === 'loot') {
          const blast = this.inputs.explodeLoot(laser.ownerId, auxiliary.id);
          if (blast.success && blast.origin) {
            this.pendingLootBlasts.push({
              lootId: auxiliary.id,
              position: { ...blast.origin },
              radius: LOOT_BLAST.RADIUS,
              shooterId: laser.ownerId,
            });
          }
        } else if (auxiliary.kind === 'surveyProbe') {
          this.inputs.probes.damage(auxiliary.hostId, DAMAGE.LASER_HIT * laser.energy);
        } else {
          const cause =
            laser.bounces > 0
              ? 'ricochet'
              : laser.attackerRole === 'raider'
                ? 'raider'
                : 'crew-fire';
          const result = this.inputs.combat.directedHit(
            auxiliary.id,
            cause,
            DAMAGE.LASER_HIT * laser.energy
          );
          if (result) {
            this.inputs.combat.emit(result);
          }
        }
        this.observeFixtureTerminal(
          laser,
          auxiliary.kind,
          auxiliary.id,
          targetBefore,
          this.fixtureCombat?.watches(laser.ownerId) === true && auxiliary.kind === 'ship'
            ? { health: this.inputs.actors.getEntity(auxiliary.id)?.health ?? null }
            : null
        );
        return null;
      }
      if (
        spiderHit &&
        (!auxiliary || spiderHit.distance < auxiliary.distance) &&
        (!impact || spiderHit.distance < impact.distance) &&
        (!surface || spiderHit.distance < surface.distance)
      ) {
        const predators = spiderHit === crawlerHit ? this.inputs.crawlers : this.inputs.terrain;
        const before =
          this.fixtureCombat?.watches(laser.ownerId) === true
            ? crawlerEvidence(predators.getBody(spiderHit.spiderId))
            : null;
        predators.resolveLaserHit(start, end, DAMAGE.LASER_HIT * laser.energy);
        laser.hasExploded = true;
        this.observeFixtureTerminal(
          laser,
          spiderHit === crawlerHit ? 'belt-crawler' : 'terrain-spider',
          spiderHit.spiderId,
          before,
          this.fixtureCombat?.watches(laser.ownerId) === true
            ? crawlerEvidence(predators.getBody(spiderHit.spiderId))
            : null
        );
        return null;
      }
      if (surface && (!impact || surface.distance <= impact.distance)) {
        if (laser.bounces >= ASTEROID_INTERACTIONS.maxBounces) {
          laser.hasExploded = true;
          this.observeFixtureTerminal(laser, 'bounce-limit');
          return null;
        }
        laser.velocity = reflectVector(laser.velocity, surface.normal);
        laser.bounces++;
        delete laser.lastAsteroidId;
        const speed = Math.hypot(laser.velocity.x, laser.velocity.y);
        const remaining = Math.max(0, distance - surface.distance);
        start = {
          x: surface.point.x - surface.normal.x * 1e-5,
          y: surface.point.y - surface.normal.y * 1e-5,
        };
        end = {
          x: start.x + (laser.velocity.x / speed) * remaining,
          y: start.y + (laser.velocity.y / speed) * remaining,
        };
        laser.prevPosition = { ...start };
        continue;
      }
      if (!impact) {
        laser.position = end;
        return null;
      }
      const rock = this.inputs.rocks.getAsteroid(impact.asteroidId);
      if (!rock) {
        return null;
      }
      laser.position = { ...impact.point };
      if (rock.glowtoy) {
        rock.glowtoy.charge = Math.min(1, rock.glowtoy.charge + laser.energy * GLOWTOY.laserCharge);
        laser.hasExploded = true;
        this.observeFixtureTerminal(laser, 'glowtoy', rock.id);
        return null;
      }
      if (rock.phenomenon?.kind === 'reflective') {
        this.inputs.rocks.recordMiningHit(rock.id, laser.ownerId);
        const charge = advanceReflectionEnergy(
          rock.phenomenon.energy,
          rock.phenomenon.maxEnergy,
          laser.energy,
          laser.bounces
        );
        rock.phenomenon.energy = charge.asteroidEnergy;
        if (!charge.reflects) {
          const result = this.inputs.mining.hit(rock.id, laser.ownerId, 'collision');
          laser.hasExploded = true;
          this.observeFixtureTerminal(laser, 'reflective-asteroid', rock.id);
          return {
            applied: result.outcome === 'destroyed',
            outcome: result.outcome,
            asteroidId: rock.id,
            playerId: laser.ownerId,
            points: pointsForRoidSize(rock.size),
            newAsteroids: result.newAsteroids,
            origin: { ...rock.position },
          };
        }
        laser.velocity = reflectVector(laser.velocity, impact.normal);
        laser.energy = charge.laserEnergy;
        laser.bounces++;
        laser.lastAsteroidId = rock.id;
        const speed = Math.hypot(laser.velocity.x, laser.velocity.y);
        if (speed <= 1e-9) {
          laser.hasExploded = true;
          this.observeFixtureTerminal(laser, 'zero-reflected-speed', rock.id);
          return null;
        }
        const remaining = Math.max(0, distance - impact.distance);
        const direction = { x: laser.velocity.x / speed, y: laser.velocity.y / speed };
        start = { x: impact.point.x + direction.x * 1e-5, y: impact.point.y + direction.y * 1e-5 };
        end = { x: start.x + direction.x * remaining, y: start.y + direction.y * remaining };
        continue;
      }
      laser.hasExploded = true;
      const healthBefore = rock.health;
      // Energized ricochets double one physical shot's metal chip; each logical shot
      // is still consumed once and terminal drops/score happen only once.
      let hit = this.inputs.mining.apply(rock.id, laser.ownerId, 'laser', laser.miningDamage);
      if (
        laser.charged !== true &&
        laser.energy >= 2 &&
        rock.material === 'metal' &&
        this.inputs.rocks.getAsteroid(rock.id)
      ) {
        hit = this.inputs.mining.apply(rock.id, laser.ownerId, 'laser', laser.miningDamage);
      }
      if (this.fixtureCombat?.watches(laser.ownerId) === true) {
        this.observeFixtureTerminal(
          laser,
          'asteroid',
          rock.id,
          { health: healthBefore },
          { health: this.inputs.rocks.getAsteroid(rock.id)?.health ?? null, outcome: hit.outcome }
        );
      }
      return hit.applied ? hit : null;
    }
    laser.hasExploded = true;
    this.observeFixtureTerminal(laser, 'segment-budget');
    return null;
  }

  private validatePosition(position: Position): Position | null {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      return null;
    }
    return { x: position.x, y: position.y };
  }

  public clearShots(): void {
    this.lasers = [];
  }
  public clearLootBlasts(): void {
    this.pendingLootBlasts = [];
  }
  public clearShotSounds(): void {
    this.pendingShotSounds = [];
  }
  public clearFixtureEvidence(): void {
    this.fixtureCombat = undefined;
  }
}
