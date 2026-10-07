import { randomUUID } from 'node:crypto';
import { cargoCapacity, ECONOMY } from '../../shared/economy';
import {
  canCollectEquipment,
  EQUIPMENT_DROPS,
  EQUIPMENT_IDS,
  isEquipmentId,
} from '../../shared/equipment';
import { cellWorldBounds, explorationCellAt } from '../../shared/exploration';
import {
  addLootMagnetPull,
  canCollectLoot,
  GROWTH,
  lootOverlap,
  planKillLoot,
} from '../../shared/shipGrowth';
import { nearbyWorldRows, WORLD } from '../../shared/world';
import type { EquipmentId, LootData, Position, SavedPointLoot, Velocity } from '../../shared-types';
import { hullRadiusForKit } from '../../src/entities/ship/shipKits';
import { spatialQueryBounds } from '../world/spatialQueryBounds';
import type { GameEntity } from './EntityManager';
import type { RNGService } from './RNGService';

interface TrackedLoot extends LootData {
  expiresAt: number;
  velocity: Velocity;
  ejectFramesLeft?: number;
  nestCache?: true;
}

/** Recoverable points bounce inside the wall instead of drifting beyond legal ship reach. */
function containPointLoot(drop: TrackedLoot): void {
  const radius = Math.hypot(drop.position.x, drop.position.y);
  const limit = WORLD.radius - drop.radius;
  if (radius <= limit) {
    return;
  }
  const nx = drop.position.x / radius;
  const ny = drop.position.y / radius;
  drop.position.x = nx * limit;
  drop.position.y = ny * limit;
  const outward = drop.velocity.x * nx + drop.velocity.y * ny;
  if (outward > 0) {
    drop.velocity.x -= 2 * outward * nx;
    drop.velocity.y -= 2 * outward * ny;
  }
}

const POINT_REST_SPEED = 0.01;

interface LootBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Receives detached values; owns atlas eligibility/revelation, never the authoritative drop. */
export interface LootCatalogObserver {
  changed(drop: LootData, insertionOrdinal: number): void;
  moved(drop: LootData, previousPosition: Position): void;
  removed(id: string): void;
  cleared(): void;
}

interface Membership {
  ordinal: number;
  cell: string;
}

interface Deadline {
  at: number;
  drop: TrackedLoot;
}

/** One deadline node per authoritative ID; removal/extension never retains a stale drop. */
class ExpiryQueue {
  private readonly heap: Deadline[] = [];
  private readonly positions = new Map<string, number>();

  upsert(deadline: Deadline): void {
    const existing = this.positions.get(deadline.drop.id);
    const at = existing ?? this.heap.length;
    this.put(at, deadline);
    const moved = this.siftUp(at);
    this.siftDown(moved);
  }

  remove(id: string): Deadline | undefined {
    const at = this.positions.get(id);
    if (at === undefined) {
      return undefined;
    }
    const removed = this.heap[at];
    const last = this.heap.pop();
    this.positions.delete(id);
    if (last && at < this.heap.length) {
      this.put(at, last);
      const moved = this.siftUp(at);
      this.siftDown(moved);
    }
    return removed;
  }

  popDue(now: number): Deadline | undefined {
    const head = this.heap[0];
    return head && head.at <= now ? this.remove(head.drop.id) : undefined;
  }

  clear(): void {
    this.heap.length = 0;
    this.positions.clear();
  }

  private put(at: number, deadline: Deadline): void {
    this.heap[at] = deadline;
    this.positions.set(deadline.drop.id, at);
  }

  private siftUp(start: number): number {
    let at = start;
    const deadline = this.heap[at];
    if (!deadline) {
      throw new Error('Missing loot expiry heap node');
    }
    while (at > 0) {
      const parentAt = Math.floor((at - 1) / 2);
      const parent = this.heap[parentAt];
      if (!parent || parent.at <= deadline.at) {
        break;
      }
      this.put(at, parent);
      at = parentAt;
    }
    this.put(at, deadline);
    return at;
  }

