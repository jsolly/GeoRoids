import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../setup/serverLogger';
import { shouldLogInboundGameplayMessage } from './communication/inboundMessageLog';
import { WebSocketCore } from './communication/WebSocketCore';
import { GameEngine } from './core/GameEngine';
import { ClientLogger } from './services/ClientLogger';
import { buildHealthPayload, handleTestResetWorld } from './testHttpHandlers';
import { SERVER_RELEASE_ID } from './release';

type CreateServerOptions = {
  port?: number;
  nodeEnv?: string;
  requireEnhancedClient?: boolean;
};

export function createServerInstance(options: CreateServerOptions = {}) {
  const PORT = options.port ?? Number(process.env.PORT ?? 3001);
  const NODE_ENV = options.nodeEnv ?? process.env.NODE_ENV ?? 'production';
  const requireEnhancedClient = options.requireEnhancedClient ?? process.env.REQUIRE_ASTEROID_CLIENT === '1';

  // Create HTTP server for health checks
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('x-release-id', SERVER_RELEASE_ID);
    // Add CORS headers for production
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Log all incoming requests for debugging
    logger.debug('📥 HTTP Request:', {
      method: req.method,
      url: req.url,
      headers: req.headers
    });

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildHealthPayload(wsCore, gameEngine)));
      return;
    }

    if (req.url === '/test/reset-world') {
      handleTestResetWorld(req, res, NODE_ENV, gameEngine);
      return;
    }

    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('GeoRoids Game Server - Running');
      return;
    }

    if (req.url === '/ws' || req.url === '/logs') {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('WebSocket connections should use ws:// protocol');
      return;
    }

    if (req.url === '/test-server-log') {
      if (req.method === 'POST') {
        logger.info('🧪 Test server log triggered from /status page');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'success',
          message: 'Test server log written to server.log',
          timestamp: new Date().toISOString()
        }));
      } else {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method not allowed');
      }
      return;
    }

    if (req.url === '/status') {
      const acceptHeader = req.headers.accept || '';
      const userAgent = req.headers['user-agent'] || '';
      const prefersJson = userAgent.includes('curl') ||
                         userAgent.includes('wget') ||
                         userAgent.includes('httpie') ||
                         acceptHeader.includes('application/json');

      const host = req.headers.host || `localhost:${PORT}`;
      const protocol = (req.headers['x-forwarded-proto'] as string) || ((req.socket as any).encrypted ? 'https' : 'http');
      const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

      if (prefersJson) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const serverStats = {
          timestamp: new Date().toISOString(),
          server: {
            status: 'healthy',
            uptime: process.uptime(),
            port: getPort(),
            nodeEnv: NODE_ENV
          },
          websockets: {
            game: {
              endpoint: `${wsProtocol}://${host}/ws`,
              status: 'available',
              description: 'Gameplay WebSocket for network functionality'
            },
            logs: {
              endpoint: `${wsProtocol}://${host}/logs`,
              status: 'available',
              description: 'Log forwarding WebSocket for client logs'
            }
          },
          connections: {
            currentPlayers: wsCore.getPlayerCount(),
            maxPlayers: 100,
            activeLogClients: 0
          },
          endpoints: {
            health: `${protocol}://${host}/health`,
            status: `${protocol}://${host}/status`,
            gameWs: `${wsProtocol}://${host}/ws`,
            logWs: `${wsProtocol}://${host}/logs`
          },
          version: {
            node: process.version,
            platform: process.platform,
            arch: process.arch
          }
        };
        res.end(JSON.stringify(serverStats, null, 2));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>WebSocket Status - GeoAsteroids</title></head><body><h1>GeoAsteroids Server</h1><p>Use curl -H "Accept: application/json" /status for JSON.</p></body></html>');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, done) => {
      let url: URL;
      try {
        url = new URL(info.req.url ?? '/', 'http://localhost');
      } catch {
        done(false, 400, 'Invalid WebSocket URL');
        return;
      }
      if (requireEnhancedClient && url.pathname === '/ws' && url.searchParams.get('asteroidInteractions') !== '1') {
        // Reject before open: old clients otherwise reset their retry counter
        // on every successful upgrade and reconnect forever after a close.
        done(false, 426, 'Client update required; refresh GeoRoids');
        return;
      }
      done(true);
    },
  });

  // Rate limiting
  const connectionAttempts = new Map<string, { count: number; lastAttempt: number }>();
  // More lenient rate limiting for testing and development
  const isTestEnvironment = NODE_ENV === 'test' || process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
  const isDevelopmentEnvironment = NODE_ENV === 'development' || process.env.NODE_ENV === 'development';
  const shouldDisableRateLimit = isTestEnvironment || isDevelopmentEnvironment;
  const MAX_CONNECTIONS_PER_MINUTE = shouldDisableRateLimit ? 10000 : 50; // Much higher limit for tests and dev
  
  // Debug logging for environment detection
  if (shouldDisableRateLimit) {
    logger.info('🧪 Development/Test environment detected - rate limiting disabled', {
      NODE_ENV,
      VITEST: process.env.VITEST,
      NODE_ENV_ENV: process.env.NODE_ENV,
      isTestEnvironment,
      isDevelopmentEnvironment
    });
  }
  const CONNECTION_WINDOW_MS = 60000;

  function isRateLimited(ip: string): boolean {
    // Skip rate limiting entirely in test or development environment
    if (shouldDisableRateLimit) {
      return false;
    }
    
    const now = Date.now();
    const attempts = connectionAttempts.get(ip);
    if (!attempts) {
      connectionAttempts.set(ip, { count: 1, lastAttempt: now });
      return false;
    }
    if (now - attempts.lastAttempt > CONNECTION_WINDOW_MS) {
      connectionAttempts.set(ip, { count: 1, lastAttempt: now });
      return false;
    }
    if (attempts.count >= MAX_CONNECTIONS_PER_MINUTE) {
      logger.warn(`🚫 Rate limited connection attempt from ${ip} (${attempts.count}/${MAX_CONNECTIONS_PER_MINUTE})`);
      return true;
    }
    attempts.count++;
    attempts.lastAttempt = now;
    return false;
  }

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of connectionAttempts.entries()) {
      if (now - attempts.lastAttempt > CONNECTION_WINDOW_MS) {
        connectionAttempts.delete(ip);
      }
    }
  }, CONNECTION_WINDOW_MS);

  wss.on('error', (error) => {
    logger.error('❌ WebSocket server error:', error);
  });

  const gameEngine = new GameEngine();
  // Ensure server-side game loop (including bot regen) runs
  gameEngine.startGameLoop();
  gameEngine.updatePauseState();
  const wsCore = new WebSocketCore(gameEngine);
  gameEngine.setOnAsteroidHits((hits) => {
    wsCore.getMessageHandler().broadcastAppliedAsteroidHits(hits);
  });
  wsCore.startPeriodicGameStateBroadcast();

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost').pathname;
    const clientIp = req.socket.remoteAddress || 'unknown';

    if (isRateLimited(clientIp)) {
      logger.warn(`🚫 Rate limited connection attempt from ${clientIp}`);
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    if (url === '/logs') {
      logger.info('📝 Log client connected');
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(String(data));
          if (message.type === 'clientLog') {
            const logData = message.data;
            ClientLogger.logClientMessage(logData).catch((error) => {
              logger.warn('Failed to write client log to file:', error);
            });
          }
        } catch (error) {
          logger.error('Failed to parse log message:', error instanceof Error ? error.message : 'Unknown error');
        }
      });
      ws.on('close', () => {
        logger.info('📝 Log client disconnected');
      });
      ws.on('error', (error) => {
        logger.error('❌ Log WebSocket error:', error);
      });
      return;
    }

    if (url === '/ws') {
      logger.info('🔌 New player connected');
      ws.on('message', (data) => {
        const rawData = String(data);
        try {
          const message = JSON.parse(rawData);
          if (shouldLogInboundGameplayMessage(message.type)) {
            logger.debug('SERVER: Received WebSocket message', { type: message.type, id: message.id });
          }
          wsCore.handleClientMessage(message, ws);
        } catch (error) {
          const rawPrefix =
            rawData.length <= 500 ? rawData : `${rawData.slice(0, 500)}…`;
          logger.error(
            'Failed to parse WebSocket message',
            {
              rawDataPrefix: rawPrefix,
              rawDataByteLength: Buffer.byteLength(rawData, 'utf8'),
            },
            error instanceof Error ? error : new Error(String(error)),
          );
          wsCore.sendError(ws, 'Invalid message format');
        }
      });
      ws.on('close', () => {
        if (gameEngine.transportClosed(ws)) return;
        for (const player of wsCore.getAllPlayers()) {
          if ((player as any).ws === ws) {
            wsCore.removePlayer((player as any).id);
            break;
          }
        }
      });
      ws.on('error', (error) => {
        logger.error('❌ WebSocket error:', error);
      });
      return;
    }

    logger.warn('❌ Unknown WebSocket path:', url);
    ws.close(1008, 'Unknown path');
  });

  function getPort(): number {
    const address = httpServer.address();
    if (address && typeof address === 'object') {
      return address.port;
    }
    return PORT;
  }

  const listening = new Promise<number>((resolve) => {
    httpServer.listen(PORT, () => {
      const actualPort = getPort();
      logger.info(`✅ Server listening on port ${actualPort}`);
      resolve(actualPort);
    });
  });

  async function close(): Promise<void> {
    clearInterval(cleanupInterval);
    wsCore.stopPeriodicGameStateBroadcast();
    gameEngine.stopGameLoop();
    await new Promise<void>((resolve) => {
      try {
        wss.close(() => resolve());
      } catch {
        resolve();
      }
    });
    await new Promise<void>((resolve) => {
      try {
        httpServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

      logger.info(`🚀 Starting ${NODE_ENV} game server on port ${PORT}`);

  return {
    httpServer,
    wss,
    wsCore,
    gameEngine,
    listening,
    getPort,
    close,
  };
}
