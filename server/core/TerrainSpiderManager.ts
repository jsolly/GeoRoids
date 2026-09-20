import { segmentCircleContact } from '../../shared/asteroidPhenomena';
import { FURNACES } from '../../shared/furnaces';
import { shipOverlapsCompletedSector } from '../../shared/sectors';
import { SPIDER } from '../../shared/terrainSpider';
import { WORLD } from '../../shared/world';
import type { Position, SpiderFieldState, TerrainSpider } from '../../shared-types';
import { sampleGradient } from '../../src/physics/terrain/heightfield';
import { getTerrainField } from '../../src/physics/terrain/terrainSession';
import type { SpiderResource } from './spiderResources';

interface SpiderActor {
  id: string;
  position: Position;
  health: number;
  exploding: boolean;
  respawnTimer?: number;
  spawnProtectionTimer?: number;
  radius?: number;
}

interface SpiderAdvanceOptions {
  players: readonly SpiderActor[];
  completedSectors: ReadonlySet<string>;
  nowFrame: number;
  resources?: () => readonly SpiderResource[];
}

export interface SpiderAttack {
  spiderId: string;
  targetId: string;
  attackerId: 'spider';
}

interface SpiderBodyHit {
  kind: 'spider';
  spiderId: string;
  distance: number;
  point: Position;
}

type Territory =
  | { kind: 'roaming' }
  | {
      kind: 'guard';
      nestId: string;
      home: Position;
      activity: 'patrolling' | 'returning';
      chaseUntil: number;
    };

interface RuntimeSpider extends TerrainSpider {
  biteReadyAt: number;
  territory: Territory;
}

interface SpiderNest {
  home: Position;
  guards: RuntimeSpider[];
}

function nestCell(position: Position): { id: string; center: Position } {
  const x = Math.floor(position.x / SPIDER.NEST_SPACING);
  const y = Math.floor(position.y / SPIDER.NEST_SPACING);
  return {
    id: `${x},${y}`,
    center: { x: (x + 0.5) * SPIDER.NEST_SPACING, y: (y + 0.5) * SPIDER.NEST_SPACING },
  };
}

const SPAWN_ATTEMPTS = 32;
const POSITION_EPSILON = 1e-6;

function copyPosition(position: Position): Position {
  return { x: position.x, y: position.y };
}

function copySpider(spider: TerrainSpider): TerrainSpider {
  return {
    id: spider.id,
    position: copyPosition(spider.position),
    angle: spider.angle,
    health: spider.health,
    maxHealth: spider.maxHealth,
    phase: spider.phase,
    targetId: spider.targetId,
  };
}

function distanceBetween(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  const wrapped = angle % fullTurn;
  return wrapped < 0 ? wrapped + fullTurn : wrapped;
}

function signedAngleDifference(target: number, current: number): number {
  const fullTurn = Math.PI * 2;
  let difference = (target - current) % fullTurn;
  if (difference > Math.PI) {
    difference -= fullTurn;
  } else if (difference < -Math.PI) {
    difference += fullTurn;
  }
  return difference;
}

function liveActor(actor: SpiderActor): boolean {
  return (
    Number.isFinite(actor.position.x) &&
    Number.isFinite(actor.position.y) &&
    actor.health > 0 &&
    !actor.exploding &&
    actor.respawnTimer === undefined
  );
}

/** Server-owned terrain predators and swept laser interactions. */
export class TerrainSpiderManager {
  private readonly spiders = new Map<string, RuntimeSpider>();
  private spiderSequence = 0;
  private nextSpawnFrame: number | null = null;
  private nextNestFrame = 0;
  private nowFrame = 0;
  private readonly nests = new Map<string, SpiderNest>();
  private spawnTargetIndex = 0;
  private completedSectors: ReadonlySet<string> = new Set();

  public constructor(private readonly random: () => number = Math.random) {}

  public snapshot(): SpiderFieldState {
    return {
      spiders: [...this.spiders.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copySpider),
    };
  }

