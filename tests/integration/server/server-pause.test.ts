import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import { GameEngine } from '../../../server/core/GameEngine';

describe('Server pause functionality', () => {
  let wss: WebSocketServer;
  let gameEngine: GameEngine;


  beforeAll(async () => {
    // Create a test server
    wss = new WebSocketServer({ port: 0 });

    
    // Create game engine
    gameEngine = new GameEngine();
    gameEngine.startGameLoop();
  });

  afterAll(async () => {
    gameEngine.stopGameLoop();
    wss.close();
  });

  it('should pause game when no players are present', () => {
    // Initially no players, game should be paused
    gameEngine.updatePauseState();
    expect(gameEngine.isGamePaused()).toBe(true);
  });

  it('should create and preserve asteroids when game is paused', () => {
    // Create asteroids
    const asteroids = gameEngine.createAsteroids(5);
    expect(asteroids.length).toBe(5);
    expect(gameEngine.getAsteroidCount()).toBe(5);
    
    // Game should still be paused (no players)
    gameEngine.updatePauseState();
    expect(gameEngine.isGamePaused()).toBe(true);
    
    // Asteroids should persist
    expect(gameEngine.getAsteroidCount()).toBe(5);
  });

  it('should resume game when players join', () => {
    // Simulate adding a player
    const mockWs = {} as any;
    const player = gameEngine.addPlayer('test-player', 'TestPlayer', mockWs);
    
    expect(player).toBeDefined();
    expect(gameEngine.isGamePaused()).toBe(false);
    
    // Asteroids should still exist
    expect(gameEngine.getAsteroidCount()).toBe(5);
  });

  it('should pause and reset the world when all players leave', () => {
    // Remove the player
    const removedPlayer = gameEngine.removePlayer('test-player');

    expect(removedPlayer).toBeDefined();
    expect(gameEngine.isGamePaused()).toBe(true);

    // When the last human leaves, the world resets so the next player starts
    // fresh: asteroids are cleared.
    expect(gameEngine.getAsteroidCount()).toBe(0);
  });

  it('should create a fresh asteroid field when a new player initializes one', () => {
    // With the world reset, requesting asteroids creates a brand-new field.
    const asteroids = gameEngine.createAsteroids(10);

    // Explicit field creation honors the requested count outside debug mode.
    expect(asteroids.length).toBe(10);
    expect(gameEngine.getAsteroidCount()).toBe(10);
  });
});
