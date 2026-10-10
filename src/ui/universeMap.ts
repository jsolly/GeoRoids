import { beltSlotPosition, beltSlots } from '../../shared/asteroidBelt';
import { oreResource } from '../../shared/economy';
import { explorationCellAt, isCellExplored } from '../../shared/exploration';
import { CIVIC_LOTS, pipeHopToParent } from '../../shared/furnaces';
import { RICOCHET_COURT } from '../../shared/ricochetCourt';
import { WORLD } from '../../shared/world';
import type { ExplorationTile, MapAsset, Position } from '../../shared-types';
import { PALETTE } from '../constants';
import { LootField } from '../entities/loot/LootField';
import { PlayerManager } from '../entities/player/PlayerManager';
import type { Roid } from '../entities/roid/Roid';
import { getKitHullOutline, projectHullPolyline } from '../entities/ship/hullOutlines';
import { activeScanners, scannedMaterial } from '../entities/ship/surveyScan';
import { getWorldExploration, getWorldMapAssets, worldFurnaces } from '../network/worldExploration';
import { getSpiderField } from '../physics/terrain/spiderSession';
import { strokeFurnaceFireTrail } from '../rendering/furnaceRenderer';
import {
  drawFoundationMapMark,
  drawFurnaceMapMark,
  UNIVERSE_MAP_LANDMARK_SIZE,
  universeMapFurnaceMarkAppearance,
  universeMapMarkScreenSize,
} from '../rendering/hud/furnaceMapMark';
import { asteroidMapInk, drawResourceMapMark } from '../rendering/hud/resourceMapMark';
import { drawCourtMapMark } from '../rendering/ricochetCourtRenderer';
import { travelCameraRotation } from '../rendering/travelCamera';
import { hexToRgba } from '../utils/colorUtils';
import {
  canPlaceMapAssetLabel,
  canPlaceMapCrewLabel,
  isFiniteMapPosition,
  type MapLabelRect,
  mapAssetNameVisible,
} from './universeMapLabels';

export const UNIVERSE_MAP_IDS = {
  dialog: 'universe-map-dialog',
  canvas: 'universe-map-canvas',
  toggle: 'universe-map-toggle',
  close: 'universe-map-close',
  center: 'universe-map-center',
  locations: 'universe-map-locations',
} as const;

export const UNIVERSE_MAP_ZOOM = {
  min: 1,
  max: 48,
  initial: 24,
  step: 1.35,
} as const;