  public isAttackActive(attack: SpiderAttack): boolean {
    const spider = this.spiders.get(attack.spiderId);
    return spider?.phase === 'hunting' && spider.targetId === attack.targetId;
  }

  /** Pause population without forgetting cleared or wounded territories. */
  public suspend(): void {
    this.removeDistantBodies([]);
    this.nextSpawnFrame = null;
    this.nextNestFrame = 0;
  }

  public clear(): void {
    this.spiders.clear();
    this.nextSpawnFrame = null;
    this.nextNestFrame = 0;
    this.nests.clear();
    this.spawnTargetIndex = 0;
  }

  /** Deterministic arrangement hook used by server scenarios and diagnostics. */
  public spawnSpider(position: Position, angle = 0): TerrainSpider | null {
    if (
      this.spiders.size >= SPIDER.MAX_ACTIVE ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(angle) ||
      Math.hypot(position.x, position.y) > WORLD.radius - SPIDER.WORLD_INSET
    ) {
      return null;
    }
    const spider: RuntimeSpider = {
      id: `spider-${++this.spiderSequence}`,
      position: copyPosition(position),
      angle: normalizeAngle(angle),
      health: SPIDER.MAX_HEALTH,
      maxHealth: SPIDER.MAX_HEALTH,
      phase: 'scuttling',
      targetId: null,
      biteReadyAt: 0,
      territory: { kind: 'roaming' },
    };
    this.spiders.set(spider.id, spider);
    return copySpider(spider);
  }

  /** Remove a spider and invalidate its pending attacks. */
  public removeSpider(spiderId: string): boolean {
    const spider = this.spiders.get(spiderId);
    if (spider?.territory.kind === 'guard') {
      const nest = this.nests.get(spider.territory.nestId);
      if (nest) {
        nest.guards = nest.guards.filter((guard) => guard.id !== spiderId);
      }
    }
    return this.spiders.delete(spiderId);
  }

