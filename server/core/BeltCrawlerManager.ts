import { beltSlotForAsteroid } from '../../shared/asteroidBelt';
import { segmentCircleContact } from '../../shared/asteroidPhenomena';
import {
  asteroidPolygonPoints,
  findNearestAsteroidImpact,
  REFLECTION_LIMITS,
} from '../../shared/asteroidReflection';
import { BELT_CRAWLER } from '../../shared/beltCrawler';
import type { AsteroidData, Position, TerrainSpider } from '../../shared-types';
import { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';
import type { SpiderAttack } from './TerrainSpiderManager';

interface Actor {
  id: string;
  position: Position;
  health: number;
  exploding: boolean;
  respawnTimer?: number;
  spawnProtectionTimer?: number;
  radius?: number;
}
interface AdvanceOptions {
  rocks: readonly AsteroidData[];
  players: readonly Actor[];
  nowFrame: number;
}
interface BodyHit {
  kind: 'spider';
  spiderId: string;
  point: Position;
  distance: number;
}
interface Crawler extends TerrainSpider {
  crawler: NonNullable<TerrainSpider['crawler']>;
  host: AsteroidData;
  index: number;
  perimeterFraction: number;
  phaseStart: number;
  direction: Position;
  struck: boolean;
  escape: { from: Position } | null;
  pursuit: { hostId: string; departureFraction: number } | null;
  nextPlanFrame: number;
}
interface Landing {
  host: AsteroidData;
  fraction: number;
  anchor: Position;
  position: Position;
}
interface Edge {
  a: Position;
  b: Position;
  length: number;
  start: number;
}
function contour(host: AsteroidData): { edges: Edge[]; length: number } {
  const points = asteroidPolygonPoints(host);
  const edges: Edge[] = [];
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) {
      continue;
    }
    const edgeLength = Math.hypot(b.x - a.x, b.y - a.y);
    if (edgeLength === 0) {
      continue;
    }
    edges.push({ a, b, length: edgeLength, start: length });
    length += edgeLength;
  }
  return { edges, length };
}
function surface(
  edges: readonly Edge[],
  distance: number
): { anchor: Position; position: Position } {
  const edge =
    edges.find((candidate) => distance <= candidate.start + candidate.length) ?? edges[0];
  if (!edge) {
    throw new Error('Crawler host has no surface');
  }
  const progress = Math.max(0, Math.min(1, (distance - edge.start) / edge.length));
  const anchor = {
    x: edge.a.x + (edge.b.x - edge.a.x) * progress,
    y: edge.a.y + (edge.b.y - edge.a.y) * progress,
  };
  return {
    anchor,
    position: {
      x: anchor.x + ((edge.b.y - edge.a.y) / edge.length) * BELT_CRAWLER.SURFACE_OFFSET,
      y: anchor.y - ((edge.b.x - edge.a.x) / edge.length) * BELT_CRAWLER.SURFACE_OFFSET,
    },
  };
}
function nearestDistance(edges: readonly Edge[], target: Position): number {
  let best = Number.POSITIVE_INFINITY;
  let result = 0;
  for (const edge of edges) {
    const dx = edge.b.x - edge.a.x;
    const dy = edge.b.y - edge.a.y;
    const fraction = Math.max(
      0,
      Math.min(
        1,
        ((target.x - edge.a.x) * dx + (target.y - edge.a.y) * dy) / (edge.length * edge.length)
      )
    );
    const distance = Math.hypot(
      target.x - edge.a.x - dx * fraction,
      target.y - edge.a.y - dy * fraction
    );
    if (distance < best) {
      best = distance;
      result = edge.start + edge.length * fraction;
    }
  }
  return result;
}

/** Sparse surface predators pursue across nearby rocks with short, unobstructed hops. */
export class BeltCrawlerManager {
  private readonly bodies = new Map<string, Crawler>();
  private rocks: readonly AsteroidData[] = [];
  private spatial = new AsteroidSpatialIndex([]);
  private players: readonly Actor[] = [];

  public constructor(private readonly liveHost?: (id: string) => AsteroidData | undefined) {}

  public clear(): void {
    this.bodies.clear();
    this.rocks = [];
    this.spatial = new AsteroidSpatialIndex([]);
    this.players = [];
  }

  public getBody(id: string): TerrainSpider | undefined {
    return this.bodies.get(id);
  }

