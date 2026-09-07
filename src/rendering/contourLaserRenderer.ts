import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { type ContourLaserTick, contourLaserTickInto } from '../physics/terrain/contourLaser';
import { getTerrainField } from '../physics/terrain/terrainSession';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvas';

const viewPad = 40;
const contourColor = hexToRgba(PALETTE.LOOT, VISUAL.CONTOUR_LASER_ALPHA);
const centerScreen = { x: 0, y: 0 };
const endpointAWorld = { x: 0, y: 0 };
const endpointBWorld = { x: 0, y: 0 };
const endpointAScreen = { x: 0, y: 0 };
const endpointBScreen = { x: 0, y: 0 };
const tickScratch: ContourLaserTick = { ax: 0, ay: 0, bx: 0, by: 0 };

function finitePosition(position: Position): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y);
}

function centerIsVisible(
  center: { x: number; y: number },
  width: number,
  height: number,
  projectedHalfLength: number
): boolean {
  const pad = viewPad + projectedHalfLength;
  return (
    center.x >= -pad && center.x <= width + pad && center.y >= -pad && center.y <= height + pad
  );
}

/**
 * Paint a cream iso-tangent under each currently rendered live shot. This is
 * a client-side paint effect over the existing bolts; it never moves a shot,
 * changes hit tests, or claims that clients share authoritative laser poses.
 */
export function drawContourLaserTicks(shipPosition: Position, shots: readonly Position[]): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs || shots.length === 0 || !finitePosition(shipPosition)) {
    return;
  }

  const scale = canvasManager.getPlayfieldScale();
  const halfLen = VISUAL.CONTOUR_LASER_LENGTH / 2;
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(halfLen)) {
    return;
  }

  const field = getTerrainField();
  const projectedHalfLength = halfLen * scale;
  let hasSegment = false;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowBlur = 0;
  ctx.strokeStyle = contourColor;
  ctx.lineWidth = VISUAL.CONTOUR_LASER_STROKE_WIDTH;
  ctx.beginPath();

  for (const shot of shots) {
    if (!finitePosition(shot)) {
      continue;
    }

    // Project and cull before sampling four terrain-noise pairs for the gradient.
    canvasManager.worldToScreenInto(centerScreen, shot, shipPosition);
    if (
      !Number.isFinite(centerScreen.x) ||
      !Number.isFinite(centerScreen.y) ||
      !centerIsVisible(centerScreen, cvs.width, cvs.height, projectedHalfLength)
    ) {
      continue;
    }

    const tick = contourLaserTickInto(tickScratch, field, shot.x, shot.y, halfLen);
    if (!tick) {
      continue;
    }
    endpointAWorld.x = tick.ax;
    endpointAWorld.y = tick.ay;
    endpointBWorld.x = tick.bx;
    endpointBWorld.y = tick.by;
    canvasManager.worldToScreenInto(endpointAScreen, endpointAWorld, shipPosition);
    canvasManager.worldToScreenInto(endpointBScreen, endpointBWorld, shipPosition);
    if (
      !Number.isFinite(endpointAScreen.x) ||
      !Number.isFinite(endpointAScreen.y) ||
      !Number.isFinite(endpointBScreen.x) ||
      !Number.isFinite(endpointBScreen.y)
    ) {
      continue;
    }
    ctx.moveTo(endpointAScreen.x, endpointAScreen.y);
    ctx.lineTo(endpointBScreen.x, endpointBScreen.y);
    hasSegment = true;
  }

  if (hasSegment) {
    ctx.stroke();
  }
  ctx.restore();
}

export type LiveLaserSource = {
  lasers: readonly {
    position: Position;
    explodeTime: number;
    hasExploded?: boolean;
  }[];
  /** Set false when this source's hull/bolts are skipped by the render pass. */
  visible?: boolean;
};

/** Match the visible laser pass while retaining local-shot death semantics. */
export function liveLaserPositions(
  ships: readonly LiveLaserSource[],
  out: Position[] = []
): Position[] {
  out.length = 0;
  for (const ship of ships) {
    if (ship.visible === false) {
      continue;
    }
    for (const laser of ship.lasers) {
      if (laser.explodeTime === 0 && !laser.hasExploded && finitePosition(laser.position)) {
        out.push(laser.position);
      }
    }
  }
  return out;
}
