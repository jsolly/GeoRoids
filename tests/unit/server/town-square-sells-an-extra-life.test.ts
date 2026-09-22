/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { EXTRA_LIFE_COST, MAX_LIVES, TOWN_STORE_ISSUE } from '../../../shared/townStore';
import { WORLD } from '../../../shared/world';
import { PALETTE } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

test('Town Square sells one extra life and keeps the new count across a restart', () => {
  expect(EXTRA_LIFE_COST).toBe(1000);
  expect(MAX_LIVES).toBe(6);
  const directory = mkdtempSync(join(tmpdir(), 'town-store-'));
  const path = join(directory, 'world.sqlite');
  const firstStore = new WorldStore(path);
  try {
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(firstStore));
    const socket = new RecordingSocket();
    const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, 'hauler');
    pilot.position = { x: 0, y: 0 };
    pilot.asteroidInteractions = 1;
    pilot.score = 0;
    pilot.lives = 3;
    pilot.health = 100;
    const registered = engine.registerPilot(pilot, socket);
    assert(registered.ok);
    const bystander = engine.addPlayer(
      'rich',
      'Rich',
      new RecordingSocket(),
      { x: 10, y: 0 },
      'surveyor'
    );
    bystander.score = 3000;
    bystander.lives = 3;
    const broadcaster = new GameStateBroadcaster(engine);
    broadcaster.negotiateSnapshot(socket);
    const handler = new MessageHandler(engine, broadcaster);

    const refuse = (message: string): void => {
      const score = pilot.score;
      const lives = pilot.lives;
      handler.handleMessage({ type: 'buyExtraLife', id: pilot.id }, socket);
      expect(socket.lastReceived('townStoreResult')?.data).toEqual({ message });
      expect(pilot.score).toBe(score);
      expect(pilot.lives).toBe(lives);
    };

    refuse('You need 1000 more score');
    pilot.score = 999;
    refuse('You need 1 more score');
    pilot.score = 1000;
    pilot.position = { x: 450, y: 0 };
    refuse(TOWN_STORE_ISSUE.AWAY);
    pilot.position = { x: 0, y: 0 };
    pilot.health = 0;
    refuse(TOWN_STORE_ISSUE.CLOSED);
    pilot.health = 100;
    pilot.exploding = true;
    refuse(TOWN_STORE_ISSUE.CLOSED);
    pilot.exploding = false;
    pilot.respawnTimer = 12;
    refuse(TOWN_STORE_ISSUE.CLOSED);
    delete pilot.respawnTimer;

    pilot.lives = 5;
    pilot.score = 1000;
    handler.handleMessage({ type: 'buyExtraLife', id: pilot.id }, socket);
    expect(socket.lastReceived('townStoreResult')?.data).toEqual({
      message: 'You have 6 lives',
      score: 0,
      lives: 6,
    });
    expect(pilot.score).toBe(0);
    expect(pilot.lives).toBe(6);
    expect(pilot.color).toBe(PALETTE.REMOTE);
    expect(bystander.score).toBe(3000);
    expect(bystander.lives).toBe(3);
    refuse(TOWN_STORE_ISSUE.FULL);

    const beforeMissing = socket.received('townStoreResult').length;
    handler.handleMessage({ type: 'buyExtraLife' }, socket);
    expect(socket.received('townStoreResult').length).toBe(beforeMissing);
    const beforeForeign = socket.received('townStoreResult').length;
    handler.handleMessage({ type: 'buyExtraLife', id: bystander.id }, socket);
    expect(socket.received('townStoreResult').length).toBe(beforeForeign);
    expect(bystander.score).toBe(3000);
    expect(bystander.lives).toBe(3);
    expect(pilot.score).toBe(0);
    expect(pilot.lives).toBe(6);

    engine.checkpointWorld();
    engine.removePlayer(pilot.id);
    engine.removePlayer(bystander.id);
    firstStore.close();
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT json FROM pilots WHERE id=?').get(pilot.id) as { json: string };
    db.close();
    expect(JSON.parse(row.json)).toMatchObject({
      score: 0,
      lives: 6,
    });
    expect(JSON.parse(row.json)).not.toHaveProperty('hullColor');
    const secondStore = new WorldStore(path);
    try {
      const restarted = new GameEngine(99, undefined, new InlineWorldPersistence(secondStore));
      const resumed = restarted.resumePilot(
        registered.resumeToken,
        new RecordingSocket(),
        'hauler'
      );
      assert(resumed.ok);
      expect(resumed.actor.lives).toBe(6);
      expect(resumed.actor.score).toBe(0);
      expect(resumed.actor.color).toBe(PALETTE.REMOTE);
    } finally {
      secondStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a saved street list still loads and the next checkpoint drops it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-legacy-'));
  const path = join(directory, 'world.sqlite');
  const startedAt = 1_700_000_000_000;
  const exploration = [{ id: '0,0', bits: `${'0'.repeat(63)}1` }];
  const store = new WorldStore(path);
  try {
    store.checkpoint(
      {
        seed: 7,
        startedAt,
        generation: WORLD.generation,
        exploration,
      },
      new Map(),
      []
    );
    store.close();
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT json FROM world WHERE id=1').get() as { json: string };
    const saved = JSON.parse(row.json) as { civicModules?: unknown };
    saved.civicModules = [{ id: 'street-1-0', builderName: 'Ada' }];
    db.prepare('UPDATE world SET json=? WHERE id=1').run(JSON.stringify(saved));
    db.close();
    const loaded = new WorldStore(path);
    try {
      expect(loaded.loadWorld()).toMatchObject({ seed: 7, startedAt, exploration });
      expect(loaded.loadWorld()).not.toHaveProperty('civicModules');
      const engine = new GameEngine(42, undefined, new InlineWorldPersistence(loaded));
      engine.checkpointWorld();
      const rewrittenDb = new DatabaseSync(path);
      const rewritten = rewrittenDb.prepare('SELECT json FROM world WHERE id=1').get() as {
        json: string;
      };
      rewrittenDb.close();
      const world = JSON.parse(rewritten.json) as {
        seed: number;
        startedAt: number;
        exploration: typeof exploration;
      };
      expect(world).toMatchObject({ seed: 7, startedAt, exploration });
      expect(world).not.toHaveProperty('civicModules');
    } finally {
      loaded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a painted pilot keeps score and lives and the next checkpoint drops the paint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-paint-'));
  const path = join(directory, 'world.sqlite');
  const firstStore = new WorldStore(path);
  try {
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(firstStore));
    const socket = new RecordingSocket();
    const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, 'hauler');
    pilot.score = 2500;
    pilot.lives = 4;
    pilot.health = 100;
    pilot.asteroidInteractions = 1;
    const registered = engine.registerPilot(pilot, socket);
    assert(registered.ok);
    engine.checkpointWorld();
    engine.removePlayer(pilot.id);
    firstStore.close();
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT json FROM pilots WHERE id=?').get(pilot.id) as { json: string };
    const saved = JSON.parse(row.json) as { hullColor?: string; score: number; lives: number };
    saved.hullColor = '#c45b2d';
    db.prepare('UPDATE pilots SET json=? WHERE id=?').run(JSON.stringify(saved), pilot.id);
    db.close();
    const painted = new DatabaseSync(path);
    const paintedRow = painted.prepare('SELECT json FROM pilots WHERE id=?').get(pilot.id) as {
      json: string;
    };
    painted.close();
    expect(JSON.parse(paintedRow.json)).toMatchObject({
      hullColor: '#c45b2d',
      score: 2500,
      lives: 4,
    });
    const secondStore = new WorldStore(path);
    try {
      const restarted = new GameEngine(99, undefined, new InlineWorldPersistence(secondStore));
      const resumed = restarted.resumePilot(
        registered.resumeToken,
        new RecordingSocket(),
        'hauler'
      );
      assert(resumed.ok);
      expect(resumed.actor.score).toBe(2500);
      expect(resumed.actor.lives).toBe(4);
      expect(resumed.actor.color).toBe(PALETTE.REMOTE);
      restarted.checkpointWorld();
      const rewrittenDb = new DatabaseSync(path);
      const rewritten = rewrittenDb.prepare('SELECT json FROM pilots WHERE id=?').get(pilot.id) as {
        json: string;
      };
      rewrittenDb.close();
      const stored = JSON.parse(rewritten.json) as { score: number; lives: number };
      expect(stored).toMatchObject({ score: 2500, lives: 4 });
      expect(stored).not.toHaveProperty('hullColor');
    } finally {
      secondStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
