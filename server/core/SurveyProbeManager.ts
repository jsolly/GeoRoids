import { randomUUID } from 'node:crypto';
import { findNearestAsteroidImpact } from '../../shared/asteroidReflection';
import { findSectorWallImpact } from '../../shared/sectors';
import { probePosition, SURVEY_PROBE } from '../../shared/surveyProbe';
import { findWorldBoundaryImpact } from '../../shared/worldBoundary';
import type { AsteroidData, AsteroidProbe, Position } from '../../shared-types';
import { hullRadiusForKit } from '../../src/entities/ship/shipKits';
import { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';

interface SurveyProbeLaunchHost {
  id: string;
  position: Position;
  angle: number;
  kitId: 'surveyor' | 'hauler';
  exploding: boolean;
  health: number;
  respawnTimer?: number;
  abilityCooldownFrames: number;
}

interface SurveyProbeTarget {
  id: string;
  asteroidId: string;
  position: Position;
  radius: number;
  ownerId: string;
}

interface SurveyProbePulse {
  ownerId: string;
  position: Position;
  asteroids: readonly AsteroidData[];
}

type AsteroidLookup = (asteroidId: string) => AsteroidData | undefined;
type ProbeScan = (pulse: SurveyProbePulse) => void;

/** Owns transient Surveyor beacons while asteroid DTOs carry their wire state. */
export class SurveyProbeManager {
  private readonly hosts = new Map<string, AsteroidData>();
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

  public prune(now: number, lookup: AsteroidLookup): void {
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
    surveyor: SurveyProbeLaunchHost,
    asteroids: readonly AsteroidData[],
    completedSectors: ReadonlySet<string>,
    now: number
  ): { host: AsteroidData; probe: AsteroidProbe } | null {
    if (
      surveyor.kitId !== 'surveyor' ||
      surveyor.exploding ||
      surveyor.health <= 0 ||
      surveyor.respawnTimer !== undefined ||
      surveyor.abilityCooldownFrames > 0
    ) {
      return null;
    }

    const direction = { x: Math.cos(surveyor.angle), y: -Math.sin(surveyor.angle) };
    const nose = hullRadiusForKit(surveyor.kitId);
    const start = {
      x: surveyor.position.x + direction.x * nose,
      y: surveyor.position.y + direction.y * nose,
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
    const impact = findNearestAsteroidImpact(start, end, candidates);
    if (!impact) {
      return null;
    }

    const worldWall = findWorldBoundaryImpact(start, end);
    const sectorWall = findSectorWallImpact(start, end, completedSectors);
    const boundary =
      worldWall && sectorWall
        ? worldWall.distance <= sectorWall.distance
          ? worldWall
          : sectorWall
        : (worldWall ?? sectorWall);
    if (boundary && boundary.distance <= impact.distance) {
      return null;
    }

    const host = asteroids.find((candidate) => candidate.id === impact.asteroidId);
    if (!host || host.health <= 0 || host.boost?.phase === 'burning' || host.probe) {
      return null;
    }

    const ownerProbes = [...this.hosts.values()].filter(
      (candidate) => candidate.probe?.ownerId === surveyor.id
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
      host.rotation;
    const probe: AsteroidProbe = {
      id: `survey-probe-${randomUUID()}`,
      ownerId: surveyor.id,
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
    lookup: AsteroidLookup,
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
    host: AsteroidData,
    probe: AsteroidProbe,
    asteroids: readonly AsteroidData[],
    scan: ProbeScan
  ): void {
    this.emitPulse(host, probe, new AsteroidSpatialIndex(asteroids), scan);
  }

  private emitPulse(
    host: AsteroidData,
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

  public targetsIn(asteroids: readonly AsteroidData[]): SurveyProbeTarget[] {
    const nearby = new Set(asteroids);
    const targets: SurveyProbeTarget[] = [];
    for (const host of this.hosts.values()) {
      const probe = host.probe;
      if (!probe || !nearby.has(host)) {
        continue;
      }
      targets.push({
        id: probe.id,
        asteroidId: host.id,
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
