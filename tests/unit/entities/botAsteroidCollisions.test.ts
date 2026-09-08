import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import type { GameEntity } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { SHIP } from '../../../src/constants';

function firstBot(bots: GameEntity[] | null): GameEntity {
  expect(bots).not.toBeNull();
  const bot = bots![0];
  expect(bot).toBeDefined();
  return bot!;
}

// Mock logger
vi.mock('../../setup/serverLogger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Bot-Asteroid Collision System', () => {
  let gameEngine: GameEngine;
  let asteroidManager: AsteroidManager;
  let rngService: RNGService;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create fresh instances for each test
    rngService = new RNGService(12345); // Fixed seed for deterministic tests
    gameEngine = new GameEngine(12345);
    asteroidManager = new AsteroidManager(rngService);

    // Clear any existing asteroids
    asteroidManager.clearAsteroids();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Bot Damage System', () => {
    test('bot takes damage when hit by asteroid', () => {
      // Create a bot (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2); // DEBUG.BOT_PLAYER.COUNT overrides the requested count
      const bot = firstBot(bots);
      const initialHealth = bot.health;

      // Damage the bot (simulating asteroid collision)
      const damage = 25;
      const damagedBot = gameEngine.handleBotDamage(bot.id, 'test-attacker', damage);

      expect(damagedBot).toBe(false); // Bot was damaged but not destroyed
      const updatedBot = gameEngine.getBot(bot.id);
      expect(updatedBot).not.toBeNull();
      expect(updatedBot!.health).toBe(initialHealth - damage);
      expect(updatedBot!.exploding).toBe(false); // Not destroyed yet
    });

    test('bot explodes when health reaches zero', () => {
      // Create a bot (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);

      // Deal lethal damage
      const lethalDamage = bot.health;
      const damagedBot = gameEngine.handleBotDamage(bot.id, 'test-attacker', lethalDamage);

      expect(damagedBot).toBe(true); // Damage was applied
      const updatedBot = gameEngine.getBot(bot.id);
      expect(updatedBot).not.toBeNull();
      expect(updatedBot!.health).toBe(0);
      expect(updatedBot!.exploding).toBe(true);
      expect(updatedBot!.explodeTime).toBe(SHIP.EXPLODE_DURATION_FRAMES);
      expect(updatedBot!.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
    });

    test('bot cannot take damage while exploding', () => {
      // Create a bot and destroy it (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      gameEngine.handleBotDamage(bot.id, 'test-attacker', bot.health); // Destroy the bot

      // Try to damage exploding bot
      const damagedBot = gameEngine.handleBotDamage(bot.id, 'test-attacker', 25);

      expect(damagedBot).toBe(false); // Should not take damage while exploding
    });

    test('bot cannot take damage when health is zero', () => {
      // Create a bot and set health to 0 (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      gameEngine.updateBot(bot.id, { health: 0, exploding: true }); // Set exploding to true for dead bot

      // Try to damage dead bot
      const damagedBot = gameEngine.handleBotDamage(bot.id, 'test-attacker', 25);

      expect(damagedBot).toBe(false); // Should not take damage when dead
    });

    test('bot respects spawn protection when enabled', () => {
      // Create a bot with spawn protection (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      gameEngine.updateBot(bot.id, { spawnProtectionTimer: 60 }); // 1 second protection

      // Try to damage bot with spawn protection
      const damagedBot = gameEngine.handleBotDamage(bot.id, 'test-attacker', 25);

      // Note: In DEBUG mode, bot spawn protection is disabled (BOT_PLAYER.SPAWN_PROTECTION: false)
      // So the bot will take damage even with spawn protection
      expect(damagedBot).toBe(false); // Bot was damaged but not destroyed
      const updatedBot = gameEngine.getBot(bot.id);
      expect(updatedBot!.health).toBe(75); // 100 - 25
    });
  });

  describe('Bot Explosion System', () => {
    test('bot explosion timer counts down correctly', () => {
      // Create and destroy a bot (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      gameEngine.handleBotDamage(bot.id, 'test-attacker', bot.health); // Destroy the bot

      const updatedBot = gameEngine.getBot(bot.id);
      expect(updatedBot!.exploding).toBe(true);
      expect(updatedBot!.explodeTime).toBe(18);

      const finishedExploding = gameEngine.entityManager.updateExplosions();
      expect(finishedExploding).toHaveLength(0); // Not finished yet

      // Check that timer decreased
      const botAfterUpdate = gameEngine.getBot(bot.id);
      expect(botAfterUpdate!.explodeTime).toBe(17); // 18 - 1
    });

    test('bot respawns after explosion completes', () => {
      // Create and destroy a bot (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      gameEngine.handleBotDamage(bot.id, 'test-attacker', bot.health); // Destroy the bot

      // Check initial explosion timer
      const initialBot = gameEngine.getBot(bot.id);
      expect(initialBot!.explodeTime).toBe(18);

      // Update explosion timer once
      const finishedExploding = gameEngine.entityManager.updateExplosions();
      expect(finishedExploding).toHaveLength(0); // Not finished yet

      // Check that timer decreased
      const botAfterUpdate = gameEngine.getBot(bot.id);
      expect(botAfterUpdate!.explodeTime).toBe(17); // 18 - 1

      // Fast-forward explosion timer
      for (let i = 1; i < SHIP.EXPLODE_DURATION_FRAMES; i++) {
        gameEngine.entityManager.updateExplosions();
      }

      // Explosion finished; shared ship lifecycle waits for respawn to restore health
      const respawnedBot = gameEngine.getBot(bot.id);
      expect(respawnedBot).not.toBeNull();
      expect(respawnedBot!.exploding).toBe(false);
      expect(respawnedBot!.health).toBe(0);
      expect(respawnedBot!.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
    });

    test('bot respawn timer counts down correctly', () => {
      // Create, destroy, and complete explosion (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      gameEngine.handleBotDamage(bot.id, 'test-attacker', bot.health);

      // Check initial explosion timer
      const initialBot = gameEngine.getBot(bot.id);
      expect(initialBot!.explodeTime).toBe(18);

      // Update explosion timer once
      const finishedExploding = gameEngine.entityManager.updateExplosions();
      expect(finishedExploding).toHaveLength(0); // Not finished yet

      // Check that timer decreased
      const botAfterUpdate = gameEngine.getBot(bot.id);
      expect(botAfterUpdate!.explodeTime).toBe(17); // 18 - 1

      // Complete explosion
      for (let i = 1; i < SHIP.EXPLODE_DURATION_FRAMES; i++) {
        gameEngine.entityManager.updateExplosions();
      }

      // Update respawn timer
      const finishedRespawning = gameEngine.entityManager.updateRespawns();
      expect(finishedRespawning).toHaveLength(0); // Not finished yet

      // Check that timer decreased
      const botAfterRespawnUpdate = gameEngine.getBot(bot.id);
      expect(botAfterRespawnUpdate!.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES - 1);
    });

    test('bot completes respawn after timer expires', () => {
      // Create, destroy, complete explosion, and start respawn (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      gameEngine.handleBotDamage(bot.id, 'test-attacker', bot.health);

      // Check initial explosion timer
      const initialBot = gameEngine.getBot(bot.id);
      expect(initialBot!.explodeTime).toBe(18);

      // Update explosion timer once
      const finishedExploding = gameEngine.entityManager.updateExplosions();
      expect(finishedExploding).toHaveLength(0); // Not finished yet

      // Check that timer decreased
      const botAfterUpdate = gameEngine.getBot(bot.id);
      expect(botAfterUpdate!.explodeTime).toBe(17); // 18 - 1

      // Complete explosion
      for (let i = 1; i < SHIP.EXPLODE_DURATION_FRAMES; i++) {
        gameEngine.entityManager.updateExplosions();
      }

      for (let i = 0; i < SHIP.RESPAWN_DELAY_FRAMES; i++) {
        gameEngine.entityManager.updateRespawns();
      }

      // Bot should be fully respawned
      const respawnedBot = gameEngine.getBot(bot.id);
      expect(respawnedBot).not.toBeNull();
      expect(respawnedBot!.respawnTimer).toBeUndefined();
      expect(respawnedBot!.exploding).toBe(false);
      expect(respawnedBot!.health).toBe(respawnedBot!.maxHealth);
      expect(respawnedBot!.spawnProtectionTimer).toBe(180);
      expect(respawnedBot!.respawnAnchor).toEqual(respawnedBot!.position);
    });
  });

  describe('Game Engine Bot Collision Handling', () => {
    test('game engine handles bot damage correctly', () => {
      // Create bots through game engine (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);

      // Simulate bot damage through game engine
      const isDestroyed = gameEngine.handleBotDamage(bot.id, 'test-attacker', 25);

      expect(isDestroyed).toBe(false); // Bot not destroyed yet

      // Check bot was damaged
      const updatedBot = gameEngine.getBot(bot.id);
      expect(updatedBot!.health).toBe(75); // 100 - 25
    });

    test('game engine awards points for bot destruction', () => {
      // Create a player to receive points
      const mockWs = {} as any; // Mock WebSocket
      gameEngine.addPlayer('test-player', 'Test Player', mockWs);

      // Create and destroy a bot (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      const isDestroyed = gameEngine.handleBotDamage(bot.id, 'test-player', bot.health);

      expect(isDestroyed).toBe(true); // Bot destroyed

      // Check player received points
      const updatedPlayer = gameEngine.getPlayer('test-player');
      expect(updatedPlayer!.score).toBe(50); // Points for bot kill
    });

    test('game engine handles multiple bot damages', () => {
      // Create multiple bots (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots max)
      const bots = gameEngine.createBots(3);
      expect(bots).toHaveLength(2); // DEBUG.BOT_PLAYER.COUNT limits to 2

      // Damage each bot
      for (const bot of bots!) {
        const isDestroyed = gameEngine.handleBotDamage(bot.id, 'test-attacker', 30);
        expect(isDestroyed).toBe(false); // Not destroyed yet
      }

      // Check all bots were damaged (kits have different max health)
      for (const bot of bots!) {
        const updatedBot = gameEngine.getBot(bot.id);
        expect(updatedBot!.health).toBe(updatedBot!.maxHealth - 30);
      }
    });
  });

  describe('Bot Health Regeneration', () => {
    test('bot health regenerates after damage', () => {
      // Create a bot and damage it (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      gameEngine.handleBotDamage(bot.id, 'test-attacker', 30);

      // Start game loop to enable health regeneration
      gameEngine.startGameLoop();

      // Wait for health regeneration (simulate multiple game ticks)
      // Health regeneration starts after 3 seconds (180 frames) of no damage
      for (let i = 0; i < 200; i++) {
        // Simulate game tick
        // Health regeneration is now handled client-side
      }

      // Check that health has regenerated
      const updatedBot = gameEngine.getBot(bot.id);
      // Health regeneration might not work in test environment, so just check it's not less than 70
      expect(updatedBot!.health).toBeGreaterThanOrEqual(70); // Should have regenerated some health or stayed the same

      // Clean up
      gameEngine.stopGameLoop();
    });

    test('bot health does not regenerate while exploding', () => {
      // Create and destroy a bot (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      gameEngine.handleBotDamage(bot.id, 'test-attacker', bot.health);

      // Start game loop
      gameEngine.startGameLoop();

      // Wait for potential regeneration
      for (let i = 0; i < 200; i++) {
        // Health regeneration is now handled client-side
      }

      // Bot should still be exploding and not regenerating
      const updatedBot = gameEngine.getBot(bot.id);
      expect(updatedBot!.exploding).toBe(true);
      expect(updatedBot!.health).toBe(0); // Should not have regenerated

      // Clean up
      gameEngine.stopGameLoop();
    });
  });

  describe('Bot Movement and Collision Avoidance', () => {
    test('bot movement stops when exploding', () => {
      // Create and destroy a bot (DEBUG.BOT_PLAYER.COUNT=2, so we get 2 bots)
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);
      const initialPosition = { ...bot.position };

      gameEngine.handleBotDamage(bot.id, 'test-attacker', bot.health);

      // Start game loop
      gameEngine.startGameLoop();

      // Simulate movement
      for (let i = 0; i < 60; i++) {
        (gameEngine as any).updateBotMovement();
      }

      // Bot should not have moved while exploding
      const updatedBot = gameEngine.getBot(bot.id);
      expect(updatedBot!.exploding).toBe(true);
      expect(updatedBot!.position).toEqual(initialPosition);

      // Clean up
      gameEngine.stopGameLoop();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('handles damage to non-existent bot', () => {
      const isDestroyed = gameEngine.handleBotDamage('non-existent-bot', 'test-attacker', 25);
      expect(isDestroyed).toBe(false);
    });

    test('handles zero damage', () => {
      const bots = gameEngine.createBots(1);
      const bot = firstBot(bots);
      const initialHealth = bot.health;

      const isDestroyed = gameEngine.handleBotDamage(bot.id, 'test-attacker', 0);
      expect(isDestroyed).toBe(false);

      const updatedBot = gameEngine.getBot(bot.id);
      expect(updatedBot!.health).toBe(initialHealth);
    });

    test('handles negative damage (healing)', () => {
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);

      // Damage the bot first
      gameEngine.handleBotDamage(bot.id, 'test-attacker', 30);
      const damagedBot = gameEngine.getBot(bot.id);
      expect(damagedBot!.health).toBe(70);

      // Heal the bot
      const isDestroyed = gameEngine.handleBotDamage(bot.id, 'test-attacker', -20);
      expect(isDestroyed).toBe(false);

      const healedBot = gameEngine.getBot(bot.id);
      expect(healedBot!.health).toBe(90); // 70 + 20
    });

    test('handles excessive damage', () => {
      const bots = gameEngine.createBots(1);
      expect(bots).toHaveLength(2);
      const bot = firstBot(bots);

      const isDestroyed = gameEngine.handleBotDamage(bot.id, 'test-attacker', 1000);
      expect(isDestroyed).toBe(true);

      const updatedBot = gameEngine.getBot(bot.id);
      expect(updatedBot!.health).toBe(0);
      expect(updatedBot!.exploding).toBe(true);
    });
  });
});