export const UNIVERSE_MAP_LOCATE_LABEL = 'Center on you';
const MAP_RASTER_SIZE = 960;
const CELLS_PER_SECTOR = 16;
const CELL_SIZE = WORLD.sectorSize / CELLS_PER_SECTOR;
const WORLD_DIAMETER = WORLD.radius * 2;
const EXPLORATION_GRID_SIZE = WORLD_DIAMETER / CELL_SIZE;
const RASTER_CELL_SIZE = MAP_RASTER_SIZE / EXPLORATION_GRID_SIZE;
const BLOCKED_GAMEPLAY_KEYS = new Set([
  'Space',
  'KeyE',
  'KeyA',
  'KeyD',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);

type MapCanvasDimensions = {
  width: number;
  height: number;
  dpr: number;
};

type MapFrame = {
  x: number;
  y: number;
  size: number;
  scale: number;
  zoom: number;
};

type MapView = {
  center: Position;
  zoom: number;
};

export type UniverseMapChrome = Readonly<{
  frame: Readonly<Pick<MapFrame, 'x' | 'y' | 'size'>>;
  heading: number;
  centered: boolean;
  zoom: number;
  locations: readonly string[];
  locationPage: number;
  locationPages: number;
  locationCount: number;
}>;

/** Occlusions are canvas-relative CSS pixel rectangles measured by the Svelte owner. */
export type UniverseMapController = {
  center(): void;
  zoomBy(factor: number): void;
  keydown(event: KeyboardEvent): void;
  setLocationPage(page: number): void;
  setOcclusions(rectangles: readonly MapLabelRect[]): void;
  dispose(): void;
};

export const MAP_LEGEND_KINDS = [
  'You',
  'Crew',
  'Furnace',
  'Court',
  'Resources',
  'Nest',
  'Uncharted',
] as const;
type MapLegendKind = (typeof MAP_LEGEND_KINDS)[number];
const LOCATION_PAGE_SIZE = 24;

type ExplorationRaster = {
  source: readonly ExplorationTile[] | null;
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
};

let readMapRoids: () => readonly Roid[] = () => [];

export function bindUniverseMapField(source: () => readonly Roid[]): void {
  readMapRoids = source;
}

const explorationRaster: ExplorationRaster = {
  source: null,
  canvas: null,
  context: null,
};

function clampZoom(zoom: number): number {
  return Math.min(UNIVERSE_MAP_ZOOM.max, Math.max(UNIVERSE_MAP_ZOOM.min, zoom));
}

export function clampUniverseMapZoom(zoom: number): number {
  return clampZoom(zoom);
}

function mapFrameFor(width: number, height: number, zoom: number): MapFrame {
  const margin = Math.min(width, height) < 520 ? 76 : 48;
  const size = Math.max(180, Math.min(width, height) - margin);
  return {
    x: (width - size) / 2,
    y: (height - size) / 2,
    size,
    scale: (size / WORLD_DIAMETER) * zoom,
    zoom,
  };
}

function chartHeadingRotation(): number {
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  return ship ? travelCameraRotation(ship) : 0;
}

export function mapScreenDeltaToWorld(
  dx: number,
  dy: number,
  scale: number,
  headingRotation = 0
): Position {
  const safeScale = scale === 0 ? 1 : scale;
  const cos = Math.cos(headingRotation);
  const sin = Math.sin(headingRotation);
  return {
    x: (cos * dx + sin * dy) / safeScale,
    y: (-sin * dx + cos * dy) / safeScale,
  };
}

export function mapWorldToCanvas(
  position: Position,
  viewCenter: Position,
  frame: Pick<MapFrame, 'x' | 'y' | 'size' | 'scale'>,
  headingRotation = 0
): Position {
  const dx = position.x - viewCenter.x;
  const dy = position.y - viewCenter.y;
  const cos = Math.cos(headingRotation);
  const sin = Math.sin(headingRotation);
  return {
    x: frame.x + frame.size / 2 + (cos * dx - sin * dy) * frame.scale,
    y: frame.y + frame.size / 2 + (sin * dx + cos * dy) * frame.scale,
  };
}

function visibleWorldHalfSize(mapFrame: MapFrame): number {
  return mapFrame.size / 2 / mapFrame.scale;
}

function clampCenter(center: Position, mapFrame: MapFrame): Position {
  const halfSize = visibleWorldHalfSize(mapFrame);
  const extent = Math.max(0, WORLD.radius - halfSize);
  return {
    x: Math.min(extent, Math.max(-extent, center.x)),
    y: Math.min(extent, Math.max(-extent, center.y)),
  };
}

function isNearbyZoom(zoom: number): boolean {
  return Math.round(zoom * 100) === Math.round(UNIVERSE_MAP_ZOOM.initial * 100);
}

export function paintMapLegend(canvas: HTMLCanvasElement, kind: MapLegendKind): void {
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(2, 2);
    if (kind === 'You' || kind === 'Crew') {
      ctx.strokeStyle = kind === 'You' ? PALETTE.LOCAL : PALETTE.REMOTE;
      ctx.lineWidth = 1;
      const player =
        kind === 'You'
          ? PlayerManager.getInstance().getLocalPlayer()
          : PlayerManager.getInstance().getNonLocalPlayers()[0];
      const hull = getKitHullOutline(player?.ship.kitId ?? 'scout');
      if (traceMapPolyline(ctx, projectHullPolyline(8, 8, 6, Math.PI / 2, hull.hull), true)) {
        ctx.stroke();
      }
    } else if (kind === 'Furnace') {
      drawFurnaceMapMark(ctx, 8, 8, 6);
    } else if (kind === 'Court') {
      drawCourtMapMark(ctx, 8, 8, 7);
    } else if (kind === 'Resources') {
      drawResourceMapMark(ctx, 'asteroid', 8, 8, 5, PALETTE.ROID);
    } else if (kind === 'Nest') {
      drawResourceMapMark(ctx, 'nest', 8, 8, 6, PALETTE.DANGER);
    } else {
      ctx.fillStyle = '#050914';
      ctx.fillRect(3, 3, 10, 10);
      ctx.strokeStyle = PALETTE.HUD_MUTED;
      ctx.strokeRect(3, 3, 10, 10);
    }
  }
}

function rebuildExplorationRaster(tiles: readonly ExplorationTile[]): void {
  if (!explorationRaster.canvas) {
    explorationRaster.canvas = document.createElement('canvas');
    explorationRaster.canvas.width = MAP_RASTER_SIZE;
    explorationRaster.canvas.height = MAP_RASTER_SIZE;
    explorationRaster.context = explorationRaster.canvas.getContext('2d');
  }
  const context = explorationRaster.context;
  if (!context) {
    explorationRaster.source = tiles;
    return;
  }

  context.clearRect(0, 0, MAP_RASTER_SIZE, MAP_RASTER_SIZE);
  context.fillStyle = hexToRgba(PALETTE.REMOTE, 0.14);
  context.imageSmoothingEnabled = false;

  // The server sends sparse 16×16 sector tiles. Decode only revealed bytes once
  // per changed snapshot; every open-map frame draws this raster as one image.
  for (const tile of tiles) {
    const [sectorXText, sectorYText] = tile.id.split(',');
    const sectorX = Number.parseInt(sectorXText ?? '', 10);
    const sectorY = Number.parseInt(sectorYText ?? '', 10);
    if (!Number.isInteger(sectorX) || !Number.isInteger(sectorY) || sectorX < 0 || sectorY < 0) {
      continue;
    }
    for (let localRow = 0; localRow < CELLS_PER_SECTOR; localRow++) {
      for (let localCol = 0; localCol < CELLS_PER_SECTOR; localCol++) {
        const bitIndex = localRow * CELLS_PER_SECTOR + localCol;
        const byteIndex = Math.floor(bitIndex / 8);
        const byte = Number.parseInt(tile.bits.slice(byteIndex * 2, byteIndex * 2 + 2), 16);
        if (!Number.isFinite(byte) || (byte & (1 << (bitIndex % 8))) === 0) {
          continue;
        }
        const cellCol = sectorX * CELLS_PER_SECTOR + localCol;
        const cellRow = sectorY * CELLS_PER_SECTOR + localRow;
        context.fillRect(
          cellCol * RASTER_CELL_SIZE,
          cellRow * RASTER_CELL_SIZE,
          RASTER_CELL_SIZE + 0.5,
          RASTER_CELL_SIZE + 0.5
        );
      }
    }
  }
  explorationRaster.source = tiles;
}

