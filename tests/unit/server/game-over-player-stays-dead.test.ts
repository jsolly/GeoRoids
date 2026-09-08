import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GameEntity } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { SHIP } from '../../../src/constants';

vi.mock('../../../setup/serverLogger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function finishExplosion(engine: GameEngine): void {
  for (let i = 0; i < SHIP.EXPLODE_DURATION_FRAMES; i++) {
    engine.entityManager.updateExplosions();
  }
}

describe('human game-over stay-dead', () => {
  let gameEngine: GameEngine;
  let player: GameEntity;

  beforeEach(() => {
    vi.clearAllMocks();
    gameEngine = new GameEngine(12345);
    player = gameEngine.addPlayer('pilot-1', 'Pilot', {} as never);
    delete player.spawnProtectionTimer;
  });

  afterEach(() => {
    gameEngine.stopGameLoop();
  });

  test('last life does not schedule a respawn and health stays at 0', () => {
    player.lives = 1;
    const destroyed = gameEngine.handlePlayerDamage('pilot-1', 'asteroid', player.health);
    expect(destroyed).toBe(true);
    expect(player.lives).toBe(0);
    expect(player.exploding).toBe(true);

    finishExplosion(gameEngine);

    expect(player.exploding).toBe(false);
    expect(player.respawnTimer).toBeUndefined();
    expect(player.health).toBe(0);
  });

  test('a leftover respawn timer does not resurrect a 0-life human', () => {
    player.lives = 0;
    player.health = 0;
    player.respawnTimer = 1;

    gameEngine.entityManager.updateRespawns();

    expect(player.health).toBe(0);
    expect(player.respawnTimer).toBeUndefined();
    expect(player.exploding).toBe(false);
  });

  test('spare lives still get a respawn timer after the explosion', () => {
    player.lives = 2;
    const destroyed = gameEngine.handlePlayerDamage('pilot-1', 'asteroid', player.health);
    expect(destroyed).toBe(true);
    expect(player.lives).toBe(1);

    finishExplosion(gameEngine);

    expect(player.respawnTimer).toBeDefined();
    expect(player.respawnTimer).toBeGreaterThan(0);
  });
});
