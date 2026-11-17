import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import type { AppliedAsteroidHit } from '../../../server/core/types';
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
    engine.asteroidLifecycle.remove(rock.id);
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
  const target = engine.getAsteroid(asteroidId);
  const hit = engine.asteroidMining.apply(asteroidId, 'pilot');
  handler.broadcastAppliedAsteroidHits([hit]);
  if (hit.applied) {
    expect(hit.origin).toBe(target?.position);
  } else {
    expect(hit.origin).toBeUndefined();
    expect(hit.points).toBe(0);
    expect(hit.newAsteroids).toEqual([]);
  }
  return hit;
}

test('a surviving deposit reports each chip and only its shatter reports destruction', () => {
  engine.asteroidLifecycle.insert(deposit('ore'));

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

test('a chip reaches pilots who could hear it and no one else', () => {
  const distant = new RecordingSocket();
  engine.addPlayer('distant', 'Distant', distant, { x: 10000, y: 0 }, 'scout');
  engine.asteroidLifecycle.insert(deposit('ore'));

  expect(chip('ore').outcome).toBe('damaged');
  expect(socket.received('asteroidHit').map((message) => message.data)).toEqual([
    { asteroidId: 'ore', position },
  ]);
  // The client culls the cue outside its viewport, so a pilot far past the
  // interest radius is never sent a message it would only discard.
  expect(distant.received('asteroidHit')).toEqual([]);

  // That socket is live, though: the shatter is not interest filtered and does
  // arrive, so it is the chip that is scoped rather than the recipient.
  expect(chip('ore').outcome).toBe('damaged');
  expect(chip('ore').outcome).toBe('destroyed');
  expect(distant.received('asteroidDestroy')).toHaveLength(1);
  expect(distant.received('asteroidHit')).toEqual([]);
});

test('an ordinary rock shatters on its first hit and never reports a chip', () => {
  const rock = deposit('ice-rock');
  engine.asteroidLifecycle.insert({ ...rock, material: 'ice', health: 40, maxHealth: 40 });

  expect(chip('ice-rock').outcome).toBe('destroyed');
  expect(socket.received('asteroidHit')).toEqual([]);
  expect(socket.received('asteroidDestroy')).toHaveLength(1);
});

test('a hit that never applied stays silent', () => {
  expect(chip('no-such-rock').outcome).toBe('missing');
  expect(socket.received('asteroidHit')).toEqual([]);
  expect(socket.received('asteroidDestroy')).toEqual([]);
  expect(engine.getLoot()).toEqual([]);

  // A deposit inside a burning boost ignores the shot, so nothing sounds.
  const burning = deposit('burning');
  engine.asteroidLifecycle.insert({
    ...burning,
    boost: { phase: 'burning', ownerId: 'pilot', angle: 0 },
  });
  expect(chip('burning').outcome).toBe('ignored');
  expect(socket.received('asteroidHit')).toEqual([]);
  expect(socket.received('asteroidDestroy')).toEqual([]);
  expect(engine.getLoot()).toEqual([]);
});

test('a late listener receives only actual applied chips in order and keeps their identities', () => {
  engine.asteroidLifecycle.insert(deposit('first-ore'));
  engine.asteroidLifecycle.insert(deposit('second-ore'));
  const missing = engine.asteroidMining.apply('missing', 'pilot');
  const first = engine.asteroidMining.apply('first-ore', 'pilot');
  const second = engine.asteroidMining.apply('second-ore', 'pilot');
  const third = engine.asteroidMining.apply('first-ore', 'pilot');
  expect(missing.applied).toBe(false);
  expect(first.outcome).toBe('damaged');
  expect(second.outcome).toBe('damaged');
  expect(third.outcome).toBe('damaged');
  engine.asteroidHitFeedback.emit([missing]);
  engine.asteroidHitFeedback.emit([missing, first, second]);
  engine.asteroidHitFeedback.emit([third, missing]);
  const batches: AppliedAsteroidHit[][] = [];

  engine.asteroidHitFeedback.setListener((hits) => {
    batches.push(hits);
    handler.broadcastAppliedAsteroidHits(hits);
  });

  expect(batches).toHaveLength(1);
  expect(batches[0]).toEqual([first, second, third]);
  expect(batches[0]?.[0]).toBe(first);
  expect(batches[0]?.[1]).toBe(second);
  expect(batches[0]?.[2]).toBe(third);
  expect(socket.received('asteroidHit').map((message) => message.data)).toEqual([
    { asteroidId: 'first-ore', position },
    { asteroidId: 'second-ore', position },
    { asteroidId: 'first-ore', position },
  ]);
  engine.asteroidHitFeedback.emit([missing]);
  expect(batches).toHaveLength(1);
  engine.asteroidHitFeedback.setListener((hits) => batches.push(hits));
  expect(batches).toHaveLength(1);
});

test('installing the listener precedes queued delivery so reentrant chips arrive immediately', () => {
  engine.asteroidLifecycle.insert(deposit('ore'));
  const first = engine.asteroidMining.apply('ore', 'pilot');
  engine.asteroidHitFeedback.emit([first]);
  const order: string[] = [];
  const batches: AppliedAsteroidHit[][] = [];

  engine.asteroidHitFeedback.setListener((hits) => {
    batches.push(hits);
    order.push(`start-${batches.length}`);
    if (batches.length === 1) {
      const next = engine.asteroidMining.apply('ore', 'pilot');
      expect(next.outcome).toBe('damaged');
      engine.asteroidHitFeedback.emit([next]);
      order.push('outer-end');
    } else {
      order.push('inner-end');
    }
  });

  expect(order).toEqual(['start-1', 'start-2', 'inner-end', 'outer-end']);
  expect(batches.map((hits) => hits.map((hit) => hit.outcome))).toEqual([['damaged'], ['damaged']]);
  expect(engine.getAsteroid('ore')?.health).toBe(25);
});

test('a queued chip is drained before its listener throws and replacement never replays it', () => {
  engine.asteroidLifecycle.insert(deposit('ore'));
  const first = engine.asteroidMining.apply('ore', 'pilot');
  engine.asteroidHitFeedback.emit([first]);
  const failure = new Error('asteroid feedback interrupted');
  const delivered: AppliedAsteroidHit[] = [];

  assert.throws(
    () =>
      engine.asteroidHitFeedback.setListener((hits) => {
        delivered.push(...hits);
        throw failure;
      }),
    (error) => error === failure
  );
  expect(delivered).toEqual([first]);
  const second = engine.asteroidMining.apply('ore', 'pilot');
  assert.throws(
    () => engine.asteroidHitFeedback.emit([second]),
    (error) => error === failure
  );
  expect(delivered).toEqual([first, second]);
  const replacement: AppliedAsteroidHit[] = [];
  engine.asteroidHitFeedback.setListener((hits) => replacement.push(...hits));
  expect(replacement).toEqual([]);
  const fresh = engine.asteroidMining.apply('ore', 'pilot');
  expect(fresh.outcome).toBe('destroyed');
  engine.asteroidHitFeedback.emit([fresh]);
  expect(replacement).toEqual([fresh]);
  expect(replacement[0]).toBe(fresh);
  expect(delivered).toEqual([first, second]);
});

test('a live listener failure escapes after mining and leaves the same listener installed', () => {
  engine.asteroidLifecycle.insert(deposit('ore'));
  const failure = new Error('live feedback interrupted');
  const delivered: AppliedAsteroidHit[] = [];
  engine.asteroidHitFeedback.setListener((hits) => {
    delivered.push(...hits);
    throw failure;
  });
  const first = engine.asteroidMining.apply('ore', 'pilot');
  assert.throws(
    () => engine.asteroidHitFeedback.emit([first]),
    (error) => error === failure
  );
  expect(engine.getAsteroid('ore')?.health).toBe(50);
  const second = engine.asteroidMining.apply('ore', 'pilot');
  assert.throws(
    () => engine.asteroidHitFeedback.emit([second]),
    (error) => error === failure
  );
  expect(delivered).toEqual([first, second]);
  expect(engine.getAsteroid('ore')?.health).toBe(25);
});

test('the last pilot leaving preserves queued asteroid feedback until a listener arrives', () => {
  engine.asteroidLifecycle.insert(deposit('ore'));
  const hit = engine.asteroidMining.apply('ore', 'pilot');
  engine.asteroidHitFeedback.emit([hit]);

  engine.removePlayer('pilot');

  expect(engine.isGamePaused()).toBe(true);
  const delivered: AppliedAsteroidHit[] = [];
  engine.asteroidHitFeedback.setListener((hits) => delivered.push(...hits));
  expect(delivered).toEqual([hit]);
  expect(delivered[0]).toBe(hit);
});

test('world reset discards old queued chips and retains the listener for the replacement world', () => {
  engine.asteroidLifecycle.insert(deposit('old-ore'));
  const stale = engine.asteroidMining.apply('old-ore', 'pilot');
  engine.asteroidHitFeedback.emit([stale]);

  engine.resetForTesting();

  const delivered: AppliedAsteroidHit[] = [];
  engine.asteroidHitFeedback.setListener((hits) => delivered.push(...hits));
  expect(delivered).toEqual([]);
  engine.resetForTesting();
  engine.addPlayer('replacement', 'Replacement', new RecordingSocket(), { x: 0, y: 0 }, 'scout');
  engine.asteroidLifecycle.insert(deposit('new-ore'));
  const fresh = engine.asteroidMining.apply('new-ore', 'replacement');
  expect(fresh.outcome).toBe('damaged');
  engine.asteroidHitFeedback.emit([fresh]);
  expect(delivered).toEqual([fresh]);
  expect(delivered[0]).toBe(fresh);
  expect(engine.getAsteroid('old-ore')).toBeUndefined();
});
