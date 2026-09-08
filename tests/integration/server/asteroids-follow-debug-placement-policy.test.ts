import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { DEBUG } from '../../../src/constants';

describe('Roid Placement Integration Tests', () => {
  let gameEngine: GameEngine;

  beforeEach(() => {
    gameEngine = new GameEngine();
  });

  afterEach(() => {
    // Clean up
    gameEngine = null as any;
  });

  describe('PLACE_ROID_ON_LOCAL_PLAYER functionality', () => {
    it('should place roids on player positions when PLACE_ROID_ON_LOCAL_PLAYER is true', () => {
      // Enable the debug feature locally for this test (production default is off
      // because spawning roids on the player makes the live game unplayable).
      const originalSetting = DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER;
      (DEBUG as any).ROIDS.PLACE_ON_LOCAL_PLAYER = true;

      try {
        // Create a player at a specific position
        const playerId = 'test-player-1';
        const playerName = 'TestPlayer';
        const playerPosition = { x: 100, y: 200 };

        // Mock WebSocket for player creation
        const mockWs = {} as any;
        gameEngine.addPlayer(playerId, playerName, mockWs, playerPosition);

        // Get player positions
        const players = gameEngine.getAllPlayers();
        const playerPositions = players.map((player) => player.position);

        expect(playerPositions).toHaveLength(1);
        expect(playerPositions[0]).toEqual(playerPosition);

        // Create bots at specific positions
        const botPositions = [
          { x: 300, y: 400 },
          { x: 500, y: 600 },
        ];

        // Create bots (this will add them to the game engine)
        const bots = gameEngine.createBots(2);
        expect(bots).toHaveLength(2);

        // Create asteroids with player and bot positions
        const asteroids = gameEngine.createAsteroids(
          5,
          { radius: 3100 },
          botPositions,
          playerPositions
        );

        expect(asteroids).toHaveLength(5);

        // Check if any asteroids are placed on player positions
        const asteroidsOnPlayer = asteroids.filter(
          (asteroid) =>
            Math.abs(asteroid.position.x - playerPosition.x) < 10 &&
            Math.abs(asteroid.position.y - playerPosition.y) < 10
        );

        // With PLACE_ROID_ON_LOCAL_PLAYER enabled, we should have at least one asteroid on the player
        expect(asteroidsOnPlayer.length).toBeGreaterThan(0);
      } finally {
        (DEBUG as any).ROIDS.PLACE_ON_LOCAL_PLAYER = originalSetting;
      }
    });

    it('should not place roids on player positions when PLACE_ROID_ON_LOCAL_PLAYER is false', () => {
      // Temporarily disable the setting
      const originalSetting = DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER;
      (DEBUG as any).ROIDS.PLACE_ON_LOCAL_PLAYER = false;

      try {
        const playerId = 'test-player-2';
        const playerName = 'TestPlayer2';
        const playerPosition = { x: 150, y: 250 };

        const mockWs = {} as any;
        gameEngine.addPlayer(playerId, playerName, mockWs, playerPosition);

        const players = gameEngine.getAllPlayers();
        const playerPositions = players.map((player) => player.position);

        const asteroids = gameEngine.createAsteroids(3, { radius: 3100 }, [], playerPositions);

        // Check if any asteroids are placed on player positions
        const asteroidsOnPlayer = asteroids.filter(
          (asteroid) =>
            Math.abs(asteroid.position.x - playerPosition.x) < 10 &&
            Math.abs(asteroid.position.y - playerPosition.y) < 10
        );

        // With PLACE_ROID_ON_LOCAL_PLAYER disabled, we should have no asteroids on the player
        expect(asteroidsOnPlayer.length).toBe(0);
      } finally {
        // Restore original setting
        (DEBUG as any).ROIDS.PLACE_ON_LOCAL_PLAYER = originalSetting;
      }
    });

    it('asteroids avoid bot positions when debug placement is disabled', () => {
      // Production placement does not pin asteroids onto bots.
      expect(DEBUG.ROIDS.PLACE_ON_BOT).toBe(false);

      const botPositions = [
        { x: 100, y: 200 },
        { x: 300, y: 400 },
      ];

      // Create bots
      const bots = gameEngine.createBots(2);
      expect(bots).toHaveLength(2);

      const asteroids = gameEngine.createAsteroids(4, { radius: 3100 }, botPositions, []);

      expect(asteroids).toHaveLength(4);

      // Check if any asteroids are placed on bot positions
      const asteroidsOnBots = asteroids.filter((asteroid) =>
        botPositions.some(
          (botPos) =>
            Math.abs(asteroid.position.x - botPos.x) < 10 &&
            Math.abs(asteroid.position.y - botPos.y) < 10
        )
      );

      // With PLACE_ROID_ON_BOT disabled, we should have no asteroids on bots
      expect(asteroidsOnBots.length).toBe(0);
    });
  });

  describe('Explicit field creation', () => {
    it('honors the requested count without player-position hints', () => {
      const asteroids = gameEngine.createAsteroids(10, { radius: 3100 }, [], []);

      expect(asteroids).toHaveLength(10);

      // Verify no asteroids are at origin (0,0) where players typically spawn
      const asteroidsAtOrigin = asteroids.filter(
        (asteroid) => Math.abs(asteroid.position.x) < 10 && Math.abs(asteroid.position.y) < 10
      );

      // This should be 0 or very few since we're not placing on players
      expect(asteroidsAtOrigin.length).toBeLessThan(3);
    });
  });
});