  public snapshot(): TerrainSpider[] {
    return [...this.bodies.values()].map((body) => ({
      id: body.id,
      position: { ...body.position },
      angle: body.angle,
      health: body.health,
      maxHealth: body.maxHealth,
      phase: body.phase,
      targetId: body.targetId,
      crawler: { ...body.crawler, anchor: { ...body.crawler.anchor } },
    }));
  }

  public isAttackActive(attack: SpiderAttack, rocks = this.rocks): boolean {
    const body = this.bodies.get(attack.spiderId);
    const target = this.players.find((player) => player.id === attack.targetId);
    return (
      body !== undefined &&
      target !== undefined &&
      rocks.some((rock) => rock.id === body.host.id && rock.health > 0) &&
      body.crawler.phase === 'lunging' &&
      body.targetId === attack.targetId &&
      !this.impact(body.position, target.position, new AsteroidSpatialIndex(rocks))
    );
  }

  public advance({ rocks, players, nowFrame }: AdvanceOptions): SpiderAttack[] {
    this.rocks = rocks;
    this.spatial = new AsteroidSpatialIndex(rocks);
    this.players = players;
    const hosts = new Map(rocks.map((rock) => [rock.id, rock]));
    for (const [id, body] of this.bodies) {
      if (!hosts.has(body.host.id) || (hosts.get(body.host.id)?.health ?? 0) <= 0) {
        this.bodies.delete(id);
      }
    }
    const attacks: SpiderAttack[] = [];
    const alive = players.filter(
      (player) => player.health > 0 && !player.exploding && player.respawnTimer === undefined
    );
    const processed = new Set<string>();
    for (const host of rocks) {
      const slot = beltSlotForAsteroid(host.id);
      if (host.health <= 0 || (!host.beltCrawlerIds && (slot === undefined || slot % 6 !== 0))) {
        continue;
      }
      this.initializeHost(host);
      const shape = contour(host);
      for (const [index, health] of (host.beltCrawlerHealth ?? []).entries()) {
        const id = host.beltCrawlerIds?.[index] ?? `belt-crawler:${host.id}:${index}`;
        if (health <= 0) {
          if (this.bodies.get(id)?.host.id === host.id) {
            this.bodies.delete(id);
          }
          continue;
        }
        if (processed.has(id)) {
          continue;
        }
        processed.add(id);
        let body = this.bodies.get(id);
        if (!body) {
          if (this.bodies.size >= BELT_CRAWLER.MAX_ACTIVE) {
            continue;
          }
          body = {
            id,
            host,
            index,
            perimeterFraction: 0,
            phaseStart: nowFrame,
            direction: { x: 1, y: 0 },
            struck: false,
            escape: null,
            pursuit: null,
            nextPlanFrame: nowFrame,
            position: { ...host.position },
            angle: 0,
            health,
            maxHealth: BELT_CRAWLER.MAX_HEALTH,
            phase: 'scuttling',
            targetId: null,
            crawler: {
              hostId: host.id,
              anchor: { ...host.position },
              phase: 'crawling',
              progress: 0,
            },
          };
          this.bodies.set(id, body);
        }
        body.host = host;
        body.health = health;
        if (body.escape) {
          const placement = surface(shape.edges, body.perimeterFraction * shape.length);
          const progress = Math.min(1, (nowFrame - body.phaseStart) / BELT_CRAWLER.ESCAPE_FRAMES);
          const next = {
            x: body.escape.from.x + (placement.position.x - body.escape.from.x) * progress,
            y: body.escape.from.y + (placement.position.y - body.escape.from.y) * progress,
          };
          if (
            Math.hypot(
              placement.position.x - body.escape.from.x,
              placement.position.y - body.escape.from.y
            ) > BELT_CRAWLER.ESCAPE_DISTANCE ||
            this.enclosed(body.position) ||
            this.enclosed(next) ||
            this.impact(body.position, next)
          ) {
            host.beltCrawlerHealth?.splice(index, 1, 0);
            this.bodies.delete(id);
            continue;
          }
          body.position = next;
          body.crawler.anchor = placement.anchor;
          body.crawler.progress = progress;
          if (progress === 1) {
            body.escape = null;
            body.crawler.phase = 'recovering';
            body.phaseStart = nowFrame;
          }
          continue;
        }
        const target = alive.reduce<Actor | undefined>((nearest, player) => {
          const distance = Math.hypot(
            player.position.x - host.position.x,
            player.position.y - host.position.y
          );
          if (distance > host.size + BELT_CRAWLER.ACQUIRE_DISTANCE) {
            return nearest;
          }
          return !nearest ||
            distance <
              Math.hypot(nearest.position.x - host.position.x, nearest.position.y - host.position.y)
            ? player
            : nearest;
        }, undefined);
        if (body.crawler.phase === 'crawling' && target) {
          if (nowFrame >= body.nextPlanFrame) {
            body.pursuit = this.pursuitRoute(body, target);
            body.nextPlanFrame = nowFrame + BELT_CRAWLER.PURSUIT_REPLAN_FRAMES;
          }
          const desired = body.pursuit
            ? body.pursuit.departureFraction * shape.length
            : nearestDistance(shape.edges, target.position);
          const current = body.perimeterFraction * shape.length;
          const delta =
            ((desired - current + shape.length * 1.5) % shape.length) - shape.length / 2;
          body.perimeterFraction =
            ((current +
              Math.sign(delta) * Math.min(Math.abs(delta), BELT_CRAWLER.CRAWL_SPEED) +
              shape.length) %
              shape.length) /
            shape.length;
        }
        const placement = surface(shape.edges, body.perimeterFraction * shape.length);
        body.crawler.anchor = placement.anchor;
        body.position = placement.position;
        body.targetId = target?.id ?? null;
        const elapsed = nowFrame - body.phaseStart;
        if (body.crawler.phase === 'crawling') {
          body.crawler.progress = 0;
          if (target && this.canReach(body.position, target)) {
            body.pursuit = null;
            body.crawler.phase = 'winding';
            body.phaseStart = nowFrame;
          } else if (target && body.pursuit) {
            const destination = hosts.get(body.pursuit.hostId);
            const departure = surface(shape.edges, body.pursuit.departureFraction * shape.length);
            if (
              destination &&
              Math.hypot(
                body.position.x - departure.position.x,
                body.position.y - departure.position.y
              ) <=
                BELT_CRAWLER.CRAWL_SPEED + 1
            ) {
              const landing = this.landing(destination, body.position);
              if (landing) {
                this.transfer(body, landing, nowFrame);
                continue;
              }
            }
          }
        } else if (body.crawler.phase === 'winding') {
          body.crawler.progress = Math.min(1, elapsed / BELT_CRAWLER.WINDUP_FRAMES);
          if (!target || !this.canReach(body.position, target)) {
            body.crawler.phase = 'crawling';
          } else if (elapsed >= BELT_CRAWLER.WINDUP_FRAMES) {
            const dx = target.position.x - body.position.x;
            const dy = target.position.y - body.position.y;
            const length = Math.hypot(dx, dy) || 1;
            body.direction = { x: dx / length, y: dy / length };
            body.crawler.phase = 'lunging';
            body.phaseStart = nowFrame;
            body.struck = false;
          }
        } else if (body.crawler.phase === 'lunging') {
          const progress = Math.min(1, elapsed / BELT_CRAWLER.LUNGE_FRAMES);
          body.crawler.progress = progress;
          const reach = Math.sin(progress * Math.PI) * BELT_CRAWLER.LUNGE_REACH;
          const end = {
            x: body.position.x + body.direction.x * reach,
            y: body.position.y + body.direction.y * reach,
          };
          const obstruction = this.impact(body.position, end);
          const travel = obstruction
            ? Math.max(0, obstruction.distance - BELT_CRAWLER.HIT_RADIUS)
            : reach;
          body.position = {
            x: body.position.x + body.direction.x * travel,
            y: body.position.y + body.direction.y * travel,
          };
          if (
            target &&
            !body.struck &&
            Math.hypot(target.position.x - body.position.x, target.position.y - body.position.y) <=
              BELT_CRAWLER.HIT_RADIUS + (target.radius ?? 18) &&
            !this.impact(body.position, target.position)
          ) {
            attacks.push({ spiderId: id, targetId: target.id, attackerId: 'spider' });
            body.struck = true;
          }
          if (elapsed >= BELT_CRAWLER.LUNGE_FRAMES) {
            body.crawler.phase = 'recovering';
            body.phaseStart = nowFrame;
          }
        } else {
          body.crawler.progress = Math.min(1, elapsed / BELT_CRAWLER.RECOVERY_FRAMES);
          if (elapsed >= BELT_CRAWLER.RECOVERY_FRAMES) {
            body.crawler.phase = 'crawling';
          }
        }
        body.angle = target
          ? Math.atan2(target.position.y - body.position.y, target.position.x - body.position.x)
          : host.rotation;
        body.phase = body.crawler.phase === 'lunging' ? 'hunting' : 'scuttling';
      }
    }
    return attacks;
  }

