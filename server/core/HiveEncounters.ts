import { COOPERATIVE, QUEEN_COMBAT } from '../../shared/cooperativeRules';
import { frontierSite, frontierSitesNear, sacPosition } from '../../shared/frontier';
import { type AbilityBody, harpoonSurfaceGap } from '../../shared/shipAbilities';
import { SHIP_ABILITY } from '../../shared/shipKits';
import { isTowCableUtility } from '../../shared/shipUtilities';
import type { CampaignSnapshot, CooperativeRecord, Position } from '../../shared-types';
import type { GameEntity } from './EntityManager';
import type { HiveEncounterInputs } from './types';

type Hive = Extract<CooperativeRecord, { kind: 'hive' }>;
const ACTIVE_RADIUS = 4200;
/** Only nearby encounters tick. Persistent rows are touched by identity, not scanned per frame. */
export class HiveEncounters {
  private readonly cleared = new Set<string>();
  private active = new Map<string, Hive>();
  private readonly children = new Map<string, Set<string>>();
  private readonly lastHit = new Map<string, { owner: string; position: Position; at: number }>();
  private readonly shieldUntil = new Map<string, number>();
  private pinned = new Set<string>();

  constructor(private readonly inputs: HiveEncounterInputs) {
    for (const row of inputs.campaign.all()) {
      if (row.kind === 'hive' && row.clearedAt !== null) {
        this.cleared.add(row.id);
      }
    }
  }

  reset(): void {
    for (const id of this.children.keys()) {
      this.removeChildren(id);
    }
    this.active.clear();
    this.cleared.clear();
    this.lastHit.clear();
    this.shieldUntil.clear();
    this.pinned.clear();
  }

  clearedIds(): string[] {
    return [...this.cleared];
  }

  private refresh(players: readonly GameEntity[]): void {
    const expanded =
      this.inputs.campaign.get('project', 'deep-scanner')?.completedAt !== null &&
      Boolean(this.inputs.campaign.get('project', 'deep-scanner'));
    const next = new Map<string, Hive>();
    for (const player of players) {
      if (!player.ws) {
        continue;
      }
      for (const site of frontierSitesNear(player.position, ACTIVE_RADIUS)) {
        if (site.frontier === 'expanded' && !expanded) {
          continue;
        }
        let hive = this.inputs.campaign.get('hive', site.id);
        if (hive == null) {
          hive = {
            kind: 'hive',
            id: site.id,
            position: site.position,
            frontier: site.frontier,
            queenHealth: COOPERATIVE.queenHealth,
            birthFramesLeft: COOPERATIVE.birthFrames,
            clearedAt: null,
            sacs: Array<number>(site.frontier === 'initial' ? 2 : 3).fill(COOPERATIVE.sacHealth),
            sacDeadline: null,
            sacsCompletedAt: null,
            restoredValue: 0,
            contributors: [],
            commissionedAt: null,
          };
          this.inputs.campaign.set(hive);
        }
        next.set(hive.id, hive);
      }
    }
    for (const id of this.active.keys()) {
      if (!next.has(id)) {
        this.removeChildren(id);
        this.lastHit.delete(id);
        this.shieldUntil.delete(id);
      }
    }
    this.active = next;
  }

  advance(frame: number, now: number): void {
    if (!this.inputs.campaign.activated) {
      return;
    }
    this.inputs.population.refresh();
    const players = this.inputs.actors
      .getAllEntities()
      .filter((actor) => actor.botRole === undefined);
    if (frame % 60 === 1) {
      this.refresh(players);
    }
    this.pinned = new Set(
      players
        .filter(
          (p) =>
            p.ws &&
            p.health > 0 &&
            !p.exploding &&
            !p.overlayHold &&
            isTowCableUtility(p) &&
            p.harpoonTargetId &&
            this.active.has(p.harpoonTargetId) &&
            harpoonSurfaceGap(p, {
              id: p.harpoonTargetId,
              position: this.active.get(p.harpoonTargetId)?.position ?? {
                x: Infinity,
                y: Infinity,
              },
              velocity: { x: 0, y: 0 },
              size: QUEEN_COMBAT.radius,
            }) <=
              SHIP_ABILITY.HARPOON_RANGE * 3 * SHIP_ABILITY.HARPOON_SLACK
        )
        .map((p) => p.harpoonTargetId ?? '')
    );
    for (const hive of this.active.values()) {
      if (hive.sacDeadline !== null && now >= hive.sacDeadline) {
        hive.sacs.fill(COOPERATIVE.sacHealth);
        hive.sacDeadline = null;
        this.inputs.campaign.set(hive);
      }
      if (hive.clearedAt !== null) {
        continue;
      }
      const children = this.children.get(hive.id) ?? new Set<string>();
      for (const id of children) {
        if (!this.inputs.spiders.getBody(id)) {
          children.delete(id);
        }
      }
      this.children.set(hive.id, children);
      if (hive.birthFramesLeft > 0) {
        hive.birthFramesLeft--;
      }
      if (hive.birthFramesLeft === 0 && children.size < COOPERATIVE.childrenPerHive) {
        const theta = children.size * 2.4;
        const child = this.inputs.spiders.spawnSpider({
          x: hive.position.x + Math.cos(theta) * 180,
          y: hive.position.y + Math.sin(theta) * 180,
        });
        if (child) {
          children.add(child.id);
          hive.birthFramesLeft = COOPERATIVE.birthFrames;
        }
      }
      this.inputs.campaign.set(hive);
    }
  }

