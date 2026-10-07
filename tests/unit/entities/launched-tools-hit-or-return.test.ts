import { expect, test } from 'vitest';
import { SurveyProbeManager } from '../../../server/core/SurveyProbeManager';
import { AsteroidSpatialIndex } from '../../../server/world/AsteroidSpatialIndex';
import { SURVEY_PROBE } from '../../../shared/surveyProbe';
import { movingAsteroidContact } from '../../../shared/toolFlightContact';
import { UTILITY_FLIGHT } from '../../../shared/utilityFlight';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import {
  type AbilityHost,
  activateAbilityOnHost,
  setHaulerUtilityOnHost,
  tickAbilityHost,
  tickTowLine,
} from '../../../src/entities/ship/shipAbilities';

function hauler(): AbilityHost {
  return {
    id: 'pilot',
    kitId: 'hauler',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    health: 100,
    exploding: false,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    harpoonTargetId: null,
  };
}
function rock(id: string, x: number, y = 0): AsteroidData {
  return {
    id,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    size: 20,
    health: 100,
    maxHealth: 100,
    jaggedness: 0,
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}

test('an aimed tow passes a nearby off-axis rock and latches the first hull along its path', () => {
  const pilot = hauler();
  const side = rock('side', 50, 80);
  const first = rock('first', 140);
  const behind = rock('behind', 230);
  expect(activateAbilityOnHost(pilot, { asteroids: [side, first, behind] }).activated).toBe(true);
  expect(pilot.harpoonTargetId).toBeNull();
  for (let frame = 0; frame < 20; frame++) {
    tickTowLine(pilot, [side, behind, first]);
  }
  expect(pilot.harpoonTargetId).toBe(first.id);
  expect(pilot.utilityFlight).toBeNull();
  expect(first.velocity).toEqual({ x: 0, y: 0 });
});

test('tow contact uses the current moving hull rather than its position at launch', () => {
  const pilot = hauler();
  const target = rock('moving', 120);
  activateAbilityOnHost(pilot, { asteroids: [target] });
  target.position.y = 100;
  for (let frame = 0; frame < 8; frame++) {
    tickTowLine(pilot, [target]);
  }
  expect(pilot.harpoonTargetId).toBeNull();
  target.position = { x: 170, y: 0 };
  for (let frame = 0; frame < 15; frame++) {
    tickTowLine(pilot, [target]);
  }
  expect(pilot.harpoonTargetId).toBe(target.id);
});

test('a missed tow reels to a moving pilot and cannot attach during its return', () => {
  const pilot = hauler();
  activateAbilityOnHost(pilot, { asteroids: [] });
  for (let frame = 0; frame < 35; frame++) {
    tickTowLine(pilot, []);
  }
  expect(pilot.utilityFlight?.phase).toBe('reeling');
  const tipX = pilot.utilityFlight?.position.x ?? 0;
  pilot.position.y = 70;
  const crossed = rock('crossed-on-return', 160);
  for (let frame = 0; frame < 50; frame++) {
    tickTowLine(pilot, [crossed]);
  }
  expect(tipX).toBeGreaterThan(280);
  expect(pilot.utilityFlight).toBeNull();
  expect(pilot.harpoonTargetId).toBeNull();
  expect(pilot.abilityCooldownFrames).toBe(180);
});

test('obstructed tow lines reel back while death and tool changes discard an in-flight shot', () => {
  const pilot = hauler();
  const claimed = rock('claimed', 100);
  activateAbilityOnHost(pilot, { asteroids: [claimed] });
  for (let frame = 0; frame < 15 && pilot.utilityFlight?.phase === 'outbound'; frame++) {
    tickTowLine(pilot, [claimed], () => false);
  }
  expect(pilot.utilityFlight?.phase).toBe('reeling');
  expect(pilot.utilityFlight?.position).toEqual({ x: 80, y: 0 });
  expect(pilot.harpoonTargetId).toBeNull();
  pilot.utilityFlight = null;
  pilot.abilityCooldownFrames = 0;
  activateAbilityOnHost(pilot);
  expect(setHaulerUtilityOnHost(pilot, 'resource_tap')).toBe(true);
  expect(pilot.utilityFlight).toBeNull();
  pilot.haulerUtility = 'tow_cable';
  pilot.abilityCooldownFrames = 0;
  activateAbilityOnHost(pilot);
  pilot.health = 0;
  tickAbilityHost(pilot);
  expect(pilot.utilityFlight).toBeNull();
});

test('a second press recalls an outbound tow before it can attach', () => {
  const pilot = hauler();
  const target = rock('ahead', 140);
  activateAbilityOnHost(pilot);
  expect(activateAbilityOnHost(pilot).activated).toBe(true);
  expect(pilot.utilityFlight?.phase).toBe('reeling');
  tickTowLine(pilot, [target]);
  expect(pilot.harpoonTargetId).toBeNull();
});

test('a probe miss consumes recharge and disintegrates, while moving hosts can intercept a live shot', () => {
  const manager = new SurveyProbeManager();
  const scout: Parameters<SurveyProbeManager['launch']>[0] = {
    ...hauler(),
    id: 'scout',
    kitId: 'scout',
  };
  expect(manager.launch(scout)).toBe(true);
  expect(scout.abilityCooldownFrames).toBe(180);
  expect(manager.launch(scout)).toBe(false);
  for (let frame = 0; frame < 70; frame++) {
    manager.advanceFlight(scout, new AsteroidSpatialIndex([]), 100);
  }
  expect(scout.utilityFlight?.phase).toBe('disintegrating');
  for (let frame = 0; frame < UTILITY_FLIGHT.DISINTEGRATE_FRAMES; frame++) {
    manager.advanceFlight(scout, new AsteroidSpatialIndex([]), 100);
  }
  expect(scout.utilityFlight).toBeNull();
  scout.abilityCooldownFrames = 0;
  const target = rock('intercept', 200, 100);
  expect(manager.launch(scout)).toBe(true);
  const index = new AsteroidSpatialIndex([target]);
  for (let frame = 0; frame < 10; frame++) {
    manager.advanceFlight(scout, index, 100);
  }
  expect(target.probe).toBeUndefined();
  target.position.y = 0;
  index.move(target);
  for (let frame = 0; frame < 20; frame++) {
    manager.advanceFlight(scout, index, 200);
  }
  expect(target.probe?.ownerId).toBe(scout.id);
  expect(target.probe?.attachedAt).toBe(200);
});

test('a world wall blocks an outbound probe before the rock beyond it', () => {
  const manager = new SurveyProbeManager();
  const scout: Parameters<SurveyProbeManager['launch']>[0] = {
    ...hauler(),
    id: 'scout',
    kitId: 'scout',
    position: { x: WORLD.radius - 60, y: 0 },
  };
  const target = rock('outside', WORLD.radius + 100);
  expect(manager.launch(scout)).toBe(true);
  for (let frame = 0; frame < 6; frame++) {
    manager.advanceFlight(scout, new AsteroidSpatialIndex([target]), 100);
  }
  expect(scout.utilityFlight?.phase).toBe('disintegrating');
  expect(target.probe).toBeUndefined();
});

for (const kind of ['tow', 'probe'] as const) {
  test(`a ${kind} shot waits for actual contact while the asteroid moves away during the frame`, async () => {
    const { GameEngine } = await import('../../../server/core/GameEngine');
    const { RecordingSocket } = await import('../../support/recordingSocket');
    const engine = new GameEngine(42);
    try {
      const pilot = engine.addPlayer(
        'pilot',
        'Pilot',
        new RecordingSocket(),
        { x: -300, y: 0 },
        kind === 'tow' ? 'hauler' : 'scout'
      );
      for (const asteroid of engine.getAllAsteroids()) {
        engine.removeAsteroid(asteroid.id);
      }
      engine.parkSatellitePickups();
      const target = rock('moving-away', kind === 'tow' ? 20 : 22);
      target.size = 12;
      target.velocity.x = 2;
      engine.addAsteroid(target);
      pilot.utilityFlight = {
        kind,
        phase: 'outbound',
        position: { x: 0, y: 0 },
        velocity: { x: kind === 'tow' ? 8 : 10, y: 0 },
        remainingDistance: 280,
      };
      engine.advanceOneFrame();
      expect(target.position.x).toBeGreaterThan(kind === 'tow' ? 20 : 22);
      expect(pilot.harpoonTargetId).toBeNull();
      expect(target.probe).toBeUndefined();
      expect(pilot.utilityFlight?.phase).toBe('outbound');
    } finally {
      engine.stopGameLoop();
    }
  });
}

test('a tow line uses the asteroid contour rather than an invisible bounding circle', () => {
  const pilot = hauler();
  const target = rock('small-contour', 100);
  target.offsets = [0.5, 0.5, 0.5, 0.5];
  activateAbilityOnHost(pilot);
  for (let frame = 0; frame < 7; frame++) {
    tickTowLine(pilot, [target]);
  }
  expect(pilot.harpoonTargetId).toBeNull();
  for (let frame = 0; frame < 3; frame++) {
    tickTowLine(pilot, [target]);
  }
  expect(pilot.harpoonTargetId).toBe(target.id);
});

test('a rotating long asteroid intercepts a stationary tip while its final contour misses', () => {
  const target = rock('rotating', 0);
  target.size = 100;
  target.offsets = [1, 0.1, 1, 0.1];
  target.rotation = Math.PI / 2;
  const tip = { x: 40, y: 40 };
  expect(movingAsteroidContact(tip, tip, target)).toBeUndefined();
  expect(movingAsteroidContact(tip, tip, target, { x: 0, y: 0, rotation: 0 })).toBeDefined();
});

test('a tip passing beside a rotating corner never hits the frozen end contour', () => {
  const target = rock('corner', 0);
  target.size = 100;
  target.rotation = 0.002;
  expect(
    movingAsteroidContact({ x: -0.1, y: 99.999 }, { x: -8.1, y: 99.999 }, target, {
      x: 0,
      y: 0,
      rotation: 0,
    })
  ).toBeUndefined();
});

test('a probe stays on the moving hull at its impact-time local offset', () => {
  const target = rock('moving-hull', 18);
  target.size = 22;
  const index = new AsteroidSpatialIndex([target]);
  const manager = new SurveyProbeManager();
  const scout: Parameters<SurveyProbeManager['launch']>[0] = {
    ...hauler(),
    id: 'scout',
    kitId: 'scout',
    utilityFlight: {
      kind: 'probe',
      phase: 'outbound',
      position: { x: -4, y: 0 },
      velocity: { x: 10, y: 0 },
      remainingDistance: 100,
    },
  };
  const result = manager.advanceFlight(
    scout,
    index,
    100,
    [],
    new Map([[target.id, { x: 20, y: 0, rotation: 0 }]])
  );
  expect(result?.probe.radialOffset).toBeCloseTo(target.size + SURVEY_PROBE.RADIUS);
});

test('an offline pilot death discards a launched tool before respawn', async () => {
  const { Ship } = await import('../../../src/entities/ship/Ship');
  const ship = new Ship({ kitId: 'hauler' });
  const shot = {
    kind: 'tow',
    phase: 'outbound',
    position: { x: 100, y: 0 },
    velocity: { x: 8, y: 0 },
    remainingDistance: 100,
  } as const;
  ship.utilityFlight = { ...shot };
  ship.explode();
  expect(ship.utilityFlight).toBeNull();
  ship.exploding = false;
  ship.health = 0;
  ship.utilityFlight = { ...shot };
  ship.updateLifecycle();
  expect(ship.utilityFlight).toBeNull();
});
