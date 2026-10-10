import type { Position } from '../../shared-types';
import { LootField } from '../entities/loot/LootField';
import { drawLootRelative } from '../entities/loot/lootRenderer';
import type { Player } from '../entities/player/Player';
import type { RoidBelt } from '../entities/roid/Roid';
import { drawAsteroidShatterBursts, drawRoidsRelative } from '../entities/roid/roidRenderer';
import { drawSurveyProbes } from '../entities/roid/surveyProbeRenderer';
import { SatellitePickupManager } from '../entities/satellitePickup/SatellitePickupManager';
import { drawSatellitePickups } from '../entities/satellitePickup/satellitePickupRenderer';
import { SHIP_ABILITY } from '../entities/ship/shipKits';
import {
  drawHaulerHarpoonRelative,
  drawLasers,
  drawShipAtPosition,
  drawShipExplosion,
  drawShipExplosionAtPosition,
  drawThruster,
  drawThrusterAtPosition,
} from '../entities/ship/shipRenderer';
import { shouldDrawShipHull } from '../entities/ship/shipUtils';
import { activeScanners } from '../entities/ship/surveyScan';
import { drawSchematicEquipHint } from '../ui/schematicEquipHint';
import { getLaserColor } from '../utils/colorUtils';
import { isDebugMode } from '../utils/debugUtils';
import { drawBeltEncounters } from './beltRenderer';
import { drawFieryBoundary } from './boundaryRenderer';
import { paintOpaqueBackground } from './canvasBackground';
import { canvasManager } from './canvasSurface';
import { drawCargoHolds } from './cargoHoldRenderer';
import { drawCargoOffloads } from './cargoOffloadRenderer';
import {
  drawContourLaserTicks,
  type LiveLaserSource,
  liveLaserPositions,
} from './contourLaserRenderer';
import { drawContourLayers, drawIsoContours, visibleContourLayers } from './contourRenderer';
import { drawContourTrack } from './contourTrackRenderer';
import {
  drawFurnaceFoundations,
  drawFurnaceLabels,
  drawFurnacePipes,
  drawFurnacesRelative,
} from './furnaceRenderer';
import { drawHeadingCue } from './headingCueRenderer';
import { drawDebugInfo, drawScoreOverlay, drawTextOverlay } from './hud/gameInfo';
import { hudLayoutForCanvas } from './hud/hudLayout';
import { drawLeaderboard } from './hud/leaderboard';
import { drawMiniMap } from './hud/minimap';
import { drawRicochetCourt } from './ricochetCourtRenderer';
import { drawTerrainSpiders } from './spiderRenderer';
import { drawStarfield, visibleStarTiles } from './starfield';

/** Mineral Scan widens the view to the whole scanned disc plus this margin. */
const SCAN_VIEW_MARGIN = 1.15;

/** Zoom out while the local Scout's scan pulse runs so the full scan area is visible. */
export function scanCameraZoom(
  ship: Parameters<typeof activeScanners>[0],
  width: number,
  height: number
) {
  if (activeScanners(ship, []).length === 0) {
    return 1;
  }
  return Math.min(
    1,
    Math.min(width, height) /
      2 /
      (SHIP_ABILITY.SCAN_RANGE * SCAN_VIEW_MARGIN * canvasManager.getPlayfieldScale())
  );
}

const laserHosts: LiveLaserSource[] = [{ lasers: [] }];
const liveLaserScratch: Position[] = [];