  private siftDown(start: number): void {
    let at = start;
    const deadline = this.heap[at];
    if (!deadline) {
      throw new Error('Missing loot expiry heap node');
    }
    while (true) {
      const leftAt = at * 2 + 1;
      const rightAt = leftAt + 1;
      const left = this.heap[leftAt];
      const right = this.heap[rightAt];
      if (!left) {
        break;
      }
      const childAt = right && right.at < left.at ? rightAt : leftAt;
      const child = this.heap[childAt];
      if (!child || child.at >= deadline.at) {
        break;
      }
      this.put(at, child);
      at = childAt;
    }
    this.put(at, deadline);
  }
}

const LOOT_CELL_SIZE = 256;
const MAX_DROP_RADIUS = Math.max(
  GROWTH.LOOT_RADIUS + 2,
  GROWTH.TAP_LOOT_RADIUS,
  EQUIPMENT_DROPS.RADIUS
);

function lootCell(position: Position): string {
  return `${Math.floor(position.x / LOOT_CELL_SIZE)},${Math.floor(position.y / LOOT_CELL_SIZE)}`;
}

export class LootManager {
  public pointRevision = 0;
  private readonly loot = new Map<string, TrackedLoot>();
  private readonly cells = new Map<string, Set<TrackedLoot>>();
  private readonly membership = new WeakMap<TrackedLoot, Membership>();
  private readonly moving = new Set<TrackedLoot>();
  private readonly ejecting = new Set<TrackedLoot>();
  private readonly disposable = new Set<TrackedLoot>();
  private readonly points = new Set<TrackedLoot>();
  private readonly frameExpiry = new ExpiryQueue();
  private readonly wallExpiry = new ExpiryQueue();
  private nextOrdinal = 0;
  private nextId = 1;
  private rng: RNGService;

  constructor(
    rngService: RNGService,
    private readonly catalog?: LootCatalogObserver
  ) {
    this.rng = rngService;
  }

  public spawnFromKill(
    entity: Pick<GameEntity, 'position' | 'mass'>,
    gameTime: number
  ): LootData[] {
    return this.spawnFromPosition(entity.position, entity.mass ?? GROWTH.BASE_MASS, gameTime);
  }

  public spawnFromPosition(position: Position, mass: number, gameTime: number): LootData[] {
    const { pelletMasses } = planKillLoot(mass);
    const spawned: LootData[] = [];

    for (const pelletMass of pelletMasses) {
      const drop = this.createPellet(position, pelletMass, gameTime);
      this.insert(drop);
      spawned.push(this.toPublic(drop));
    }

    this.enforceCap();
    return spawned;
  }

  /** One shard at the break site. Collect uses the existing overlap collection path. */
  public spawnShard(
    position: Position,
    gameTime: number,
    mass: number = GROWTH.SHARD_MASS
  ): LootData {
    const drop: TrackedLoot = {
      id: `loot-${this.nextId++}`,
      position: { x: position.x, y: position.y },
      mass,
      radius: GROWTH.LOOT_RADIUS,
      kind: 'shard',
      points: GROWTH.SHARD_SCORE,
      expiresAt: gameTime + GROWTH.LOOT_TTL_FRAMES,
      velocity: { x: 0, y: 0 },
    };
    this.insert(drop);
    this.enforceCap();
    return this.toPublic(drop);
  }

  public spawnPoints(
    position: Position,
    points: number,
    motion?: { velocity: Velocity; ejectFramesLeft: number }
  ): void {
    if (points <= 0) {
      return;
    }
    const drop: TrackedLoot = {
      id: `points-${randomUUID()}`,
      position: { ...position },
      points,
      mass: 0,
      radius: GROWTH.LOOT_RADIUS + 2,
      kind: 'points',
      expiresAt: Date.now() + (ECONOMY.deathLootFrames / 60) * 1000,
      velocity: motion ? { ...motion.velocity } : { x: 0, y: 0 },
      ...(motion ? { ejectFramesLeft: motion.ejectFramesLeft } : {}),
    };
    containPointLoot(drop);
    this.insert(drop);
    this.pointRevision++;
    this.enforceCap();
  }