function getExplorationRaster(): HTMLCanvasElement | null {
  const tiles = getWorldExploration();
  if (explorationRaster.source !== tiles) {
    rebuildExplorationRaster(tiles);
  }
  return explorationRaster.canvas;
}

function isRevealed(position: Position, exploration: readonly ExplorationTile[]): boolean {
  const cell = explorationCellAt(position);
  return cell !== null && isCellExplored(exploration, cell);
}

/** Furnace lots stay on the chart before their ground is explored. Loot does not. */
function chartShowsAsset(asset: MapAsset, exploration: readonly ExplorationTile[]): boolean {
  return (
    asset.kind === 'furnace' ||
    asset.kind === 'foundation' ||
    isRevealed(asset.position, exploration)
  );
}

const beltMapPositions = beltSlots().map(beltSlotPosition);

function drawDiscoveredBelt(
  context: CanvasRenderingContext2D,
  frame: MapFrame,
  exploration: readonly ExplorationTile[]
): void {
  const revealed = beltMapPositions.filter((position) => isRevealed(position, exploration));
  context.save();
  context.strokeStyle = '#e9b96d';
  context.fillStyle = '#e9b96d';
  context.lineWidth = 1.5 / frame.scale;
  for (const position of revealed) {
    context.beginPath();
    context.arc(position.x, position.y, 3 / frame.scale, 0, Math.PI * 2);
    context.stroke();
  }
  const label = revealed[Math.floor(revealed.length / 2)];
  if (label) {
    context.save();
    context.translate(label.x, label.y);
    context.rotate(-chartHeadingRotation());
    context.font = `${11 / frame.scale}px monospace`;
    context.fillText('ASTEROID BELT', 12 / frame.scale, -15 / frame.scale);
    context.restore();
  }
  context.restore();
}

function drawMapBackground(context: CanvasRenderingContext2D, frame: MapFrame): void {
  context.fillStyle = '#050914';
  context.fillRect(-WORLD.radius, -WORLD.radius, WORLD_DIAMETER, WORLD_DIAMETER);
  const raster = getExplorationRaster();
  if (raster) {
    context.imageSmoothingEnabled = false;
    context.drawImage(raster, -WORLD.radius, -WORLD.radius, WORLD_DIAMETER, WORLD_DIAMETER);
  }

  context.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, 0.17);
  context.lineWidth = 1 / frame.scale;
  for (let coordinate = -WORLD.radius; coordinate <= WORLD.radius; coordinate += WORLD.sectorSize) {
    context.beginPath();
    context.moveTo(coordinate, -WORLD.radius);
    context.lineTo(coordinate, WORLD.radius);
    context.stroke();
    context.beginPath();
    context.moveTo(-WORLD.radius, coordinate);
    context.lineTo(WORLD.radius, coordinate);
    context.stroke();
  }

  context.strokeStyle = hexToRgba(PALETTE.HUD, 0.55);
  context.lineWidth = 2 / frame.scale;
  context.beginPath();
  context.arc(0, 0, WORLD.radius, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = hexToRgba(PALETTE.REMOTE, 0.2);
  context.lineWidth = 1 / frame.scale;
  context.beginPath();
  context.moveTo(-WORLD.radius, 0);
  context.lineTo(WORLD.radius, 0);
  context.moveTo(0, -WORLD.radius);
  context.lineTo(0, WORLD.radius);
  context.stroke();
}

const MAP_LOCAL_SHIP_SIZE = 18;
const MAP_CREW_SHIP_SIZE = 14;

function mapStrokeWidth(screen: number, nearSize: number, frame: MapFrame): number {
  return (1.5 * screen) / nearSize / frame.scale;
}

function mapGlowBlur(screen: number, nearSize: number, frame: MapFrame): number {
  return (8 * screen) / nearSize / frame.scale;
}