  /**
   * Advance the predator state and return bite intents. Damage is deliberately
   * applied by GameEngine so protection, death, regen, and combat broadcasts
   * continue through the one authoritative ship damage path.
   */
  public advance(options: SpiderAdvanceOptions): SpiderAttack[] {
    this.completedSectors = options.completedSectors;
    const nowFrame = Number.isFinite(options.nowFrame) ? options.nowFrame : 0;
    this.nowFrame = nowFrame;
    const players = options.players
      .filter(liveActor)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const playerById = new Map(players.map((player) => [player.id, player]));

    this.removeBlockedBodies(options.completedSectors);
    this.removeDistantBodies(players);
    if (players.length > 0 && nowFrame >= this.nextNestFrame) {
      this.updateNests(options.resources?.() ?? [], players, options.completedSectors);
      this.nextNestFrame = nowFrame + 60;
    }
    if (this.nextSpawnFrame === null) {
      this.scheduleRoamer(nowFrame);
    }

    const attacks: SpiderAttack[] = [];
    for (const spider of [...this.spiders.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      this.advanceSpider(spider, players, playerById, options.completedSectors, nowFrame, attacks);
    }

    // A nest encounter also buys a full quiet interval before another ambush.
    if ([...this.spiders.values()].some((spider) => spider.phase === 'hunting')) {
      this.nextSpawnFrame = Math.max(
        this.nextSpawnFrame ?? 0,
        nowFrame + SPIDER.SPAWN_INTERVAL_FRAMES
      );
    }
    if (players.length > 0 && nowFrame >= (this.nextSpawnFrame ?? 0)) {
      const roamers = [...this.spiders.values()].filter(
        (spider) => spider.territory.kind === 'roaming'
      );
      if (roamers.length < SPIDER.MAX_ROAMERS && this.spiders.size < SPIDER.MAX_ACTIVE) {
        this.spawnNearPlayers(players, options.completedSectors);
      }
      // Failed attempts consume the interval too; never retry spawning every frame.
      this.scheduleRoamer(nowFrame);
    }
    return attacks;
  }

  /** Find the first spider body crossed by a swept laser segment. */
  public findLaserHit(start: Position, end: Position): SpiderBodyHit | null {
    const candidates: SpiderBodyHit[] = [];
    for (const spider of this.spiders.values()) {
      const fraction = segmentCircleContact(start, end, spider.position, SPIDER.HIT_RADIUS);
      if (fraction === undefined) {
        continue;
      }
      candidates.push({
        kind: 'spider',
        spiderId: spider.id,
        distance: fraction * Math.hypot(end.x - start.x, end.y - start.y),
        point: {
          x: start.x + (end.x - start.x) * fraction,
          y: start.y + (end.y - start.y) * fraction,
        },
      });
    }
    return (
      candidates.sort(
        (a, b) => a.distance - b.distance || a.spiderId.localeCompare(b.spiderId)
      )[0] ?? null
    );
  }

  /** Apply damage only after this body wins the ordinary swept hit ordering. */
  public resolveLaserHit(start: Position, end: Position, damage: number): SpiderBodyHit | null {
    const hit = this.findLaserHit(start, end);
    if (!hit) {
      return null;
    }
    const spider = this.spiders.get(hit.spiderId);
    if (spider) {
      this.nextSpawnFrame = Math.max(
        this.nextSpawnFrame ?? 0,
        this.nowFrame + SPIDER.SPAWN_INTERVAL_FRAMES
      );
      spider.health = Math.max(0, spider.health - damage);
      if (spider.health === 0) {
        this.removeSpider(spider.id);
      }
    }
    return hit;
  }

  private removeBlockedBodies(completedSectors: ReadonlySet<string>): void {
    for (const spider of [...this.spiders.values()]) {
      if (
        !this.canOccupy(spider.position, SPIDER.HIT_RADIUS, completedSectors) ||
        (spider.territory.kind === 'guard' &&
          !this.canOccupy(spider.territory.home, SPIDER.HIT_RADIUS, completedSectors))
      ) {
        this.removeSpider(spider.id);
      }
    }
  }

  private removeDistantBodies(players: readonly SpiderActor[]): void {
    for (const spider of [...this.spiders.values()]) {
      const origin = spider.territory.kind === 'guard' ? spider.territory.home : spider.position;
      const nearest = players.reduce(
        (distance, player) => Math.min(distance, distanceBetween(origin, player.position)),
        Number.POSITIVE_INFINITY
      );
      const limit =
        spider.territory.kind === 'guard' ? SPIDER.NEST_WAKE_DISTANCE : SPIDER.DESPAWN_DISTANCE;
      if (nearest > limit) {
        // Sleeping guards retain their health and identity. Death uses removeSpider.
        this.spiders.delete(spider.id);
        spider.targetId = null;
        spider.phase = 'scuttling';
        if (spider.territory.kind === 'guard') {
          spider.territory.activity = 'returning';
        }
      }
    }
  }

  private scheduleRoamer(nowFrame: number): void {
    this.nextSpawnFrame =
      nowFrame +
      SPIDER.SPAWN_INTERVAL_FRAMES +
      Math.floor(this.random() * (SPIDER.SPAWN_INTERVAL_MAX_FRAMES - SPIDER.SPAWN_INTERVAL_FRAMES));
  }

  private updateNests(
    resources: readonly SpiderResource[],
    players: readonly SpiderActor[],
    completed: ReadonlySet<string>
  ): void {
    const candidates = new Map<string, SpiderResource>();
    for (const resource of resources) {
      const cell = nestCell(resource.position);
      if (
        this.nests.has(cell.id) ||
        distanceBetween(resource.position, cell.center) > SPIDER.NEST_SITE_RADIUS ||
        !this.canOccupy(
          resource.position,
          SPIDER.NEST_PATROL_RADIUS + SPIDER.HIT_RADIUS,
          completed
        ) ||
        !players.some(
          (player) =>
            distanceBetween(player.position, resource.position) <= SPIDER.NEST_WAKE_DISTANCE
        ) ||
        players.some(
          (player) =>
            distanceBetween(player.position, resource.position) < SPIDER.NEST_SPAWN_SAFE_RADIUS
        )
      ) {
        continue;
      }
      const previous = candidates.get(cell.id);
      if (
        !previous ||
        resource.value > previous.value ||
        (resource.value === previous.value && resource.id.localeCompare(previous.id) < 0)
      ) {
        candidates.set(cell.id, resource);
      }
    }
    for (const [id, resource] of candidates) {
      const count = SPIDER.NEST_GUARDS[resource.value];
      if (this.spiders.size + count > SPIDER.MAX_ACTIVE) {
        continue;
      }
      const home = copyPosition(resource.position);
      const positions = Array.from({ length: count }, (_, index) => {
        const angle = (index * Math.PI * 2) / count;
        return {
          x: home.x + Math.cos(angle) * SPIDER.NEST_PATROL_RADIUS * 0.6,
          y: home.y + Math.sin(angle) * SPIDER.NEST_PATROL_RADIUS * 0.6,
        };
      });
      if (!positions.every((position) => this.canOccupy(position, SPIDER.HIT_RADIUS, completed))) {
        continue;
      }
      const nest: SpiderNest = { home, guards: [] };
      this.nests.set(id, nest);
      for (const position of positions) {
        const spawned = this.spawnSpider(position);
        const guard = spawned ? this.spiders.get(spawned.id) : undefined;
        if (guard) {
          guard.territory = {
            kind: 'guard',
            nestId: id,
            home,
            activity: 'patrolling',
            chaseUntil: 0,
          };
          nest.guards.push(guard);
        }
      }
    }
    // Constant-size neighborhood lookup per pilot, never a scan of the saved world.
    for (const player of players) {
      const x = Math.floor(player.position.x / SPIDER.NEST_SPACING);
      const y = Math.floor(player.position.y / SPIDER.NEST_SPACING);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nest = this.nests.get(`${x + dx},${y + dy}`);
          if (!nest || distanceBetween(nest.home, player.position) > SPIDER.NEST_WAKE_DISTANCE) {
            continue;
          }
          nest.guards = nest.guards.filter(
            (guard) =>
              this.canOccupy(nest.home, SPIDER.HIT_RADIUS, completed) &&
              this.canOccupy(guard.position, SPIDER.HIT_RADIUS, completed)
          );
          for (const guard of nest.guards) {
            if (this.spiders.size >= SPIDER.MAX_ACTIVE) {
              break;
            }
            if (
              !this.spiders.has(guard.id) &&
              players.some(
                (other) =>
                  distanceBetween(other.position, guard.position) < SPIDER.NEST_SPAWN_SAFE_RADIUS
              )
            ) {
              continue;
            }
            this.spiders.set(guard.id, guard);
          }
        }
      }
    }
  }

  private advanceSpider(
    spider: RuntimeSpider,
    players: readonly SpiderActor[],
    playerById: ReadonlyMap<string, SpiderActor>,
    completedSectors: ReadonlySet<string>,
    nowFrame: number,
    attacks: SpiderAttack[]
  ): void {
    const territory = spider.territory;
    if (territory.kind === 'guard') {
      if (
        spider.phase === 'hunting' &&
        (nowFrame >= territory.chaseUntil ||
          distanceBetween(spider.position, territory.home) > SPIDER.NEST_LEASH_DISTANCE)
      ) {
        territory.activity = 'returning';
      }
      if (territory.activity === 'returning') {
        spider.phase = 'scuttling';
        spider.targetId = null;
        this.returnHome(spider, territory, completedSectors);
        return;
      }
    }
    if (spider.phase !== 'hunting') {
      const target = this.findHuntTarget(spider, players);
      if (target) {
        spider.targetId = target.id;
        spider.phase = 'hunting';
        if (territory.kind === 'guard') {
          territory.chaseUntil = nowFrame + SPIDER.NEST_CHASE_FRAMES;
        }
        return;
      }
    }

    if (spider.phase === 'scuttling') {
      if (
        territory.kind === 'guard' &&
        distanceBetween(spider.position, territory.home) >= SPIDER.NEST_PATROL_RADIUS
      ) {
        territory.activity = 'returning';
        this.returnHome(spider, territory, completedSectors);
      } else {
        this.scuttle(spider, completedSectors);
      }
      return;
    }

    const target = spider.targetId ? playerById.get(spider.targetId) : undefined;
    if (
      !target ||
      (territory.kind === 'guard' &&
        distanceBetween(target.position, territory.home) > SPIDER.NEST_LEASH_DISTANCE) ||
      !this.canOccupy(target.position, target.radius ?? 0, completedSectors) ||
      distanceBetween(target.position, spider.position) > SPIDER.HUNT_RELEASE_DISTANCE
    ) {
      spider.targetId = null;
      spider.phase = 'scuttling';
      if (territory.kind === 'guard') {
        territory.activity = 'returning';
      }
      return;
    }

    const dx = target.position.x - spider.position.x;
    const dy = target.position.y - spider.position.y;
    const distance = Math.hypot(dx, dy);
    if (distance > POSITION_EPSILON) {
      spider.angle = normalizeAngle(Math.atan2(dy, dx));
      const stride = Math.min(SPIDER.HUNT_SPEED, Math.max(0, distance - SPIDER.BITE_DISTANCE));
      const next = this.containPosition({
        x: spider.position.x + (dx / distance) * stride,
        y: spider.position.y + (dy / distance) * stride,
      });
      if (!this.canOccupy(next, SPIDER.HIT_RADIUS, completedSectors)) {
        spider.targetId = null;
        spider.phase = 'scuttling';
        return;
      }
      spider.position = next;
    }
    if (
      distanceBetween(spider.position, target.position) <=
        SPIDER.BITE_DISTANCE + POSITION_EPSILON &&
      nowFrame >= spider.biteReadyAt
    ) {
      attacks.push({
        spiderId: spider.id,
        targetId: target.id,
        attackerId: 'spider',
      });
      spider.biteReadyAt = nowFrame + SPIDER.BITE_COOLDOWN_FRAMES;
    }
  }

  private returnHome(
    spider: RuntimeSpider,
    territory: Extract<Territory, { kind: 'guard' }>,
    completed: ReadonlySet<string>
  ): void {
    const distance = distanceBetween(spider.position, territory.home);
    if (distance <= SPIDER.NEST_PATROL_RADIUS * 0.5) {
      territory.activity = 'patrolling';
      return;
    }
    const angle = Math.atan2(
      territory.home.y - spider.position.y,
      territory.home.x - spider.position.x
    );
    const stride = Math.min(SPIDER.SCUTTLE_SPEED, distance);
    const next = {
      x: spider.position.x + Math.cos(angle) * stride,
      y: spider.position.y + Math.sin(angle) * stride,
    };
    if (this.canOccupy(next, SPIDER.HIT_RADIUS, completed)) {
      spider.angle = normalizeAngle(angle);
      spider.position = next;
    }
  }

  private scuttle(spider: RuntimeSpider, completedSectors: ReadonlySet<string>): void {
    const gradient = sampleGradient(getTerrainField(), spider.position.x, spider.position.y);
    const gradientMagnitude = Math.hypot(gradient.x, gradient.y);
    if (gradientMagnitude > 1e-6) {
      const tangent = Math.atan2(gradient.x, -gradient.y);
      const opposite = tangent + Math.PI;
      const tangentTarget =
        Math.abs(signedAngleDifference(tangent, spider.angle)) <=
        Math.abs(signedAngleDifference(opposite, spider.angle))
          ? tangent
          : opposite;
      const turn = signedAngleDifference(tangentTarget, spider.angle);
      spider.angle = normalizeAngle(
        spider.angle + Math.max(-SPIDER.TURN_RATE, Math.min(SPIDER.TURN_RATE, turn))
      );
    }
    spider.angle = normalizeAngle(spider.angle + (this.random() - 0.5) * SPIDER.TURN_RATE * 0.5);
    const next = this.containPosition({
      x: spider.position.x + Math.cos(spider.angle) * SPIDER.SCUTTLE_SPEED,
      y: spider.position.y + Math.sin(spider.angle) * SPIDER.SCUTTLE_SPEED,
    });
    if (!this.canOccupy(next, SPIDER.HIT_RADIUS, completedSectors)) {
      spider.angle = normalizeAngle(spider.angle + Math.PI);
      return;
    }
    spider.position = next;
  }

  private findHuntTarget(
    spider: RuntimeSpider,
    players: readonly SpiderActor[]
  ): SpiderActor | undefined {
    return players
      .filter(
        (player) =>
          this.canOccupy(player.position, player.radius ?? 0, this.completedSectors) &&
          distanceBetween(player.position, spider.position) <=
            (spider.territory.kind === 'guard'
              ? SPIDER.NEST_ACQUIRE_DISTANCE
              : SPIDER.HUNT_ACQUIRE_DISTANCE) &&
          (spider.territory.kind !== 'guard' ||
            distanceBetween(player.position, spider.territory.home) <= SPIDER.NEST_LEASH_DISTANCE)
      )
      .sort(
        (a, b) =>
          distanceBetween(a.position, spider.position) -
            distanceBetween(b.position, spider.position) || a.id.localeCompare(b.id)
      )[0];
  }

  private canOccupy(position: Position, radius: number, completed: ReadonlySet<string>): boolean {
    return (
      Number.isFinite(position.x) &&
      Number.isFinite(position.y) &&
      Math.hypot(position.x, position.y) <= WORLD.radius - SPIDER.WORLD_INSET &&
      Math.hypot(position.x, position.y) >= SPIDER.STARTER_SAFE_RADIUS + radius &&
      !shipOverlapsCompletedSector(position, radius, completed) &&
      !FURNACES.some(
        (furnace) =>
          distanceBetween(position, furnace.position) < SPIDER.FURNACE_SAFE_RADIUS + radius
      )
    );
  }

  private spawnNearPlayers(
    players: readonly SpiderActor[],
    completedSectors: ReadonlySet<string>
  ): boolean {
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const player = players[(this.spawnTargetIndex + attempt) % players.length];
      if (!player || !this.canOccupy(player.position, player.radius ?? 0, completedSectors)) {
        continue;
      }
      const angle = this.random() * Math.PI * 2;
      const distance =
        SPIDER.SPAWN_RADIUS_MIN +
        Math.max(0, Math.min(1, this.random())) *
          (SPIDER.SPAWN_RADIUS_MAX - SPIDER.SPAWN_RADIUS_MIN);
      const position = {
        x: player.position.x + Math.cos(angle) * distance,
        y: player.position.y + Math.sin(angle) * distance,
      };
      if (!this.validSpawn(position, players, completedSectors)) {
        continue;
      }
      const spawned = this.spawnSpider(position, angle);
      if (spawned) {
        const roamer = this.spiders.get(spawned.id);
        if (roamer) {
          roamer.phase = 'hunting';
          roamer.targetId = player.id;
        }
        this.spawnTargetIndex = (this.spawnTargetIndex + 1) % players.length;
      }
      return spawned !== null;
    }
    return false;
  }

  private validSpawn(
    position: Position,
    players: readonly SpiderActor[],
    completedSectors: ReadonlySet<string>
  ): boolean {
    return (
      this.canOccupy(position, SPIDER.HIT_RADIUS, completedSectors) &&
      !players.some(
        (player) => distanceBetween(position, player.position) < SPIDER.NEST_SPAWN_SAFE_RADIUS
      )
    );
  }

  private containPosition(position: Position): Position {
    const distance = Math.hypot(position.x, position.y);
    const limit = WORLD.radius - SPIDER.WORLD_INSET;
    if (distance <= limit || distance <= POSITION_EPSILON) {
      return position;
    }
    const scale = limit / distance;
    return { x: position.x * scale, y: position.y * scale };
  }
}