  private initializeHost(host: AsteroidData): void {
    const clamp = (health: number): number =>
      Math.min(Math.max(0, health), BELT_CRAWLER.MAX_HEALTH);
    if (host.beltCrawlerIds) {
      if (host.beltCrawlerHealth) {
        host.beltCrawlerHealth = host.beltCrawlerHealth.map(clamp);
      }
      return;
    }
    const slot = beltSlotForAsteroid(host.id);
    const native = slot !== undefined && slot % 6 === 0;
    const saved = host.beltCrawlerHealth?.[0];
    host.beltCrawlerHealth = native
      ? [saved === undefined ? BELT_CRAWLER.MAX_HEALTH : clamp(saved)]
      : [];
    host.beltCrawlerIds = native ? [`belt-crawler:${host.id}:0`] : [];
  }

  /** Called by destruction, never by sector eviction. Ownership moves before the animation. */
  public escapeDestroyedHost(
    destroyed: AsteroidData,
    rocks: readonly AsteroidData[],
    nowFrame: number
  ): void {
    this.spatial = new AsteroidSpatialIndex(rocks);
    for (const body of this.bodies.values()) {
      if (body.host.id !== destroyed.id) {
        continue;
      }
      const from = { ...body.position };
      const range = BELT_CRAWLER.ESCAPE_DISTANCE;
      const candidates = this.spatial.query({
        minX: from.x - range,
        maxX: from.x + range,
        minY: from.y - range,
        maxY: from.y + range,
      });
      let destination: (Landing & { distance: number }) | undefined;
      for (const host of candidates) {
        if (host.id === destroyed.id) {
          continue;
        }
        const landing = this.landing(host, from);
        if (!landing) {
          continue;
        }
        const gap = Math.hypot(landing.position.x - from.x, landing.position.y - from.y);
        if (!destination || gap < destination.distance) {
          destination = { ...landing, distance: gap };
        }
      }
      if (destroyed.beltCrawlerHealth) {
        destroyed.beltCrawlerHealth[body.index] = 0;
      }
      if (!destination) {
        this.bodies.delete(body.id);
        continue;
      }
      this.transfer(body, destination, nowFrame);
    }
  }

