import type { LootData, LootKind } from '../../../shared-types';
import { PALETTE, VISUAL } from '../../constants';
import { lootStrokeColor } from '../../entities/loot/lootRenderer';
import { drawSoftFactionMark } from '../../entities/player/factionMarkPainters';
import { PlayerNetwork } from '../../entities/player/playerNetwork';
import type { SoftFactionId } from '../../entities/player/softFactions';
import type { Roid } from '../../entities/roid/Roid';
import type { SatellitePickup } from '../../entities/satellitePickup/SatellitePickup';
import type { Ship } from '../../entities/ship/Ship';
import { calculateShipTrianglePoints, strokePhosphorHull } from '../../entities/ship/shipRenderer';
import { scannedMaterial } from '../../entities/ship/surveyScan';
import type { CircleBoundary } from '../../physics/boundary';
import { getGameBoundary } from '../../physics/boundary';
import { getFactionColor, hexToRgba } from '../../utils/colorUtils';
import { logger } from '../../utils/Logger';
import type { HudLayout } from './hudLayout';

type RadarMark =
  | { kind: 'local'; x: number; y: number; heading: number; factionId?: SoftFactionId }
  | {
      kind: 'other';
      x: number;
      y: number;
      heading: number;
      color: string;
      factionId?: SoftFactionId;
    };

const LOOT_MARK_KINDS = ['wreckage', 'shard', 'laserCore'] satisfies readonly LootKind[];

// These marks stay visible at the radar's world scale without borrowing the
// much larger playfield silhouettes.
const MINIMAP_ROID_SIZE = 1.5;
const MINIMAP_LOOT_SIZE = 2;
const MINIMAP_ORBITER_SIZE = 3;

interface MiniMapGeometry {
  readonly boundary: CircleBoundary;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly projection: { x: number; y: number };
}

export function projectWorldToMiniMap(
  boundary: CircleBoundary,
  miniMapX: number,
  miniMapY: number,
  miniMapSize: number,
  worldX: number,
  worldY: number,
  tolerance = 10
): { x: number; y: number } | null {
  return projectWorldToMiniMapInto(
    { x: 0, y: 0 },
    boundary,
    miniMapX,
    miniMapY,
    miniMapSize,
    worldX,
    worldY,
    tolerance
  );
}

/** Allocation-free projection for the per-frame HUD path. */
export function projectWorldToMiniMapInto(
  out: { x: number; y: number },
  boundary: CircleBoundary,
  miniMapX: number,
  miniMapY: number,
  miniMapSize: number,
  worldX: number,
  worldY: number,
  tolerance = 10
): { x: number; y: number } | null {
  const normalizedX = (worldX - boundary.cx) / boundary.radius;
  const normalizedY = (worldY - boundary.cy) / boundary.radius;

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

function projectPosition(geometry: MiniMapGeometry, position: { x: number; y: number }): boolean {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return false;
  }
  return (
    projectWorldToMiniMapInto(
      geometry.projection,
      geometry.boundary,
      geometry.x,
      geometry.y,
      geometry.size,
      position.x,
      position.y
    ) !== null
  );
}

function drawRadarMark(ctx: CanvasRenderingContext2D, mark: RadarMark): void {
  switch (mark.kind) {
    case 'local': {
      const hull = calculateShipTrianglePoints(
        mark.x,
        mark.y,
        VISUAL.MINIMAP_LOCAL_SIZE,
        mark.heading
      );
      strokePhosphorHull(ctx, hull, getFactionColor(mark.factionId));
      drawSoftFactionMark(ctx, mark.factionId, {
        x: mark.x,
        y: mark.y,
        radius: VISUAL.MINIMAP_LOCAL_SIZE,
        angle: mark.heading,
        context: 'minimap',
      });
      return;
    }
    case 'other': {
      const hull = calculateShipTrianglePoints(mark.x, mark.y, VISUAL.MINIMAP_DOT, mark.heading);
      strokePhosphorHull(ctx, hull, mark.color);
      drawSoftFactionMark(ctx, mark.factionId, {
        x: mark.x,
        y: mark.y,
        radius: VISUAL.MINIMAP_DOT,
        angle: mark.heading,
        context: 'minimap',
      });
      return;
    }
  }
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
  ship: Ship
): void {
  if (roids.length === 0) {
    return;
  }

  const { projection } = geometry;
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = hexToRgba(PALETTE.ROID, 0.55);
  for (const roid of roids) {
    if (canDrawAsteroidOnMiniMap(roid) && projectPosition(geometry, roid.position)) {
      ctx.rect(
        projection.x - MINIMAP_ROID_SIZE / 2,
        projection.y - MINIMAP_ROID_SIZE / 2,
        MINIMAP_ROID_SIZE,
        MINIMAP_ROID_SIZE
      );
    }
  }
  ctx.fill();
  if (
    ship.kitId !== 'surveyor' ||
    ship.abilityActiveFrames <= 0 ||
    ship.exploding ||
    ship.health <= 0
  ) {
    ctx.restore();
    return;
  }
  for (const roid of roids) {
    if (!canDrawAsteroidOnMiniMap(roid) || !projectPosition(geometry, roid.position)) {
      continue;
    }
    const material = scannedMaterial(ship, roid);
    const x = projection.x,
      y = projection.y;
    ctx.beginPath();
    switch (material) {
      case 'ice':
        ctx.fillStyle = '#A5F3FC';
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        break;
      case 'metal':
        ctx.fillStyle = '#FDE68A';
        ctx.rect(x - 3, y - 3, 6, 6);
        break;
      case 'rubble':
        ctx.fillStyle = '#FDBA74';
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 3.5, y + 3);
        ctx.lineTo(x - 3.5, y + 3);
        ctx.closePath();
        break;
      case undefined:
        continue;
    }
    ctx.fill();
  }
  ctx.restore();
}

function addDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x + radius, y);
  ctx.lineTo(x, y + radius);
  ctx.lineTo(x - radius, y);
  ctx.closePath();
}

function addLootMark(ctx: CanvasRenderingContext2D, drop: LootData, x: number, y: number): void {
  switch (drop.kind) {
    case 'laserCore':
      addDiamond(ctx, x, y, MINIMAP_LOOT_SIZE);
      ctx.moveTo(x - 1, y + 1);
      ctx.lineTo(x + 1, y - 1);
      return;
    case 'shard':
      addDiamond(ctx, x, y, MINIMAP_LOOT_SIZE);
      return;
    case 'wreckage':
      ctx.rect(
        x - MINIMAP_LOOT_SIZE,
        y - MINIMAP_LOOT_SIZE,
        MINIMAP_LOOT_SIZE * 2,
        MINIMAP_LOOT_SIZE * 2
      );
      return;
    default: {
      const _exhaustive: never = drop.kind;
      void _exhaustive;
    }
  }
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
      if (drop.kind !== kind || !projectPosition(geometry, drop.position)) {
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
      addLootMark(ctx, drop, projection.x, projection.y);
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
    if (pickup.state !== 'loose' || !projectPosition(geometry, pickup.position)) {
      continue;
    }
    if (!painted) {
      ctx.save();
      ctx.strokeStyle = hexToRgba(PALETTE.SATELLITE, 0.95);
      ctx.lineWidth = 1;
      ctx.beginPath();
    }
    const radius = VISUAL.MINIMAP_DOT / 2;
    ctx.moveTo(projection.x + radius, projection.y);
    ctx.arc(projection.x, projection.y, radius, 0, Math.PI * 2);
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
    if (pickup.state !== 'orbiting' || !projectPosition(geometry, pickup.position)) {
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
    addDiamond(ctx, projection.x, projection.y, MINIMAP_ORBITER_SIZE);
    painted = true;
  }
  if (painted) {
    ctx.stroke();
    ctx.restore();
  }
}

export function drawMiniMap(
  ctx: CanvasRenderingContext2D,
  layout: HudLayout,
  ship: Ship,
  roids: readonly Roid[],
  loot: readonly LootData[],
  pickups: readonly SatellitePickup[]
): void {
  const boundary = getGameBoundary();
  const { x: miniMapX, y: miniMapY, size: miniMapSize } = layout.miniMap;
  const centerX = miniMapX + miniMapSize / 2;
  const centerY = miniMapY + miniMapSize / 2;
  const geometry: MiniMapGeometry = {
    boundary,
    x: miniMapX,
    y: miniMapY,
    size: miniMapSize,
    projection: { x: 0, y: 0 },
  };

  if (
    ship.kitId === 'surveyor' &&
    ship.abilityActiveFrames > 0 &&
    !ship.exploding &&
    ship.health > 0
  ) {
    ctx.save();
    ctx.fillStyle = PALETTE.HUD;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const legendX = miniMapX >= 70 ? miniMapX - 64 : miniMapX + miniMapSize + 6;
    for (const [index, label] of ['○ Ice', '□ Metal', '△ Rubble'].entries()) {
      ctx.fillText(label, legendX, miniMapY + index * 13);
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
    drawAsteroidMarks(ctx, roids, geometry, ship);
    drawLootMarks(ctx, loot, geometry);
    drawLoosePickupMarks(ctx, pickups, geometry);
    drawOrbiterMarks(ctx, pickups, geometry);

    // The pilot hulls are deliberately last: they must remain readable over
    // dense rock, loot, and pickup fields.
    const playerNetwork = PlayerNetwork.getInstance();
    const otherPlayers = playerNetwork.getOtherPlayers();

    for (const player of otherPlayers) {
      if (player.ship.exploding) {
        continue;
      }
      const p = projectPosition(geometry, player.ship.position);
      if (!p) {
        continue;
      }
      drawRadarMark(ctx, {
        kind: 'other',
        x: geometry.projection.x,
        y: geometry.projection.y,
        heading: player.ship.angle,
        color: getFactionColor(player.factionId),
        ...(player.ship.factionId !== undefined ? { factionId: player.ship.factionId } : {}),
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
          ...(ship.factionId !== undefined ? { factionId: ship.factionId } : {}),
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
}
