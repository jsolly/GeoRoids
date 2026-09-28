import {
  ASTEROID_BELT,
  type BeltRecoveryWarning,
  type BeltSlotState,
  beltAsteroid,
  beltSlots,
} from '../../shared/asteroidBelt';
import { parseSectorId, sectorAt, WORLD } from '../../shared/world';
import type { AsteroidData, Position } from '../../shared-types';
import { DEPOSIT_FIELD } from '../../src/constants';
import type { AsteroidManager } from '../core/AsteroidManager';
import { sectorDeposits } from './depositLayout';

/** Probes are live hardware, not part of the durable asteroid field. */
function stripTransientProbe(rock: AsteroidData): AsteroidData {
  if (!Object.hasOwn(rock, 'probe')) {
    return rock;
  }
  const { probe: _probe, ...persisted } = rock;
  return persisted;
}

/**
 * Distant sectors sleep; harvested deposit slots regrow out of sight.
 *
 * Every saved sector stays in memory as a dormant sector, so activating,
 * sleeping and counting sectors never reads the database while the game runs.
 * At the world's full 60,000-unit radius that is at most a few thousand
 * sectors of deposit rows, well within a game server's memory.
 *
 * A generated slot regrows only when its ID exists nowhere: not awake and not
 * in any dormant sector (rocks drift across edges). Each interval restores a
 * share of a sector's missing slots, at least one, so a few mined rocks return
 * one at a time and a stripped field refills quickly. A sector waking from
 * sleep catches up on the intervals it slept through; time before this
 * process started does not count. A world saved with an older layout keeps its
 * surviving rocks and fills the missing slots the same way.
 */
export class RegionalAsteroidField {
  private active = new Set<string>();
  private belt: BeltSlotState[];
  private readonly dormant = new Map<string, AsteroidData[]>();
  /** Every dormant rock ID, so slot existence never scans world history. */
  private readonly dormantIds = new Set<string>();
  private changed = new Map<string, AsteroidData[]>();
  private visited = new Set<string>();
  private readonly savedPoweredSectors = new Set<string>();
  /** Generated slots for awake sectors; dropped when the sector sleeps. */
  private readonly layouts = new Map<string, AsteroidData[]>();
  private readonly nextRegrowth = new Map<string, number>();
  /** When this process put an awake sector to sleep. */
  private readonly sleptAt = new Map<string, number>();
  /** Sectors saved before this process started have slept since its first update. */
  private clockStart: number | undefined;
  /** Rock IDs per awake sector at the last committed checkpoint. */
  private readonly flushedMembership = new Map<string, string>();
  private pendingMembership = new Map<string, string>();
  private checkpoints = 0;
  private fullFlushRequested = false;
  private fullFlushInBatch = false;

