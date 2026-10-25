import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import type { AppliedAsteroidHit } from '../../../server/core/GameEngine';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

vi.mock('../../../setup/serverLogger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const position = { x: 400, y: -250 };

let engine: GameEngine;
let broadcaster: GameStateBroadcaster;
let handler: MessageHandler;
let socket: RecordingSocket;

beforeEach(() => {
  engine = new GameEngine(4242);
  broadcaster = new GameStateBroadcaster(engine);
  handler = new MessageHandler(engine, broadcaster);
  socket = new RecordingSocket();
  engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, 'scout');
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
});

afterEach(() => {
  engine.stopGameLoop();
  vi.restoreAllMocks();
});

/** A durable deposit: three Scout shots, so the first two leave it standing. */
function deposit(id: string): AsteroidData {
  return {
    id,
    position: { ...position },
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 75,
    maxHealth: 75,
    vertices: 6,
    offsets: [1, 1, 1, 1, 1, 1],
  };
}

function chip(asteroidId: string): AppliedAsteroidHit {
  const hit = engine.applyLaserAsteroidHit(asteroidId, 'pilot');
  handler.broadcastAppliedAsteroidHits([hit]);
  return hit;
}

test('a surviving deposit reports each chip and only its shatter reports destruction', () => {
  engine.addAsteroid(deposit('ore'));

  expect(chip('ore').outcome).toBe('damaged');
  expect(socket.received('asteroidHit').map((message) => message.data)).toEqual([
    { asteroidId: 'ore', position },
  ]);
  expect(socket.received('asteroidDestroy')).toEqual([]);

  expect(chip('ore').outcome).toBe('damaged');
  expect(socket.received('asteroidHit')).toHaveLength(2);
  expect(socket.received('asteroidDestroy')).toEqual([]);

  // The shatter is already audible as a destruction, so it reports no chip.
  socket.clear();
  expect(chip('ore').outcome).toBe('destroyed');
  expect(socket.received('asteroidHit')).toEqual([]);
  expect(socket.received('asteroidDestroy')).toHaveLength(1);
});

test('an ordinary rock shatters on its first hit and never reports a chip', () => {
  const rock = deposit('ice-rock');
  engine.addAsteroid({ ...rock, material: 'ice', health: 40, maxHealth: 40 });

  expect(chip('ice-rock').outcome).toBe('destroyed');
  expect(socket.received('asteroidHit')).toEqual([]);
  expect(socket.received('asteroidDestroy')).toHaveLength(1);
});

test('a hit that never applied stays silent', () => {
  expect(chip('no-such-rock').outcome).toBe('missing');
  expect(socket.received('asteroidHit')).toEqual([]);
  expect(socket.received('asteroidDestroy')).toEqual([]);

  // A deposit inside a burning boost ignores the shot, so nothing sounds.
  const burning = deposit('burning');
  engine.addAsteroid({
    ...burning,
    boost: { phase: 'burning', ownerId: 'pilot', angle: 0 },
  });
  expect(chip('burning').outcome).toBe('ignored');
  expect(socket.received('asteroidHit')).toEqual([]);
  expect(socket.received('asteroidDestroy')).toEqual([]);
});
