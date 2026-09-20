import {
  cellWorldBounds,
  explorationCellAt,
  explorationCellsInView,
  isCellExplored,
} from '../../../shared/exploration';
import { FURNACES } from '../../../shared/furnaces';
import { sectorBounds } from '../../../shared/sectors';
import { SURVEY_PROBE } from '../../../shared/surveyProbe';
import { parseSectorId, sectorAt, WORLD } from '../../../shared/world';
import type {
  ExplorationTile,
  LootData,
  LootKind,
  Position,
  ShipKitId,
} from '../../../shared-types';
import { PALETTE, VISUAL } from '../../constants';
import { lootStrokeColor } from '../../entities/loot/lootRenderer';
import type { Player } from '../../entities/player/Player';
import type { Roid } from '../../entities/roid/Roid';
import type { SatellitePickup } from '../../entities/satellitePickup/SatellitePickup';
import { getKitHullOutline, projectHullPolyline } from '../../entities/ship/hullOutlines';
import type { Ship } from '../../entities/ship/Ship';
import { strokePhosphorPolyline } from '../../entities/ship/shipRenderer';
import { activeScanners, scannedMaterial } from '../../entities/ship/surveyScan';
import { getCompletedSectors, getWorldExploration } from '../../network/worldExploration';
import { getSpiderField } from '../../physics/terrain/spiderSession';
import { hexToRgba } from '../../utils/colorUtils';
import { logger } from '../../utils/Logger';
import { resolveGlow } from '../renderQuality';
import { drawFurnaceMapMark, MINIMAP_FURNACE_MARK_SIZE } from './furnaceMapMark';
import type { HudLayout } from './hudLayout';
import { addResourceMapPath, asteroidMapInk, drawResourceMapMark } from './resourceMapMark';

type RadarMark = {
  kind: 'local' | 'other';
  x: number;
  y: number;
  heading: number;
  color: string;
  kitId: ShipKitId;
};

const LOOT_MARK_KINDS = ['wreckage', 'shard', 'laserCore', 'tap'] satisfies readonly LootKind[];

// These marks stay visible at the radar's world scale without borrowing the
// much larger playfield silhouettes.
const MINIMAP_ROID_SIZE = 2.5;
const MINIMAP_LOOT_SIZE = 4;
const MINIMAP_ORBITER_SIZE = 4;

interface MiniMapGeometry {
  readonly center: Position;
  readonly radius: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly exploration: readonly ExplorationTile[];
  readonly projection: { x: number; y: number };
}

function projectPosition(geometry: MiniMapGeometry, position: { x: number; y: number }): boolean {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return false;
  }
  return (
    projectLocalToMiniMapInto(
      geometry.projection,
      geometry.center,
      geometry.radius,
      geometry.x,
      geometry.y,
      geometry.size,
      position.x,
      position.y
    ) !== null
  );
}

export function projectLocalToMiniMapInto(
  out: { x: number; y: number },
  center: Position,
  radius: number,
  miniMapX: number,
  miniMapY: number,
  miniMapSize: number,
  worldX: number,
  worldY: number,
  tolerance = 10
): { x: number; y: number } | null {
  const normalizedX = (worldX - center.x) / radius;
  const normalizedY = (worldY - center.y) / radius;
  const x = miniMapX + miniMapSize / 2 + normalizedX * (miniMapSize / 2);
  const y = miniMapY + miniMapSize / 2 + normalizedY * (miniMapSize / 2);

  if (
    x < miniMapX - tolerance ||
    x > miniMapX + miniMapSize + tolerance ||
    y < miniMapY - tolerance ||
    y > miniMapY + miniMapSize + tolerance
  ) {
    return null;
  }
  out.x = x;
  out.y = y;
  return out;
}

function isExploredPosition(
  geometry: MiniMapGeometry,
  position: { x: number; y: number }
): boolean {
  const cell = explorationCellAt(position);
  return cell !== null && isCellExplored(geometry.exploration, cell);
}

