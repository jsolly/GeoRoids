import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';

describe('Server Message Parity', () => {
  let wsCore: WebSocketCore;
  let gameEngine: GameEngine;

  beforeAll(() => {
    gameEngine = new GameEngine();
    wsCore = new WebSocketCore(gameEngine);
  });

  afterAll(() => {
    // Clean up any timers
    // Note: cleanupStalePlayers is private, so we can't call it directly
    // The interval will be cleaned up when the process ends
  });

  it('should handle join messages with nested data payloads', () => {
    const sentMessages: string[] = [];
    const mockWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => {
        sentMessages.push(data);
      },
    } as unknown as WebSocket;

    const joinMessage = {
      type: 'join',
      data: {
        id: 'test-id',
        name: 'test-name',
        position: { x: 0, y: 0 },
      },
    };

    wsCore.handleClientMessage(joinMessage, mockWs);

    // Verify player was added
    expect(wsCore.getPlayerCount()).toBe(1);
    const player = gameEngine.getPlayer('test-id');
    expect(player).toBeDefined();
    expect(player?.name).toBe('test-name');

    // Check that we got the joined message and game state
    expect(sentMessages.length).toBeGreaterThan(0);
    const joinedMessage = sentMessages.find((msg) => {
      const parsed = JSON.parse(msg);
      return parsed.type === 'joined';
    });
    expect(joinedMessage).toBeDefined();
    expect(joinedMessage).toBeTruthy();

    const parsedJoined = JSON.parse(joinedMessage as string);
    expect(parsedJoined.data.id).toBe('test-id');
    expect(parsedJoined.data.name).toBe('test-name');
    expect(parsedJoined.data.position).toBeDefined();
  });

  it('should handle update messages with nested data payloads', () => {
    const mockWs = {
      readyState: WebSocket.OPEN,
      send: (_data: string) => {
        // This would be called for broadcasts, but we're not testing that here
      },
    } as unknown as WebSocket;

    // First add a player
    const joinMessage = {
      type: 'join',
      data: {
        id: 'update-test-id',
        name: 'update-test-name',
        position: { x: 0, y: 0 },
      },
    };
    wsCore.handleClientMessage(joinMessage, mockWs);

    // Then update the player. Position is client-owned; score/lives/health are
    // server-authoritative and intentionally ignored from client updates.
    const updateMessage = {
      type: 'update',
      data: {
        id: 'update-test-id',
        position: { x: 100, y: 200 },
        score: 150,
      },
    };

    wsCore.handleClientMessage(updateMessage, mockWs);

    // The nested-data update was applied to the client-owned position...
    const player = gameEngine.getPlayer('update-test-id');
    expect(player).toBeDefined();
    expect(player?.position).toEqual({ x: 100, y: 200 });
    // ...but the client-sent score was ignored (server-authoritative).
    expect(player?.score).toBe(0);
  });

  it('should handle top-level id/name fields for backward compatibility', () => {
    const sentMessages: string[] = [];
    const mockWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => {
        sentMessages.push(data);
      },
    } as unknown as WebSocket;

    const joinMessage = {
      type: 'join',
      id: 'top-level-id',
      name: 'top-level-name',
      position: { x: 0, y: 0 },
    };

    wsCore.handleClientMessage(joinMessage, mockWs);

    // Verify player was added
    const player = gameEngine.getPlayer('top-level-id');
    expect(player).toBeDefined();
    expect(player?.name).toBe('top-level-name');

    // Check that we got the joined message
    expect(sentMessages.length).toBeGreaterThan(0);
    const joinedMessage = sentMessages.find((msg) => {
      const parsed = JSON.parse(msg);
      return parsed.type === 'joined';
    });
    expect(joinedMessage).toBeDefined();
    expect(joinedMessage).toBeTruthy();

    const parsedJoined = JSON.parse(joinedMessage as string);
    expect(parsedJoined.data.id).toBe('top-level-id');
    expect(parsedJoined.data.name).toBe('top-level-name');
  });

  it('should send standardized error messages', () => {
    const sentMessages: string[] = [];
    const mockWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => {
        sentMessages.push(data);
      },
    } as unknown as WebSocket;

    // Send invalid message (missing id)
    const invalidMessage = {
      type: 'update',
      data: {
        position: { x: 0, y: 0 },
      },
    };

    wsCore.handleClientMessage(invalidMessage, mockWs);

    // Verify error was sent
    expect(sentMessages).toHaveLength(1);
    const rawMessage = sentMessages[0];
    assert.exists(rawMessage);
    const errorMessage = JSON.parse(rawMessage);
    expect(errorMessage.type).toBe('error');
    expect(errorMessage.data).toBe('Missing player ID');
    expect(errorMessage.timestamp).toBeDefined();
  });

  it('should handle shoot messages', () => {
    const sentMessages: string[] = [];
    const mockWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => {
        sentMessages.push(data);
      },
    } as unknown as WebSocket;

    // Add the shooter player
    const joinMessage = {
      type: 'join',
      data: {
        id: 'shoot-test-id',
        name: 'shoot-test-name',
        position: { x: 0, y: 0 },
      },
    };
    wsCore.handleClientMessage(joinMessage, mockWs);

    // Add another player to receive the broadcast
    const otherPlayerWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => {
        sentMessages.push(data);
      },
    } as unknown as WebSocket;

    const otherJoinMessage = {
      type: 'join',
      data: {
        id: 'other-test-id',
        name: 'other-test-name',
        position: { x: 100, y: 100 },
      },
    };
    wsCore.handleClientMessage(otherJoinMessage, otherPlayerWs);

    // Clear previous messages
    sentMessages.length = 0;

    // Then send a shoot message
    const shootMessage = {
      type: 'shoot',
      id: 'shoot-test-id',
      data: {
        laserStart: { x: 10, y: 20 },
        laserDirection: { x: 1, y: 0 },
      },
      timestamp: Date.now(),
    };

    wsCore.handleClientMessage(shootMessage, mockWs);

    // A muzzle can also hit a live asteroid immediately. Verify the shoot
    // event exactly once without mistaking authoritative hit events for duplicates.
    const shots = sentMessages
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === 'playerShoot');
    expect(shots).toHaveLength(1);
    const broadcastMessage = shots[0];
    assert.exists(broadcastMessage);
    expect(broadcastMessage.type).toBe('playerShoot');
    expect(broadcastMessage.data.id).toBe('shoot-test-id');
    expect(broadcastMessage.data.laserStart).toEqual({ x: 10, y: 20 });
    expect(broadcastMessage.data.laserDirection).toEqual({ x: 1, y: 0 });
    expect(broadcastMessage.timestamp).toBeDefined();
  });
});
