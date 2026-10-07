import type { IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';
import { logger } from '../setup/serverLogger';
import type { WebSocketCore } from './communication/WebSocketCore';
import type { GameEngine } from './core/GameEngine';
import type { ServerPerformanceSummary } from './performanceMetrics';
import { SERVER_RELEASE_ID } from './release';

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function acceptTestPost(
  req: IncomingMessage,
  res: ServerResponse,
  nodeEnv: string
): boolean {
  if (!areTestHttpEndpointsEnabled(nodeEnv) || !isLoopbackRequest(req)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return false;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return false;
  }
  return true;
}

/** Test-only HTTP routes — enabled only in local dev and Vitest, never in production. */
export function areTestHttpEndpointsEnabled(nodeEnv: string): boolean {
  return nodeEnv === 'test' || nodeEnv === 'development';
}

export function buildHealthPayload(
  wsCore: WebSocketCore,
  gameEngine: GameEngine,
  logging?: Record<string, unknown>,
  metrics?: ServerPerformanceSummary
): Record<string, unknown> {
  const diagnostics = gameEngine.getDiagnostics();
  return {
    status: gameEngine.isPersistenceHealthy() ? 'healthy' : 'unhealthy',
    releaseId: SERVER_RELEASE_ID,
    timestamp: new Date().toISOString(),
    players: wsCore.getPlayerCount(),
    uptime: process.uptime(),
    world: diagnostics,
    ...(logging ? { logging } : {}),
    ...(metrics ? { metrics } : {}),
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
  if (!isLoopbackRequest(req)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    gameEngine.resetForTesting();
  } catch (error) {
    const failure =
      error instanceof AggregateError
        ? {
            message: error.message,
            failures: Array.from(error.errors, (entry: unknown) =>
              entry instanceof Error
                ? { message: entry.message, cause: entry.cause }
                : String(entry)
            ),
          }
        : error;
    logger.error('TEST_RESET_FAILED', {
      operation: 'reset test world',
      action: 'close or replace the failing player socket, then retry',
      error: failure,
    });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Test world reset failed',
        reason: error instanceof AggregateError ? 'socket-close-failed' : 'world-reset-failed',
      })
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'reset',
      world: gameEngine.getDiagnostics(),
      timestamp: new Date().toISOString(),
    })
  );
}
