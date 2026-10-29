import { SHIP_ABILITY } from '../../shared/shipKits';
import { isActiveScanner } from '../../shared/surveyScan';
import { getTerrainField } from '../../shared/terrainField';
import type { ContourLockState, Position } from '../../shared-types';
import { PALETTE } from '../constants';
import { LootField } from '../entities/loot/LootField';
import { drawLootRelative } from '../entities/loot/lootRenderer';
import type { Player } from '../entities/player/Player';
import type { RoidBelt } from '../entities/roid/Roid';
import { drawAsteroidShatterBursts, drawRoidsRelative } from '../entities/roid/roidRenderer';
import { drawSurveyProbes } from '../entities/roid/surveyProbeRenderer';
import { SatellitePickupManager } from '../entities/satellitePickup/SatellitePickupManager';
import { drawSatellitePickups } from '../entities/satellitePickup/satellitePickupRenderer';
import {
  drawHaulerHarpoonRelative,
  drawLasers,
  drawShipAtPosition,
  drawShipExplosionAtPosition,
  drawThruster,
  drawThrusterAtPosition,
} from '../entities/ship/shipRenderer';
import { shouldDrawShipHull } from '../entities/ship/shipUtils';
import { getWorldCampaign } from '../network/worldCampaign';
import { getWorldExploration, getWorldRemains, worldFurnaces } from '../network/worldExploration';
import { getContourBridges } from '../physics/terrain/contourBridgeSession';
import { findContourCapture } from '../physics/terrain/contourCapture';
import { getRolyPolys } from '../physics/terrain/rolyPolySession';
import { getSpiderField } from '../physics/terrain/spiderSession';
import { drawSchematicEquipHint } from '../ui/schematicEquipHint';
import { drawBeltEncounters, getBeltRecovery } from './beltRenderer';
import { drawFieryBoundary } from './boundaryRenderer';
import { drawCampaign } from './campaignRenderer';
import { paintOpaqueBackground } from './canvasBackground';
import { canvasManager } from './canvasSurface';
import { drawCargoHolds } from './cargoHoldRenderer';
import { drawCargoOffloads } from './cargoOffloadRenderer';
import { drawContourBridges } from './contourBridgeRenderer';
import {
  drawContourLaserTicks,
  type LiveLaserSource,
  liveLaserPositions,
} from './contourLaserRenderer';
import { drawContourLayers, drawIsoContours, visibleContourLayers } from './contourRenderer';
import { drawContourTrack } from './contourTrackRenderer';
import { drawCrewSignals } from './crewSignalRenderer';
import {
  drawFurnaceFoundations,
  drawFurnaceLabels,
  drawFurnacePipes,
  drawFurnacesRelative,
} from './furnaceRenderer';
import { drawHeadingCue } from './headingCueRenderer';
import { drawScoreOverlay } from './hud/gameInfo';
import { hudLayoutForCanvas } from './hud/hudLayout';
import { drawLeaderboard } from './hud/leaderboard';
import { drawMiniMap } from './hud/minimap';
import { drawNavigationJourney } from './navigationJourney';
import { drawWorldRemains } from './remainsRenderer';
import { drawRicochetCourt } from './ricochetCourtRenderer';
import { drawRolyPolys } from './rolyPolyRenderer';
import { drawRouteWaypoints } from './routeWaypoints';
import { drawShipLighting } from './shipLighting';
import { simpleScanNavigation } from './simpleScanNavigation';
import { drawSpiderDanger, drawTerrainSpiders } from './spiderRenderer';
import { drawStarfield, visibleStarTiles } from './starfield';

/** Mineral Scan widens the view to the whole scanned disc plus this margin. */
const SCAN_VIEW_MARGIN = 1.15;

