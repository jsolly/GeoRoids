import { EQUIPMENT_DROPS, EQUIPMENT_IDS, isEquipmentId } from '../../shared/equipment';
import {
  addLootMagnetPull,
  canCollectLoot,
  GROWTH,
  lootOverlap,
  planKillLoot,
} from '../../shared/shipGrowth';
import type { EquipmentId, LootData, Position, Velocity } from '../../shared-types';
import { hullRadiusForKit } from '../../src/entities/ship/shipKits';
import type { GameEntity } from './EntityManager';
import type { RNGService } from './RNGService';

interface TrackedLoot extends LootData {
  expiresAt: number;
  velocity: Velocity;
  ejectFramesLeft?: number;
  nestCache?: true;
}

export class LootManager {
  private loot = new Map<string, TrackedLoot>();
  private nextId = 1;
  private rng: RNGService;

  constructor(rngService: RNGService) {
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

  /** One ejected canister during a Resource Tap extract. The rock stays in the field. */
  public spawnTap(position: Position, gameTime: number, velocity: Velocity): LootData {
    const drop: TrackedLoot = {
      id: `tap-${this.nextId++}`,
      position: { x: position.x, y: position.y },
      mass: GROWTH.TAP_LOOT_MASS,
      radius: GROWTH.TAP_LOOT_RADIUS,
      kind: 'tap',
      expiresAt: gameTime + GROWTH.LOOT_TTL_FRAMES,
      velocity: { ...velocity },
      ejectFramesLeft: GROWTH.TAP_LOOT_EJECT_FRAMES,
    };
    this.loot.set(drop.id, drop);
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
    this.loot.set(drop.id, drop);
    this.enforceCap();
    return this.toPublic(drop);
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
    this.loot.set(drop.id, drop);
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
      this.spawnLaserCore(at(5), gameTime),
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
      }
    }
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

    const claimedEquipment = new Map<string, Set<EquipmentId>>();
    const drops = [...this.loot.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const drop of drops) {
      if ((drop.ejectFramesLeft ?? 0) > 0) {
        continue;
      }
      const winner = collectors.find((entity) => {
        if (
          isEquipmentId(drop.kind) &&
          (entity.equipment?.includes(drop.kind) || claimedEquipment.get(entity.id)?.has(drop.kind))
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
      }
      this.loot.delete(drop.id);
      collected.push({ collector: winner, loot: this.toPublic(drop) });
    }

    return collected;
  }

  public expire(gameTime: number, collectors: readonly GameEntity[] = []): void {
    const liveCollectors = collectors.filter((entity) => canCollectLoot(entity));
    const magnetPositions = liveCollectors.map((entity) => entity.position);
    const haulerPositions = liveCollectors
      .filter((entity) => entity.kitId === 'hauler')
      .map((entity) => entity.position);

    for (const [id, drop] of this.loot) {
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
            .filter((entity) => !entity.equipment?.includes(equipment))
            .map((entity) => entity.position)
        );
      } else {
        addLootMagnetPull(drop, magnetPositions);
      }
      drop.position.x += drop.velocity.x;
      drop.position.y += drop.velocity.y;
      drop.velocity.x *= GROWTH.LOOT_DRAG;
      drop.velocity.y *= GROWTH.LOOT_DRAG;
      if (gameTime >= drop.expiresAt) {
        this.loot.delete(id);
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
    const oldest = [...this.loot.values()];
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

    return publicDrop;
  }
}