  private nearby(position: Position, radius: number): Hive[] {
    return frontierSitesNear(position, radius).flatMap((site) => {
      const hive = this.active.get(site.id);
      return hive != null ? [hive] : [];
    });
  }
  body(id: string): (AbilityBody & { size: number }) | undefined {
    const hive = this.active.get(id);
    return hive != null && hive.clearedAt === null
      ? {
          id,
          kind: 'spider',
          position: { ...hive.position },
          velocity: { x: 0, y: 0 },
          size: QUEEN_COMBAT.radius,
          health: hive.queenHealth,
        }
      : undefined;
  }
  bodiesNear(position: Position, radius: number): (AbilityBody & { size: number })[] {
    return this.nearby(position, radius + QUEEN_COMBAT.radius).flatMap((hive) => {
      const body = this.body(hive.id);
      return body ? [body] : [];
    });
  }
  ruinsNear(position: Position) {
    return this.nearby(position, 85)
      .filter((hive) => hive.clearedAt !== null && hive.commissionedAt === null)
      .flatMap((hive) => {
        const site = frontierSite(hive.id);
        return site ? [site] : [];
      });
  }
  targetsNear(
    position: Position,
    radius: number
  ): { id: string; position: Position; radius: number }[] {
    return this.nearby(position, radius + COOPERATIVE.sacSpacing).flatMap((h) => [
      ...(h.clearedAt === null
        ? [{ id: h.id, position: h.position, radius: QUEEN_COMBAT.radius }]
        : []),
      ...h.sacs.flatMap((hp, i) =>
        hp > 0
          ? [
              {
                id: `${h.id}/sac/${i}`,
                position: sacPosition(h.position, i, h.sacs.length),
                radius: 34,
              },
            ]
          : []
      ),
    ]);
  }
  shieldOpen(id: string, now: number): boolean {
    return this.pinned.has(id) || now < (this.shieldUntil.get(id) ?? 0);
  }
  hit(id: string, owner: GameEntity, damage: number, now: number): boolean {
    const [hiveId, sac] = id.split('/sac/');
    const hive = hiveId ? this.active.get(hiveId) : undefined;
    if (hive == null || !Number.isFinite(damage) || damage <= 0) {
      return false;
    }
    if (sac !== undefined) {
      const index = Number(sac),
        hp = hive.sacs[index];
      if (hp === undefined || hp <= 0 || hive.sacsCompletedAt !== null) {
        return false;
      }
      hive.sacs[index] = Math.max(0, hp - damage);
      if (hive.sacs[index] === 0 && hive.sacDeadline === null) {
        hive.sacDeadline = Math.floor(now + COOPERATIVE.sacWindowMs);
      }
      if (hive.sacs.every((value) => value === 0)) {
        hive.sacsCompletedAt = Math.floor(now);
        hive.sacDeadline = null;
      }
    } else {
      if (hive.clearedAt !== null) {
        return false;
      }
      const previous = this.lastHit.get(id);
      if (
        previous &&
        previous.owner !== owner.id &&
        now - previous.at <= QUEEN_COMBAT.oppositeWindowMs
      ) {
        const ax = previous.position.x - hive.position.x,
          ay = previous.position.y - hive.position.y;
        const bx = owner.position.x - hive.position.x,
          by = owner.position.y - hive.position.y;
        const length = Math.hypot(ax, ay) * Math.hypot(bx, by);
        if (length > 0 && (ax * bx + ay * by) / length <= QUEEN_COMBAT.oppositeCosine) {
          this.shieldUntil.set(id, now + QUEEN_COMBAT.shieldWindowMs);
        }
      }
      this.lastHit.set(id, { owner: owner.id, position: { ...owner.position }, at: now });
      if (!this.shieldOpen(id, now)) {
        return false;
      }
      hive.queenHealth = Math.max(0, hive.queenHealth - damage);
      if (hive.queenHealth === 0) {
        hive.clearedAt = Math.floor(now);
        this.cleared.add(hive.id);
        this.removeChildren(id);
        this.pinned.delete(id);
      }
    }
    this.inputs.campaign.set(hive);
    return true;
  }
  private removeChildren(id: string): void {
    for (const child of this.children.get(id) ?? []) {
      this.inputs.spiders.removeSpider(child);
    }
    this.children.delete(id);
  }
  snapshot(now: number): CampaignSnapshot['hives'] {
    return [...this.active.values()].map((h) => ({
      ...h,
      sacs: [...h.sacs],
      contributors: [...h.contributors],
      shieldOpen: this.shieldOpen(h.id, now),
    }));
  }
}