  private landing(host: AsteroidData, from: Position): Landing | undefined {
    if (
      host.health <= 0 ||
      ((host.beltCrawlerHealth?.length ?? 0) >= BELT_CRAWLER.MAX_ACTIVE &&
        !host.beltCrawlerHealth?.includes(0))
    ) {
      return undefined;
    }
    const shape = contour(host);
    const distance = nearestDistance(shape.edges, from);
    const placement = surface(shape.edges, distance);
    if (
      Math.hypot(placement.position.x - from.x, placement.position.y - from.y) >
        BELT_CRAWLER.ESCAPE_DISTANCE ||
      this.enclosed(from) ||
      this.enclosed(placement.position) ||
      this.impact(from, placement.position)
    ) {
      return undefined;
    }
    return { host, fraction: distance / shape.length, ...placement };
  }

  private pursuitRoute(body: Crawler, target: Actor): Crawler['pursuit'] {
    if (this.canReach(body.position, target)) {
      return null;
    }
    const shape = contour(body.host);
    const range = body.host.size * Math.max(1, ...body.host.offsets) + BELT_CRAWLER.ESCAPE_DISTANCE;
    const origin = body.host.position;
    const remaining =
      Math.hypot(target.position.x - origin.x, target.position.y - origin.y) - body.host.size;
    let best = remaining - BELT_CRAWLER.PURSUIT_PROGRESS;
    let route: Crawler['pursuit'] = null;
    for (const host of this.spatial.query({
      minX: origin.x - range,
      maxX: origin.x + range,
      minY: origin.y - range,
      maxY: origin.y + range,
    })) {
      if (host.id === body.host.id || host.health <= 0) {
        continue;
      }
      const score =
        Math.hypot(target.position.x - host.position.x, target.position.y - host.position.y) -
        host.size;
      if (score >= best) {
        continue;
      }
      const departureDistance = nearestDistance(shape.edges, host.position);
      const departure = surface(shape.edges, departureDistance);
      if (!this.landing(host, departure.position)) {
        continue;
      }
      best = score;
      route = { hostId: host.id, departureFraction: departureDistance / shape.length };
    }
    return route;
  }