function drawMapAsset(
  context: CanvasRenderingContext2D,
  asset: MapAsset,
  frame: MapFrame,
  showLabel: boolean
): void {
  if (!isFiniteMapPosition(asset.position)) {
    return;
  }
  const screen = universeMapMarkScreenSize(UNIVERSE_MAP_LANDMARK_SIZE, frame.zoom);
  const size = screen / frame.scale;
  context.save();
  context.translate(asset.position.x, asset.position.y);
  context.lineWidth = mapStrokeWidth(screen, UNIVERSE_MAP_LANDMARK_SIZE, frame);
  context.shadowBlur = mapGlowBlur(screen, UNIVERSE_MAP_LANDMARK_SIZE, frame);
  if (asset.kind === 'furnace') {
    context.save();
    context.scale(1 / frame.scale, 1 / frame.scale);
    drawFurnaceMapMark(context, 0, 0, screen, universeMapFurnaceMarkAppearance(frame.zoom).lod);
    context.restore();
  } else if (asset.kind === 'foundation') {
    context.save();
    context.scale(1 / frame.scale, 1 / frame.scale);
    drawFoundationMapMark(context, 0, 0, screen * 0.7);
    context.restore();
  } else {
    const color = asset.kind === 'satellite' ? PALETTE.SATELLITE : PALETTE.LOOT;
    context.scale(1 / frame.scale, 1 / frame.scale);
    drawResourceMapMark(context, asset.kind, 0, 0, screen, color);
    context.scale(frame.scale, frame.scale);
  }
  if (showLabel && asset.name) {
    context.save();
    context.rotate(-chartHeadingRotation());
    context.font = `${12 / frame.scale}px "Courier New", monospace`;
    context.fillStyle = hexToRgba(PALETTE.HUD, 0.86);
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillText(asset.name, 0, size * 1.6);
    context.restore();
  }
  context.restore();
}

/** Local snapshot details supplement the chart's persistent landmarks. */
function drawNearbyResources(
  context: CanvasRenderingContext2D,
  frame: MapFrame,
  exploration: readonly ExplorationTile[]
): void {
  const local = PlayerManager.getInstance().getLocalPlayer();
  if (!local) {
    return;
  }
  const scanners = activeScanners(
    local.ship,
    PlayerManager.getInstance()
      .getNonLocalPlayers()
      .map((player) => player.ship)
  );
  context.save();
  context.scale(1 / frame.scale, 1 / frame.scale);
  for (const roid of readMapRoids()) {
    if (
      roid.health <= 0 ||
      !isFiniteMapPosition(roid.position) ||
      !isRevealed(roid.position, exploration)
    ) {
      continue;
    }
    const material =
      roid.surveyedBy && roid.surveyedBy.length > 0
        ? (oreResource(roid) ?? undefined)
        : scanners
            .map((scanner) => scannedMaterial(scanner, roid))
            .find((value) => value !== undefined);
    drawResourceMapMark(
      context,
      'asteroid',
      roid.position.x * frame.scale,
      roid.position.y * frame.scale,
      universeMapMarkScreenSize(material ? 5 : 3, frame.zoom),
      asteroidMapInk(material),
      material
    );
  }
  for (const drop of LootField.getInstance().getAll()) {
    // Mined cargo already has persistent landmark entries.
    if (
      (drop.kind !== 'shard' && drop.kind !== 'tap') ||
      !isFiniteMapPosition(drop.position) ||
      !isRevealed(drop.position, exploration)
    ) {
      continue;
    }
    drawResourceMapMark(
      context,
      drop.kind,
      drop.position.x * frame.scale,
      drop.position.y * frame.scale,
      universeMapMarkScreenSize(6, frame.zoom),
      PALETTE.LOOT
    );
  }
  context.restore();
}

function drawNestMarks(
  context: CanvasRenderingContext2D,
  frame: MapFrame,
  exploration: readonly ExplorationTile[]
): void {
  context.save();
  context.scale(1 / frame.scale, 1 / frame.scale);
  for (const nest of getSpiderField().nests) {
    if (!isFiniteMapPosition(nest.position) || !isRevealed(nest.position, exploration)) {
      continue;
    }
    drawResourceMapMark(
      context,
      'nest',
      nest.position.x * frame.scale,
      nest.position.y * frame.scale,
      universeMapMarkScreenSize(UNIVERSE_MAP_LANDMARK_SIZE, frame.zoom),
      nest.cleared ? PALETTE.CLEARED_NEST : PALETTE.DANGER
    );
  }
  context.restore();
}

function traceMapPolyline(
  context: CanvasRenderingContext2D,
  points: readonly Position[],
  closed: boolean
): boolean {
  const first = points[0];
  if (!first) {
    return false;
  }
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index++) {
    const point = points[index];
    if (point) {
      context.lineTo(point.x, point.y);
    }
  }
  if (closed) {
    context.closePath();
  }
  return true;
}