/** Everything drawn in world space; the scan camera may scale this layer. */
function drawWorldLayers(
  ctx: CanvasRenderingContext2D,
  currPlayer: Player,
  roids: ReturnType<RoidBelt['getRoids']>,
  loot: ReturnType<LootField['getAll']>,
  satellitePickups: ReturnType<SatellitePickupManager['getAll']>,
  allPlayers: Player[]
): void {
  const currShip = currPlayer.ship;
  const localId = currPlayer.id;
  const viewport = canvasManager.getViewportSize();

  const gpuContours = canvasManager.canDrawGpuRear()
    ? visibleContourLayers(currShip.position)
    : undefined;
  const gpuDrawn =
    gpuContours !== undefined &&
    canvasManager.drawGpuRear({
      position: currShip.position,
      contours: gpuContours,
      starTiles: visibleStarTiles(currShip.position),
    }) &&
    canvasManager.composeGpuRear(ctx);
  if (!gpuDrawn) {
    paintOpaqueBackground(ctx);
    drawStarfield(currShip.position);
    drawIsoContours(currShip.position);
  } else if (gpuContours !== undefined && canvasManager.requiresNativeGpuContours()) {
    canvasManager.recordNativeGpuContours(drawContourLayers(currShip.position, gpuContours));
  }
  if (!currShip.exploding && currShip.health > 0 && !currShip.furnaceTransit) {
    drawContourTrack(currShip.position, currShip.angle, currShip.contourLock);
  }
  drawRicochetCourt(currShip.position);
  drawTerrainSpiders(currShip.position, currPlayer.id, currShip.health > 0 && !currShip.exploding);

  let laserHostCount = 1;
  const localLaserHost = laserHosts[0];
  if (localLaserHost) {
    localLaserHost.lasers = currShip.lasers;
  }
  for (const player of allPlayers) {
    if (player.id !== localId && shouldDrawShipHull(player.ship)) {
      const host = laserHosts[laserHostCount];
      if (host) {
        host.lasers = player.ship.lasers;
      } else {
        laserHosts.push({ lasers: player.ship.lasers });
      }
      laserHostCount++;
    }
  }
  laserHosts.length = laserHostCount;
  drawContourLaserTicks(currShip.position, liveLaserPositions(laserHosts, liveLaserScratch));

  drawFieryBoundary(currShip.position);

  drawRoidsRelative(currShip, roids);
  drawBeltEncounters(currShip.position, roids);
  if (roids.length > 0) {
    drawSurveyProbes(roids, currShip.position);
  }
  drawFurnacePipes(currShip.position);
  drawFurnaceFoundations(currShip.position);
  drawFurnacesRelative(currShip.position);
  drawAsteroidShatterBursts(currShip);

  drawLootRelative(currShip, loot);
  drawSatellitePickups(satellitePickups, currShip.position);

  const laserColor = getLaserColor();

  for (const player of allPlayers) {
    const isLocal = player.id === localId;
    const ship = isLocal ? currShip : player.ship;
    drawHaulerHarpoonRelative(ship, currShip.position);
  }

  for (const player of allPlayers) {
    const isLocal = player.id === localId;
    const ship = isLocal ? currShip : player.ship;
    const shipColor = isLocal ? currPlayer.color : player.color;

    if (ship.exploding) {
      if (isLocal) {
        drawShipExplosion(currShip, shipColor);
      } else {
        drawShipExplosionAtPosition(ship, currShip.position, shipColor);
      }
    } else if (shouldDrawShipHull(ship)) {
      drawShipAtPosition(
        ship,
        currShip.position,
        shipColor,
        isLocal ? currPlayer.name : player.name
      );
    }
  }

  for (const player of allPlayers) {
    const isLocal = player.id === localId;
    const ship = isLocal ? currShip : player.ship;
    if (!shouldDrawShipHull(ship) || !ship.thrusting) {
      continue;
    }
    const shipColor = isLocal ? currPlayer.color : player.color;
    if (isLocal) {
      drawThruster(currShip, shipColor);
    } else {
      drawThrusterAtPosition(ship, currShip.position, shipColor);
    }
  }

  drawCargoHolds(allPlayers, currShip.position);
  drawCargoOffloads(allPlayers, currShip.position);

  drawLasers(currShip, laserColor);

  for (const player of allPlayers) {
    if (player.id === localId || !shouldDrawShipHull(player.ship)) {
      continue;
    }
    drawLasers(player.ship, laserColor, currShip.position);
  }

  drawFurnaceLabels(currShip.position);

  drawHeadingCue(ctx, viewport, currShip);

  if (shouldDrawShipHull(currShip) && !currShip.exploding) {
    drawSchematicEquipHint(
      ctx,
      viewport.width / 2,
      viewport.height / 2,
      currShip.r * canvasManager.getPlayfieldScale()
    );
  }
}

export function drawGame(
  currPlayer: Player,
  currRoidBelt: RoidBelt,
  currScore: number,
  textAlpha: number,
  text: string,
  allPlayers: Player[]
): void {
  const currShip = currPlayer.ship;
  const ctx = canvasManager.getContext();
  const canvas = canvasManager.getCanvas();

  if (!ctx || !canvas) {
    return;
  }

  canvasManager.followTravel(currShip);
  const viewport = canvasManager.getViewportSize();
  canvasManager.easeZoomToward(
    scanCameraZoom(currShip, viewport.width, viewport.height),
    performance.now()
  );
  const roids = currRoidBelt.getRoids();
  const loot = LootField.getInstance().getAll();
  const satellitePickups = SatellitePickupManager.getInstance().getAll();
  const localId = currPlayer.id;

  // Always close the zoomed layer so a painter failure cannot leave the HUD viewport inflated.
  canvasManager.beginWorldLayers(ctx);
  let worldLayersCompleted = false;
  try {
    drawWorldLayers(ctx, currPlayer, roids, loot, satellitePickups, allPlayers);
    worldLayersCompleted = true;
  } finally {
    canvasManager.endWorldLayers(ctx, !worldLayersCompleted);
  }

  const hudLayout = hudLayoutForCanvas(viewport);
  const otherPlayers = allPlayers.filter((player) => player.id !== localId);
  drawMiniMap(ctx, hudLayout, currShip, roids, loot, satellitePickups, otherPlayers);

  drawScoreOverlay(ctx, hudLayout, viewport, currScore);

  if (text && textAlpha > 0) {
    drawTextOverlay(ctx, hudLayout, viewport, text, textAlpha);
  }

  drawLeaderboard(ctx, hudLayout, allPlayers, currPlayer.id);

  const roidCount = currRoidBelt.roids.length;
  drawDebugInfo(ctx, viewport, roidCount, isDebugMode());
}
