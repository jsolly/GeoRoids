import {
  ASTEROID_BELT,
  type BeltRecoveryWarning,
  type BeltSlotState,
  beltAsteroid,
  beltSlots,
} from '../../shared/asteroidBelt';
import { asteroidMaterialAt, MATERIAL_OUTLINES } from '../../shared/asteroidMaterials';
import {
  ASTEROID_INTERACTIONS,
  layoutReflectiveCluster,
  seedAsteroidPhenomena,
} from '../../shared/asteroidPhenomena';
import { applyColossalDeposit, sectorHostsColossal } from '../../shared/asteroidScale';
import { parseSectorId, sectorAt, WORLD } from '../../shared/world';
import type { AsteroidData, Position } from '../../shared-types';
import { ROID } from '../../src/constants';
import type { AsteroidManager } from '../core/AsteroidManager';
import { RNGService } from '../core/RNGService';

const DEPOSIT_ID = /^deposit-(\d+)-(-?\d+)-(-?\d+)-(\d+)$/u;
const SECTOR_EDGE_EPSILON = 1e-6;
const STATIONARY_SLOTS = Math.round(WORLD.depositsPerSector * ROID.STATIONARY_FRACTION);

/** Probes are live hardware, not part of the durable asteroid field. */
function stripTransientProbe(rock: AsteroidData): AsteroidData {
  if (!Object.hasOwn(rock, 'probe')) {
    return rock;
  }
  const { probe: _probe, ...persisted } = rock;
  return persisted;
}

function stationarySlot(index: number): boolean {
  return index < STATIONARY_SLOTS;
}

/**
 * Distant sectors sleep; visited empty sectors never regenerate harvested deposits.
 *
 * Every saved sector stays in memory as a dormant sector, so activating,
 * sleeping and counting sectors never reads the database while the game runs.
 * At the world's full 60,000-unit radius that is at most a few thousand
 * sectors of deposit rows, well within a game server's memory.
 */
export class RegionalAsteroidField {
  private active = new Set<string>();
  private belt: BeltSlotState[];
  private readonly dormant: Map<string, AsteroidData[]>;
  private changed = new Map<string, AsteroidData[]>();
  private visited = new Set<string>();
  private savedDensityMigrationApplied = false;
  private readonly densityMigrationSectors = new Set<string>();
  private savedMotionMigrationApplied = false;
  private readonly savedPoweredSectors = new Set<string>();

  constructor(
    private readonly seed: number,
    saved: ReadonlyMap<string, AsteroidData[]> = new Map(),
    savedBelt?: readonly BeltSlotState[]
  ) {
    this.dormant = new Map(
      [...saved].map(([id, rocks]) => [id, rocks.map(stripTransientProbe)] as const)
    );
    for (const [id, rocks] of saved) {
      if (rocks.length > 0) {
        this.densityMigrationSectors.add(id);
      }
    }
    this.belt =
      savedBelt?.map((entry) => ({ ...entry })) ??
      beltSlots().map((slot) => ({ slot, generation: 0, recoverAt: null }));
    // Additive rollout touches only the finite belt footprint, including previously mined sectors.
    // The durable ledger distinguishes a new feature from a legitimately missing host.
    for (const entry of this.belt) {
      const rock = beltAsteroid(this.seed, entry.slot, entry.generation);
      const sector = sectorAt(rock.position);
      let rows = this.dormant.get(sector.id);
      if (!rows) {
        rows = this.generate(sector.x, sector.y);
        this.dormant.set(sector.id, rows);
      }
      if (!savedBelt && !rows.some((existing) => existing.id === rock.id)) {
        rows.push(rock);
        this.changed.set(sector.id, rows);
      }
    }
    for (const [id, rocks] of saved) {
      if (rocks.some((rock) => rock.boost?.phase === 'burning')) {
        this.savedPoweredSectors.add(id);
      }
    }
  }