/** Draw the shared exploration mask behind known world marks. */
function drawExplorationFog(ctx: CanvasRenderingContext2D, geometry: MiniMapGeometry): void {
  ctx.save();
  ctx.fillStyle = hexToRgba(PALETTE.BG, 0.78);
  const cellScale = geometry.size / (geometry.radius * 2);
  for (const cell of explorationCellsInView({
    cx: geometry.center.x,
    cy: geometry.center.y,
    radius: geometry.radius,
  })) {
    if (isCellExplored(geometry.exploration, cell)) {
      continue;
    }
    const bounds = cellWorldBounds(cell);
    const x = geometry.x + geometry.size / 2 + (bounds.x - geometry.center.x) * cellScale;
    const y = geometry.y + geometry.size / 2 + (bounds.y - geometry.center.y) * cellScale;
    const size = bounds.size * cellScale + 0.5;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

function drawCompletedSectors(ctx: CanvasRenderingContext2D, geometry: MiniMapGeometry): void {
  const completed = getCompletedSectors();
  if (completed.size === 0) {
    return;
  }
  const cellScale = geometry.size / (geometry.radius * 2);
  ctx.save();
  ctx.fillStyle = hexToRgba(PALETTE.DANGER, 0.22);
  ctx.strokeStyle = hexToRgba(PALETTE.DANGER, 0.7);
  ctx.lineWidth = 1;
  for (const id of completed) {
    const parsed = parseSectorId(id);
    if (!parsed) {
      continue;
    }
    const bounds = sectorBounds(parsed.x, parsed.y);
    const x = geometry.x + geometry.size / 2 + (bounds.minX - geometry.center.x) * cellScale;
    const y = geometry.y + geometry.size / 2 + (bounds.minY - geometry.center.y) * cellScale;
    const width = WORLD.sectorSize * cellScale;
    const height = WORLD.sectorSize * cellScale;
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
  }
  ctx.restore();
}

function strokeRadarHull(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  heading: number,
  color: string,
  kitId: ShipKitId
): void {
  const outline = getKitHullOutline(kitId);
  strokePhosphorPolyline(
    ctx,
    projectHullPolyline(x, y, size, heading, outline.hull),
    color,
    outline.hull.closed
  );
  for (const extra of outline.extras) {
    strokePhosphorPolyline(
      ctx,
      projectHullPolyline(x, y, size, heading, extra),
      color,
      extra.closed
    );
  }
}

function drawRadarMark(ctx: CanvasRenderingContext2D, mark: RadarMark): void {
  const { kind } = mark;
  switch (kind) {
    case 'local': {
      strokeRadarHull(
        ctx,
        mark.x,
        mark.y,
        VISUAL.MINIMAP_LOCAL_SIZE,
        mark.heading,
        mark.color,
        mark.kitId
      );
      return;
    }
    case 'other': {
      strokeRadarHull(
        ctx,
        mark.x,
        mark.y,
        VISUAL.MINIMAP_DOT,
        mark.heading,
        mark.color,
        mark.kitId
      );
      return;
    }
    default:
      throw new Error(`Unexpected radar mark kind: ${kind}`);
  }
}

function drawPilotEdgeMark(
  ctx: CanvasRenderingContext2D,
  geometry: MiniMapGeometry,
  position: Position,
  color: string,
  kitId: ShipKitId
): void {
  const dx = position.x - geometry.center.x;
  const dy = position.y - geometry.center.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return;
  }
  // Placement is canvas Y-down; kit projection uses game heading (Y-up).
  const canvasBearing = Math.atan2(dy, dx);
  const heading = Math.atan2(-dy, dx);
  const radius = Math.max(8, geometry.size / 2 - 8);
  const x = geometry.x + geometry.size / 2 + Math.cos(canvasBearing) * radius;
  const y = geometry.y + geometry.size / 2 + Math.sin(canvasBearing) * radius;
  strokeRadarHull(ctx, x, y, VISUAL.MINIMAP_DOT, heading, color, kitId);
}

function canDrawAsteroidOnMiniMap(roid: Roid): boolean {
  return (
    Number.isFinite(roid.position.x) &&
    Number.isFinite(roid.position.y) &&
    Number.isFinite(roid.r) &&
    roid.r > 0 &&
    Number.isFinite(roid.health) &&
    roid.health > 0
  );
}

function drawAsteroidMarks(
  ctx: CanvasRenderingContext2D,
  roids: readonly Roid[],
  geometry: MiniMapGeometry,
  scanners: ReturnType<typeof activeScanners>
): void {
  if (roids.length === 0) {
    return;
  }

  const { projection } = geometry;
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = hexToRgba(PALETTE.ROID, 0.65);
  ctx.lineWidth = 0.8;
  for (const roid of roids) {
    if (
      canDrawAsteroidOnMiniMap(roid) &&
      !(roid.surveyedBy && roid.surveyedBy.length > 0 && roid.material !== undefined) &&
      !scanners.some((scanner) => scannedMaterial(scanner, roid) !== undefined) &&
      isExploredPosition(geometry, roid.position) &&
      projectPosition(geometry, roid.position)
    ) {
      addResourceMapPath(ctx, 'asteroid', projection.x, projection.y, MINIMAP_ROID_SIZE);
    }
  }
  ctx.stroke();
  const hasSurveyedDeposits = roids.some(
    (roid) => (Array.isArray(roid.surveyedBy) && roid.surveyedBy.length > 0) || Boolean(roid.probe)
  );
  if (scanners.length === 0 && !hasSurveyedDeposits) {
    ctx.restore();
    return;
  }
  for (const roid of roids) {
    if (
      !canDrawAsteroidOnMiniMap(roid) ||
      !isExploredPosition(geometry, roid.position) ||
      !projectPosition(geometry, roid.position)
    ) {
      continue;
    }
    const material =
      roid.surveyedBy && roid.surveyedBy.length > 0
        ? roid.material
        : scanners
            .map((scanner) => scannedMaterial(scanner, roid))
            .find((value) => value !== undefined);
    const x = projection.x,
      y = projection.y;
    if (material !== undefined) {
      drawResourceMapMark(ctx, 'asteroid', x, y, 4, asteroidMapInk(material), material);
    }
    if (roid.probe && roid.probe.health > 0) {
      const phase =
        (Math.max(0, Date.now() - roid.probe.attachedAt) % SURVEY_PROBE.PULSE_MS) /
        SURVEY_PROBE.PULSE_MS;
      ctx.strokeStyle = PALETTE.LOCAL;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1 - phase * 0.65;
      ctx.beginPath();
      ctx.arc(x, y, 5 + phase * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

function drawLootMarks(
  ctx: CanvasRenderingContext2D,
  loot: readonly LootData[],
  geometry: MiniMapGeometry
): void {
  if (loot.length === 0) {
    return;
  }

  const { projection } = geometry;
  for (const kind of LOOT_MARK_KINDS) {
    let painted = false;
    for (const drop of loot) {
      if (
        drop.kind !== kind ||
        !isExploredPosition(geometry, drop.position) ||
        !projectPosition(geometry, drop.position)
      ) {
        continue;
      }
      if (!painted) {
        ctx.save();
        ctx.strokeStyle = lootStrokeColor(kind);
        ctx.lineWidth = 1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
      }
      addResourceMapPath(ctx, drop.kind, projection.x, projection.y, MINIMAP_LOOT_SIZE);
      painted = true;
    }
    if (painted) {
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawLoosePickupMarks(
  ctx: CanvasRenderingContext2D,
  pickups: readonly SatellitePickup[],
  geometry: MiniMapGeometry
): void {
  if (pickups.length === 0) {
    return;
  }

  const { projection } = geometry;
  let painted = false;
  for (const pickup of pickups) {
    if (
      pickup.state !== 'loose' ||
      !isExploredPosition(geometry, pickup.position) ||
      !projectPosition(geometry, pickup.position)
    ) {
      continue;
    }
    if (!painted) {
      ctx.save();
      ctx.strokeStyle = hexToRgba(PALETTE.SATELLITE, 0.95);
      ctx.lineWidth = 1;
      ctx.beginPath();
    }
    addResourceMapPath(ctx, 'satellite', projection.x, projection.y, MINIMAP_ORBITER_SIZE);
    painted = true;
  }
  if (painted) {
    ctx.stroke();
    ctx.restore();
  }
}

function drawOrbiterMarks(
  ctx: CanvasRenderingContext2D,
  pickups: readonly SatellitePickup[],
  geometry: MiniMapGeometry
): void {
  if (pickups.length === 0) {
    return;
  }

  const { projection } = geometry;
  let painted = false;
  for (const pickup of pickups) {
    if (
      pickup.state !== 'orbiting' ||
      !isExploredPosition(geometry, pickup.position) ||
      !projectPosition(geometry, pickup.position)
    ) {
      continue;
    }
    if (!painted) {
      ctx.save();
      ctx.strokeStyle = hexToRgba(PALETTE.SATELLITE, 0.95);
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
    }
    addResourceMapPath(ctx, 'satellite', projection.x, projection.y, MINIMAP_ORBITER_SIZE);
    ctx.moveTo(projection.x + 6, projection.y);
    ctx.ellipse(projection.x, projection.y, 6, 2, -0.5, 0, Math.PI * 2);
    painted = true;
  }
  if (painted) {
    ctx.stroke();
    ctx.restore();
  }
}

function drawTowMarkers(
  ctx: CanvasRenderingContext2D,
  geometry: MiniMapGeometry,
  localShip: Ship,
  otherShips: readonly Ship[],
  roids: readonly Roid[]
): void {
  const haulers = [localShip, ...otherShips].filter(
    (candidate) => candidate.kitId === 'hauler' && candidate.harpoonTargetId !== null
  );
  if (haulers.length === 0) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = PALETTE.LOOT;
  ctx.fillStyle = PALETTE.LASER_LOCAL;
  ctx.shadowColor = PALETTE.LOOT;
  ctx.shadowBlur = resolveGlow(4);
  ctx.lineWidth = 1.25;
  for (const hauler of haulers) {
    const targetId = hauler.harpoonTargetId;
    if (targetId === null) {
      continue;
    }
    const target = roids.find((roid) => roid.id === targetId);
    const targetPosition = target?.position ?? hauler.harpoonLatchPos;
    if (!targetPosition) {
      continue;
    }
    if (!projectPosition(geometry, hauler.position)) {
      continue;
    }
    const haulerX = geometry.projection.x;
    const haulerY = geometry.projection.y;
    if (!projectPosition(geometry, targetPosition)) {
      continue;
    }
    const targetX = geometry.projection.x;
    const targetY = geometry.projection.y;

    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(haulerX, haulerY);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(targetX, targetY, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(targetX, targetY, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = resolveGlow(4);
  }
  ctx.restore();
}

/** Furnace destinations become useful landmarks only after the crew reveals them. */
function drawFurnaceMarks(ctx: CanvasRenderingContext2D, geometry: MiniMapGeometry): void {
  const { projection } = geometry;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.shadowBlur = resolveGlow(4);
  for (const furnace of FURNACES) {
    if (!isExploredPosition(geometry, furnace.position)) {
      continue;
    }
    const dx = furnace.position.x - geometry.center.x;
    const dy = furnace.position.y - geometry.center.y;
    const distance = Math.hypot(dx, dy);
    if (distance > geometry.radius) {
      continue;
    }
    if (!projectPosition(geometry, furnace.position)) {
      continue;
    }
    drawFurnaceMapMark(ctx, projection.x, projection.y, MINIMAP_FURNACE_MARK_SIZE);
  }
  ctx.restore();
}

function formatCoordinate(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

function drawRadarReadout(ctx: CanvasRenderingContext2D, geometry: MiniMapGeometry): void {
  const sector = sectorAt(geometry.center);
  const width = Math.min(geometry.size, 112);
  const x = geometry.x + geometry.size / 2;
  const outsideY = geometry.y - 29;
  const y = outsideY >= 0 ? outsideY : geometry.y + 5;
  ctx.save();
  ctx.fillStyle = hexToRgba(PALETTE.BG, 0.72);
  ctx.fillRect(x - width / 2, y - 3, width, 27);
  ctx.fillStyle = hexToRgba(PALETTE.HUD, 0.9);
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`X ${formatCoordinate(geometry.center.x)}`, x, y);
  ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.9);
  ctx.fillText(`Y ${formatCoordinate(geometry.center.y)} · S${sector.x},${sector.y}`, x, y + 11);
  ctx.restore();
}

export function drawMiniMap(
  ctx: CanvasRenderingContext2D,
  layout: HudLayout,
  ship: Ship,
  roids: readonly Roid[],
  loot: readonly LootData[],
  pickups: readonly SatellitePickup[],
  otherPlayers: readonly Player[]
): void {
  const { x: miniMapX, y: miniMapY, size: miniMapSize } = layout.miniMap;
  const centerX = miniMapX + miniMapSize / 2;
  const centerY = miniMapY + miniMapSize / 2;
  const geometry: MiniMapGeometry = {
    center: ship.position,
    radius: WORLD.minimapRadius,
    x: miniMapX,
    y: miniMapY,
    size: miniMapSize,
    exploration: getWorldExploration(),
    projection: { x: 0, y: 0 },
  };

  const scanners = activeScanners(
    ship,
    otherPlayers.map((player) => player.ship)
  );
  if (scanners.length > 0) {
    ctx.save();
    ctx.fillStyle = PALETTE.HUD;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const legendX = miniMapX >= 70 ? miniMapX - 64 : miniMapX + miniMapSize + 6;
    for (const [index, material] of (['ice', 'metal', 'rubble'] as const).entries()) {
      drawResourceMapMark(
        ctx,
        'asteroid',
        legendX + 4,
        miniMapY + index * 13 + 5,
        4,
        asteroidMapInk(material),
        material
      );
      ctx.fillText(material, legendX + 12, miniMapY + index * 13);
    }
    ctx.restore();
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, miniMapSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = hexToRgba(PALETTE.BG, VISUAL.MINIMAP_VOID_ALPHA);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, VISUAL.MINIMAP_RING_ALPHA);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();

  try {
    drawExplorationFog(ctx, geometry);
    drawCompletedSectors(ctx, geometry);
    drawAsteroidMarks(ctx, roids, geometry, scanners);
    drawLootMarks(ctx, loot, geometry);
    drawLoosePickupMarks(ctx, pickups, geometry);
    drawOrbiterMarks(ctx, pickups, geometry);
    drawTowMarkers(
      ctx,
      geometry,
      ship,
      otherPlayers.map((player) => player.ship),
      roids
    );
    drawFurnaceMarks(ctx, geometry);
    for (const nest of getSpiderField().nests) {
      if (isExploredPosition(geometry, nest.position) && projectPosition(geometry, nest.position)) {
        drawResourceMapMark(
          ctx,
          'nest',
          geometry.projection.x,
          geometry.projection.y,
          8,
          PALETTE.DANGER
        );
      }
    }

    // The pilot hulls are deliberately last: they must remain readable over
    // dense rock, loot, and pickup fields.

    for (const player of otherPlayers) {
      if (player.ship.exploding) {
        continue;
      }
      const p = projectPosition(geometry, player.ship.position);
      if (!p) {
        drawPilotEdgeMark(ctx, geometry, player.ship.position, player.color, player.ship.kitId);
        continue;
      }
      drawRadarMark(ctx, {
        kind: 'other',
        x: geometry.projection.x,
        y: geometry.projection.y,
        heading: player.ship.angle,
        color: player.color,
        kitId: player.ship.kitId,
      });
    }

    if (!ship.exploding) {
      const p = projectPosition(geometry, ship.position);
      if (p) {
        drawRadarMark(ctx, {
          kind: 'local',
          x: geometry.projection.x,
          y: geometry.projection.y,
          heading: ship.angle,
          color: ship.color,
          kitId: ship.kitId,
        });
      }
    }
  } catch (error: unknown) {
    logger.error(
      'RENDERING',
      'Error drawing mini map',
      error instanceof Error ? error : new Error(String(error))
    );
  }

  ctx.restore();
  // Keep the coordinate readout crisp and unclipped above the radar ring.
  drawRadarReadout(ctx, geometry);
}
