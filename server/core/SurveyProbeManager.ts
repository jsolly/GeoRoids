import { randomUUID } from 'node:crypto';
import { segmentCircleContact } from '../../shared/asteroidPhenomena';
import { findNearestAsteroidImpact } from '../../shared/asteroidReflection';
import { probePosition, SURVEY_PROBE } from '../../shared/surveyProbe';
import { SPIDER } from '../../shared/terrainSpider';
import { findWorldBoundaryImpact } from '../../shared/worldBoundary';
import type { AsteroidData, AsteroidProbe, Position, TerrainSpider } from '../../shared-types';
import { hullRadiusForKit } from '../../src/entities/ship/shipKits';
import { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';

interface SurveyProbeLaunchHost {
  id: string;
  position: Position;
  angle: number;
  kitId: 'scout' | 'hauler';
  exploding: boolean;
  health: number;
  respawnTimer?: number;
  abilityCooldownFrames: number;
}

interface SurveyProbeTarget {
  id: string;
  hostId: string;
  position: Position;
  radius: number;
  ownerId: string;
}

interface SurveyProbePulse {
  ownerId: string;
  position: Position;
  asteroids: readonly AsteroidData[];
}

type ProbeHost = AsteroidData | TerrainSpider;
type HostLookup = (hostId: string) => ProbeHost | undefined;
type ProbeScan = (pulse: SurveyProbePulse) => void;

/** Owns transient Scout beacons while host DTOs carry their wire state. */
export class SurveyProbeManager {
  private readonly hosts = new Map<string, ProbeHost>();
  private readonly pulseAt = new Map<string, number>();

  public registerAsteroid(host: AsteroidData): void {
    const probe = host.probe;
    if (!probe) {
      this.unregister(host.id);
      return;
    }
    const previous = this.hosts.get(host.id);
    const previousProbeId = previous?.probe?.id;
    this.hosts.set(host.id, host);
    if (previous !== host || previousProbeId !== probe.id || !this.pulseAt.has(host.id)) {
      this.pulseAt.set(host.id, probe.attachedAt);
    }
  }

  public unregister(asteroidId: string): void {
    this.hosts.delete(asteroidId);
    this.pulseAt.delete(asteroidId);
  }

  public clear(): void {
    this.hosts.clear();
    this.pulseAt.clear();
  }

  public observerPositions(): Position[] {
    return [...this.hosts.values()].map((host) => ({ ...host.position }));
  }

  public prune(now: number, lookup: HostLookup): void {
    for (const [asteroidId, host] of this.hosts) {
      const probe = host.probe;
      const current = lookup(asteroidId);
      if (current !== host || !probe || probe.health <= 0 || now >= probe.expiresAt) {
        if (current === host && probe) {
          host.probe = null;
        }
        this.unregister(asteroidId);
      }
    }
  }

  public launch(
    scout: SurveyProbeLaunchHost,
    asteroids: readonly AsteroidData[],
    now: number,
    spiders: readonly TerrainSpider[] = []
  ): { host: ProbeHost; probe: AsteroidProbe } | null {
    if (
      scout.kitId !== 'scout' ||
      scout.exploding ||
      scout.health <= 0 ||
      scout.respawnTimer !== undefined ||
      scout.abilityCooldownFrames > 0
    ) {
      return null;
    }

    const direction = { x: Math.cos(scout.angle), y: -Math.sin(scout.angle) };
    const nose = hullRadiusForKit(scout.kitId);
    const start = {
      x: scout.position.x + direction.x * nose,
      y: scout.position.y + direction.y * nose,
    };
    const end = {
      x: start.x + direction.x * SURVEY_PROBE.LAUNCH_RANGE,
      y: start.y + direction.y * SURVEY_PROBE.LAUNCH_RANGE,
    };
    const index = new AsteroidSpatialIndex(asteroids);
    const candidates = index.query({
      minX: Math.min(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxX: Math.max(start.x, end.x),
      maxY: Math.max(start.y, end.y),
    });
    const asteroidImpact = findNearestAsteroidImpact(start, end, candidates);
    let impact: { host: ProbeHost; point: Position; distance: number } | undefined;
    if (asteroidImpact) {
      const host = asteroids.find((candidate) => candidate.id === asteroidImpact.asteroidId);
      if (host) {
        impact = { host, point: asteroidImpact.point, distance: asteroidImpact.distance };
      }
    }
    for (const spider of spiders) {
      const fraction = segmentCircleContact(start, end, spider.position, SPIDER.HIT_RADIUS);
      if (fraction === undefined) {
        continue;
      }
      const distance = fraction * SURVEY_PROBE.LAUNCH_RANGE;
      if (impact && impact.distance <= distance) {
        continue;
      }
      impact = {
        host: spider,
        point: {
          x: start.x + (end.x - start.x) * fraction,
          y: start.y + (end.y - start.y) * fraction,
        },
        distance,
      };
    }
    if (!impact) {
      return null;
    }

    const boundary = findWorldBoundaryImpact(start, end);
    if (boundary && boundary.distance <= impact.distance) {
      return null;
    }

    const host = impact.host;
    if (host.health <= 0 || ('boost' in host && host.boost?.phase === 'burning') || host.probe) {
      return null;
    }

    const ownerProbes = [...this.hosts.values()].filter(
      (candidate) => candidate.probe?.ownerId === scout.id
    );
    if (ownerProbes.length >= SURVEY_PROBE.MAX_PER_OWNER) {
      const oldest = ownerProbes.sort((left, right) => {
        const at =
          (left.probe?.attachedAt ?? Number.POSITIVE_INFINITY) -
          (right.probe?.attachedAt ?? Number.POSITIVE_INFINITY);
        return at || left.id.localeCompare(right.id);
      })[0];
      if (oldest?.probe) {
        oldest.probe = null;
        this.unregister(oldest.id);
      }
    }

    const radialDistance = Math.hypot(
      impact.point.x - host.position.x,
      impact.point.y - host.position.y
    );
    const radialAngle =
      Math.atan2(impact.point.y - host.position.y, impact.point.x - host.position.x) -
      ('rotation' in host ? host.rotation : host.angle);
    const probe: AsteroidProbe = {
      id: `survey-probe-${randomUUID()}`,
      ownerId: scout.id,
      health: SURVEY_PROBE.MAX_HEALTH,
      maxHealth: SURVEY_PROBE.MAX_HEALTH,
      attachedAt: now,
      expiresAt: now + SURVEY_PROBE.LIFETIME_MS,
      angle: Math.atan2(Math.sin(radialAngle), Math.cos(radialAngle)),
      radialOffset: radialDistance + SURVEY_PROBE.RADIUS,
    };
    host.probe = probe;
    this.hosts.set(host.id, host);
    this.pulseAt.set(host.id, now);
    return { host, probe };
  }

  public tick(
    now: number,
    getAsteroids: () => readonly AsteroidData[],
    lookup: HostLookup,
    scan: ProbeScan
  ): void {
    this.prune(now, lookup);
    let index: AsteroidSpatialIndex | undefined;
    let asteroids: readonly AsteroidData[] | undefined;
    for (const [asteroidId, host] of this.hosts) {
      const probe = host.probe;
      if (!probe) {
        continue;
      }
      const lastPulseAt = this.pulseAt.get(asteroidId) ?? probe.attachedAt;
      if (now - lastPulseAt < SURVEY_PROBE.PULSE_MS) {
        continue;
      }
      asteroids ??= getAsteroids();
      index ??= new AsteroidSpatialIndex(asteroids);
      this.emitPulse(host, probe, index, scan);
      this.pulseAt.set(asteroidId, now);
    }
  }

  public pulseNow(
    host: ProbeHost,
    probe: AsteroidProbe,
    asteroids: readonly AsteroidData[],
    scan: ProbeScan
  ): void {
    this.emitPulse(host, probe, new AsteroidSpatialIndex(asteroids), scan);
  }

  private emitPulse(
    host: ProbeHost,
    probe: AsteroidProbe,
    index: AsteroidSpatialIndex,
    scan: ProbeScan
  ): void {
    const position = probePosition(host, probe);
    scan({
      ownerId: probe.ownerId,
      position,
      asteroids: index.query({
        minX: position.x - SURVEY_PROBE.RANGE,
        minY: position.y - SURVEY_PROBE.RANGE,
        maxX: position.x + SURVEY_PROBE.RANGE,
        maxY: position.y + SURVEY_PROBE.RANGE,
      }),
    });
  }

  public targetsIn(hosts: readonly ProbeHost[]): SurveyProbeTarget[] {
    const nearby = new Set(hosts);
    const targets: SurveyProbeTarget[] = [];
    for (const host of this.hosts.values()) {
      const probe = host.probe;
      if (!probe || !nearby.has(host)) {
        continue;
      }
      targets.push({
        id: probe.id,
        hostId: host.id,
        position: probePosition(host, probe),
        radius: SURVEY_PROBE.RADIUS,
        ownerId: probe.ownerId,
      });
    }
    return targets;
  }

  public damage(asteroidId: string, damage: number): boolean {
    const host = this.hosts.get(asteroidId);
    const probe = host?.probe;
    if (!host || !probe || !Number.isFinite(damage) || damage <= 0) {
      return false;
    }
    probe.health = Math.max(0, probe.health - damage);
    if (probe.health > 0) {
      return true;
    }
    host.probe = null;
    this.unregister(asteroidId);
    return true;
  }
}