  private generate(x: number, y: number): AsteroidData[] {
    const random = new RNGService(this.seed ^ Math.imul(x, 73856093) ^ Math.imul(y, 19349663));
    const rocks: AsteroidData[] = [];
    for (let index = 0; index < WORLD.depositsPerSector; index++) {
      const position = {
        x: (x + random.random()) * WORLD.sectorSize,
        y: (y + random.random()) * WORLD.sectorSize,
      };
      if (Math.hypot(position.x, position.y) > WORLD.radius - 100) {
        continue;
      }
      // Keep the launch area navigable; nearby deposits still fit inside the first scan.
      if (Math.hypot(position.x, position.y) < 160) {
        position.x += 240;
      }
      const material = asteroidMaterialAt(index);
      const offsets = [...MATERIAL_OUTLINES[material]];
      const health = material === 'metal' ? 75 : 25;
      // Keep drawing every random value for every slot, including stationary
      // slots, so positions and all later slot metadata remain seed-stable.
      const direction = random.random() * Math.PI * 2;
      const speed =
        ROID.DRIFT_SPEED_MIN + (ROID.DRIFT_SPEED_MAX - ROID.DRIFT_SPEED_MIN) * random.random() ** 2;
      const generatedVelocity = { x: Math.cos(direction) * speed, y: Math.sin(direction) * speed };
      rocks.push({
        id: `deposit-${this.seed}-${x}-${y}-${index}`,
        position,
        velocity: stationarySlot(index) ? { x: 0, y: 0 } : generatedVelocity,
        size: 18 + random.random() * 30,
        material,
        health,
        maxHealth: health,
        rotation: random.random() * Math.PI * 2,
        angularVelocity: (random.random() - 0.5) * 0.005,
        jaggedness: material === 'rubble' ? 0.7 : 0.25,
        vertices: offsets.length,
        offsets,
      });
    }
    const collab = rocks[0];
    if (collab) {
      collab.size = Math.max(collab.size, ROID.COLLAB_SPLIT_MIN_SIZE);
      collab.isCollabTarget = true;
      collab.health = 100;
      collab.maxHealth = 100;
    }
    seedAsteroidPhenomena(rocks);
    this.placeReflectiveClusters(rocks, x, y);
    this.placeColossalDeposit(rocks, x, y);
    // Phenomenon clusters and the launch-area offset may move a generated
    // slot across an edge. Keep the slot owned by its deterministic sector;
    // later simulation drift is what transfers ownership during checkpointing.
    const minX = x * WORLD.sectorSize;
    const minY = y * WORLD.sectorSize;
    const maxX = (x + 1) * WORLD.sectorSize - SECTOR_EDGE_EPSILON;
    const maxY = (y + 1) * WORLD.sectorSize - SECTOR_EDGE_EPSILON;
    for (const rock of rocks) {
      rock.position = {
        x: Math.min(maxX, Math.max(minX, rock.position.x)),
        y: Math.min(maxY, Math.max(minY, rock.position.y)),
      };
    }
    // Clusters can extend beyond the circular world even when their anchor is inside.
    return rocks.filter((rock) => Math.hypot(rock.position.x, rock.position.y) <= WORLD.radius);
  }