  public savedPoints(): SavedPointLoot[] {
    return this.inInsertionOrder(this.points)
      .filter((drop) => drop.expiresAt > Date.now())
      .map((drop) => ({
        id: drop.id,
        position: { ...drop.position },
        points: drop.points ?? 0,
        expiresAt: drop.expiresAt,
        velocity: { ...drop.velocity },
        ejectFramesLeft: drop.ejectFramesLeft ?? 0,
      }));
  }

  public restorePoints(drops: SavedPointLoot[]): void {
    for (const drop of drops) {
      if (drop.expiresAt <= Date.now()) {
        continue;
      }
      this.insert({
        ...drop,
        position: { ...drop.position },
        kind: 'points',
        mass: 0,
        radius: GROWTH.LOOT_RADIUS + 2,
        velocity: { ...(drop.velocity ?? { x: 0, y: 0 }) },
      });
    }
    this.pointRevision++;
  }

  public get(lootId: string): LootData | undefined {
    const drop = this.loot.get(lootId);
    return drop ? this.toPublic(drop) : undefined;
  }

  /** One ejected canister during a Resource Tap extract. The rock stays in the field. */
  public spawnTap(position: Position, gameTime: number, velocity: Velocity): LootData {
    const drop: TrackedLoot = {
      id: `tap-${this.nextId++}`,
      position: { x: position.x, y: position.y },
      mass: GROWTH.TAP_LOOT_MASS,
      radius: GROWTH.TAP_LOOT_RADIUS,
      kind: 'tap',
      points: GROWTH.TAP_LOOT_SCORE,
      expiresAt: gameTime + GROWTH.LOOT_TTL_FRAMES,
      velocity: { ...velocity },
      ejectFramesLeft: GROWTH.TAP_LOOT_EJECT_FRAMES,
    };
    this.insert(drop);
    this.enforceCap();
    return this.toPublic(drop);
  }

  /** A silk bundle ejects before becoming collectible; it never grants hull mass. */
  public spawnSilk(position: Position, gameTime: number, velocity: Velocity): LootData {
    const drop: TrackedLoot = {
      id: `silk-${this.nextId++}`,
      position: { ...position },
      mass: 0,
      radius: GROWTH.TAP_LOOT_RADIUS,
      kind: 'silk',
      expiresAt: gameTime + GROWTH.LOOT_TTL_FRAMES,
      velocity: { ...velocity },
      ejectFramesLeft: GROWTH.TAP_LOOT_EJECT_FRAMES,
    };
    this.insert(drop);
    this.enforceCap();
    return this.toPublic(drop);
  }

  public spawnEquipment(position: Position, gameTime: number, kind: EquipmentId): LootData {
    const drop: TrackedLoot = {
      id: `equipment-${this.nextId++}`,
      position: { ...position },
      mass: 0,
      radius: EQUIPMENT_DROPS.RADIUS,
      kind,
      expiresAt: gameTime + EQUIPMENT_DROPS.NEST_LIFETIME_FRAMES,
      velocity: { x: 0, y: 0 },
    };
    this.insert(drop);
    this.enforceCap();
    return this.toPublic(drop);
  }

  /** A guarded cache is seeded once when its nest is created. */
  public spawnNestCache(position: Position, gameTime: number): void {
    const at = (slot: number): Position => {
      const angle = (slot * Math.PI) / 4;
      return { x: position.x + Math.cos(angle) * 100, y: position.y + Math.sin(angle) * 100 };
    };
    const cache = [
      ...this.spawnFromPosition(at(7), GROWTH.BASE_MASS, gameTime),
      this.spawnShard(at(0), gameTime, 0.5),
      this.spawnShard(at(1), gameTime, 0.75),
      this.spawnShard(at(2), gameTime, 0.25),
      this.spawnTap(at(3), gameTime, { x: 0, y: 0 }),
      this.spawnSilk(at(4), gameTime, { x: 0, y: 0 }),
    ];
    if (this.rng.random() < EQUIPMENT_DROPS.NEST_CHANCE) {
      const equipment = EQUIPMENT_IDS[Math.floor(this.rng.random() * EQUIPMENT_IDS.length)];
      if (equipment) {
        cache.push(this.spawnEquipment(at(6), gameTime, equipment));
      }
    }
    for (const item of cache) {
      const tracked = this.loot.get(item.id);
      if (tracked) {
        tracked.expiresAt = gameTime + EQUIPMENT_DROPS.NEST_LIFETIME_FRAMES;
        tracked.nestCache = true;
        this.scheduleExpiry(tracked);
      }
    }
  }

