import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import process from 'node:process';
import { type WebSocket, WebSocketServer } from 'ws';
import { getServerLogDiagnostics, logger, writeServerDiagnostic } from '../setup/serverLogger';
import { ASTEROID_INTERACTIONS_CAPABILITY, SNAPSHOT_VERSION } from '../shared/snapshotProtocol';
import { upgradeChargeAddress } from './communication/clientAddress';
import {
  CONNECTION_ADMISSION_WINDOW_MS,
  connectionLimitsDisabled,
  createConnectionAdmission,
  MAX_PLAYERS,
  UNATTRIBUTED_CLIENT,
} from './communication/connectionAdmission';
import { shouldLogInboundGameplayMessage } from './communication/inboundMessageLog';
import { createLostAttributionTally } from './communication/lostAttribution';
import { GameplayMessageBudget } from './communication/messageBudget';
import { WebSocketCore } from './communication/WebSocketCore';
import { readServerConfiguration } from './configuration';
import { GameEngine } from './core/GameEngine';
import { DebugReportWorker } from './debugReports/client';
import {
  type DebugReportConfiguration,
  readDebugReportConfiguration,
} from './debugReports/configuration';
import { createDebugReportHttp } from './debugReports/http';
import { buildHealthResponse } from './health';
import {
  acquireServerPerformanceMetrics,
  releaseServerPerformanceMetrics,
  serverPerformanceMetrics,
  serverPerformanceMetricsEnabled,
} from './performanceMetrics';
import { SERVER_RELEASE_ID } from './release';
import { ClientLogger } from './services/ClientLogger';
import { createStaticClient } from './staticClient';
import { renderStatusPage } from './statusPage';
import {
  acceptTestPost,
  areTestHttpEndpointsEnabled,
  handleTestResetWorld,
} from './testHttpHandlers';
import { openWorldPersistence } from './world/openWorldPersistence';

type CreateServerOptions = {
  port?: number;
  nodeEnv?: string;
  seed?: number;
  worldPath?: string;
  localPlayground?: boolean;
  /** Built client directory served from this origin; set only for preview environments. */
  serveClientFrom?: string;
  /** Explicit transport injection; the production entry keeps compression disabled. */
  perMessageDeflate?: false | WebSocket.PerMessageDeflateOptions;
  /** Isolated report store for owned tests; false never touches real reporting storage. */
  debugReports?: DebugReportConfiguration | false;
};

