import { PALETTE, VISUAL } from '../../constants';
import { drawSoftFactionMark } from '../../entities/player/factionMarkPainters';
import { PlayerNetwork } from '../../entities/player/playerNetwork';
import type { SoftFactionId } from '../../entities/player/softFactions';
import type { Ship } from '../../entities/ship/Ship';
import { calculateShipTrianglePoints, strokePhosphorHull } from '../../entities/ship/shipRenderer';
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

function drawRadarMark(ctx: CanvasRenderingContext2D, mark: RadarMark): void {
  switch (mark.kind) {
    case 'local': {
      const hull = calculateShipTrianglePoints(
        mark.x,
        mark.y,
        VISUAL.MINIMAP_LOCAL_SIZE,
        mark.heading
      );
      strokePhosphorHull(ctx, hull, PALETTE.LOCAL);
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

export function drawMiniMap(ctx: CanvasRenderingContext2D, layout: HudLayout, ship: Ship): void {
  const boundary = getGameBoundary();
  const { x: miniMapX, y: miniMapY, size: miniMapSize } = layout.miniMap;
  const centerX = miniMapX + miniMapSize / 2;
  const centerY = miniMapY + miniMapSize / 2;
  const projection = { x: 0, y: 0 };

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
    const playerNetwork = PlayerNetwork.getInstance();
    const otherPlayers = playerNetwork.getOtherPlayers();

    for (const player of otherPlayers) {
      if (player.ship.exploding) {
        continue;
      }
      const p = projectWorldToMiniMapInto(
        projection,
        boundary,
        miniMapX,
        miniMapY,
        miniMapSize,
        player.ship.position.x,
        player.ship.position.y
      );
      if (!p) {
        continue;
      }
      drawRadarMark(ctx, {
        kind: 'other',
        x: p.x,
        y: p.y,
        heading: player.ship.angle,
        color: getFactionColor(player.type),
        ...(player.ship.factionId !== undefined ? { factionId: player.ship.factionId } : {}),
      });
    }

    if (!ship.exploding) {
      const p = projectWorldToMiniMapInto(
        projection,
        boundary,
        miniMapX,
        miniMapY,
        miniMapSize,
        ship.position.x,
        ship.position.y
      );
      if (p) {
        drawRadarMark(ctx, {
          kind: 'local',
          x: p.x,
          y: p.y,
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