  public remove(lootId: string): LootData | undefined {
    const drop = this.loot.get(lootId);
    if (!drop) {
      return undefined;
    }
    this.erase(drop);
    if (drop.kind === 'points') {
      this.pointRevision++;
    }
    return this.toPublic(drop);
  }

  public collectOverlaps(entities: GameEntity[]): Array<{ collector: GameEntity; loot: LootData }> {
    const wallNow = Date.now();
    const collected: Array<{ collector: GameEntity; loot: LootData }> = [];
    const collectors = entities
      .filter((entity) => canCollectLoot(entity))
      .sort((a, b) => a.id.localeCompare(b.id));

    const claimedEquipment = new Map<string, Set<EquipmentId>>();
    // Direct callers used to purge due point drops even when no ships overlap them.
    for (const drop of this.takeDue(this.wallExpiry, wallNow)) {
      this.erase(drop);
      this.pointRevision++;
    }
    const candidates = new Set<TrackedLoot>();
    for (const collector of collectors) {
      const reach = hullRadiusForKit(collector.kitId) + MAX_DROP_RADIUS;
      for (const drop of this.inBounds(spatialQueryBounds(collector.position, reach))) {
        candidates.add(drop);
      }
    }
    const drops = [...candidates].sort(this.compareRows);
    for (const drop of drops) {
      if ((drop.ejectFramesLeft ?? 0) > 0) {
        continue;
      }
      if (drop.kind === 'points' && drop.expiresAt <= wallNow) {
        this.erase(drop);
        this.pointRevision++;
        continue;
      }
      const winner = collectors.find((entity) => {
        // Prior drops in this same collection pass may have filled this pilot.
        if (!canCollectLoot(entity)) {
          return false;
        }
        if (
          isEquipmentId(drop.kind) &&
          (!canCollectEquipment(entity, drop.kind) ||
            claimedEquipment.get(entity.id)?.has(drop.kind))
        ) {
          return false;
        }
        if (
          !lootOverlap(entity.position, hullRadiusForKit(entity.kitId), drop.position, drop.radius)
        ) {
          return false;
        }

        return true;
      });
      if (!winner) {
        continue;
      }
      if (isEquipmentId(drop.kind)) {
        const claimed = claimedEquipment.get(winner.id) ?? new Set<EquipmentId>();
        claimed.add(drop.kind);
        claimedEquipment.set(winner.id, claimed);
        // Each eligible ship takes its own copy; the drop stays for the others.
        collected.push({ collector: winner, loot: this.toPublic(drop) });
        continue;
      }
      const availablePoints = drop.points ?? 0;
      if (availablePoints > 0) {
        const accepted = Math.min(availablePoints, cargoCapacity(winner.kitId) - winner.cargo);
        winner.cargo += accepted;
        const receipt = { ...this.toPublic(drop), points: accepted };
        drop.points = availablePoints - accepted;
        if (drop.kind === 'points') {
          this.pointRevision++;
        }
        if (drop.points === 0) {
          this.erase(drop);
        } else {
          const ordinal = this.membership.get(drop)?.ordinal;
          if (ordinal !== undefined) {
            this.catalog?.changed(this.toPublic(drop), ordinal);
          }
        }
        collected.push({ collector: winner, loot: receipt });
      } else {
        this.erase(drop);
        collected.push({ collector: winner, loot: this.toPublic(drop) });
      }
    }

    return collected;
  }

