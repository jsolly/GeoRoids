import type { LootData, Position } from '../../../shared-types';

/** Client snapshot of server-authoritative loot. */
export class LootField {
  private static instance: LootField;
  private loot: LootData[] = [];
  private blast: { position: Position; radius: number; until: number } | null = null;

  static getInstance(): LootField {
    if (!LootField.instance) {
      LootField.instance = new LootField();
    }
    return LootField.instance;
  }

  applySnapshot(loot: LootData[]): void {
    // Reserved wreckage rows are not collectible world loot.
    this.loot = loot
      .filter((drop) => drop.kind !== 'wreckage')
      .map((drop) => ({
        id: drop.id,
        position: { x: drop.position.x, y: drop.position.y },
        mass: drop.mass,
        radius: drop.radius,
        kind: drop.kind,
        ...(drop.points !== undefined ? { points: drop.points } : {}),
      }));
  }

  getAll(): LootData[] {
    return this.loot;
  }

  remove(lootId: string): void {
    this.loot = this.loot.filter((drop) => drop.id !== lootId);
  }

  noteBlast(position: Position, radius: number, durationMs = 220): void {
    this.blast = {
      position: { x: position.x, y: position.y },
      radius,
      until: performance.now() + durationMs,
    };
  }

  getBlast(): { position: Position; radius: number } | null {
    if (!this.blast) {
      return null;
    }
    if (performance.now() > this.blast.until) {
      this.blast = null;
      return null;
    }
    return this.blast;
  }

  clear(): void {
    this.loot = [];
    this.blast = null;
  }
}
