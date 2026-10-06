import { randomUUID } from 'node:crypto';
import { segmentCircleContact } from '../../shared/asteroidPhenomena';
import { probePosition, SURVEY_PROBE } from '../../shared/surveyProbe';
import { spiderHitRadius } from '../../shared/terrainSpider';
import {
  firstToolFlightContact,
  movingAsteroidContact,
  relativeFlightStart,
} from '../../shared/toolFlightContact';
import {
  advanceUtilityFlight,
  launchUtilityFlight,
  missUtilityFlight,
} from '../../shared/utilityFlight';
import type {
  AsteroidData,
  AsteroidProbe,
  Position,
  TerrainSpider,
  ToolTargetPose,
} from '../../shared-types';
import { hullRadiusForKit } from '../../src/entities/ship/shipKits';
import type { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';

interface SurveyProbeLaunchHost {
  id: string;
  position: Position;
  angle: number;
  kitId: 'scout' | 'hauler';
  exploding: boolean;
  health: number;
  respawnTimer?: number;
  abilityCooldownFrames: number;
  utilityFlight?: import('../../shared-types').UtilityFlight | null;
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

  public launch(scout: SurveyProbeLaunchHost): boolean {
    if (
      scout.kitId !== 'scout' ||
      scout.exploding ||
      scout.health <= 0 ||
      scout.respawnTimer !== undefined ||
      scout.abilityCooldownFrames > 0 ||
      scout.utilityFlight
    ) {
      return false;
    }
    scout.utilityFlight = launchUtilityFlight(
      scout,
      'probe',
      hullRadiusForKit(scout.kitId),
      SURVEY_PROBE.LAUNCH_RANGE
    );
    scout.abilityCooldownFrames = SURVEY_PROBE.COOLDOWN_FRAMES;
    return true;
  }

  public advanceFlight(
    scout: SurveyProbeLaunchHost,
    index: AsteroidSpatialIndex,
    now: number,
    spiders: readonly TerrainSpider[] = [],
    previousPositions: ReadonlyMap<string, ToolTargetPose> = new Map()
  ): { host: ProbeHost; probe: AsteroidProbe } | null {
    if (scout.utilityFlight?.kind !== 'probe') {
      return null;
    }
    if (scout.exploding || scout.health <= 0 || scout.respawnTimer !== undefined) {
      scout.utilityFlight = null;
      return null;
    }
    const segment = advanceUtilityFlight(scout);
    if (!segment) {
      return null;
    }
    const { start, end } = segment;
    const candidates = index.queryMotion({
      minX: Math.min(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxX: Math.max(start.x, end.x),
      maxY: Math.max(start.y, end.y),
    });
    const impact = firstToolFlightContact<ProbeHost>(
      start,
      end,
      [...candidates, ...spiders],
      (candidate) =>
        'rotation' in candidate
          ? movingAsteroidContact(
              start,
              end,
              candidate,
              index.previousPose(candidate.id) ?? previousPositions.get(candidate.id)
            )
          : segmentCircleContact(
              relativeFlightStart(
                start,
                candidate.position,
                previousPositions.get(candidate.id) ?? candidate.position
              ),
              end,
              candidate.position,
              spiderHitRadius(candidate.id)
            )
    );
    if (impact && scout.utilityFlight) {
      scout.utilityFlight.position = { ...impact.point };
    }
    if (impact?.kind === 'boundary') {
      missUtilityFlight(scout);
      return null;
    }
    if (!impact) {
      if (scout.utilityFlight?.phase === 'outbound' && scout.utilityFlight.remainingDistance <= 0) {
        missUtilityFlight(scout);
      }
      return null;
    }

    const host = impact.body;
    if (host.health <= 0 || ('boost' in host && host.boost?.phase === 'burning') || host.probe) {
      missUtilityFlight(scout);
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

    const fraction = impact.fraction;
    const previous = index.previousPose(host.id) ??
      previousPositions.get(host.id) ?? {
        ...host.position,
        rotation: 'rotation' in host ? host.rotation : host.angle,
      };
    const localX = impact.point.x - (previous.x + (host.position.x - previous.x) * fraction);
    const localY = impact.point.y - (previous.y + (host.position.y - previous.y) * fraction);
    const radialDistance = Math.hypot(localX, localY);
    const rotation = 'rotation' in host ? host.rotation : host.angle;
    const priorRotation = previous.rotation ?? rotation;
    const rotationDelta = Math.atan2(
      Math.sin(rotation - priorRotation),
      Math.cos(rotation - priorRotation)
    );
    const radialAngle = Math.atan2(localY, localX) - (priorRotation + rotationDelta * fraction);
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
    scout.utilityFlight = null;
    host.probe = probe;
    this.hosts.set(host.id, host);
    this.pulseAt.set(host.id, now);
    return { host, probe };
  }

  public tick(
    now: number,
    asteroidIndex: () => AsteroidSpatialIndex,
    lookup: HostLookup,
    scan: ProbeScan
  ): void {
    this.prune(now, lookup);
    for (const [asteroidId, host] of this.hosts) {
      const probe = host.probe;
      if (!probe) {
        continue;
      }
      const lastPulseAt = this.pulseAt.get(asteroidId) ?? probe.attachedAt;
      if (now - lastPulseAt < SURVEY_PROBE.PULSE_MS) {
        continue;
      }
      this.emitPulse(host, probe, asteroidIndex(), scan);
      this.pulseAt.set(asteroidId, now);
    }
  }

  public pulseNow(
    host: ProbeHost,
    probe: AsteroidProbe,
    index: AsteroidSpatialIndex,
    scan: ProbeScan
  ): void {
    this.emitPulse(host, probe, index, scan);
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