  public expire(gameTime: number, collectors: readonly GameEntity[] = []): void {
    const wallNow = Date.now();
    const liveCollectors = collectors.filter((entity) => canCollectLoot(entity));
    const magnetPositions = liveCollectors.map((entity) => entity.position);
    const haulerPositions = liveCollectors
      .filter((entity) => entity.kitId === 'hauler')
      .map((entity) => entity.position);

    const candidates = new Set<TrackedLoot>(this.moving);
    for (const drop of this.ejecting) {
      candidates.add(drop);
    }
    for (const collector of liveCollectors) {
      // Use the larger range for broad-phase only. The existing branch below decides attraction.
      for (const drop of this.inCircle(collector.position, GROWTH.TAP_LOOT_MAGNET_RANGE)) {
        candidates.add(drop);
      }
    }
    const due = new Set([
      ...this.takeDue(this.frameExpiry, gameTime),
      ...this.takeDue(this.wallExpiry, wallNow),
    ]);
    for (const drop of due) {
      candidates.add(drop);
    }

    for (const drop of this.inInsertionOrder(candidates)) {
      const previousPosition = { ...drop.position };
      const previousVx = drop.velocity.x;
      const previousVy = drop.velocity.y;
      const previousEjectFrames = drop.ejectFramesLeft ?? 0;
      if ((drop.ejectFramesLeft ?? 0) > 0) {
        drop.ejectFramesLeft = (drop.ejectFramesLeft ?? 0) - 1;
      } else if ((drop.kind === 'tap' || drop.kind === 'silk') && haulerPositions.length > 0) {
        addLootMagnetPull(drop, haulerPositions, {
          range: GROWTH.TAP_LOOT_MAGNET_RANGE,
          accel: GROWTH.TAP_LOOT_MAGNET_ACCEL,
        });
      } else if (isEquipmentId(drop.kind)) {
        const equipment = drop.kind;
        addLootMagnetPull(
          drop,
          liveCollectors
            .filter((entity) => canCollectEquipment(entity, equipment))
            .map((entity) => entity.position)
        );
      } else {
        addLootMagnetPull(drop, magnetPositions);
      }
      drop.position.x += drop.velocity.x;
      drop.position.y += drop.velocity.y;
      if (drop.kind === 'points') {
        containPointLoot(drop);
      }
      drop.velocity.x *= GROWTH.LOOT_DRAG;
      drop.velocity.y *= GROWTH.LOOT_DRAG;
      if (
        drop.kind === 'points' &&
        (drop.ejectFramesLeft ?? 0) === 0 &&
        Math.hypot(drop.velocity.x, drop.velocity.y) < POINT_REST_SPEED
      ) {
        drop.velocity.x = 0;
        drop.velocity.y = 0;
      }
      this.updateMotionMembership(drop);
      this.refile(drop);
      if (drop.position.x !== previousPosition.x || drop.position.y !== previousPosition.y) {
        this.catalog?.moved(this.toPublic(drop), previousPosition);
      }
      if (
        drop.kind === 'points' &&
        (drop.position.x !== previousPosition.x ||
          drop.position.y !== previousPosition.y ||
          drop.velocity.x !== previousVx ||
          drop.velocity.y !== previousVy ||
          (drop.ejectFramesLeft ?? 0) !== previousEjectFrames ||
          wallNow >= drop.expiresAt)
      ) {
        this.pointRevision++;
      }
      if ((drop.kind === 'points' ? wallNow : gameTime) >= drop.expiresAt) {
        this.erase(drop);
      }
    }
  }

  /** Spawned nest rewards cannot seed another nest across a cell boundary. */
  public getNestResources(): LootData[] {
    return [...this.loot.values()]
      .filter((drop) => !drop.nestCache)
      .map((drop) => this.toPublic(drop));
  }

  public getAll(): LootData[] {
    return [...this.loot.values()].sort(this.compareRows).map((drop) => this.toPublic(drop));
  }

  public getCount(): number {
    return this.loot.size;
  }

  public clear(): void {
    this.loot.clear();
    this.cells.clear();
    this.moving.clear();
    this.ejecting.clear();
    this.disposable.clear();
    this.points.clear();
    this.frameExpiry.clear();
    this.wallExpiry.clear();
    this.catalog?.cleared();
    this.pointRevision++;
  }

  private createPellet(origin: Position, mass: number, gameTime: number): TrackedLoot {
    const angle = this.rng.random() * Math.PI * 2;
    const dist = GROWTH.SCATTER_MIN + this.rng.random() * (GROWTH.SCATTER_MAX - GROWTH.SCATTER_MIN);
    return {
      id: `loot-${this.nextId++}`,
      position: {
        x: origin.x + Math.cos(angle) * dist,
        y: origin.y + Math.sin(angle) * dist,
      },
      mass,
      radius: GROWTH.LOOT_RADIUS,
      kind: 'wreckage',
      expiresAt: gameTime + GROWTH.LOOT_TTL_FRAMES,
      velocity: { x: 0, y: 0 },
    };
  }

