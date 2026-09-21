import { segmentCircleContact } from '../../shared/asteroidPhenomena';
import { FURNACE_BUILD, FurnaceField } from '../../shared/furnaceField';
import { shipOverlapsCompletedSector } from '../../shared/sectors';
import { SPIDER } from '../../shared/terrainSpider';
import { WORLD } from '../../shared/world';
import type { Position, SpiderFieldState, TerrainSpider } from '../../shared-types';
import { SHIP_ABILITY } from '../../src/entities/ship/shipKits';
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
  scanning?: boolean;
}

interface SpiderAdvanceOptions {
  players: readonly SpiderActor[];
  completedSectors: ReadonlySet<string>;
  nowFrame: number;
  towedIds?: ReadonlySet<string>;
  resources?: () => readonly SpiderResource[];
  dormantResource?: (id: string, home: Position) => SpiderResource | undefined;
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
  readonly kind: 'spider';
  size: number;
  velocity: Position;
  silkBursts: number;
  displaced: boolean;
  biteReadyAt: number;
  territory: Territory;
}

interface SpiderNest {
  resourceId: string;
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
    shudderFrames: spider.shudderFrames ?? 0,
    ...(spider.probe ? { probe: { ...spider.probe } } : {}),
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
  private consumed: NonNullable<SpiderFieldState['consumed']> = [];
  private readonly spiders = new Map<string, RuntimeSpider>();
  private spiderSequence = 0;
  private nextSpawnFrame: number | null = null;
  private nextNestFrame = 0;
  private nowFrame = 0;
  private readonly nests = new Map<string, SpiderNest>();
  private nestMarkers: SpiderFieldState['nests'] = [];
  private spawnTargetIndex = 0;
  private completedSectors: ReadonlySet<string> = new Set();

  public constructor(
    private readonly random: () => number = Math.random,
    private readonly furnaces = new FurnaceField()
  ) {}

  public snapshot(): SpiderFieldState {
    return {
      spiders: [...this.spiders.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copySpider),
      // Rebuilt with the resource refresh; snapshots never scan dormant nest history.
      nests: this.nestMarkers,
      consumed: this.consumed.map((event) => ({
        ...event,
        position: copyPosition(event.position),
      })),
    };
  }

