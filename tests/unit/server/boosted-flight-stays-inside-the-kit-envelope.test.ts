import { afterEach, beforeEach, expect, test } from 'vitest';
import { cruiseSpeed } from '../../../shared/shipFlight';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { GameServerWorld, useQuietServerConsole } from '../scenarios/support/gameServerWorld';

useQuietServerConsole();
let world: GameServerWorld;
beforeEach(() => {
  world = new GameServerWorld();
});
afterEach(() => world.dispose());

test('a boosting Surveyor may cruise faster than a boosting Hauler, and overspeed is rejected', () => {
  const surveyorPilot = world.join('Boost Surveyor', { x: 0, y: 0 }, { kitId: 'surveyor' });
  const haulerPilot = world.join('Boost Hauler', { x: 40, y: 0 }, { kitId: 'hauler' });
  world.clearAsteroids();
  const surveyor = world.entity(surveyorPilot);
  const hauler = world.entity(haulerPilot);
  const now = world.engine.getServerTime();
  const surveyorKit = getShipKit('surveyor');
  const haulerKit = getShipKit('hauler');
  const surveyorBoost = cruiseSpeed(
    surveyor.mass,
    surveyorKit.maxVelocity,
    surveyorKit.boostMultiplier
  );
  const haulerBoost = cruiseSpeed(hauler.mass, haulerKit.maxVelocity, haulerKit.boostMultiplier);
  expect(surveyorBoost).toBeGreaterThan(haulerBoost);
  expect(surveyorKit.maxVelocity).toBe(haulerKit.maxVelocity);

  const surveyorPose = {
    epoch: surveyor.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { x: surveyorBoost, y: 0 },
    velocity: { x: surveyorBoost, y: 0 },
    angle: 0,
    thrusting: true,
    boosting: true,
  };
  expect(
    world.engine.playerMotion.acceptFreePose(surveyorPilot.socket, surveyorPose, now + 17).ok
  ).toBe(true);

  const haulerPose = {
    epoch: hauler.playerMotion?.epoch ?? 0,
    sequence: 1,
    position: { x: 40 + haulerBoost, y: 0 },
    velocity: { x: haulerBoost, y: 0 },
    angle: 0,
    thrusting: true,
    boosting: true,
  };
  expect(
    world.engine.playerMotion.acceptFreePose(haulerPilot.socket, haulerPose, now + 17).ok
  ).toBe(true);

  expect(
    world.engine.playerMotion.acceptFreePose(
      haulerPilot.socket,
      {
        ...haulerPose,
        epoch: hauler.playerMotion?.epoch ?? 0,
        sequence: 2,
        position: { x: 40 + surveyorBoost, y: 0 },
        velocity: { x: surveyorBoost, y: 0 },
      },
      now + 34
    ).ok
  ).toBe(false);
});
