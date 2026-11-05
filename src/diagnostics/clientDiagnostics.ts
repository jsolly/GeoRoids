import { formatDebugDiagnostics, sanitizeDebugDiagnostics } from '../../shared/debugReports';
import { getTerrainSeed } from '../../shared/terrainField';
import type { DebugDiagnosticSnapshot } from '../../shared-types';
import { readAudioDiagnostics } from '../audio/audioRuntime';
import { readMusicDiagnostics } from '../audio/musicBeds';
import { GameController } from '../core/gameController';
import { readTouchControlDiagnostics } from '../input/touchControls';
import { readStoredResumeName, readStoredResumeToken } from '../network/services/resumeCredential';
import { canvasManager } from '../rendering/canvasSurface';
import { getClientReleaseId } from '../utils/buildInfo';
import { getClientLogContext } from '../utils/clientLogContext';
import { logger } from '../utils/Logger';
import { readDebugHudMetrics } from './debugHudMetrics';
import { clientPerformance } from './performanceMetrics';

/** Explicit fields only: never serialize the player, transport or browser storage. */
export function captureClientDiagnostics(): DebugDiagnosticSnapshot {
  const game = GameController.getInstance();
  const network = game.getNetworkManager();
  const player = game.getCurrPlayer();
  const ship = player?.ship;
  const canvas = canvasManager.getCanvas();
  const viewport = canvasManager.getViewportSize();
  const graphics = clientPerformance.read().graphicsSettings;
  const state = {
    version: 1,
    capturedAt: new Date().toISOString(),
    ...getClientLogContext(),
    clientReleaseId: getClientReleaseId(),
    serverReleaseId: network.getServerReleaseId(),
    browser: navigator.userAgent,
    page: {
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      width: innerWidth,
      height: innerHeight,
      deviceDpr: devicePixelRatio,
    },
    canvas: canvas
      ? {
          cssWidth: viewport.width,
          cssHeight: viewport.height,
          backingWidth: canvas.width,
          backingHeight: canvas.height,
          effectiveDpr: canvas.width / viewport.width,
        }
      : null,
    graphics: {
      maxDpr: graphics['maxDpr'],
      glow: graphics['glow'],
      source: graphics['source'],
      scanScenery: graphics['scanScenery'],
      scanSceneryMaxPixels: graphics['scanSceneryMaxPixels'],
      sceneryCache: { scope: 'canvas-lifetime', ...canvasManager.getScanSceneryStats() },
      scanDetail: graphics['scanDetail'],
      deviceCategory: graphics['deviceCategory'],
      scanDetailReason: graphics['scanDetailReason'],
      scanDeviceMemory: graphics['scanDeviceMemory'],
      scanLogicalCores: graphics['scanLogicalCores'],
      simpleScanDprCap: graphics['simpleScanDprCap'],
      simpleScanPixelCap: graphics['simpleScanPixelCap'],
      simpleScanMaxDimension: graphics['simpleScanMaxDimension'],
      presentationPolicy: graphics['presentationPolicy'],
      flightEffectiveDpr: graphics['flightEffectiveDpr'],
      flightBackingWidth: graphics['flightBackingWidth'],
      flightBackingHeight: graphics['flightBackingHeight'],
      simplifiedScan: canvasManager.readSimpleScanDiagnostics(),
    },
    audio: { ...readAudioDiagnostics(), ...readMusicDiagnostics() },
    metrics: readDebugHudMetrics(performance.now()),
    connected: network.isConnected,
    running: game.getIsGameRunning(),
    ship: ship
      ? {
          id: player?.id,
          kitId: ship.kitId,
          position: ship.position,
          velocity: ship.velocity,
          angle: ship.angle,
          health: ship.health,

          exploding: ship.exploding,
          thrusting: ship.thrusting,
          movementLocked: ship.movementLocked,
          serverOwnsMotion: ship.serverOwnsMotion,
          motion: ship.playerMotion,
          contourLock: ship.contourLock,
        }
      : null,
    input: readTouchControlDiagnostics(),
    world: {
      terrainSeed: getTerrainSeed(),
      players: network.getAllPlayers().length,
      asteroids: game.getCurrRoidCount(),
      loot: game.getLoot().length,
    },
  };
  return sanitizeDebugDiagnostics(
    {
      state: JSON.parse(JSON.stringify(state)),
      recentLogs: logger.getRecentDiagnostics().slice(-80),
    },
    [readStoredResumeName(), readStoredResumeToken()].filter((value): value is string =>
      Boolean(value)
    )
  );
}

export function buildClientDiagnostics(): string {
  return formatDebugDiagnostics(captureClientDiagnostics());
}
