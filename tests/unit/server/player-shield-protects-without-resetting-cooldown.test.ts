import { expect, test } from 'vitest';
import { EntityManager } from '../../../server/core/EntityManager';
import { RNGService } from '../../../server/core/RNGService';
import { activatePlayerShield, PLAYER_SHIELD } from '../../../shared/playerShield';

test('shield blocks damage for two seconds and stays on cooldown after protection ends', () => {
  const entities = new EntityManager(new RNGService(7));
  const pilot = entities.addPlayer('pilot', 'Pilot', undefined, { x: 2000, y: 0 });
  delete pilot.spawnProtectionTimer;
  expect(activatePlayerShield(pilot)).toBe(true);
  expect(entities.damageEntity(pilot.id, 30)).toBeNull();
  expect(pilot.health).toBe(pilot.maxHealth);
  expect(activatePlayerShield(pilot)).toBe(false);
  for (let tick = 0; tick < PLAYER_SHIELD.durationFrames; tick++) {
    entities.updateRespawns();
  }
  expect(pilot.shieldFrames).toBe(0);
  expect(activatePlayerShield(pilot)).toBe(false);
  entities.damageEntity(pilot.id, 30);
  expect(pilot.health).toBe(pilot.maxHealth - 30);
  for (let tick = PLAYER_SHIELD.durationFrames; tick < PLAYER_SHIELD.cooldownFrames; tick++) {
    entities.updateRespawns();
  }
  expect(activatePlayerShield(pilot)).toBe(true);
});
