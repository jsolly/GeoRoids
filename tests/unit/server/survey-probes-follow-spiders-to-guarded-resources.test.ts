/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { SurveyProbeManager } from '../../../server/core/SurveyProbeManager';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { probePosition, SURVEY_PROBE } from '../../../shared/surveyProbe';
import type { AsteroidData, TerrainSpider } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

const pilot = {
  id: 'scout',
  position: { x: 0, y: 0 },
  angle: 0,
  kitId: 'scout' as const,
  exploding: false,
  health: 100,
  abilityCooldownFrames: 0,
};
function spiderAt(id: string, x: number, y = 0): TerrainSpider {
  return {
    id,
    position: { x, y },
    angle: 0,
    health: 75,
    maxHealth: 75,
    phase: 'scuttling',
    targetId: null,
  };
}
function rockAt(id: string, x: number, y = 0): AsteroidData {
  return {
    id,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    size: 25,
    jaggedness: 0,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
}

describe('spiders carry Scout probes', () => {
  test('a spider intercepts the launch before a rock and an occupied spider blocks another launch', () => {
    const manager = new SurveyProbeManager();
    const spider = spiderAt('spider', 200);
    const rock = rockAt('rock', 400);
    expect(manager.launch(pilot, [rock], 100, [spider])?.host).toBe(spider);
    expect(rock.probe).toBeUndefined();
    expect(manager.launch(pilot, [rock], 101, [spider])).toBeNull();
    const blocker = rockAt('blocker', 100);
    expect(manager.launch(pilot, [blocker], 102, [spider])?.host).toBe(blocker);
  });

  test('a probe rotates with its spider and scans resources after the spider travels home', () => {
    const manager = new SurveyProbeManager();
    const spider = spiderAt('spider', 200);
    const rock = rockAt('nest-resource', 2000, 100);
    assert.ok(manager.launch(pilot, [], 100, [spider]));
    assert.ok(spider.probe);
    const before = probePosition(spider, spider.probe);
    spider.position = { x: 2000, y: 0 };
    spider.angle = Math.PI / 2;
    const after = probePosition(spider, spider.probe);
    expect(after.x).toBeCloseTo(2000);
    expect(after.y).toBeLessThan(0);
    expect(after).not.toEqual(before);
    const pulses: string[] = [];
    manager.tick(
      100 + SURVEY_PROBE.PULSE_MS,
      () => [rock],
      () => spider,
      (pulse) => {
        expect(pulse.position).toEqual(after);
        expect(pulse.ownerId).toBe(pilot.id);
        pulses.push(...pulse.asteroids.map((asteroid) => asteroid.id));
      }
    );
    expect(pulses).toEqual([rock.id]);
    expect(manager.targetsIn([spider])).toMatchObject([{ hostId: spider.id, position: after }]);
  });

  test('a probed nest guard remains active after the scout retreats and carries scans home', () => {
    const spiders = new TerrainSpiderManager(() => 0.5);
    const probes = new SurveyProbeManager();
    const resource = { id: 'guarded-metal', position: { x: 15000, y: 5000 }, value: 1 as const };
    const scout = { id: 'scout', position: { x: 17000, y: 5000 }, health: 100, exploding: false };
    const options = {
      players: [scout],
      resources: () => [resource],
    };
    spiders.advance({ ...options, nowFrame: 1 });
    const guard = spiders.getBodies()[0];
    assert.ok(guard);
    scout.position = { x: guard.position.x + 300, y: guard.position.y };
    for (let frame = 2; frame < 50; frame++) {
      spiders.advance({ ...options, nowFrame: frame });
    }
    assert.ok(
      probes.launch(
        { ...pilot, position: { x: guard.position.x - 200, y: guard.position.y } },
        [],
        100,
        [guard]
      )
    );
    scout.position = { x: 21000, y: 5000 };
    for (let frame = 50; frame < 500; frame++) {
      spiders.advance({ ...options, nowFrame: frame });
    }
    expect(spiders.getBody(guard.id)).toBe(guard);
    expect(
      Math.hypot(guard.position.x - resource.position.x, guard.position.y - resource.position.y)
    ).toBeLessThan(300);
    const ore = rockAt(resource.id, resource.position.x, resource.position.y);
    const revealed: string[] = [];
    probes.tick(
      100 + SURVEY_PROBE.PULSE_MS,
      () => [ore],
      (id) => spiders.getBody(id),
      (pulse) => revealed.push(...pulse.asteroids.map((rock) => rock.id))
    );
    expect(revealed).toContain(ore.id);
  });

  test('asteroid and spider probes share the owner cap, damage, expiry, and host loss cleanup', () => {
    const manager = new SurveyProbeManager();
    const rock = rockAt('oldest', 200);
    assert.ok(manager.launch(pilot, [rock], 100));
    const spiders = [0, 1, 2].map((i) => spiderAt(`spider-${i}`, 200, (i + 1) * 200));
    for (const [i, spider] of spiders.entries()) {
      assert.ok(
        manager.launch({ ...pilot, position: { x: 0, y: spider.position.y } }, [], 101 + i, [
          spider,
        ])
      );
    }
    expect(rock.probe).toBeNull();
    const [damaged, expired, removed] = spiders;
    assert.ok(damaged && expired && removed);
    expect(manager.damage(damaged.id, SURVEY_PROBE.MAX_HEALTH)).toBe(true);
    expect(damaged.probe).toBeNull();
    manager.prune(102 + SURVEY_PROBE.LIFETIME_MS, (id) =>
      id === expired.id ? expired : undefined
    );
    expect(expired.probe).toBeNull();
    expect(manager.observerPositions()).toEqual([]);
  });

  test('a Scout attaches a networked spider beacon that a laser can shoot off', () => {
    const engine = new GameEngine(42);
    const scout = engine.addPlayer('scout', 'Scout', new RecordingSocket(), { x: 0, y: 0 });
    for (const rock of engine.getAllAsteroids()) {
      engine.removeAsteroid(rock.id);
    }
    scout.position = { x: 0, y: 0 };
    scout.angle = 0;
    scout.equipment = ['survey_probe'];
    engine.setScoutUtility(scout.id, 'survey_probe');
    const spider = engine.spawnTerrainSpider({ x: 200, y: 0 });
    assert.ok(spider);
    expect(engine.useAbility(scout.id, 'scout')).toBe(true);
    expect(
      engine.getSpiderField().spiders.find((body) => body.id === spider.id)?.probe?.ownerId
    ).toBe(scout.id);
    const now = engine.getServerTime();
    engine.spawnLaser('shooter', { x: 120, y: 0 }, { x: 60, y: 0 }, now);
    engine.advanceLasersAndResolveHits(now + 1);
    expect(
      engine.getSpiderField().spiders.find((body) => body.id === spider.id)?.probe?.health
    ).toBe(15);
    expect(engine.getSpiderField().spiders.find((body) => body.id === spider.id)?.health).toBe(75);
  });
});
