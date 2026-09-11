import { createFuelLootData, isFuelLoot, shouldReleaseFuel } from '../../shared/fuel';
import { canCollectLoot, GROWTH, lootOverlap, planKillLoot } from '../../shared/shipGrowth';
import type { AsteroidData, LootData, Position, Velocity } from '../../shared-types';
import { FUEL } from '../../src/constants';
import { applyQuakeImpulse } from '../../src/entities/ship/quakeImpulse';
import type { GameEntity } from './EntityManager';
import { QUAKE_KNOCKBACK_DECAY } from './quakeMotion';
import type { RNGService } from './RNGService';

interface TrackedLoot extends LootData {
  expiresAt: number;
  velocity: Velocity;
}

export class LootManager {
  private loot = new Map<string, TrackedLoot>();
  private nextId = 1;
  private rng: RNGService;

  constructor(rngService: RNGService) {
    this.rng = rngService;
  }

  public spawnFuelFromAsteroid(asteroid: AsteroidData, gameTime: number): LootData | undefined {
    if (!shouldReleaseFuel(asteroid.size)) {
      return undefined;
    }
    const drop: TrackedLoot = {
      ...createFuelLootData(`fuel-${this.nextId++}`, asteroid.position),
      expiresAt: gameTime + GROWTH.LOOT_TTL_FRAMES,
      velocity: { x: 0, y: 0 },
    };
    this.loot.set(drop.id, drop);
    this.enforceCap();
    return this.toPublic(drop);
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
      this.loot.set(drop.id, drop);
      spawned.push(this.toPublic(drop));
    }

    this.enforceCap();
    return spawned;
  }

  /** One shard at the break site. Collect uses the existing overlap/growth path. */
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
      expiresAt: gameTime + GROWTH.LOOT_TTL_FRAMES,
      velocity: { x: 0, y: 0 },
    };
    this.loot.set(drop.id, drop);
    this.enforceCap();
    return this.toPublic(drop);
  }

  public get(lootId: string): LootData | undefined {
    const drop = this.loot.get(lootId);
    return drop ? this.toPublic(drop) : undefined;
  }

  public spawnLaserCore(position: Position, gameTime: number): LootData {
    const drop: TrackedLoot = {
      id: `core-${this.nextId++}`,
      position: { ...position },
      mass: 0,
      radius: GROWTH.LOOT_RADIUS + 3,
      kind: 'laserCore',
      expiresAt: gameTime + GROWTH.LOOT_TTL_FRAMES,
      velocity: { x: 0, y: 0 },
    };
    this.loot.set(drop.id, drop);
    this.enforceCap();
    return this.toPublic(drop);
  }

  public remove(lootId: string): LootData | undefined {
    const drop = this.loot.get(lootId);
    if (!drop) {
      return undefined;
    }
    this.loot.delete(lootId);
    return this.toPublic(drop);
  }

  public collectOverlaps(entities: GameEntity[]): Array<{ collector: GameEntity; loot: LootData }> {
    const collected: Array<{ collector: GameEntity; loot: LootData }> = [];
    const collectors = entities
      .filter((entity) => canCollectLoot(entity))
      .sort((a, b) => a.id.localeCompare(b.id));

    const drops = [...this.loot.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const drop of drops) {
      const winner = collectors.find((entity) => {
        if (
          !lootOverlap(entity.position, entity.mass ?? GROWTH.BASE_MASS, drop.position, drop.radius)
        ) {
          return false;
        }
        if (isFuelLoot(drop) && (entity.fuel ?? FUEL.START) >= (entity.maxFuel ?? FUEL.MAX)) {
          return false;
        }
        return true;
      });
      if (!winner) {
        continue;
      }
      this.loot.delete(drop.id);
      collected.push({ collector: winner, loot: this.toPublic(drop) });
    }

    return collected;
  }

  public expire(gameTime: number): void {
    for (const [id, drop] of this.loot) {
      drop.position.x += drop.velocity.x;
      drop.position.y += drop.velocity.y;
      drop.velocity.x *= QUAKE_KNOCKBACK_DECAY;
      drop.velocity.y *= QUAKE_KNOCKBACK_DECAY;
      if (gameTime >= drop.expiresAt) {
        this.loot.delete(id);
      }
    }
  }

  /** Apply a Quake kick to every live loot body; motion advances in expire(). */
  public applyQuakePulse(origin: Position, fallbackAngle = 0): number {
    let affected = 0;
    for (const drop of this.loot.values()) {
      if (applyQuakeImpulse(drop, origin, fallbackAngle)) {
        affected += 1;
      }
    }
    return affected;
  }

  public getAll(): LootData[] {
    return [...this.loot.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((drop) => this.toPublic(drop));
  }

  public getCount(): number {
    return this.loot.size;
  }

  public clear(): void {
    this.loot.clear();
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
    if (this.loot.size <= GROWTH.MAX_LOOT) {
      return;
    }
    const oldest = [...this.loot.values()].sort((a, b) => a.id.localeCompare(b.id));
    const overflow = this.loot.size - GROWTH.MAX_LOOT;
    for (let i = 0; i < overflow; i++) {
      const drop = oldest[i];
      if (drop) {
        this.loot.delete(drop.id);
      }
    }
  }

  private toPublic(drop: TrackedLoot): LootData {
    const publicDrop: LootData = {
      id: drop.id,
      position: { x: drop.position.x, y: drop.position.y },
      mass: drop.mass,
      radius: drop.radius,
      kind: drop.kind,
    };
    if (isFuelLoot(drop)) {
      publicDrop.kind = 'fuel';
      publicDrop.fuel = drop.fuel ?? FUEL.DROP_AMOUNT;
    }
    return publicDrop;
  }
}
