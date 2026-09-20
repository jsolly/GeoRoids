import type { Position } from '../../shared-types';
import { PALETTE } from '../constants';
import { LootField } from '../entities/loot/LootField';
import { drawLootRelative } from '../entities/loot/lootRenderer';
import type { Player } from '../entities/player/Player';
import type { RoidBelt } from '../entities/roid/Roid';
import { drawRoidsRelative } from '../entities/roid/roidRenderer';
import { drawSurveyProbes } from '../entities/roid/surveyProbeRenderer';
import { SatellitePickupManager } from '../entities/satellitePickup/SatellitePickupManager';
import { drawSatellitePickups } from '../entities/satellitePickup/satellitePickupRenderer';
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
import { getLaserColor } from '../utils/colorUtils';
import { isDebugMode } from '../utils/debugUtils';
import { drawFieryBoundary } from './boundaryRenderer';
import { canvasManager } from './canvasSurface';
import {
  drawContourLaserTicks,
  type LiveLaserSource,
  liveLaserPositions,
} from './contourLaserRenderer';
import { drawIsoContours } from './contourRenderer';
import { drawFurnacesRelative } from './furnaceRenderer';
import { drawHeadingCue } from './headingCueRenderer';
import { drawDebugInfo, drawScoreOverlay, drawTextOverlay } from './hud/gameInfo';
import { hudLayoutForCanvas } from './hud/hudLayout';
import { drawLeaderboard } from './hud/leaderboard';
import { drawLivesIndicator } from './hud/lives';
import { drawMiniMap } from './hud/minimap';
import { drawSectorBoundaries } from './sectorRenderer';
import { drawShockwaves } from './shockwaveRenderer';
import { drawStarfield } from './starfield';

const laserHosts: LiveLaserSource[] = [{ lasers: [] }];
const liveLaserScratch: Position[] = [];

export function drawGame(
  currPlayer: Player,
  currRoidBelt: RoidBelt,
  currScore: number,
  textAlpha: number,
  text: string,
  lives: number,
  allPlayers: Player[]
): void {
  const currShip = currPlayer.ship;
  const ctx = canvasManager.getContext();
  const canvas = canvasManager.getCanvas();

  if (!ctx || !canvas) {
    return;
  }

  const viewport = canvasManager.getViewportSize();
  ctx.fillStyle = PALETTE.BG;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const roids = currRoidBelt.getRoids();

  drawStarfield(currShip.position);
  drawIsoContours(currShip.position);

  const localId = currPlayer.id;
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
  drawSectorBoundaries(currShip.position);

  if (roids.length > 0) {
    drawRoidsRelative(currShip, roids);
    drawSurveyProbes(roids, currShip.position);
  }
  drawFurnacesRelative(currShip.position);

  const loot = LootField.getInstance().getAll();
  const satellitePickups = SatellitePickupManager.getInstance().getAll();
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

  drawShockwaves(currShip.position);

  drawLasers(currShip, laserColor);

  for (const player of allPlayers) {
    if (player.id === localId || !shouldDrawShipHull(player.ship)) {
      continue;
    }
    drawLasers(player.ship, laserColor, currShip.position);
  }

  drawHeadingCue(ctx, viewport, currShip);

  const hudLayout = hudLayoutForCanvas(viewport);
  const otherPlayers = allPlayers.filter((player) => player.id !== localId);
  drawMiniMap(ctx, hudLayout, currShip, roids, loot, satellitePickups, otherPlayers);

  drawScoreOverlay(ctx, hudLayout, viewport, currScore, lives);

  drawLivesIndicator(ctx, hudLayout, lives, currPlayer.color, currShip.kitId);

  if (text && textAlpha > 0) {
    drawTextOverlay(ctx, hudLayout, viewport, text, textAlpha);
  }

  drawLeaderboard(ctx, hudLayout, allPlayers, currPlayer.id);

  const roidCount = currRoidBelt.roids.length;
  drawDebugInfo(ctx, viewport, roidCount, isDebugMode());
}
