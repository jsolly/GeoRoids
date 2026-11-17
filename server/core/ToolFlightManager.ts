import { boostOwnerIds } from '../../shared/asteroidBoost';
import { asteroidCrewNeeded, isColossalAsteroid } from '../../shared/asteroidScale';
import { tickTowLine } from '../../shared/shipAbilities';
import { SHIP_ABILITY } from '../../shared/shipKits';
import { haulerUtilityOf, isTowCableUtility } from '../../shared/shipUtilities';
import { SURVEY_PROBE } from '../../shared/surveyProbe';
import { spiderHitRadius } from '../../shared/terrainSpider';
import { advanceUtilityFlight } from '../../shared/utilityFlight';
import type { AsteroidData, TerrainSpider, ToolTargetPose } from '../../shared-types';
import type { GameEntity } from './EntityManager';
import type { ToolFlightInputs } from './types';

/** Owns tool pose capture, target admission and swept post-motion contact effects. */
export class ToolFlightManager {
  constructor(private readonly inputs: ToolFlightInputs) {}

  public captureStartPositions(): Map<string, ToolTargetPose> {
    const positions = new Map<string, ToolTargetPose>();
    const pilots = this.inputs.actors
      .getAllEntities()
      .filter((pilot) => pilot.utilityFlight?.phase === 'outbound');
    if (pilots.length === 0) {
      return positions;
    }
    for (const spider of this.inputs.spiders.getBodies()) {
      positions.set(spider.id, { ...spider.position, rotation: spider.angle });
    }
    return positions;
  }

  public hasOutboundFlight(): boolean {
    return this.inputs.actors
      .getAllEntities()
      .some((pilot) => pilot.utilityFlight?.phase === 'outbound');
  }

  /** Resolve tool travel after world motion, using each target's complete frame trajectory. */
  public advance(previousPositions: ReadonlyMap<string, ToolTargetPose> = new Map()): void {
    const pilots = this.inputs.actors.getAllEntities();
    const cargo = new Set(pilots.map((pilot) => pilot.harpoonTargetId));
    const spiders = pilots.some((pilot) => pilot.utilityFlight?.phase === 'outbound')
      ? this.inputs.spiders.getBodies()
      : [];
    for (const pilot of pilots) {
      const flight = pilot.utilityFlight;
      if (!flight) {
        continue;
      }
      if (
        pilot.exploding ||
        pilot.health <= 0 ||
        pilot.respawnTimer !== undefined ||
        pilot.furnaceTransit
      ) {
        pilot.utilityFlight = null;
        continue;
      }
      if (flight.phase !== 'outbound') {
        advanceUtilityFlight(pilot);
        continue;
      }
      const bounds = this.toolFlightBounds(flight);
      const nearbySpiders = spiders.filter((spider) => {
        const previous = previousPositions.get(spider.id) ?? spider.position;
        const r = spiderHitRadius(spider.id);
        return (
          Math.min(previous.x, spider.position.x) - r <= bounds.maxX &&
          Math.max(previous.x, spider.position.x) + r >= bounds.minX &&
          Math.min(previous.y, spider.position.y) - r <= bounds.maxY &&
          Math.max(previous.y, spider.position.y) + r >= bounds.minY
        );
      });
      if (flight.kind === 'probe') {
        this.advanceSurveyProbe(pilot, nearbySpiders, previousPositions);
      } else {
        const index = this.inputs.rocks.spatialIndex();
        const nearby = index.queryMotion(bounds);
        const targetPoses = new Map(previousPositions);
        for (const rock of nearby) {
          const previous = index.previousPose(rock.id);
          if (previous) {
            targetPoses.set(rock.id, previous);
          }
        }
        tickTowLine(
          pilot,
          [
            ...nearby,
            ...nearbySpiders,
            ...(isTowCableUtility(pilot)
              ? this.inputs.hives.bodiesNear(pilot.position, SHIP_ABILITY.HARPOON_RANGE * 3)
              : []),
          ],
          (body) => {
            const rock = this.inputs.rocks.getAsteroid(body.id);
            return rock ? this.canTarget(pilot, rock, cargo) : !cargo.has(body.id);
          },
          targetPoses
        );
        if (pilot.harpoonTargetId != null && pilot.harpoonTargetId !== '') {
          cargo.add(pilot.harpoonTargetId);
        }
      }
    }
  }

  /** Ordinary cargo is exclusive; a colossal deposit can share tows or couplings. */
  public canTarget(
    entity: GameEntity,
    asteroid: AsteroidData,
    cargo: ReadonlySet<string | null | undefined>
  ): boolean {
    if (asteroid.id === entity.harpoonTargetId || !cargo.has(asteroid.id)) {
      return true;
    }
    if (!isColossalAsteroid(asteroid.size)) {
      return false;
    }
    if (asteroid.boost) {
      return (
        haulerUtilityOf(entity) === 'boost_coupling' &&
        boostOwnerIds(asteroid.boost).length < asteroidCrewNeeded(asteroid.size)
      );
    }
    return isTowCableUtility(entity) && !asteroid.boost;
  }

  private advanceSurveyProbe(
    scout: GameEntity,
    spiders: readonly TerrainSpider[],
    previousPositions: ReadonlyMap<string, ToolTargetPose>
  ): void {
    const result = this.inputs.probes.advanceFlight(
      scout,
      this.inputs.rocks.spatialIndex(),
      this.inputs.now(),
      spiders,
      previousPositions
    );
    if (!result) {
      return;
    }
    this.inputs.probes.pulseNow(
      result.host,
      result.probe,
      this.inputs.rocks.spatialIndex(),
      ({ ownerId, position, asteroids: nearby }) =>
        this.inputs.abilities.survey(ownerId, position, nearby, SURVEY_PROBE.RANGE)
    );
    if ('rotation' in result.host) {
      result.host.surveyedBy ??= [];
      if (!result.host.surveyedBy.includes(result.probe.ownerId)) {
        result.host.surveyedBy.push(result.probe.ownerId);
      }
    }
  }

  private toolFlightBounds(
    flight: Extract<NonNullable<GameEntity['utilityFlight']>, { phase: 'outbound' }>
  ) {
    const end = {
      x: flight.position.x + flight.velocity.x,
      y: flight.position.y + flight.velocity.y,
    };
    return {
      minX: Math.min(flight.position.x, end.x),
      minY: Math.min(flight.position.y, end.y),
      maxX: Math.max(flight.position.x, end.x),
      maxY: Math.max(flight.position.y, end.y),
    };
  }
}