  private enforceCap(): void {
    // The disposable subset is bounded by the existing cap; unrelated points never participate.
    const overflow = this.disposable.size - GROWTH.MAX_LOOT;
    if (overflow <= 0) {
      return;
    }
    for (const drop of this.inInsertionOrder(this.disposable).slice(0, overflow)) {
      this.erase(drop);
    }
  }

  /** Inclusive exact center square; snapshot consumers retain the existing ID order. */
  public queryBounds(bounds: LootBounds): LootData[] {
    return this.inBounds(bounds)
      .sort(this.compareRows)
      .map((drop) => this.toPublic(drop));
  }

  /** Rounded exploration addressing is the final predicate, not the literal cell rectangle. */
  public queryExplorationCell(cell: number): LootData[] {
    const bounds = cellWorldBounds(cell);
    const center = { x: bounds.x + bounds.size / 2, y: bounds.y + bounds.size / 2 };
    return this.inBounds(spatialQueryBounds(center, bounds.size / 2))
      .filter((drop) => explorationCellAt(drop.position) === cell)
      .sort(this.compareRows)
      .map((drop) => this.toPublic(drop));
  }

  /** Candidate bounds are conservative; the existing snapshot predicate decides admission. */
  public queryNearby(position: Position): LootData[] {
    return nearbyWorldRows(
      this.inBounds(spatialQueryBounds(position, WORLD.interestRadius)),
      position
    )
      .sort(this.compareRows)
      .map((drop) => this.toPublic(drop));
  }

  /** Inclusive exact center circle; callers can retain their existing swept-hit/tie predicates. */
  public queryCircle(position: Position, radius: number): LootData[] {
    return this.inCircle(position, radius)
      .sort(this.compareRows)
      .map((drop) => this.toPublic(drop));
  }

  /** Local discovery keeps original loot-domain insertion order across overlapping pilot circles. */
  public getNestResourcesNear(positions: readonly Position[], radius: number): LootData[] {
    const found = new Set<TrackedLoot>();
    for (const position of positions) {
      // TerrainSpiderManager's existing exact predicate is Math.hypot, including its rounding.
      for (const drop of this.inBounds(spatialQueryBounds(position, radius))) {
        if (
          !drop.nestCache &&
          Math.hypot(position.x - drop.position.x, position.y - drop.position.y) <= radius
        ) {
          found.add(drop);
        }
      }
    }
    return this.inInsertionOrder(found).map((drop) => this.toPublic(drop));
  }

  /** Existing distant marker anchors must not depend on the discovery window. */
  public getNestResource(id: string): LootData | undefined {
    const drop = this.loot.get(id);
    return drop && !drop.nestCache ? this.toPublic(drop) : undefined;
  }

  private inBounds(bounds: LootBounds): TrackedLoot[] {
    const found: TrackedLoot[] = [];
    for (
      let y = Math.floor(bounds.minY / LOOT_CELL_SIZE);
      y <= Math.floor(bounds.maxY / LOOT_CELL_SIZE);
      y++
    ) {
      for (
        let x = Math.floor(bounds.minX / LOOT_CELL_SIZE);
        x <= Math.floor(bounds.maxX / LOOT_CELL_SIZE);
        x++
      ) {
        for (const drop of this.cells.get(`${x},${y}`) ?? []) {
          if (
            drop.position.x >= bounds.minX &&
            drop.position.x <= bounds.maxX &&
            drop.position.y >= bounds.minY &&
            drop.position.y <= bounds.maxY
          ) {
            found.push(drop);
          }
        }
      }
    }
    return found;
  }

  private inCircle(position: Position, radius: number): TrackedLoot[] {
    const radiusSq = radius * radius;
    return this.inBounds(spatialQueryBounds(position, radius)).filter((drop) => {
      const dx = position.x - drop.position.x;
      const dy = position.y - drop.position.y;
      return dx * dx + dy * dy <= radiusSq;
    });
  }

