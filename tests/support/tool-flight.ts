import { expect } from 'vitest';
import type { GameEngine } from '../../server/core/GameEngine';
import type { SurveyProbeManager } from '../../server/core/SurveyProbeManager';
import type { AsteroidSpatialIndex } from '../../server/world/AsteroidSpatialIndex';
import type { TerrainSpider } from '../../shared-types';

/** Advance real simulation frames until all currently outbound tools resolve. */
export function resolveToolFlights(engine: GameEngine): void {
  for (let frame = 0; frame < 100; frame++) {
    if (
      !engine.entityManager
        .getAllEntities()
        .some((pilot) => pilot.utilityFlight?.phase === 'outbound')
    ) {
      return;
    }
    engine.tickToolFlights();
  }
  throw new Error('Tool flight did not resolve within its launch range');
}

/** Launch an independent shot, then let the manager resolve its real swept contact. */
export function fireProbe(
  manager: SurveyProbeManager,
  pilot: Parameters<SurveyProbeManager['launch']>[0],
  index: AsteroidSpatialIndex,
  now: number,
  spiders: readonly TerrainSpider[] = []
): ReturnType<SurveyProbeManager['advanceFlight']> {
  const shot = { ...pilot, abilityCooldownFrames: 0, utilityFlight: null };
  expect(manager.launch(shot)).toBe(true);
  for (let frame = 0; frame < 100; frame++) {
    const attached = manager.advanceFlight(shot, index, now, spiders);
    if (attached) {
      return attached;
    }
  }
  return null;
}

/** Collision scenarios start with a real aimed attachment, then arrange their cargo impact. */
export function attachTowForScenario(
  engine: GameEngine,
  pilotId: string,
  asteroidId: string
): void {
  const pilot = engine.getPlayer(pilotId);
  const target = engine.getAsteroid(asteroidId);
  if (!pilot || !target) {
    throw new Error('Missing tow scenario participant');
  }
  const original = { ...target.position };
  const obstacles = engine
    .getAllAsteroids()
    .filter((rock) => rock.id !== target.id)
    .map((rock) => ({ rock, position: { ...rock.position } }));
  for (const obstacle of obstacles) {
    obstacle.rock.position.y += 2000;
    engine.addAsteroid(obstacle.rock);
  }
  target.position = { x: pilot.position.x + target.size + 120, y: pilot.position.y };
  engine.addAsteroid(target);
  pilot.angle = 0;
  expect(engine.useAbility(pilotId, 'hauler')).toBe(true);
  resolveToolFlights(engine);
  expect(pilot.harpoonTargetId).toBe(asteroidId);
  target.position = original;
  engine.addAsteroid(target);
  for (const obstacle of obstacles) {
    obstacle.rock.position = obstacle.position;
    engine.addAsteroid(obstacle.rock);
  }
}
