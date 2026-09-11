/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { afterEach, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import type { SoftFactionId } from '../../../shared-types';
import { DAMAGE } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

const engines: GameEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.stopGameLoop();
  }
});
function arena(faction: SoftFactionId = 'ember', kit: 'dart' | 'warden' = 'dart') {
  const engine = new GameEngine(741);
  engines.push(engine);
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  for (const bot of engine.getAllBots()) {
    engine.removeBot(bot.id);
  }
  for (const satellite of engine.getAllSatellites()) {
    const row = engine.getSatellite(satellite.id);
    assert(row);
    row.position = { x: 20000, y: 20000 };
  }
  const attacker = engine.addPlayer(
    'attacker',
    'Attacker',
    new RecordingSocket(),
    { x: -100, y: 0 },
    undefined,
    'dart',
    'ion'
  );
  const target = engine.addPlayer(
    'target',
    'Target',
    new RecordingSocket(),
    { x: 0, y: 0 },
    undefined,
    kit,
    faction
  );
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  delete target.spawnProtectionTimer;
  return { engine, attacker, target };
}
function fire(engine: GameEngine, ownerId: string) {
  const shot = engine.spawnLaser(ownerId, { x: -50, y: 0 }, { x: 100, y: 0 });
  assert(shot);
  engine.advanceLasersAndResolveHits();
  return shot;
}

test('an allied shot passes through while a hostile shot damages the shared hull', () => {
  for (const faction of ['ion', 'ember'] as const) {
    const { engine, attacker, target } = arena(faction);
    const health = target.health;
    const shot = fire(engine, attacker.id);
    expect(target.health).toBe(faction === 'ion' ? health : health - DAMAGE.LASER_HIT);
    expect(shot.hasExploded).toBe(faction === 'ember');
    expect(engine.getGameState().entities.find((row) => row.id === target.id)?.health).toBe(
      target.health
    );
  }
});

test('a bot shot damages a human but passes through a spawn-protected human', () => {
  for (const protectedSpawn of [false, true]) {
    const { engine, target } = arena();
    const bot = engine.entityManager.createBots(1)[0];
    assert(bot);
    bot.factionId = 'ion';
    bot.position = { x: -100, y: 0 };
    if (protectedSpawn) {
      target.spawnProtectionTimer = 60;
    }
    const health = target.health;
    fire(engine, bot.id);
    expect(target.health).toBe(protectedSpawn ? health : health - DAMAGE.LASER_HIT);
  }
});

for (const shield of ['manual', 'warden'] as const) {
  test(`a hostile shot flashes the ${shield} shield while an allied shot passes quietly`, () => {
    for (const faction of ['ion', 'ember'] as const) {
      const { engine, attacker, target } = arena(faction);
      if (shield === 'manual') {
        expect(engine.requestShield(target.id, true)).toBe(true);
      } else {
        const caster = engine.addPlayer(
          'warden',
          'Warden',
          new RecordingSocket(),
          { x: 0, y: 80 },
          undefined,
          'warden',
          faction
        );
        expect(engine.useAbility(caster.id)).toBe(true);
        expect(caster.shieldTargetId).toBe(target.id);
        expect(target.shieldSourceId).toBe(caster.id);
        for (const rock of engine.getAllAsteroids()) {
          engine.removeAsteroid(rock.id);
        }
      }
      const health = target.health;
      const shot = fire(engine, attacker.id);
      expect(target.health).toBe(health);
      expect(target.shieldFlashTime > 0).toBe(faction === 'ember');
      expect(shot.bounces ?? 0).toBe(faction === 'ember' ? 1 : 0);
      expect(shot.velocity.x < 0).toBe(faction === 'ember');
      expect(target.shieldActive).toBe(shield === 'manual');
      const snapshot = engine.getGameState().entities.find((row) => row.id === target.id);
      expect(snapshot?.shieldFlashTime).toBe(target.shieldFlashTime);
    }
  });
}
