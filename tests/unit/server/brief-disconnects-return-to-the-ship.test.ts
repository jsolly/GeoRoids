/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { PLAYER_MOTION } from '../../../shared/playerMotion';
import { RecordingSocket } from '../../support/recordingSocket';

function registerPilot(engine: GameEngine, id: string, position: { x: number; y: number }) {
  const socket = new RecordingSocket();
  const actor = engine.addPlayer(id, id, socket, position, 'scout');
  actor.asteroidInteractions = 1;
  const registered = engine.registerPilot(actor, socket);
  assert(registered.ok);
  return { actor, token: registered.resumeToken };
}

test('Enter Game after a brief leave puts the ship back with the same lives and hull', () => {
  const engine = new GameEngine(82);
  const original = registerPilot(engine, 'scout', { x: 2_400, y: 1_800 });
  original.actor.lives = 2;
  original.actor.score = 210;
  original.actor.health = 40;
  original.actor.mass = 6;
  original.actor.angle = 0.75;
  original.actor.velocity = { x: 12, y: -4 };
  engine.removePlayer('scout');

  const resumed = engine.resumePilot(original.token, new RecordingSocket(), 'scout', 'Bob');
  assert(resumed.ok);
  expect(resumed.actor).toMatchObject({
    id: 'scout',
    name: 'Bob',
    kitId: 'scout',
    lives: 2,
    score: 210,
    health: 40,
    mass: 6,
    position: { x: 2_400, y: 1_800 },
    angle: 0.75,
  });
  expect(resumed.actor.velocity.x).toBeGreaterThan(0);
  expect(resumed.actor.velocity.y).toBeLessThan(0);
  expect(resumed.actor.spawnProtectionTimer ?? 0).toBe(0);
  engine.stopGameLoop();
});

test('a long absence starts a new flight with the saved score', () => {
  let monotonicMs = 1_000;
  const clock = new ServerClock({
    wallNow: () => Date.parse('2026-09-15T12:00:00.000Z'),
    monotonicNow: () => monotonicMs,
  });
  const store = new WorldStore(':memory:');
  try {
    const engine = new GameEngine(82, clock, new InlineWorldPersistence(store));
    const original = registerPilot(engine, 'scout', { x: 2_400, y: 1_800 });
    original.actor.lives = 2;
    original.actor.score = 210;
    original.actor.health = 40;
    engine.removePlayer('scout');
    engine.stopGameLoop();

    monotonicMs += PLAYER_MOTION.returnToShipMs + 1;
    const later = new GameEngine(82, clock, new InlineWorldPersistence(store));
    const resumed = later.resumePilot(original.token, new RecordingSocket(), 'scout', 'Bob');
    assert(resumed.ok);
    expect(resumed.actor).toMatchObject({
      id: 'scout',
      name: 'Bob',
      kitId: 'scout',
      lives: 5,
      score: 210,
      health: resumed.actor.maxHealth,
    });
    expect(resumed.actor.position).not.toEqual({ x: 2_400, y: 1_800 });
    later.stopGameLoop();
  } finally {
    store.close();
  }
});

test('a restart inside the return window restores the ship and refills only elapsed boost charge', () => {
  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => 1789473600000, monotonicNow: () => elapsed });
  const store = new WorldStore(':memory:');
  try {
    const engine = new GameEngine(82, clock, new InlineWorldPersistence(store));
    const original = registerPilot(engine, 'scout', { x: 2_400, y: 1_800 });
    original.actor.lives = 1;
    original.actor.score = 880;
    original.actor.health = 22;
    original.actor.boost = { phase: 'exhausted', charge: 0.4 };
    engine.removePlayer('scout');
    engine.stopGameLoop();

    elapsed += 500;
    const restarted = new GameEngine(82, clock, new InlineWorldPersistence(store));
    const resumed = restarted.resumePilot(original.token, new RecordingSocket());
    assert(resumed.ok);
    expect(resumed.actor).toMatchObject({
      id: 'scout',
      lives: 1,
      score: 880,
      health: 22,
      boost: { phase: 'exhausted', charge: 0.5 },
      position: { x: 2_400, y: 1_800 },
    });
    restarted.stopGameLoop();
  } finally {
    store.close();
  }
});