  /**
   * Add the new deterministic slots to rows written by the 24-slot world.
   *
   * A row is migrated once per process startup, and the caller persists the
   * resulting rows atomically with WORLD.asteroidDensityVersion. Missing
   * legacy IDs are intentionally never regenerated: they may have been
   * harvested, destroyed, or carried into another sector.
   */
  private migrateSector(
    id: string,
    saved: readonly AsteroidData[],
    persistedIds: ReadonlySet<string>
  ): AsteroidData[] {
    const parsed = parseSectorId(id);
    if (!parsed) {
      throw new Error('Invalid sector identity');
    }
    const generated = this.generate(parsed.x, parsed.y);
    const additions = generated.filter((rock) => {
      const prefix = `deposit-${this.seed}-${parsed.x}-${parsed.y}-`;
      if (!rock.id.startsWith(prefix) || persistedIds.has(rock.id)) {
        return false;
      }
      const slot = Number(rock.id.slice(prefix.length));
      return (
        Number.isSafeInteger(slot) &&
        slot >= WORLD.legacyDepositsPerSector &&
        slot < WORLD.depositsPerSector
      );
    });
    // A pre-density sector has six stationary reflective rocks and 18 moving
    // rocks. Fill the stationary target from the additive slots while preserving
    // the exact saved velocities (including sectors that were partly mined or
    // carried across a boundary before this migration).
    const existingStationary = saved.filter(
      (rock) => rock.velocity.x === 0 && rock.velocity.y === 0
    ).length;
    const stationaryNeeded = Math.max(0, STATIONARY_SLOTS - existingStationary);
    for (const [index, rock] of additions.entries()) {
      if (index >= stationaryNeeded) {
        break;
      }
      rock.velocity = { x: 0, y: 0 };
    }
    return additions.length === 0 ? [...saved] : [...saved, ...additions];
  }