  /**
   * True when a furnace at `position` would cover a known nest home with its
   * spider-safe radius. Cleared deposits (web gone) are not keep-out.
   */
  public furnaceWouldCoverNest(position: Position): boolean {
    return this.nestMarkers.some(
      (nest) => distanceBetween(position, nest.position) < SPIDER.FURNACE_SAFE_RADIUS
    );
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
    this.consumed = [];
    this.nextSpawnFrame = null;
    this.nextNestFrame = 0;
    this.nests.clear();
    this.nestMarkers = [];
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
      kind: 'spider',
      size: SPIDER.HIT_RADIUS,
      velocity: { x: 0, y: 0 },
      silkBursts: SPIDER.SILK_BURSTS,
      displaced: false,
      biteReadyAt: 0,
      territory: { kind: 'roaming' },
    };
    this.spiders.set(spider.id, spider);
    return copySpider(spider);
  }

  public getBody(id: string): RuntimeSpider | undefined {
    return this.spiders.get(id);
  }

  public getBodies(): readonly RuntimeSpider[] {
    return [...this.spiders.values()];
  }

  /** Tapping agitates the living spider without reducing its health. */
  public provoke(id: string, targetId: string): void {
    const spider = this.spiders.get(id);
    if (!spider) {
      return;
    }
    spider.phase = 'hunting';
    spider.targetId = targetId;
    spider.shudderFrames = SPIDER.SHUDDER_FRAMES;
    if (spider.territory.kind === 'guard') {
      spider.territory.activity = 'patrolling';
      spider.territory.chaseUntil = this.nowFrame + SPIDER.NEST_CHASE_FRAMES;
    }
  }

  /** A spider has a finite silk reserve; repeated latches cannot farm infinite drops. */
  public extractSilk(id: string, targetId: string): boolean {
    this.provoke(id, targetId);
    const spider = this.spiders.get(id);
    if (!spider || spider.silkBursts <= 0) {
      return false;
    }
    spider.silkBursts -= 1;
    return true;
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

    this.consumed = this.consumed.filter(
      (event) => nowFrame - event.frame <= SPIDER.CONSUMED_HISTORY_FRAMES
    );
    for (const spider of this.spiders.values()) {
      spider.shudderFrames = Math.max(0, (spider.shudderFrames ?? 0) - 1);
      if (options.towedIds?.has(spider.id)) {
        spider.displaced = true;
      }
    }
    this.removeBlockedBodies(options.completedSectors);
    this.removeDistantBodies(players);
    if (players.length > 0 && nowFrame >= this.nextNestFrame) {
      this.updateNests(
        options.resources?.() ?? [],
        players,
        options.completedSectors,
        options.dormantResource
      );
      this.nextNestFrame = nowFrame + 60;
    }
    if (this.nextSpawnFrame === null) {
      this.scheduleRoamer(nowFrame);
    }

    const attacks: SpiderAttack[] = [];
    for (const spider of [...this.spiders.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (options.towedIds?.has(spider.id)) {
        const start = copyPosition(spider.position);
        spider.position = this.containPosition({
          x: start.x + spider.velocity.x,
          y: start.y + spider.velocity.y,
        });
        this.consumeAtFurnace(spider, start);
        continue;
      }
      spider.velocity.x = 0;
      spider.velocity.y = 0;
      if (spider.displaced) {
        if (this.retreatFromProtection(spider)) {
          continue;
        }
        spider.displaced = false;
      }
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
        shipOverlapsCompletedSector(spider.position, SPIDER.HIT_RADIUS, completedSectors) ||
        (!spider.displaced &&
          !this.canOccupy(spider.position, SPIDER.HIT_RADIUS, completedSectors)) ||
        (spider.territory.kind === 'guard' &&
          !this.canOccupy(spider.territory.home, SPIDER.HIT_RADIUS, completedSectors))
      ) {
        this.removeSpider(spider.id);
      }
    }
  }

  private removeDistantBodies(players: readonly SpiderActor[]): void {
    for (const spider of [...this.spiders.values()]) {
      const origin =
        spider.territory.kind === 'guard' && !spider.displaced
          ? spider.territory.home
          : spider.position;
      const nearest = players.reduce(
        (distance, player) => Math.min(distance, distanceBetween(origin, player.position)),
        Number.POSITIVE_INFINITY
      );
      const limit =
        spider.territory.kind === 'guard' ? SPIDER.NEST_WAKE_DISTANCE : SPIDER.DESPAWN_DISTANCE;
      if (nearest > limit && !spider.probe) {
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
    completed: ReadonlySet<string>,
    dormantResource: SpiderAdvanceOptions['dormantResource']
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
      const nest: SpiderNest = { resourceId: resource.id, home, guards: [] };
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
    const available = new Map(resources.map((resource) => [resource.id, resource]));
    const markers: SpiderFieldState['nests'] = [];
    // At most one nest per 10,000-unit cell (144 cells across this world).
    // Check only those known homes once a second, never scan dormant sectors.
    for (const [id, nest] of this.nests) {
      const resource =
        available.get(nest.resourceId) ?? dormantResource?.(nest.resourceId, nest.home);
      if (
        resource &&
        distanceBetween(nest.home, resource.position) <= POSITION_EPSILON &&
        this.canOccupy(nest.home, SPIDER.HIT_RADIUS, completed)
      ) {
        markers.push({ id, resourceId: nest.resourceId, position: copyPosition(nest.home) });
      }
    }
    this.nestMarkers = markers.sort((a, b) => a.id.localeCompare(b.id));
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
              (guard.displaced || this.canOccupy(guard.position, SPIDER.HIT_RADIUS, completed))
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
    const scanner = players
      .filter(
        (player) =>
          player.scanning &&
          distanceBetween(player.position, spider.position) <= SHIP_ABILITY.SCAN_RANGE
      )
      .sort(
        (a, b) =>
          distanceBetween(a.position, spider.position) -
          distanceBetween(b.position, spider.position)
      )[0];
    if (scanner) {
      spider.phase = 'scuttling';
      spider.targetId = null;
      const away =
        distanceBetween(spider.position, scanner.position) > POSITION_EPSILON
          ? Math.atan2(
              spider.position.y - scanner.position.y,
              spider.position.x - scanner.position.x
            )
          : spider.angle;
      // A blocked exit may slide along a sector or world edge, but never toward the scanner.
      for (const turn of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
        const angle = away + turn;
        const next = {
          x: spider.position.x + Math.cos(angle) * SPIDER.HUNT_SPEED,
          y: spider.position.y + Math.sin(angle) * SPIDER.HUNT_SPEED,
        };
        if (this.canOccupy(next, SPIDER.HIT_RADIUS, completedSectors)) {
          spider.angle = normalizeAngle(angle);
          spider.position = next;
          break;
        }
      }
      return;
    }
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

  private consumeAtFurnace(spider: RuntimeSpider, start: Position): boolean {
    const midpoint = { x: (start.x + spider.position.x) / 2, y: (start.y + spider.position.y) / 2 };
    const furnace = this.furnaces
      .nearby(midpoint, distanceBetween(start, spider.position) / 2 + FURNACE_BUILD.RADIUS)
      .find(
        (site) =>
          segmentCircleContact(start, spider.position, site.position, site.radius) !== undefined
      );
    if (!furnace) {
      return false;
    }
    this.consumed.push({
      id: spider.id,
      position: copyPosition(spider.position),
      furnaceId: furnace.id,
      frame: this.nowFrame,
    });
    this.consumed = this.consumed.slice(-SPIDER.MAX_ACTIVE);
    this.removeSpider(spider.id);
    return true;
  }

  /** Released cargo walks out of safe areas instead of freezing or attacking inside them. */
  private retreatFromProtection(spider: RuntimeSpider): boolean {
    const furnace = this.furnaces
      .nearby(spider.position, SPIDER.FURNACE_SAFE_RADIUS + SPIDER.HIT_RADIUS)
      .find(
        (site) =>
          distanceBetween(spider.position, site.position) <
          SPIDER.FURNACE_SAFE_RADIUS + SPIDER.HIT_RADIUS
      );
    const inStarter =
      Math.hypot(spider.position.x, spider.position.y) <
      SPIDER.STARTER_SAFE_RADIUS + SPIDER.HIT_RADIUS;
    const origin = inStarter ? { x: 0, y: 0 } : furnace?.position;
    if (!origin) {
      return false;
    }
    const angle = Math.atan2(spider.position.y - origin.y, spider.position.x - origin.x);
    const next = {
      x: spider.position.x + Math.cos(angle) * SPIDER.SCUTTLE_SPEED,
      y: spider.position.y + Math.sin(angle) * SPIDER.SCUTTLE_SPEED,
    };
    if (shipOverlapsCompletedSector(next, SPIDER.HIT_RADIUS, this.completedSectors)) {
      this.removeSpider(spider.id);
      return true;
    }
    spider.phase = 'scuttling';
    spider.targetId = null;
    spider.angle = angle;
    const start = spider.position;
    spider.position = next;
    this.consumeAtFurnace(spider, start);
    return true;
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
      !this.furnaces
        .nearby(position, SPIDER.FURNACE_SAFE_RADIUS + radius)
        .some(
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