/** Zoom out while the local Scout's scan pulse runs so the full scan area is visible. */
export function scanCameraZoom(
  ship: Parameters<typeof isActiveScanner>[0],
  width: number,
  height: number
) {
  if (!isActiveScanner(ship)) {
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
  allPlayers: Player[],
  navigationTarget: ContourLockState | null
): void {
  const currShip = currPlayer.ship;
  const localId = currPlayer.id;
  const viewport = canvasManager.getViewportSize();

  if (!canvasManager.drawScanScenery(currShip.position)) {
    const gpuContours = canvasManager.canDrawGpuRear()
      ? visibleContourLayers(currShip.position, viewport, canvasManager.getPlayfieldScale())
      : undefined;
    const gpuDrawn =
      gpuContours !== undefined &&
      canvasManager.drawGpuRear({
        position: currShip.position,
        contours: gpuContours,
        starTiles: visibleStarTiles(currShip.position, viewport, canvasManager.getPlayfieldScale()),
      }) &&
      canvasManager.composeGpuRear(ctx);
    if (!gpuDrawn) {
      paintOpaqueBackground(ctx);
      drawStarfield(ctx, currShip.position, viewport, canvasManager.getPlayfieldScale());
      drawIsoContours(ctx, currShip.position, viewport, canvasManager.getPlayfieldScale());
    } else if (gpuContours !== undefined && canvasManager.requiresNativeGpuContours()) {
      canvasManager.recordNativeGpuContours(
        drawContourLayers(
          ctx,
          currShip.position,
          viewport,
          canvasManager.getPlayfieldScale(),
          gpuContours
        )
      );
    }
  }
  if (!currShip.exploding && currShip.health > 0 && !currShip.furnaceTransit) {
    drawContourTrack(currShip.position, navigationTarget, currShip.contourLock !== null);
  }
  drawShipLighting(
    currShip.position,
    allPlayers.map((player) => player.ship)
  );
  drawRouteWaypoints(currShip.position);
  drawContourBridges(currShip.position);
  drawWorldRemains(currShip.position);
  drawRolyPolys(currShip.position);
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

  const laserColor = PALETTE.LASER_LOCAL;

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
      drawShipExplosionAtPosition(ship, currShip.position, shipColor);
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

  drawCampaign(currShip.position, Date.now() + currShip.furnaceClockOffsetMs);
  drawCrewSignals(allPlayers, currShip.position);
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

export function drawGame(currPlayer: Player, currRoidBelt: RoidBelt, allPlayers: Player[]): void {
  const currShip = currPlayer.ship;
  const ctx = canvasManager.getContext();
  const canvas = canvasManager.getCanvas();

  if (!ctx || !canvas) {
    return;
  }

  const viewport = canvasManager.getViewportSize();
  canvasManager.easeZoomToward(
    scanCameraZoom(currShip, viewport.width, viewport.height),
    performance.now()
  );
  const roids = currRoidBelt.getRoids();
  const loot = LootField.getInstance().getAll();
  const satellitePickups = SatellitePickupManager.getInstance().getAll();
  const localId = currPlayer.id;
  const navigable = !currShip.exploding && currShip.health > 0 && !currShip.furnaceTransit;
  // Resolve against the genuine flight viewport, before world painters enlarge it for Scan.
  const navigationTarget = navigable
    ? (currShip.contourLock ?? findContourCapture(currShip.position, currShip.angle))
    : null;

  if (canvasManager.usesSimpleScan()) {
    const spiders = getSpiderField();
    canvasManager.drawSimpleScan(
      {
        localPlayer: currPlayer,
        players: allPlayers,
        roids,
        loot,
        lootBlast: LootField.getInstance().getBlast(),
        pickups: satellitePickups,
        spiders,
        recovery: getBeltRecovery(),
        rolyPolys: getRolyPolys(),
        bridges: getContourBridges(),
        remains: getWorldRemains(),
        campaign: getWorldCampaign(),
        terrain: getTerrainField(),
        furnaces: worldFurnaces,
        exploration: getWorldExploration(),
      },
      performance.now()
    );
    // Accurate nearby capture/hop lines remain visible over the coarse distant terrain.
    const localLines = navigable
      ? simpleScanNavigation(currShip.position, viewport, canvasManager.getPlayfieldScale())
      : [];
    canvasManager.beginWorldLayers(ctx);
    let localLayersCompleted = false;
    try {
      drawContourLayers(
        ctx,
        currShip.position,
        canvasManager.getViewportSize(),
        canvasManager.getPlayfieldScale(),
        localLines
      );
      if (navigable) {
        drawContourTrack(currShip.position, navigationTarget, currShip.contourLock !== null);
      }
      localLayersCompleted = true;
    } finally {
      canvasManager.endWorldLayers(ctx, !localLayersCompleted);
    }
    drawSpiderDanger(ctx, viewport, currShip.position, spiders, localId, navigable);
    drawHeadingCue(ctx, viewport, currShip);
    if (shouldDrawShipHull(currShip) && !currShip.exploding) {
      drawSchematicEquipHint(
        ctx,
        viewport.width / 2,
        viewport.height / 2,
        currShip.r * canvasManager.getPlayfieldScale()
      );
    }
  } else {
    // Always close the zoomed layer so a painter failure cannot leave the HUD viewport inflated.
    canvasManager.beginWorldLayers(ctx);
    let worldLayersCompleted = false;
    try {
      drawWorldLayers(ctx, currPlayer, roids, loot, satellitePickups, allPlayers, navigationTarget);
      worldLayersCompleted = true;
    } finally {
      canvasManager.endWorldLayers(ctx, !worldLayersCompleted);
    }
  }

  drawNavigationJourney(currPlayer, roids, allPlayers);
  const hudLayout = hudLayoutForCanvas(viewport);
  const otherPlayers = allPlayers.filter((player) => player.id !== localId);
  drawMiniMap(ctx, hudLayout, currShip, roids, loot, satellitePickups, otherPlayers);

  drawScoreOverlay(ctx, hudLayout, viewport, currPlayer);

  drawLeaderboard(ctx, hudLayout, allPlayers, currPlayer.id);
}
