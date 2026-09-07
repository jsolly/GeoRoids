import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GameEngine } from './core/GameEngine';
import type { WebSocketCore } from './communication/WebSocketCore';
import { SERVER_RELEASE_ID } from './release';

export type GameEngineDiagnostics = {
  isPaused: boolean;
  gameTime: number;
  humanPlayers: number;
  bots: number;
  asteroids: number;
  satellites: number;
  satellitePickups: number;
};

/** Test-only HTTP routes — enabled only in local dev and Vitest, never in production. */
export function areTestHttpEndpointsEnabled(nodeEnv: string): boolean {
  return nodeEnv === 'test' || nodeEnv === 'development';
}

export function buildHealthPayload(
  wsCore: WebSocketCore,
  gameEngine: GameEngine
): Record<string, unknown> {
  const diagnostics = gameEngine.getDiagnostics();
  return {
    status: 'healthy',
    releaseId: SERVER_RELEASE_ID,
    timestamp: new Date().toISOString(),
    players: wsCore.getPlayerCount(),
    uptime: process.uptime(),
    world: diagnostics,
  };
}

export function handleTestResetWorld(
  req: IncomingMessage,
  res: ServerResponse,
  nodeEnv: string,
  gameEngine: GameEngine
): void {
  if (!areTestHttpEndpointsEnabled(nodeEnv)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  gameEngine.resetForTesting();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'reset',
      world: gameEngine.getDiagnostics(),
      timestamp: new Date().toISOString(),
    })
  );
}
