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
import { PALETTE } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

test('Town Square sells one extra life and keeps the new count across a restart', () => {
  expect(EXTRA_LIFE_COST).toBe(250);
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
      'scout'
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

    refuse('You need 250 more score');
    pilot.score = 249;
    refuse('You need 1 more score');
    pilot.score = 250;
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
    pilot.score = 250;
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
