import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { getServerLogDiagnostics, logger, writeServerDiagnostic } from '../setup/serverLogger';
import { shouldLogInboundGameplayMessage } from './communication/inboundMessageLog';
import { WebSocketCore } from './communication/WebSocketCore';
import { readServerConfiguration } from './configuration';
import { GameEngine } from './core/GameEngine';
import {
  acquireServerPerformanceMetrics,
  releaseServerPerformanceMetrics,
  serverPerformanceMetrics,
  serverPerformanceMetricsEnabled,
} from './performanceMetrics';
import { SERVER_RELEASE_ID } from './release';
import { ClientLogger } from './services/ClientLogger';
import { renderStatusPage } from './statusPage';
import {
  acceptTestPost,
  areTestHttpEndpointsEnabled,
  buildHealthPayload,
  handleTestArrangeBotShot,
  handleTestPlacePlayer,
  handleTestResetWorld,
} from './testHttpHandlers';

export type CreateServerOptions = {
  port?: number;
  nodeEnv?: string;
  requireEnhancedClient?: boolean;
  seed?: number;
};

export function createServerInstance(options: CreateServerOptions = {}) {
  const configuration = readServerConfiguration();
  const PORT = options.port ?? configuration.port;
  const NODE_ENV = options.nodeEnv ?? configuration.nodeEnv;
  const requireEnhancedClient =
    options.requireEnhancedClient ?? configuration.requireEnhancedClient;
  const logClients = new Set<WebSocket>();
  const loggingDiagnostics = () => ({
    activeLogClients: logClients.size,
    clientIngress: ClientLogger.getDiagnostics(),
    serverWriter: getServerLogDiagnostics(),
  });

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
      headers: req.headers,
    });

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          buildHealthPayload(
            wsCore,
            gameEngine,
            loggingDiagnostics(),
            serverPerformanceMetricsEnabled() ? serverPerformanceMetrics.read() : undefined
          )
        )
      );
      return;
    }

    if (req.url === '/test/reset-world') {
      handleTestResetWorld(req, res, NODE_ENV, gameEngine);
      return;
    }

    if (req.url === '/test/place-player') {
      handleTestPlacePlayer(req, res, NODE_ENV, gameEngine, wsCore);
      return;
    }

    if (req.url === '/test/arrange-bot-shot') {
      handleTestArrangeBotShot(req, res, NODE_ENV, gameEngine, wsCore);
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
      if (!acceptTestPost(req, res, NODE_ENV)) {
        return;
      }
      void writeServerDiagnostic('Test server log triggered from /status page')
        .then((written) => {
          res.writeHead(written ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: written ? 'success' : 'error',
              message: written
                ? 'Test server log written to server.log'
                : 'Server log write failed',
              timestamp: new Date().toISOString(),
            })
          );
        })
        .catch((error) => {
          logger.error('Failed to complete server log diagnostic', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Server log diagnostic failed' }));
        });
      return;
    }

    if (req.url === '/status') {
      const acceptHeader = req.headers.accept || '';
      const userAgent = req.headers['user-agent'] || '';
      const prefersJson =
        userAgent.includes('curl') ||
        userAgent.includes('wget') ||
        userAgent.includes('httpie') ||
        acceptHeader.includes('application/json');

      const host = req.headers.host || `localhost:${PORT}`;
      const forwardedProto = req.headers['x-forwarded-proto'];
      const protocol =
        (typeof forwardedProto === 'string' ? forwardedProto : forwardedProto?.[0]) ||
        ('encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http');
      const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

      if (prefersJson) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const serverStats = {
          timestamp: new Date().toISOString(),
          server: {
            status: 'healthy',
            uptime: process.uptime(),
            port: getPort(),
            nodeEnv: NODE_ENV,
          },
          websockets: {
            game: {
              endpoint: `${wsProtocol}://${host}/ws`,
              status: 'available',
              description: 'Gameplay WebSocket for network functionality',
            },
            logs: {
              endpoint: `${wsProtocol}://${host}/logs`,
              status: 'available',
              description: 'Log forwarding WebSocket for client logs',
            },
          },
          connections: {
            currentPlayers: wsCore.getPlayerCount(),
            maxPlayers: 100,
            activeLogClients: logClients.size,
          },
          logging: loggingDiagnostics(),
          endpoints: {
            health: `${protocol}://${host}/health`,
            status: `${protocol}://${host}/status`,
            gameWs: `${wsProtocol}://${host}/ws`,
            logWs: `${wsProtocol}://${host}/logs`,
          },
          version: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
          },
        };
        res.end(JSON.stringify(serverStats, null, 2));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderStatusPage(areTestHttpEndpointsEnabled(NODE_ENV)));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 64 * 1024,
    verifyClient: (info, done) => {
      let url: URL;
      try {
        url = new URL(info.req.url ?? '/', 'http://localhost');
      } catch {
        done(false, 400, 'Invalid WebSocket URL');
        return;
      }
      if (
        requireEnhancedClient &&
        url.pathname === '/ws' &&
        url.searchParams.get('asteroidInteractions') !== '1'
      ) {
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
  const isTestEnvironment =
    NODE_ENV === 'test' || process.env['VITEST'] === 'true' || process.env['NODE_ENV'] === 'test';
  const isDevelopmentEnvironment =
    NODE_ENV === 'development' || process.env['NODE_ENV'] === 'development';
  const shouldDisableRateLimit = isTestEnvironment || isDevelopmentEnvironment;
  const MAX_CONNECTIONS_PER_MINUTE = shouldDisableRateLimit ? 10000 : 50; // Much higher limit for tests and dev

  // Debug logging for environment detection
  if (shouldDisableRateLimit) {
    logger.info('🧪 Development/Test environment detected - rate limiting disabled', {
      NODE_ENV,
      VITEST: process.env['VITEST'],
      NODE_ENV_ENV: process.env['NODE_ENV'],
      isTestEnvironment,
      isDevelopmentEnvironment,
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
      logger.warn(
        `🚫 Rate limited connection attempt from ${ip} (${attempts.count}/${MAX_CONNECTIONS_PER_MINUTE})`
      );
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

  const gameEngine = new GameEngine(options.seed);
  acquireServerPerformanceMetrics();
  // Ensure server-side game loop (including bot regen) runs
  gameEngine.startGameLoop();
  gameEngine.updatePauseState();
  const wsCore = new WebSocketCore(gameEngine, requireEnhancedClient);
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
      logClients.add(ws);
      logger.info('📝 Log client connected');
      ws.on('message', (data) => {
        try {
          const message: unknown = JSON.parse(String(data));
          if (
            typeof message !== 'object' ||
            message === null ||
            Array.isArray(message) ||
            !('type' in message) ||
            message.type !== 'clientLog'
          ) {
            ClientLogger.recordInvalidMessage();
            ws.close(1008, 'Invalid client log message');
            return;
          }
          const result = ClientLogger.logClientMessage(
            'data' in message ? message.data : undefined,
            ws
          );
          if (result === 'invalid') {
            ws.close(1008, 'Invalid client log payload');
          } else if (result === 'rate-limited') {
            ws.close(1008, 'Client log rate limit exceeded');
          }
        } catch {
          ClientLogger.recordInvalidMessage();
          logger.warn('Rejected malformed client log message');
          ws.close(1007, 'Malformed client log message');
        }
      });
      ws.on('close', () => {
        logClients.delete(ws);
        logger.info('📝 Log client disconnected');
      });
      ws.on('error', (error) => {
        logClients.delete(ws);
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
            logger.debug('SERVER: Received WebSocket message', {
              type: message.type,
              id: message.id,
            });
          }
          wsCore.handleClientMessage(message, ws);
        } catch (error) {
          logger.error(
            'Failed to parse WebSocket message',
            { rawDataByteLength: Buffer.byteLength(rawData, 'utf8') },
            error instanceof Error ? error : new Error(String(error))
          );
          wsCore.sendError(ws, 'Invalid message format');
        }
      });
      ws.on('close', () => {
        const player = gameEngine.getPlayerBySocket(ws);
        const resumable = gameEngine.transportClosed(ws);
        logger.info('STATE', 'Gameplay transport closed', {
          ...(player ? { playerId: player.id } : {}),
          resumable,
          gameTime: gameEngine.getDiagnostics().gameTime,
          releaseId: SERVER_RELEASE_ID,
        });
        if (resumable) {
          return;
        }
        for (const player of wsCore.getAllPlayers()) {
          if (player.ws === ws) {
            wsCore.removePlayer(player.id);
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

  const listening = new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, () => {
      httpServer.off('error', reject);
      const actualPort = getPort();
      logger.info(`✅ Server listening on port ${actualPort}`);
      resolve(actualPort);
    });
  });

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) {
      return closing;
    }
    clearInterval(cleanupInterval);
    wsCore.stopPeriodicGameStateBroadcast();
    gameEngine.stopGameLoop();
    releaseServerPerformanceMetrics();
    closing = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        for (const socket of wss.clients) {
          socket.terminate();
        }
        httpServer.closeAllConnections();
        reject(new Error('Server shutdown timed out; remaining connections were terminated'));
      }, 2000);
      const stopWebSockets = new Promise<void>((done, fail) => {
        wss.close((error) => (error ? fail(error) : done()));
        for (const socket of wss.clients) {
          socket.close(1001, 'Server shutting down');
        }
      });
      const stopHttp = new Promise<void>((done, fail) => {
        httpServer.close((error) => {
          if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) {
            fail(error);
          } else {
            done();
          }
        });
      });
      void Promise.all([stopWebSockets, stopHttp])
        .then(async () => {
          if (!(await ClientLogger.flushPending())) {
            throw new Error('Timed out flushing forwarded client logs');
          }
        })
        .then(
          () => {
            clearTimeout(deadline);
            resolve();
          },
          (error) => {
            clearTimeout(deadline);
            reject(error);
          }
        );
    });
    return closing;
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