  /** Keep intact pinball pockets off sector edges without restoring mined members. */
  private placeReflectiveClusters(rocks: AsteroidData[], x: number, y: number): boolean {
    const groups = new Map<string, AsteroidData[]>();
    for (const rock of rocks) {
      if (rock.phenomenon?.kind === 'reflective') {
        const group = groups.get(rock.phenomenon.clusterId) ?? [];
        group.push(rock);
        groups.set(rock.phenomenon.clusterId, group);
      }
    }
    let changed = false;
    const extent = ASTEROID_INTERACTIONS.clusterRadius + ASTEROID_INTERACTIONS.reflectiveSize + 1;
    for (const group of groups.values()) {
      if (
        group.length !== ASTEROID_INTERACTIONS.rocksPerCluster ||
        group.some((rock) => rock.boost || rock.velocity.x !== 0 || rock.velocity.y !== 0)
      ) {
        continue;
      }
      const center = {
        x: Math.min(
          (x + 1) * WORLD.sectorSize - extent,
          Math.max(
            x * WORLD.sectorSize + extent,
            group.reduce((sum, rock) => sum + rock.position.x, 0) / group.length
          )
        ),
        y: Math.min(
          (y + 1) * WORLD.sectorSize - extent,
          Math.max(
            y * WORLD.sectorSize + extent,
            group.reduce((sum, rock) => sum + rock.position.y, 0) / group.length
          )
        ),
      };
      // At the circular rim, preserve the original group rather than placing
      // a pocket partly outside the playable world.
      if (Math.hypot(center.x, center.y) + extent > WORLD.radius) {
        continue;
      }
      const placements = layoutReflectiveCluster(center);
      for (const [index, rock] of group.entries()) {
        const placement = placements[index];
        if (
          placement &&
          (rock.position.x !== placement.position.x ||
            rock.position.y !== placement.position.y ||
            rock.rotation !== placement.rotation)
        ) {
          rock.position = { ...placement.position };
          rock.rotation = placement.rotation;
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Resize one ordinary slot; keep collab rocks and pinball clusters intact. */
  private placeColossalDeposit(rocks: AsteroidData[], x: number, y: number): void {
    if (!sectorHostsColossal(x, y, this.seed)) {
      return;
    }
    const slot =
      rocks.find(
        (rock) =>
          !rock.isCollabTarget && !rock.phenomenon && rock.velocity.x === 0 && rock.velocity.y === 0
      ) ?? rocks.find((rock) => !rock.isCollabTarget && !rock.phenomenon);
    if (slot) {
      applyColossalDeposit(slot);
    }
  }

  /** Wake newly drifting slots once at startup; never restore missing deposits. */
  migrateSavedMotion(): void {
    if (this.savedMotionMigrationApplied) {
      return;
    }
    this.savedMotionMigrationApplied = true;
    const generated = new Map<string, Map<string, AsteroidData>>();
    for (const [sector, saved] of this.dormant) {
      let changed = false;
      const rows = saved.map((rock) => {
        if (rock.boost || rock.phenomenon || rock.velocity.x !== 0 || rock.velocity.y !== 0) {
          return rock;
        }
        const match = DEPOSIT_ID.exec(rock.id);
        if (!match || Number(match[1]) !== this.seed) {
          return rock;
        }
        const x = Number(match[2]);
        const y = Number(match[3]);
        const origin = `${x},${y}`;
        let originals = generated.get(origin);
        if (!originals) {
          originals = new Map(this.generate(x, y).map((entry) => [entry.id, entry]));
          generated.set(origin, originals);
        }
        const velocity = originals.get(rock.id)?.velocity;
        if (!velocity || (velocity.x === 0 && velocity.y === 0)) {
          return rock;
        }
        changed = true;
        return { ...rock, velocity: { ...velocity } };
      });
      const parsed = parseSectorId(sector);
      // Clone rows before changing cluster poses; the saved input is a snapshot.
      const arranged = rows.map((rock) => ({ ...rock }));
      const layoutChanged = parsed
        ? this.placeReflectiveClusters(arranged, parsed.x, parsed.y)
        : false;
      if (changed || layoutChanged) {
        this.dormant.set(sector, arranged);
        this.changed.set(sector, arranged);
      }
    }
  }

  private load(id: string): AsteroidData[] {
    this.visited.add(id);
    const cached = this.dormant.get(id);
    if (cached) {
      return cached;
    }
    const parsed = parseSectorId(id);
    if (!parsed) {
      throw new Error('Invalid sector identity');
    }
    return this.generate(parsed.x, parsed.y);
  }

  /**
   * Expand persisted sectors exactly once for the density migration. This is
   * deliberately separate from load(): a missing row means an unvisited
   * sector, while a missing asteroid in a saved row may be a legitimate
   * harvest. The world-row density marker makes this operation durable across
   * restarts, including when every newly added slot is later destroyed.
   */
  migrateSavedSectors(): ReadonlyMap<string, AsteroidData[]> {
    if (this.savedDensityMigrationApplied) {
      return new Map();
    }
    this.savedDensityMigrationApplied = true;
    const migrated = new Map<string, AsteroidData[]>();
    const persistedIds = new Set<string>();
    for (const saved of this.dormant.values()) {
      for (const rock of saved) {
        persistedIds.add(rock.id);
      }
    }
    for (const [id, saved] of this.dormant) {
      // An empty saved row is a durable harvest tombstone.
      if (!this.densityMigrationSectors.has(id)) {
        continue;
      }
      const rows = this.migrateSector(id, saved, persistedIds);
      if (rows.length !== saved.length) {
        this.dormant.set(id, rows);
        for (const rock of rows.slice(saved.length)) {
          persistedIds.add(rock.id);
        }
        this.changed.set(id, rows);
        migrated.set(id, rows);
      }
    }
    return migrated;
  }

  update(
    manager: AsteroidManager,
    observers: readonly Position[],
    now = Date.now()
  ): AsteroidData[] {
    const wanted = new Map<string, { x: number; y: number }>();
    for (const observer of observers) {
      const start = sectorAt({
        x: observer.x - WORLD.interestRadius,
        y: observer.y - WORLD.interestRadius,
      });
      const end = sectorAt({
        x: observer.x + WORLD.interestRadius,
        y: observer.y + WORLD.interestRadius,
      });
      for (let y = start.y; y <= end.y; y++) {
        for (let x = start.x; x <= end.x; x++) {
          const id = `${x},${y}`;
          if (
            Math.hypot((x + 0.5) * WORLD.sectorSize, (y + 0.5) * WORLD.sectorSize) >
            WORLD.radius + WORLD.sectorSize
          ) {
            continue;
          }
          wanted.set(id, { x, y });
        }
      }
    }
    for (const rock of manager.getAllAsteroids()) {
      if (rock.boost?.phase === 'burning' || rock.probe) {
        const sector = sectorAt(rock.position);
        wanted.set(sector.id, { x: sector.x, y: sector.y });
      }
    }
    // Resume saved deliveries once. The index is built at startup; ticks never
    // scan dormant world history.
    for (const id of this.savedPoweredSectors) {
      const sector = parseSectorId(id);
      if (sector) {
        wanted.set(id, sector);
      }
    }
    this.savedPoweredSectors.clear();
    this.sleepDistantSectors(manager, new Set(wanted.keys()));
    const created: AsteroidData[] = [];
    for (const id of wanted.keys()) {
      if (this.active.has(id)) {
        continue;
      }
      const rows = this.load(id);
      this.dormant.delete(id);
      for (const rock of rows) {
        if (manager.getAsteroid(rock.id)) {
          continue;
        }
        manager.addAsteroid(rock);
        created.push(rock);
      }
    }
    this.active = new Set(wanted.keys());
    created.push(...this.reconcileBelt(manager, now));
    return created;
  }

  /** A small tow can cross a sector edge without vacating the belt slot. */
  private dormantBeltHost(home: AsteroidData): AsteroidData | undefined {
    const start = sectorAt({
      x: home.position.x - ASTEROID_BELT.removalDistance,
      y: home.position.y - ASTEROID_BELT.removalDistance,
    });
    const end = sectorAt({
      x: home.position.x + ASTEROID_BELT.removalDistance,
      y: home.position.y + ASTEROID_BELT.removalDistance,
    });
    for (let y = start.y; y <= end.y; y++) {
      for (let x = start.x; x <= end.x; x++) {
        const host = this.dormant.get(`${x},${y}`)?.find((rock) => rock.id === home.id);
        if (host) {
          return host;
        }
      }
    }
    return undefined;
  }

  /** Bounded to the fixed landmark, independent of explored-world size. */
  reconcileBelt(manager: AsteroidManager, now = Date.now()): AsteroidData[] {
    const created: AsteroidData[] = [];
    let changed = false;
    const next = this.belt.map((entry): BeltSlotState => {
      const home = beltAsteroid(this.seed, entry.slot, entry.generation);
      const sector = sectorAt(home.position).id;
      if (entry.recoverAt === null) {
        const host = manager.getAsteroid(home.id) ?? this.dormantBeltHost(home);
        if (
          host &&
          Math.hypot(host.position.x - home.position.x, host.position.y - home.position.y) <=
            ASTEROID_BELT.removalDistance
        ) {
          return entry;
        }
        changed = true;
        return { ...entry, recoverAt: now + ASTEROID_BELT.recoveryMs };
      }
      if (now < entry.recoverAt) {
        return entry;
      }
      const renewed = { slot: entry.slot, generation: entry.generation + 1, recoverAt: null };
      const rock = beltAsteroid(this.seed, renewed.slot, renewed.generation);
      if (this.active.has(sector)) {
        manager.addAsteroid(rock);
        created.push(rock);
      } else {
        const rows = [...(this.dormant.get(sector) ?? []), rock];
        this.dormant.set(sector, rows);
        this.changed.set(sector, rows);
      }
      changed = true;
      return renewed;
    });
    if (changed) {
      this.belt = next;
    }
    return created;
  }

  /** Identity changes only when a timer starts or a replacement is created. */
  beltState(): readonly BeltSlotState[] {
    return this.belt;
  }

  recoveryWarnings(now = Date.now()): BeltRecoveryWarning[] {
    return this.belt.flatMap((entry) => {
      if (entry.recoverAt === null || entry.recoverAt - now > ASTEROID_BELT.warningMs) {
        return [];
      }
      const rock = beltAsteroid(this.seed, entry.slot, entry.generation);
      return [
        { slot: entry.slot, position: rock.position, size: rock.size, recoverAt: entry.recoverAt },
      ];
    });
  }

  private sleepDistantSectors(manager: AsteroidManager, wanted: ReadonlySet<string>): void {
    const probeSectors = new Set<string>();
    for (const rock of manager.getAllAsteroids()) {
      if (rock.probe) {
        probeSectors.add(sectorAt(rock.position).id);
      }
    }
    for (const id of probeSectors) {
      this.active.add(id);
    }
    const retained = new Set([...wanted, ...probeSectors]);
    // Partition current positions, including rocks carried across sector boundaries.
    const bySector = new Map<string, AsteroidData[]>([...this.active].map((id) => [id, []]));
    for (const rock of manager.getAllAsteroids()) {
      const id = sectorAt(rock.position).id;
      let rows = bySector.get(id);
      if (!rows) {
        rows = [];
        bySector.set(id, rows);
      }
      rows.push(rock);
    }
    for (const [id, rows] of bySector) {
      if (retained.has(id)) {
        continue;
      }
      const prior = this.active.has(id) ? [] : this.load(id);
      const saved = [...new Map([...prior, ...rows].map((rock) => [rock.id, rock])).values()];
      this.dormant.set(id, saved);
      this.changed.set(id, saved);
      for (const rock of rows) {
        manager.removeAsteroid(rock.id);
      }
    }
  }

  checkpoint(manager: AsteroidManager): ReadonlyMap<string, AsteroidData[]> {
    // A powered rock may cross a sector edge between interest updates. Keep
    // its new sector awake before checkpointing can put it into dormancy.
    for (const rock of manager.getAllAsteroids()) {
      if (rock.boost?.phase !== 'burning') {
        continue;
      }
      const id = sectorAt(rock.position).id;
      if (!this.active.has(id)) {
        for (const native of this.load(id)) {
          if (!manager.getAsteroid(native.id)) {
            manager.addAsteroid(native);
          }
        }
        this.dormant.delete(id);
        this.active.add(id);
      }
    }
    this.sleepDistantSectors(manager, this.active);
    const rows = new Map(this.changed);
    for (const id of this.active) {
      rows.set(id, []);
    }
    for (const rock of manager.getAllAsteroids()) {
      const id = sectorAt(rock.position).id;
      const sector = rows.get(id);
      if (!sector) {
        throw new Error(`Active asteroid ${rock.id} has no sector ${id}`);
      }
      sector.push(stripTransientProbe(rock));
    }
    return rows;
  }

  /** The pending changes were handed to persistence; dormant rows stay as the in-memory world. */
  saved(): void {
    this.changed.clear();
  }

  reset(): void {
    this.active.clear();
    this.dormant.clear();
    this.changed.clear();
    this.visited.clear();
    this.savedPoweredSectors.clear();
    this.densityMigrationSectors.clear();
    this.savedDensityMigrationApplied = false;
    this.belt = beltSlots().map((slot) => ({ slot, generation: 0, recoverAt: null }));
    for (const entry of this.belt) {
      const rock = beltAsteroid(this.seed, entry.slot, 0);
      const sector = sectorAt(rock.position);
      const rows = this.dormant.get(sector.id) ?? this.generate(sector.x, sector.y);
      rows.push(rock);
      this.dormant.set(sector.id, rows);
      this.changed.set(sector.id, rows);
    }
  }

  hasVisited(id: string): boolean {
    return this.visited.has(id) || this.active.has(id) || this.dormant.has(id);
  }

  visitedSectorIds(): string[] {
    const ids = new Set(this.visited);
    for (const id of this.active) {
      ids.add(id);
    }
    for (const id of this.dormant.keys()) {
      ids.add(id);
    }
    return [...ids];
  }

  /** Look up one known nest resource in its home sector without traversing world history. */
  dormantAsteroid(id: string, home: Position): AsteroidData | undefined {
    return this.dormant.get(sectorAt(home).id)?.find((rock) => rock.id === id);
  }

  dormantSectors(): ReadonlyMap<string, AsteroidData[]> {
    return this.dormant;
  }
}