  constructor(
    private readonly seed: number,
    saved: ReadonlyMap<string, AsteroidData[]> = new Map(),
    savedBelt?: readonly BeltSlotState[]
  ) {
    for (const [id, rocks] of saved) {
      this.putDormant(id, rocks.map(stripTransientProbe));
      if (rocks.some((rock) => rock.boost?.phase === 'burning')) {
        this.savedPoweredSectors.add(id);
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
      const rows = this.dormant.get(sector.id) ?? sectorDeposits(this.seed, sector.x, sector.y);
      if (!savedBelt && !rows.some((existing) => existing.id === rock.id)) {
        this.putDormant(sector.id, [...rows, rock]);
        this.changed.set(sector.id, this.dormant.get(sector.id) ?? []);
      } else if (!this.dormant.has(sector.id)) {
        this.putDormant(sector.id, rows);
      }
    }
  }

  private putDormant(id: string, rows: AsteroidData[]): void {
    this.takeDormant(id);
    this.dormant.set(id, rows);
    for (const rock of rows) {
      this.dormantIds.add(rock.id);
    }
  }

  private takeDormant(id: string): AsteroidData[] | undefined {
    const rows = this.dormant.get(id);
    if (rows) {
      this.dormant.delete(id);
      for (const rock of rows) {
        this.dormantIds.delete(rock.id);
      }
    }
    return rows;
  }

  private load(id: string): AsteroidData[] {
    this.visited.add(id);
    return this.dormant.get(id) ?? this.freshRows(id);
  }

  /** A never-visited sector's generated rows, independent of the cached templates. */
  private freshRows(id: string): AsteroidData[] {
    return this.layout(id).map((slot) => structuredClone(slot));
  }

  /** Move a sector's rows into the simulation. Regrowth catch-up runs in update(). */
  private wake(manager: AsteroidManager, id: string): AsteroidData[] {
    this.visited.add(id);
    const rows = this.takeDormant(id) ?? this.freshRows(id);
    const added: AsteroidData[] = [];
    for (const rock of rows) {
      if (manager.getAsteroid(rock.id)) {
        continue;
      }
      manager.addAsteroid(rock);
      added.push(rock);
    }
    this.active.add(id);
    return added;
  }

  private layout(id: string): AsteroidData[] {
    let slots = this.layouts.get(id);
    if (!slots) {
      const parsed = parseSectorId(id);
      if (!parsed) {
        throw new Error('Invalid sector identity');
      }
      slots = sectorDeposits(this.seed, parsed.x, parsed.y);
      this.layouts.set(id, slots);
    }
    return slots;
  }

  /** Restore missing slots of an awake sector for elapsed intervals, where no observer can see them. */
  private regrow(
    manager: AsteroidManager,
    id: string,
    intervals: number,
    observers: readonly Position[]
  ): AsteroidData[] {
    const missing = this.layout(id).filter(
      (slot) =>
        !manager.getAsteroid(slot.id) &&
        !this.dormantIds.has(slot.id) &&
        // Square, like a scanning pilot's asteroid rows; it contains the radar circle.
        observers.every(
          (observer) =>
            Math.max(
              Math.abs(observer.x - slot.position.x),
              Math.abs(observer.y - slot.position.y)
            ) > DEPOSIT_FIELD.REGROWTH_HIDDEN_DISTANCE
        )
    );
    let remaining = missing.length;
    for (let interval = 0; interval < intervals && remaining > 0; interval++) {
      remaining -= Math.max(1, Math.ceil(remaining * DEPOSIT_FIELD.REGROWTH_FRACTION));
    }
    const grown = missing
      .slice(0, missing.length - Math.max(0, remaining))
      .map((slot) => structuredClone(slot));
    for (const rock of grown) {
      manager.addAsteroid(rock);
    }
    return grown;
  }

  update(
    manager: AsteroidManager,
    observers: readonly Position[],
    now = Date.now()
  ): AsteroidData[] {
    this.clockStart ??= now;
    const clockStart = this.clockStart;
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
    this.sleepDistantSectors(manager, new Set(wanted.keys()), now);
    const created: AsteroidData[] = [];
    for (const id of wanted.keys()) {
      if (!this.active.has(id)) {
        created.push(...this.wake(manager, id));
      }
      const next = this.nextRegrowth.get(id);
      let intervals: number;
      if (next === undefined) {
        // Newly awake, here or by a powered rock during a checkpoint: catch up
        // on the intervals it slept through.
        const slept = this.sleptAt.get(id) ?? clockStart;
        this.sleptAt.delete(id);
        intervals = Math.floor((now - slept) / DEPOSIT_FIELD.REGROWTH_INTERVAL_MS);
      } else if (now >= next) {
        intervals = 1;
      } else {
        continue;
      }
      created.push(...this.regrow(manager, id, intervals, observers));
      this.nextRegrowth.set(id, now + DEPOSIT_FIELD.REGROWTH_INTERVAL_MS);
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
        this.putDormant(sector, rows);
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

  private sleepDistantSectors(
    manager: AsteroidManager,
    wanted: ReadonlySet<string>,
    now?: number
  ): void {
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
      const wasActive = this.active.has(id);
      const prior = wasActive ? [] : this.load(id);
      const saved = [...new Map([...prior, ...rows].map((rock) => [rock.id, rock])).values()];
      this.putDormant(id, saved);
      this.changed.set(id, saved);
      this.layouts.delete(id);
      this.nextRegrowth.delete(id);
      this.flushedMembership.delete(id);
      if (wasActive && now !== undefined) {
        this.sleptAt.set(id, now);
      }
      for (const rock of rows) {
        manager.removeAsteroid(rock.id);
      }
    }
  }

  /**
   * The next checkpoint writes every awake sector, including drift and damage
   * that periodic flushes defer. The request survives until a checkpoint is
   * saved, so a flush deferred behind a busy writer still honors it.
   */
  requestFullFlush(): void {
    this.fullFlushRequested = true;
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
        this.wake(manager, id);
      }
    }
    this.sleepDistantSectors(manager, this.active);
    const awake = new Map<string, AsteroidData[]>([...this.active].map((id) => [id, []]));
    for (const rock of manager.getAllAsteroids()) {
      const id = sectorAt(rock.position).id;
      const sector = awake.get(id);
      if (!sector) {
        throw new Error(`Active asteroid ${rock.id} has no sector ${id}`);
      }
      sector.push(stripTransientProbe(rock));
    }
    // Membership changes (mined, regrown, carried across an edge) leave within
    // a second. Drift alone is written every few checkpoints: a hard crash
    // rewinds rocks a few seconds along their paths, never loses or duplicates one.
    const driftDue =
      this.fullFlushRequested || this.checkpoints % WORLD.driftFlushCheckpoints === 0;
    this.fullFlushInBatch = this.fullFlushRequested;
    const rows = new Map(this.changed);
    this.pendingMembership = new Map();
    for (const [id, sector] of awake) {
      const membership = sector.map((rock) => rock.id).join(',');
      if (driftDue || this.flushedMembership.get(id) !== membership) {
        rows.set(id, sector);
        this.pendingMembership.set(id, membership);
      }
    }
    return rows;
  }

  /** The pending changes were handed to persistence; dormant rows stay as the in-memory world. */
  saved(): void {
    this.changed.clear();
    for (const [id, membership] of this.pendingMembership) {
      this.flushedMembership.set(id, membership);
    }
    this.pendingMembership.clear();
    this.checkpoints += 1;
    if (this.fullFlushInBatch) {
      this.fullFlushRequested = false;
      this.fullFlushInBatch = false;
    }
  }

  reset(): void {
    this.active.clear();
    this.dormant.clear();
    this.dormantIds.clear();
    this.changed.clear();
    this.visited.clear();
    this.savedPoweredSectors.clear();
    this.layouts.clear();
    this.nextRegrowth.clear();
    this.sleptAt.clear();
    this.clockStart = undefined;
    this.flushedMembership.clear();
    this.pendingMembership.clear();
    this.checkpoints = 0;
    this.fullFlushRequested = false;
    this.fullFlushInBatch = false;
    this.belt = beltSlots().map((slot) => ({ slot, generation: 0, recoverAt: null }));
    for (const entry of this.belt) {
      const rock = beltAsteroid(this.seed, entry.slot, 0);
      const sector = sectorAt(rock.position);
      const rows = [
        ...(this.dormant.get(sector.id) ?? sectorDeposits(this.seed, sector.x, sector.y)),
        rock,
      ];
      this.putDormant(sector.id, rows);
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