function drawCrew(
  context: CanvasRenderingContext2D,
  frame: MapFrame,
  occupied: MapLabelRect[],
  view: MapView
): void {
  const local = PlayerManager.getInstance().getLocalPlayer();
  const crew = PlayerManager.getInstance().getNonLocalPlayers();
  const players = local ? [local, ...crew] : crew;
  for (const player of players) {
    const position = player.ship.position;
    if (!isFiniteMapPosition(position)) {
      continue;
    }
    const nearSize = player.type === 'local' ? MAP_LOCAL_SHIP_SIZE : MAP_CREW_SHIP_SIZE;
    const screen = universeMapMarkScreenSize(nearSize, frame.zoom);
    const size = screen / frame.scale;
    const color = player.ship.color;
    const outline = getKitHullOutline(player.ship.kitId);
    context.save();
    context.translate(position.x, position.y);
    context.lineWidth = mapStrokeWidth(screen, nearSize, frame);
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.strokeStyle = color;
    context.fillStyle = hexToRgba(color, player.type === 'local' ? 0.22 : 0.12);
    context.shadowColor = color;
    context.shadowBlur = mapGlowBlur(screen, nearSize, frame);
    const hull = projectHullPolyline(0, 0, size, player.ship.angle, outline.hull);
    if (traceMapPolyline(context, hull, outline.hull.closed)) {
      context.fill();
      context.shadowBlur = 0;
      context.stroke();
    }
    for (const extra of outline.extras) {
      const points = projectHullPolyline(0, 0, size, player.ship.angle, extra);
      if (traceMapPolyline(context, points, extra.closed)) {
        context.stroke();
      }
    }
    if (
      view.zoom >= 1.35 &&
      canPlaceMapCrewLabel(
        player.name,
        position,
        size,
        frame,
        view.center,
        occupied,
        chartHeadingRotation()
      )
    ) {
      context.save();
      context.rotate(-chartHeadingRotation());
      context.font = `${11 / frame.scale}px "Courier New", monospace`;
      context.fillStyle = hexToRgba(PALETTE.HUD, 0.9);
      context.textAlign = 'left';
      context.textBaseline = 'bottom';
      context.fillText(player.name, size * 1.4, -size);
      context.restore();
    }
    context.restore();
  }
}

function formatCoordinate(value: number): string {
  return `${value >= 0 ? '+' : ''}${Math.round(value)}`;
}

function accessibleLocations(assets: readonly MapAsset[]): string[] {
  const local = PlayerManager.getInstance().getLocalPlayer();
  const crew = PlayerManager.getInstance().getNonLocalPlayers();
  const players = local ? [local, ...crew] : crew;
  const knownBelt = beltMapPositions.find((position) =>
    isRevealed(position, getWorldExploration())
  );
  const locations = [
    ...(knownBelt
      ? [{ name: 'Asteroid belt · rich mining / surface crawlers', position: knownBelt }]
      : []),
    { name: `${RICOCHET_COURT.name} · bank-shot dueling`, position: RICOCHET_COURT.center },
    ...assets.map((asset) => ({ name: `${asset.name} (${asset.kind})`, position: asset.position })),
    ...getSpiderField()
      .nests.filter(
        (nest) =>
          isFiniteMapPosition(nest.position) && isRevealed(nest.position, getWorldExploration())
      )
      .map((nest) => ({
        name: nest.cleared ? 'Cleared spider nest' : 'Spider nest · guarded resource',
        position: nest.position,
      })),
    ...players
      .filter((player) => isFiniteMapPosition(player.ship.position))
      .map((player) => ({
        name: `${player.name}${player.type === 'local' ? ' (you)' : ' (crew)'}`,
        position: player.ship.position,
      })),
  ];
  return locations.map(
    ({ name, position }) =>
      `${name}: X ${formatCoordinate(position.x)}, Y ${formatCoordinate(position.y)}`
  );
}

/** Lit furnaces only. Dark lots stay marked, with no line back to Town Square. */
function drawLitFurnacePipes(context: CanvasRenderingContext2D, frame: MapFrame): void {
  const now = performance.now();
  const width = 2.6 / frame.scale;
  for (const lot of CIVIC_LOTS) {
    if (!worldFurnaces.isLit(lot.id)) {
      continue;
    }
    const hop = pipeHopToParent(lot.id);
    strokeFurnaceFireTrail(context, hop, hop.length, now, width, 12 / frame.scale, 480);
  }
}

function drawCourtLandmark(
  context: CanvasRenderingContext2D,
  frame: MapFrame,
  labelRects: MapLabelRect[],
  view: MapView
): void {
  const markSize = universeMapMarkScreenSize(UNIVERSE_MAP_LANDMARK_SIZE, frame.zoom);
  const showLabel = canPlaceMapAssetLabel(
    { name: RICOCHET_COURT.name, position: RICOCHET_COURT.center },
    frame,
    view.center,
    labelRects,
    chartHeadingRotation()
  );
  context.save();
  context.translate(RICOCHET_COURT.center.x, RICOCHET_COURT.center.y);
  context.save();
  context.scale(1 / frame.scale, 1 / frame.scale);
  drawCourtMapMark(context, 0, 0, markSize);
  context.restore();
  if (showLabel) {
    context.rotate(-chartHeadingRotation());
    context.scale(1 / frame.scale, 1 / frame.scale);
    context.font = '12px "Courier New", monospace';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillStyle = hexToRgba(PALETTE.REMOTE, 0.9);
    context.fillText(RICOCHET_COURT.name, 0, markSize * 1.6);
  }
  context.restore();
}