  private transfer(body: Crawler, destination: Landing, nowFrame: number): void {
    const from = { ...body.position };
    if (body.host.beltCrawlerHealth) {
      body.host.beltCrawlerHealth[body.index] = 0;
    }
    this.initializeHost(destination.host);
    const ids = destination.host.beltCrawlerIds;
    const health = destination.host.beltCrawlerHealth;
    if (!ids || !health) {
      throw new Error('Crawler destination was not initialized');
    }
    const previousIndex = ids.indexOf(body.id);
    const emptyIndex = health.indexOf(0);
    body.index = previousIndex >= 0 ? previousIndex : emptyIndex >= 0 ? emptyIndex : health.length;
    health[body.index] = body.health;
    ids[body.index] = body.id;
    body.host = destination.host;
    body.perimeterFraction = destination.fraction;
    body.escape = { from };
    body.pursuit = null;
    body.phaseStart = nowFrame;
    body.targetId = null;
    body.phase = 'scuttling';
    body.angle = Math.atan2(destination.position.y - from.y, destination.position.x - from.x);
    body.crawler = {
      hostId: destination.host.id,
      anchor: destination.anchor,
      phase: 'escaping',
      progress: 0,
    };
  }

  private enclosed(point: Position): boolean {
    return this.spatial
      .query({ minX: point.x, maxX: point.x, minY: point.y, maxY: point.y })
      .some((rock) => {
        if (this.liveHost && this.liveHost(rock.id) !== rock) {
          return false;
        }
        const points = asteroidPolygonPoints(rock);
        let inside = false;
        for (let index = 0; index < points.length; index++) {
          const a = points[index];
          const b = points[(index + 1) % points.length];
          if (
            a &&
            b &&
            a.y > point.y !== b.y > point.y &&
            point.x < a.x + ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y)
          ) {
            inside = !inside;
          }
        }
        return inside;
      });
  }

  private impact(
    start: Position,
    end: Position,
    index = this.spatial
  ): ReturnType<typeof findNearestAsteroidImpact> {
    const candidates = index
      .query({
        minX: Math.min(start.x, end.x) - 0.001,
        minY: Math.min(start.y, end.y) - 0.001,
        maxX: Math.max(start.x, end.x) + 0.001,
        maxY: Math.max(start.y, end.y) + 0.001,
      })
      .filter((rock) => !this.liveHost || this.liveHost(rock.id) === rock);
    let nearest: ReturnType<typeof findNearestAsteroidImpact> = null;
    // Overlapping piles can exceed the geometry helper's batch cap. Trace every batch.
    for (let offset = 0; offset < candidates.length; offset += REFLECTION_LIMITS.asteroids) {
      const hit = findNearestAsteroidImpact(
        start,
        end,
        candidates.slice(offset, offset + REFLECTION_LIMITS.asteroids)
      );
      if (hit && (!nearest || hit.distance < nearest.distance)) {
        nearest = hit;
      }
    }
    return nearest;
  }

  private canReach(position: Position, target: Actor): boolean {
    return (
      Math.hypot(target.position.x - position.x, target.position.y - position.y) <=
        BELT_CRAWLER.LUNGE_REACH + (target.radius ?? 18) && !this.impact(position, target.position)
    );
  }

  public findLaserHit(start: Position, end: Position): BodyHit | null {
    let closest: BodyHit | null = null;
    const obstacle = this.impact(start, end);
    for (const body of this.bodies.values()) {
      if (this.liveHost && this.liveHost(body.host.id) !== body.host) {
        continue;
      }
      const fraction = segmentCircleContact(start, end, body.position, BELT_CRAWLER.HIT_RADIUS);
      if (fraction === undefined) {
        continue;
      }
      const distance = fraction * Math.hypot(end.x - start.x, end.y - start.y);
      if (
        (obstacle && obstacle.distance <= distance) ||
        (closest && closest.distance <= distance)
      ) {
        continue;
      }
      closest = {
        kind: 'spider',
        spiderId: body.id,
        distance,
        point: {
          x: start.x + (end.x - start.x) * fraction,
          y: start.y + (end.y - start.y) * fraction,
        },
      };
    }
    return closest;
  }

  public resolveLaserHit(start: Position, end: Position, damage: number): BodyHit | null {
    const hit = this.findLaserHit(start, end);
    const body = hit && this.bodies.get(hit.spiderId);
    if (body) {
      body.health = Math.max(0, body.health - damage);
      if (body.host.beltCrawlerHealth) {
        body.host.beltCrawlerHealth[body.index] = body.health;
      }
      if (body.health === 0) {
        this.bodies.delete(body.id);
      }
    }
    return hit;
  }
}
