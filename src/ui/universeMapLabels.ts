import { WORLD } from '../../shared/world';
import type { MapAsset, Position } from '../../shared-types';
import {
  UNIVERSE_MAP_LANDMARK_SIZE,
  universeMapMarkScreenSize,
} from '../rendering/hud/furnaceMapMark';

/** Other landmarks may name themselves once the chart is inside this zoom. */
const MAP_LABEL_ZOOM = 2.8;
/** Wide views keep a single non-furnace name so the chart is not blank. */
const MAP_DEFAULT_LABEL_LIMIT = 1;
/**
 * Furnace and foundation names wait until one step inside the 5k nearby view
 * (`UNIVERSE_MAP_ZOOM.initial` × `UNIVERSE_MAP_ZOOM.step`). Marks stay visible.
 */
export const FURNACE_NAME_ZOOM = 32;

/** Furnace names stay off wide charts; salvage and satellites keep the older gate. */
export function mapAssetNameVisible(
  kind: MapAsset['kind'],
  zoom: number,
  labelsAlreadyDrawn: number
): boolean {
  if (kind === 'furnace' || kind === 'foundation') {
    return zoom >= FURNACE_NAME_ZOOM;
  }
  return zoom >= MAP_LABEL_ZOOM || labelsAlreadyDrawn < MAP_DEFAULT_LABEL_LIMIT;
}

export type MapLabelRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type MapLabelFrame = {
  size: number;
  scale: number;
  zoom: number;
};

export function isFiniteMapPosition(value: Position | undefined): value is Position {
  return (
    value !== undefined &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Math.hypot(value.x, value.y) <= WORLD.radius * 1.25
  );
}

function chartOffset(position: Position, viewCenter: Position, headingRotation: number): Position {
  const dx = position.x - viewCenter.x;
  const dy = position.y - viewCenter.y;
  const cos = Math.cos(headingRotation);
  const sin = Math.sin(headingRotation);
  return {
    x: cos * dx - sin * dy,
    y: sin * dx + cos * dy,
  };
}

export function canPlaceMapAssetLabel(
  asset: Pick<MapAsset, 'name' | 'position'>,
  frame: MapLabelFrame,
  viewCenter: Position,
  occupied: MapLabelRect[],
  headingRotation = 0
): boolean {
  if (!asset.name || !isFiniteMapPosition(asset.position)) {
    return false;
  }

  const fontSize = 12 / frame.scale;
  const iconSize = universeMapMarkScreenSize(UNIVERSE_MAP_LANDMARK_SIZE, frame.zoom) / frame.scale;
  const gap = 6 / frame.scale;
  const labelWidth = asset.name.length * fontSize * 0.62;
  const screen = chartOffset(asset.position, viewCenter, headingRotation);
  const left = screen.x - labelWidth / 2 - gap;
  const top = screen.y + iconSize * 1.6 - gap;
  const rect: MapLabelRect = {
    left,
    right: left + labelWidth + gap * 2,
    top,
    bottom: top + fontSize + gap * 2,
  };
  return reserveMapLabel(rect, frame, occupied);
}

export function canPlaceMapCrewLabel(
  name: string,
  position: Position,
  shipSize: number,
  frame: MapLabelFrame,
  viewCenter: Position,
  occupied: MapLabelRect[],
  headingRotation = 0
): boolean {
  if (!name || !isFiniteMapPosition(position)) {
    return false;
  }

  const fontSize = 11 / frame.scale;
  const screen = chartOffset(position, viewCenter, headingRotation);
  const labelX = screen.x + shipSize * 1.4;
  const labelY = screen.y - shipSize;
  const gap = 6 / frame.scale;
  return reserveMapLabel(
    {
      left: labelX - gap,
      right: labelX + name.length * fontSize * 0.62 + gap,
      top: labelY - fontSize - gap,
      bottom: labelY + gap,
    },
    frame,
    occupied
  );
}

function reserveMapLabel(
  rect: MapLabelRect,
  frame: MapLabelFrame,
  occupied: MapLabelRect[]
): boolean {
  const halfSize = frame.size / 2 / frame.scale;
  if (
    rect.left < -halfSize ||
    rect.right > halfSize ||
    rect.top < -halfSize ||
    rect.bottom > halfSize
  ) {
    return false;
  }

  if (
    occupied.some(
      (other) =>
        rect.left < other.right &&
        rect.right > other.left &&
        rect.top < other.bottom &&
        rect.bottom > other.top
    )
  ) {
    return false;
  }
  occupied.push(rect);
  return true;
}
