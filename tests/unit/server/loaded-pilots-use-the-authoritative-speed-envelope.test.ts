import { afterEach, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { cargoCapacity } from '../../../shared/economy';
import { RecordingSocket } from '../../support/recordingSocket';

let engine: GameEngine | undefined;
afterEach(() => engine?.stopGameLoop());
test('loaded pilots retain empty-hold cruise and still reject excess velocity', () => {
  engine = new GameEngine(82);
  const socket = new RecordingSocket();
  const pilot = engine.addPlayer('carrier', 'Carrier', socket, { x: 0, y: 0 }, 'hauler');
  pilot.position = { x: 0, y: 0 };
  pilot.contourLock = null;
  const empty = engine.playerMotion.legalSpeed(pilot, 0);
  pilot.cargo = cargoCapacity(pilot.kitId) / 2;
  expect(engine.playerMotion.legalSpeed(pilot, 0)).toBeCloseTo(empty);
  pilot.cargo = cargoCapacity(pilot.kitId);
  const full = engine.playerMotion.legalSpeed(pilot, 0);
  expect(full).toBeCloseTo(empty);
  expect(engine.playerMotion.register(pilot, socket, 0).ok).toBe(true);
  const pose = {
    epoch: 1,
    sequence: 0,
    position: { x: 0, y: 0 },
    velocity: { x: full, y: 0 },
    angle: 0,
    thrusting: true,
  };
  expect(engine.playerMotion.acceptFreePose(socket, pose, 100).ok).toBe(true);
  expect(
    engine.playerMotion.acceptFreePose(
      socket,
      { ...pose, sequence: 1, velocity: { x: empty * 2, y: 0 } },
      200
    ).ok
  ).toBe(false);
});