/** Unlabelled chart layers at an arbitrary scale, centered on `center`, for the spawn fly-in. */
export function drawSpawnChart(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  center: Position,
  scale: number
): void {
  const size = Math.min(width, height);
  const frame: MapFrame = {
    x: (width - size) / 2,
    y: (height - size) / 2,
    size,
    scale,
    zoom: (scale * WORLD_DIAMETER) / size,
  };
  const exploration = getWorldExploration();
  context.save();
  context.translate(width / 2, height / 2);
  context.scale(scale, scale);
  context.translate(-center.x, -center.y);
  drawMapBackground(context, frame);
  drawLitFurnacePipes(context, frame);
  drawDiscoveredBelt(context, frame, exploration);
  for (const asset of getWorldMapAssets()) {
    if (chartShowsAsset(asset, exploration)) {
      drawMapAsset(context, asset, frame, false);
    }
  }
  context.restore();
}

/** Owns only canvas pixels, geometry and gestures. Opening and closing belong to runtime overlay state. */
export function mountUniverseMap(
  canvas: HTMLCanvasElement,
  onChrome: (chrome: UniverseMapChrome) => void
): UniverseMapController {
  const listenerScope = new AbortController();
  const { signal } = listenerScope;
  let disposed = false;
  let frameRequest: number | null = null;
  let dimensions: MapCanvasDimensions = { width: 1, height: 1, dpr: 1 };
  const openingPilot = PlayerManager.getInstance().getLocalPlayer();
  const view: MapView = {
    center: openingPilot?.ship.position ? { ...openingPilot.ship.position } : { x: 0, y: 0 },
    zoom: UNIVERSE_MAP_ZOOM.initial,
  };
  const mapPointers = new Map<number, Position>();
  let occlusions: readonly MapLabelRect[] = [];
  let nextChromeAt = 0;
  let previousChrome = '';
  let locationPage = 0;

  function publishChrome(): void {
    const now = performance.now();
    if (disposed || now < nextChromeAt) {
      return;
    }
    nextChromeAt = now + 100;
    const exploration = getWorldExploration();
    const locations = accessibleLocations(
      getWorldMapAssets().filter((asset) => chartShowsAsset(asset, exploration))
    );
    const locationPages = Math.max(1, Math.ceil(locations.length / LOCATION_PAGE_SIZE));
    locationPage = Math.min(locationPage, locationPages - 1);
    const frame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
    const chrome: UniverseMapChrome = {
      frame: { x: frame.x, y: frame.y, size: frame.size },
      heading: chartHeadingRotation(),
      centered: isNearbyLocalView(),
      zoom: view.zoom,
      locations: locations.slice(
        locationPage * LOCATION_PAGE_SIZE,
        (locationPage + 1) * LOCATION_PAGE_SIZE
      ),
      locationPage,
      locationPages,
      locationCount: locations.length,
    };
    const signature = JSON.stringify(chrome);
    if (signature !== previousChrome) {
      previousChrome = signature;
      onChrome(chrome);
    }
  }

  function mapCanvasToWorld(
    x: number,
    y: number,
    mapFrame: MapFrame,
    headingRotation: number
  ): Position {
    const delta = mapScreenDeltaToWorld(
      x - (mapFrame.x + mapFrame.size / 2),
      y - (mapFrame.y + mapFrame.size / 2),
      mapFrame.scale,
      headingRotation
    );
    return {
      x: view.center.x + delta.x,
      y: view.center.y + delta.y,
    };
  }

  function isNearbyLocalView(): boolean {
    if (!isNearbyZoom(view.zoom)) {
      return false;
    }
    const local = PlayerManager.getInstance().getLocalPlayer();
    const target = local?.ship.position ?? { x: 0, y: 0 };
    const frame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
    const expected = clampCenter(target, frame);
    return Math.hypot(view.center.x - expected.x, view.center.y - expected.y) < 1;
  }

  function setViewCenter(center: Position): void {
    if (disposed) {
      return;
    }
    const frame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
    view.center = clampCenter(center, frame);
  }

  function setViewZoom(zoom: number, anchor?: { x: number; y: number }): void {
    const nextZoom = clampZoom(zoom);
    if (nextZoom === view.zoom) {
      return;
    }

    if (anchor) {
      const heading = chartHeadingRotation();
      const oldFrame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
      const anchorWorld = mapCanvasToWorld(anchor.x, anchor.y, oldFrame, heading);
      view.zoom = nextZoom;
      const nextFrame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
      const nextAnchorWorld = mapCanvasToWorld(anchor.x, anchor.y, nextFrame, heading);
      view.center = clampCenter(
        {
          x: view.center.x + (anchorWorld.x - nextAnchorWorld.x),
          y: view.center.y + (anchorWorld.y - nextAnchorWorld.y),
        },
        nextFrame
      );
    } else {
      view.zoom = nextZoom;
      setViewCenter(view.center);
    }
  }

  function resizeCanvas(): void {
    if (disposed) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || window.innerWidth || 800));
    const height = Math.max(1, Math.round(rect.height || window.innerHeight || 600));
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    if (
      dimensions.width === width &&
      dimensions.height === height &&
      dimensions.dpr === dpr &&
      canvas.width === Math.round(width * dpr) &&
      canvas.height === Math.round(height * dpr)
    ) {
      return;
    }
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    dimensions = { width, height, dpr };
    setViewCenter(view.center);
  }

  function renderMap(): void {
    if (disposed) {
      return;
    }
    resizeCanvas();
    const heading = chartHeadingRotation();
    publishChrome();
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    const frame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
    context.setTransform(dimensions.dpr, 0, 0, dimensions.dpr, 0, 0);
    context.clearRect(0, 0, dimensions.width, dimensions.height);
    context.fillStyle = PALETTE.BG;
    context.fillRect(0, 0, dimensions.width, dimensions.height);

    context.save();
    context.beginPath();
    context.rect(frame.x, frame.y, frame.size, frame.size);
    context.clip();
    context.translate(frame.x + frame.size / 2, frame.y + frame.size / 2);
    context.rotate(heading);
    context.scale(frame.scale, frame.scale);
    context.translate(-view.center.x, -view.center.y);

    const exploration = getWorldExploration();
    drawMapBackground(context, frame);
    drawLitFurnacePipes(context, frame);
    drawNearbyResources(context, frame, exploration);
    drawDiscoveredBelt(context, frame, exploration);
    let drawnLabelCount = 0;
    const revealedAssets = getWorldMapAssets().filter((asset) =>
      chartShowsAsset(asset, exploration)
    );
    // Labels use upright camera-relative coordinates; reserve the visible controls too.
    const labelRects: MapLabelRect[] = occlusions.map((bounds) => ({
      left: (bounds.left - frame.x - frame.size / 2) / frame.scale,
      right: (bounds.right - frame.x - frame.size / 2) / frame.scale,
      top: (bounds.top - frame.y - frame.size / 2) / frame.scale,
      bottom: (bounds.bottom - frame.y - frame.size / 2) / frame.scale,
    }));
    drawCourtLandmark(context, frame, labelRects, view);
    revealedAssets.sort((left, right) => {
      const furnacePriority = Number(right.kind === 'furnace') - Number(left.kind === 'furnace');
      if (furnacePriority !== 0) {
        return furnacePriority;
      }
      const leftDistance = Math.hypot(
        left.position.x - view.center.x,
        left.position.y - view.center.y
      );
      const rightDistance = Math.hypot(
        right.position.x - view.center.x,
        right.position.y - view.center.y
      );
      const outsideRadarPriority =
        Number(rightDistance > WORLD.minimapRadius) - Number(leftDistance > WORLD.minimapRadius);
      return outsideRadarPriority !== 0 ? outsideRadarPriority : leftDistance - rightDistance;
    });
    for (const asset of revealedAssets) {
      const labelAllowed = mapAssetNameVisible(asset.kind, view.zoom, drawnLabelCount);
      const showLabel =
        labelAllowed &&
        canPlaceMapAssetLabel(asset, frame, view.center, labelRects, chartHeadingRotation());
      if (showLabel) {
        drawnLabelCount++;
      }
      drawMapAsset(context, asset, frame, showLabel);
    }
    drawNestMarks(context, frame, exploration);
    drawCrew(context, frame, labelRects, view);
    context.restore();

    context.save();
    context.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, 0.45);
    context.lineWidth = 1;
    context.strokeRect(frame.x, frame.y, frame.size, frame.size);
    context.fillStyle = hexToRgba(PALETTE.HUD, 0.72);
    context.font = '10px "Courier New", monospace';
    context.textAlign = 'right';
    context.textBaseline = 'top';
    context.fillText(
      `${Number((WORLD_DIAMETER / view.zoom / 1000).toFixed(1))}k across`,
      frame.x + frame.size - 8,
      frame.y + 8
    );
    context.restore();
  }

  function renderLoop(): void {
    if (disposed) {
      frameRequest = null;
      return;
    }
    renderMap();
    frameRequest = window.requestAnimationFrame(renderLoop);
  }

  function startRenderLoop(): void {
    if (frameRequest === null) {
      frameRequest = window.requestAnimationFrame(renderLoop);
    }
  }

  function stopRenderLoop(): void {
    if (frameRequest !== null) {
      window.cancelAnimationFrame(frameRequest);
      frameRequest = null;
    }
  }

  function releaseMapPointers(): void {
    const captured = [...mapPointers.keys()];
    mapPointers.clear();
    for (const id of captured) {
      if (canvas.hasPointerCapture?.(id)) {
        canvas.releasePointerCapture(id);
      }
    }
  }

  function handleMapKeydown(ev: KeyboardEvent): void {
    if (disposed) {
      return;
    }
    if (ev.code === 'Home') {
      ev.preventDefault();
      ev.stopPropagation();
      centerOnLocalPlayer();
      return;
    }
    if (ev.target instanceof HTMLButtonElement) {
      ev.stopPropagation();
      return;
    }

    let panX = 0;
    let panY = 0;
    const frame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
    const panStep = visibleWorldHalfSize(frame) * 0.16;
    switch (ev.code) {
      case 'ArrowLeft':
        panX = -panStep;
        break;
      case 'ArrowRight':
        panX = panStep;
        break;
      case 'ArrowUp':
        panY = -panStep;
        break;
      case 'ArrowDown':
        panY = panStep;
        break;
      case 'Equal':
      case 'NumpadAdd':
        setViewZoom(view.zoom * UNIVERSE_MAP_ZOOM.step);
        break;
      case 'Minus':
      case 'NumpadSubtract':
        setViewZoom(view.zoom / UNIVERSE_MAP_ZOOM.step);
        break;
      default:
        if (!BLOCKED_GAMEPLAY_KEYS.has(ev.code)) {
          return;
        }
        break;
    }
    if (panX !== 0 || panY !== 0) {
      const pan = mapScreenDeltaToWorld(panX, panY, 1, chartHeadingRotation());
      setViewCenter({ x: view.center.x + pan.x, y: view.center.y + pan.y });
    }
    ev.preventDefault();
    ev.stopPropagation();
  }

  function canvasPoint(ev: PointerEvent | WheelEvent): { x: number; y: number } | null {
    if (disposed) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
    };
  }

  function centerOnLocalPlayer(): void {
    const local = PlayerManager.getInstance().getLocalPlayer();
    setViewZoom(UNIVERSE_MAP_ZOOM.initial);
    setViewCenter(local?.ship.position ?? { x: 0, y: 0 });
  }

  function mapGesture(): { center: Position; distance: number } | undefined {
    const contacts = [...mapPointers.values()];
    const first = contacts[0];
    if (!first) {
      return undefined;
    }
    const second = contacts[1];
    return second
      ? {
          center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
          distance: Math.hypot(second.x - first.x, second.y - first.y),
        }
      : { center: first, distance: 0 };
  }

  function onPointerDown(ev: PointerEvent): void {
    if (disposed || (ev.button !== 0 && ev.pointerType !== 'touch')) {
      return;
    }
    const point = canvasPoint(ev);
    if (!point) {
      return;
    }
    mapPointers.set(ev.pointerId, point);
    canvas.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  }

  function onPointerMove(ev: PointerEvent): void {
    if (disposed || !mapPointers.has(ev.pointerId)) {
      return;
    }
    const point = canvasPoint(ev);
    const before = mapGesture();
    if (!point || !before) {
      return;
    }
    mapPointers.set(ev.pointerId, point);
    const after = mapGesture();
    if (!after) {
      return;
    }
    if (before.distance > 0 && after.distance > 0) {
      setViewZoom((view.zoom * after.distance) / before.distance, before.center);
    }
    const frame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
    const pan = mapScreenDeltaToWorld(
      after.center.x - before.center.x,
      after.center.y - before.center.y,
      frame.scale,
      chartHeadingRotation()
    );
    setViewCenter({ x: view.center.x - pan.x, y: view.center.y - pan.y });
    ev.preventDefault();
  }

  function onPointerUp(ev: PointerEvent): void {
    if (disposed || !mapPointers.delete(ev.pointerId)) {
      return;
    }
    if (canvas.hasPointerCapture?.(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
  }

  function onWheel(ev: WheelEvent): void {
    if (disposed) {
      return;
    }
    const point = canvasPoint(ev);
    if (!point) {
      return;
    }
    const direction = ev.deltaY < 0 ? UNIVERSE_MAP_ZOOM.step : 1 / UNIVERSE_MAP_ZOOM.step;
    setViewZoom(view.zoom * direction, point);
    ev.preventDefault();
  }

  canvas.addEventListener('pointerdown', onPointerDown, { signal });
  canvas.addEventListener('pointermove', onPointerMove, { signal });
  canvas.addEventListener('pointerup', onPointerUp, { signal });
  canvas.addEventListener('pointercancel', onPointerUp, { signal });
  canvas.addEventListener('lostpointercapture', onPointerUp, { signal });
  canvas.addEventListener('wheel', onWheel, { passive: false, signal });
  const observer = new ResizeObserver(() => {
    if (!disposed) {
      renderMap();
    }
  });
  observer.observe(canvas);
  window.addEventListener('resize', renderMap, { signal });
  resizeCanvas();
  setViewCenter(view.center);
  renderMap();
  startRenderLoop();
  return {
    center() {
      if (!disposed) {
        centerOnLocalPlayer();
      }
    },
    zoomBy(factor) {
      if (!disposed) {
        setViewZoom(view.zoom * factor);
      }
    },
    keydown: handleMapKeydown,
    setLocationPage(page) {
      if (!disposed) {
        locationPage = Math.max(0, Math.floor(page));
      }
    },
    setOcclusions(rectangles) {
      if (!disposed) {
        occlusions = rectangles;
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      listenerScope.abort();
      observer.disconnect();
      stopRenderLoop();
      releaseMapPointers();
      occlusions = [];
      explorationRaster.source = null;
      explorationRaster.canvas = null;
      explorationRaster.context = null;
    },
  };
}
