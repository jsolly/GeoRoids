import { COOPERATIVE } from '../../shared/cooperativeRules';
import { hazardPhase } from '../../shared/worldHazards';
import type { Position } from '../../shared-types';
import type { GameEntity } from './EntityManager';
import type { TerrainSpiderManager } from './TerrainSpiderManager';

/** Event ownership is explicit so expiration never removes ordinary or queen-owned spiders. */
export class WorldHazards {
  private window: number | null = null;
  private readonly swarm = new Set<string>();
  private nextSpawnAt = 0;
  private lastNow = 0;
  private sequence = 0;
  private meteors: { id: string; position: Position; velocity: Position; expiresAt: number }[] = [];
  constructor(private readonly spiders: TerrainSpiderManager) {}

  advance(now: number, players: readonly GameEntity[], hit: (id: string) => void): void {
    const phase = hazardPhase(now);
    if (phase.phase !== 'active' || this.window !== phase.startsAt || now < this.lastNow) {
      this.clearActors();
      this.window = phase.phase === 'active' ? phase.startsAt : null;
      this.nextSpawnAt = now;
    }
    this.lastNow = now;
    if (phase.phase !== 'active') {
      return;
    }
    const crew = players.filter((p) => p.ws && p.health > 0 && !p.exploding && !p.furnaceTransit);
    for (const id of this.swarm) {
      if (!this.spiders.getBody(id)) {
        this.swarm.delete(id);
      }
    }
    this.meteors = this.meteors.filter((m) => m.expiresAt > now);
    if (!crew.length) {
      this.clearActors();
      return;
    }
    if (now >= this.nextSpawnAt) {
      this.nextSpawnAt = now + 1000;
      const pilot = crew[this.sequence++ % crew.length];
      if (pilot) {
        const angle = this.sequence * 2.4;
        const position = {
          x: pilot.position.x + Math.cos(angle) * 700,
          y: pilot.position.y + Math.sin(angle) * 700,
        };
        if (phase.kind === 'swarm' && this.swarm.size < COOPERATIVE.swarmSlots) {
          const spider = this.spiders.spawnSpider(position, angle + Math.PI, true);
          if (spider) {
            this.swarm.add(spider.id);
          }
        } else if (phase.kind === 'meteors' && this.meteors.length < 12) {
          this.meteors.push({
            id: `meteor:${phase.startsAt}:${this.sequence}`,
            position,
            velocity: { x: -Math.cos(angle) * 5, y: -Math.sin(angle) * 5 },
            expiresAt: Math.min(phase.endsAt, now + 8000),
          });
        }
      }
    }
    const targets = players.filter(
      (p) => (p.ws || p.botRole) && p.health > 0 && !p.exploding && !p.furnaceTransit
    );
    for (const meteor of this.meteors) {
      meteor.position.x += meteor.velocity.x;
      meteor.position.y += meteor.velocity.y;
      for (const pilot of targets) {
        if (
          Math.hypot(pilot.position.x - meteor.position.x, pilot.position.y - meteor.position.y) <=
          48
        ) {
          hit(pilot.id);
          meteor.expiresAt = now;
          break;
        }
      }
    }
  }
  private clearActors(): void {
    for (const id of this.swarm) {
      this.spiders.removeSpider(id);
    }
    this.swarm.clear();
    this.meteors = [];
  }
  reset(): void {
    this.clearActors();
    this.window = null;
    this.nextSpawnAt = 0;
    this.lastNow = 0;
    this.sequence = 0;
  }
  snapshot() {
    return this.meteors.map((m) => ({ id: m.id, position: { ...m.position } }));
  }
  swarmCount(): number {
    return this.swarm.size;
  }
}