  /** Stable locale ties follow the authoritative Map's original insertion order. */
  private readonly compareRows = (a: TrackedLoot, b: TrackedLoot): number =>
    a.id.localeCompare(b.id) || this.order(a) - this.order(b);

  private inInsertionOrder(drops: Iterable<TrackedLoot>): TrackedLoot[] {
    return [...drops].sort((a, b) => this.order(a) - this.order(b));
  }

  private order(drop: TrackedLoot): number {
    const entry = this.membership.get(drop);
    if (!entry) {
      throw new Error(`Loot membership missing for ${drop.id}`);
    }
    return entry.ordinal;
  }

  private insert(drop: TrackedLoot): void {
    const existing = this.loot.get(drop.id);
    const ordinal = existing ? this.order(existing) : this.nextOrdinal++;
    if (existing) {
      this.cancelExpiry(existing);
      this.unplace(existing);
      this.moving.delete(existing);
      this.ejecting.delete(existing);
      this.disposable.delete(existing);
      this.points.delete(existing);
    }
    this.loot.set(drop.id, drop);
    this.membership.set(drop, { ordinal, cell: lootCell(drop.position) });
    this.place(drop);
    this.updateMotionMembership(drop);
    if (drop.kind === 'points') {
      this.points.add(drop);
    } else if (!isEquipmentId(drop.kind)) {
      this.disposable.add(drop);
    }
    this.scheduleExpiry(drop);
    this.catalog?.changed(this.toPublic(drop), ordinal);
  }

  private erase(drop: TrackedLoot): void {
    this.cancelExpiry(drop);
    this.loot.delete(drop.id);
    this.unplace(drop);
    this.moving.delete(drop);
    this.ejecting.delete(drop);
    this.disposable.delete(drop);
    this.points.delete(drop);
    this.catalog?.removed(drop.id);
  }

  private updateMotionMembership(drop: TrackedLoot): void {
    if (drop.velocity.x !== 0 || drop.velocity.y !== 0) {
      this.moving.add(drop);
    } else {
      this.moving.delete(drop);
    }
    if ((drop.ejectFramesLeft ?? 0) > 0) {
      this.ejecting.add(drop);
    } else {
      this.ejecting.delete(drop);
    }
  }

  private place(drop: TrackedLoot): void {
    const key = lootCell(drop.position);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = new Set();
      this.cells.set(key, bucket);
    }
    bucket.add(drop);
  }

  private unplace(drop: TrackedLoot): void {
    const entry = this.membership.get(drop);
    if (!entry) {
      throw new Error(`Loot membership missing for ${drop.id}`);
    }
    const bucket = this.cells.get(entry.cell);
    bucket?.delete(drop);
    if (bucket?.size === 0) {
      this.cells.delete(entry.cell);
    }
  }

  private refile(drop: TrackedLoot): void {
    const entry = this.membership.get(drop);
    if (!entry) {
      throw new Error(`Loot membership missing for ${drop.id}`);
    }
    const key = lootCell(drop.position);
    if (entry.cell !== key) {
      this.unplace(drop);
      entry.cell = key;
      this.place(drop);
    }
  }

  private scheduleExpiry(drop: TrackedLoot): void {
    const queue = drop.kind === 'points' ? this.wallExpiry : this.frameExpiry;
    queue.upsert({ at: drop.expiresAt, drop });
  }

  private cancelExpiry(drop: TrackedLoot): void {
    const queue = drop.kind === 'points' ? this.wallExpiry : this.frameExpiry;
    queue.remove(drop.id);
  }

  private takeDue(queue: ExpiryQueue, now: number): TrackedLoot[] {
    const due: TrackedLoot[] = [];
    let deadline = queue.popDue(now);
    while (deadline) {
      due.push(deadline.drop);
      deadline = queue.popDue(now);
    }
    return due;
  }

  private toPublic(drop: TrackedLoot): LootData {
    const publicDrop: LootData = {
      id: drop.id,
      position: { x: drop.position.x, y: drop.position.y },
      mass: drop.mass,
      radius: drop.radius,
      kind: drop.kind,
      ...(drop.points !== undefined ? { points: drop.points } : {}),
    };

    return publicDrop;
  }
}
