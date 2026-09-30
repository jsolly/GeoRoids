import type { Position, TerrainSpider, Velocity } from '../../shared-types';

type ShotEvent =
  | {
      kind: 'admission';
      requestId: string | null;
      projectileId: string | null;
      rejectionReason: string | null;
      start: Position;
      velocity: Velocity;
      shooter: unknown;
    }
  | {
      kind: 'segment';
      projectileId: string;
      start: Position;
      end: Position;
      candidates: unknown;
    }
  | {
      kind: 'terminal';
      projectileId: string;
      reason: string;
      targetId: string | null;
      position: Position;
      targetBefore: unknown;
      targetAfter: unknown;
    };

/** Opt-in local fixture evidence. No history is allocated until a test control enables it. */
export class FixtureCombatRecorder {
  private events: (ShotEvent & { ownerId: string; gameTime: number; sequence: number })[] = [];
  private important: (ShotEvent & { ownerId: string; gameTime: number; sequence: number })[] = [];
  private sequence = 0;
  private dropped = 0;
  private owners: ReadonlySet<string> = new Set();

  start(owners: readonly string[]): void {
    this.owners = new Set(owners);
    this.events = [];
    this.important = [];
    this.sequence = 0;
    this.dropped = 0;
  }

  watches(ownerId: string): boolean {
    return this.owners.has(ownerId);
  }

  record(ownerId: string, gameTime: number, event: ShotEvent): void {
    if (!this.watches(ownerId)) {
      return;
    }
    const rows = event.kind === 'segment' ? this.events : this.important;
    const limit = event.kind === 'segment' ? 1024 : 64;
    if (rows.length >= limit) {
      this.dropped++;
      return;
    }
    rows.push(structuredClone({ ...event, ownerId, gameTime, sequence: this.sequence++ }));
  }

  read() {
    return structuredClone({
      events: [...this.events, ...this.important].sort((a, b) => a.sequence - b.sequence),
      dropped: this.dropped,
    });
  }
}

/** Keep crawler competition by value even when the hit removes the body. */
export function crawlerEvidence(body: TerrainSpider | undefined) {
  return body ? structuredClone(body) : null;
}