function serveServerBanner(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('GeoRoids Game Server - Running');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

export function createServerInstance(options: CreateServerOptions = {}) {
  const configuration = readServerConfiguration();
  const PORT = options.port ?? configuration.port;
  const NODE_ENV = options.nodeEnv ?? configuration.nodeEnv;
  const reportConfiguration =
    options.debugReports === false
      ? undefined
      : (options.debugReports ?? readDebugReportConfiguration(process.env, NODE_ENV));
  const reportWorker =
    reportConfiguration !== undefined ? new DebugReportWorker(reportConfiguration) : undefined;
  // Behind Railway's ingress the socket peer is the edge proxy, so both the
  // reporting listener and the upgrade limiter have to charge `X-Real-IP`.
  const railwayIngress =
    NODE_ENV === 'production' && Boolean(process.env['RAILWAY_ENVIRONMENT_ID']);
  const reportHttp = createDebugReportHttp(reportWorker, {
    sameOriginClient: Boolean(options.serveClientFrom),
    allowedOrigins: [
      'https://www.georoids.com',
      ...(NODE_ENV !== 'production' ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []),
      ...(process.env['RAILWAY_PUBLIC_DOMAIN']
        ? [`https://${process.env['RAILWAY_PUBLIC_DOMAIN']}`]
        : []),
    ],
    railwayIngress,
    health: () => {
      const world = gameEngine.getDiagnostics();
      const persistence = world.persistence;
      return {
        releaseId: SERVER_RELEASE_ID,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        healthy: gameEngine.isPersistenceHealthy(),
        world: {
          isPaused: world.isPaused,
          gameTime: world.gameTime,
          players: world.players,
          asteroids: world.asteroids,
          loot: world.loot,
          satellitePickups: world.satellitePickups,
          loop: { ...world.loop },
          persistence: persistence
            ? {
                mode: persistence.mode,
                pendingBatches: persistence.pendingBatches,
                committedBatches: persistence.committedBatches,
                failed: persistence.failed,
                lastCommitMs: persistence.lastCommitMs ?? null,
                lastCommittedAt: persistence.lastCommittedAt ?? null,
              }
            : null,
        },
      };
    },
  });
  const logClients = new Set<WebSocket>();
  const loggingDiagnostics = () => ({
    activeLogClients: logClients.size,
    clientIngress: ClientLogger.getDiagnostics(),
    gameplayIngress: messageBudget.diagnostics(),
    serverWriter: getServerLogDiagnostics(),
  });

  // Routes the server does not own: the game server banner, or a preview's built client.
  const serveUnmatched =
    options.serveClientFrom === undefined
      ? serveServerBanner
      : createStaticClient(options.serveClientFrom);

  // Create HTTP server for health checks
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = req.url?.split('?', 1)[0];
    if (pathname === '/debug' || pathname?.startsWith('/debug/')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }
    if (reportHttp(req, res)) {
      return;
    }
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
      const health = buildHealthResponse(
        gameEngine,
        loggingDiagnostics(),
        serverPerformanceMetricsEnabled() ? serverPerformanceMetrics.read() : undefined
      );
      res.writeHead(health.statusCode, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ...health.body,
          debugReports: reportWorker?.diagnostics() ?? { enabled: false },
        })
      );
      return;
    }

    if (req.url === '/test/reset-world') {
      handleTestResetWorld(req, res, NODE_ENV, gameEngine);
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
        // Mirror /health: a failed world commit makes the server unhealthy and gameplay unavailable.
        const healthy = gameEngine.isPersistenceHealthy();
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        const serverStats = {
          timestamp: new Date().toISOString(),
          server: {
            status: healthy ? 'healthy' : 'unhealthy',
            uptime: process.uptime(),
            port: getPort(),
            nodeEnv: NODE_ENV,
          },
          websockets: {
            game: {
              endpoint: `${wsProtocol}://${host}/ws`,
              status: healthy ? 'available' : 'unavailable',
              description: 'Gameplay WebSocket for network functionality',
            },
            logs: {
              endpoint: `${wsProtocol}://${host}/logs`,
              status: 'available',
              description: 'Log forwarding WebSocket for client logs',
            },
          },
          connections: {
            currentPlayers: gameEngine.getPlayerCount(),
            maxPlayers: MAX_PLAYERS,
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

    serveUnmatched(req, res);
  });

  // Test and development runs skip both the connection and per-message budgets.
  const limitsDisabled = connectionLimitsDisabled({
    nodeEnv: NODE_ENV,
    ...(process.env['NODE_ENV'] ? { processNodeEnv: process.env['NODE_ENV'] } : {}),
    ...(process.env['VITEST'] ? { vitest: process.env['VITEST'] } : {}),
  });
  const admission = createConnectionAdmission(limitsDisabled);
  // Losing `X-Real-IP` under Railway ingress silently returns every caller to a
  // shared budget. That needs its own signal rather than being inferred from
  // refusals, which read identically to one flapping client. The record carries
  // how many upgrades it stands for, because one caller withholding the header
  // and ingress failing for a whole fleet are different incidents that a bare
  // line reads the same for. It is flushed on the limiter's own cleanup timer,
  // so an incident that ends between upgrades still reports its real volume.
  const lostAttribution = createLostAttributionTally();
  const flushLostAttribution = (): void => {
    const unattributed = lostAttribution.flush();
    if (unattributed === null) {
      return;
    }
    logger.warn(
      `⚠️ X-Real-IP unusable on ${unattributed} upgrade(s) under Railway ingress; charged to the shared unattributed budget`
    );
  };
  const logQuotaClosed = new WeakSet<WebSocket>();

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 64 * 1024,
    perMessageDeflate: options.perMessageDeflate ?? false,
    verifyClient: (info, done) => {
      let url: URL;
      try {
        url = new URL(info.req.url ?? '/', 'http://localhost');
      } catch {
        done(false, 400, 'Invalid WebSocket URL');
        return;
      }
      if (
        url.pathname !== '/logs' &&
        (url.searchParams.get('snapshotVersion') !== String(SNAPSHOT_VERSION) ||
          url.searchParams.get('asteroidInteractions') !== String(ASTEROID_INTERACTIONS_CAPABILITY))
      ) {
        // Reject before open: clients without the supported capability otherwise
        // reset their retry counter on every successful upgrade and reconnect forever.
        done(false, 426, 'Client update required; refresh GeoRoids');
        return;
      }
      // An upgrade the edge cannot attribute is charged to the shared
      // unattributed budget, which is sized for a whole fleet. An earlier
      // revision charged the proxy's own address instead, which put the whole
      // fleet into one 50-per-window bucket and refused half of it — the lockout
      // this limiter exists to prevent, reached by losing a header, not by load.
      const clientIp = upgradeChargeAddress(info.req, railwayIngress);
      if (railwayIngress && clientIp === UNATTRIBUTED_CLIENT) {
        lostAttribution.note();
      }
      const admissionDecision = admission.admit(clientIp, url.pathname, Date.now());
      if (!admissionDecision.accepted) {
        if (admissionDecision.firstRejection) {
          const spend = `${admissionDecision.count}/${admissionDecision.limit}`;
          // Which bound refused is the first thing an operator needs: one
          // flapping pilot, a lane backstop reached across every address, and a
          // tracking ceiling full of one-shot addresses are three different
          // incidents that otherwise print the same line. The charged address
          // is always named, including the shared unattributed bucket.
          const where =
            admissionDecision.scope === 'lane'
              ? `${admissionDecision.lane} lane backstop`
              : admissionDecision.scope === 'tracking'
                ? 'tracked-address ceiling'
                : admissionDecision.lane === 'logs'
                  ? 'log connection budget'
                  : 'connection budget';
          logger.warn(`🚫 Rate limited: ${where} from ${clientIp} (${spend})`);
        }
        done(
          false,
          429,
          admissionDecision.lane === 'logs'
            ? 'Log connection rate limit exceeded'
            : 'Rate limit exceeded'
        );
        return;
      }
      done(true);
    },
  });
  // Per-connection inbound message budget, on the same footing as the
  // connection limiter: a flood cannot load the single game loop, and honest
  // 60 Hz clients stay well inside it. Off in test/dev like the IP limiter.
  const messageBudget = new GameplayMessageBudget();

  // Debug logging for environment detection
  if (limitsDisabled) {
    logger.info('🧪 Development/Test environment detected - rate limiting disabled', {
      NODE_ENV,
      VITEST: process.env['VITEST'],
      NODE_ENV_ENV: process.env['NODE_ENV'],
    });
  }
  const cleanupInterval = setInterval(() => {
    admission.prune(Date.now());
    flushLostAttribution();
  }, CONNECTION_ADMISSION_WINDOW_MS);

  wss.on('error', (error) => {
    logger.error('❌ WebSocket server error:', error);
  });

  const persistence =
    options.worldPath != null && options.worldPath !== ''
      ? openWorldPersistence(options.worldPath)
      : undefined;
  const gameEngine = new GameEngine(
    options.seed,
    undefined,
    persistence,
    NODE_ENV === 'development' && options.localPlayground === true
  );
  acquireServerPerformanceMetrics();
  // Ensure the server-side game loop runs
  gameEngine.startGameLoop();
  gameEngine.updatePauseState();
  const wsCore = new WebSocketCore(gameEngine);
  gameEngine.setOnAsteroidHits((hits) => {
    wsCore.getMessageHandler().broadcastAppliedAsteroidHits(hits);
  });
  wsCore.startPeriodicGameStateBroadcast();

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (url === '/logs') {
      logClients.add(ws);
      const endLogSocket = (warn: boolean): void => {
        logQuotaClosed.add(ws);
        if (warn) {
          logger.warn('Rejected malformed client log message');
        }
        ws.terminate();
      };
      ws.on('message', (data) => {
        if (logQuotaClosed.has(ws)) {
          return;
        }
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
            endLogSocket(false);
            return;
          }
          const result = ClientLogger.logClientMessage(
            'data' in message ? message.data : undefined,
            ws
          );
          if (result === 'invalid' || result === 'rate-limited') {
            endLogSocket(false);
          }
        } catch {
          ClientLogger.recordInvalidMessage();
          endLogSocket(true);
        }
      });
      ws.on('close', () => {
        logClients.delete(ws);
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
        if (!limitsDisabled) {
          const decision = messageBudget.admit(ws, Buffer.byteLength(rawData, 'utf8'));
          if (decision !== 'ok') {
            // Only the first over-budget frame acts: terminate (a flooder need
            // not be owed the close handshake, which it can ignore for 30 s
            // while every frame re-logs) and log once. Later frames drop silently.
            if (decision === 'rate-limited') {
              const offender = gameEngine.getPlayerBySocket(ws);
              logger.warn('STATE', 'ws_message_budget_exceeded', {
                releaseId: SERVER_RELEASE_ID,
                ...(offender ? { playerId: offender.id } : {}),
              });
              ws.terminate();
            }
            return;
          }
        }
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
        for (const connectedPlayer of gameEngine.getAllPlayers()) {
          if (connectedPlayer.ws === ws) {
            wsCore.removePlayer(connectedPlayer.id);
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
    if (closing !== undefined) {
      return closing;
    }
    clearInterval(cleanupInterval);
    wsCore.stopPeriodicGameStateBroadcast();
    gameEngine.stopGameLoop();
    releaseServerPerformanceMetrics();
    const stopTransports = new Promise<void>((resolve, reject) => {
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
      void Promise.all([stopWebSockets, stopHttp]).then(
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
    closing = (async () => {
      // Whether the sockets closed or were terminated at the deadline, the
      // departing pilots are captured by now; flush the final batch and wait
      // for its commit before the process can exit. The engine bounds both
      // its wait for the writer and the writer's close, so a hung writer
      // cannot hold the process past Railway's SIGTERM window either.
      const errors: Error[] = [];
      try {
        await stopTransports;
      } catch (error) {
        errors.push(
          error instanceof Error ? error : new Error('Server shutdown failed', { cause: error })
        );
      }
      try {
        await gameEngine.shutdownPersistence();
      } catch (cause) {
        errors.push(new Error('Persistent world checkpoint failed', { cause }));
      }
      if (reportWorker) {
        try {
          await reportWorker.close();
        } catch (cause) {
          errors.push(new Error('Debug report worker shutdown failed', { cause }));
        }
      }
      if (!(await ClientLogger.flushPending())) {
        errors.push(new Error('Timed out flushing forwarded client logs'));
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Server shutdown did not complete cleanly');
      }
    })();
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
