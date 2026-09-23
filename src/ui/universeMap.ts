import { beltSlotPosition, beltSlots } from '../../shared/asteroidBelt';
import { oreResource } from '../../shared/economy';
import { explorationCellAt, isCellExplored } from '../../shared/exploration';
import { CIVIC_LOTS, pipeHopToParent } from '../../shared/furnaces';
import { RICOCHET_COURT } from '../../shared/ricochetCourt';
import { WORLD } from '../../shared/world';
import type { ExplorationTile, MapAsset, Position } from '../../shared-types';
import { playFeedback } from '../audio/feedbackSounds';
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
import { hexToRgba } from '../utils/colorUtils';
import { logger } from '../utils/Logger';
import { requestTownStoreClose } from './townStoreState';
import {
  canPlaceMapAssetLabel,
  canPlaceMapCrewLabel,
  isFiniteMapPosition,
  type MapLabelRect,
} from './universeMapLabels';
import { shouldUseTouchControls } from './viewportChrome';

export const UNIVERSE_MAP_IDS = {
  dialog: 'universe-map-dialog',
  canvas: 'universe-map-canvas',
  toggle: 'universe-map-toggle',
  close: 'universe-map-close',
  center: 'universe-map-center',
  zoomIn: 'universe-map-zoom-in',
  zoomOut: 'universe-map-zoom-out',
  status: 'universe-map-status',
  locations: 'universe-map-locations',
} as const;

export const UNIVERSE_MAP_ZOOM = {
  min: 1,
  max: 48,
  initial: 24,
  step: 1.35,
} as const;

export const UNIVERSE_MAP_LOCATE_LABEL = 'Center on you';
export const DESKTOP_MAP_HELP =
  'Drag to pan · Locate or Home for your ship · Scroll or +/- to zoom · M or Esc closes · Ship stopped · Rocks pass through until you return and blink.';
export const TOUCH_MAP_HELP =
  'Drag to pan · Locate for your ship · Tap +/− to zoom · Close returns to flight · Ship stopped · Rocks pass through until you return and blink.';

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
const MAP_LABEL_ZOOM = 2.8;
const MAP_DEFAULT_LABEL_LIMIT = 1;

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

type UniverseMapElements = {
  dialog: HTMLDialogElement;
  canvas: HTMLCanvasElement;
  toggle: HTMLButtonElement;
  close: HTMLButtonElement;
  center: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  zoomControls: HTMLElement;
  status: HTMLElement;
  locations: HTMLUListElement;
  help: HTMLElement;
};

type ExplorationRaster = {
  source: readonly ExplorationTile[] | null;
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
};

let readMapRoids: () => readonly Roid[] = () => [];

export function bindUniverseMapField(source: () => readonly Roid[]): void {
  readMapRoids = source;
}

let initialized = false;
let mapOpen = false;
let frameRequest: number | null = null;
let closeInProgress = false;
let openInputRelease: (() => void) | undefined;
let elements: UniverseMapElements | null = null;
let dimensions: MapCanvasDimensions = { width: 1, height: 1, dpr: 1 };
const view: MapView = { center: { x: 0, y: 0 }, zoom: UNIVERSE_MAP_ZOOM.initial };
let nextLocationUpdateAt = 0;
let pointerPan: { id: number; x: number; y: number } | null = null;
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

export function mapWorldToCanvas(
  position: Position,
  viewCenter: Position,
  frame: Pick<MapFrame, 'x' | 'y' | 'size' | 'scale'>
): Position {
  return {
    x: frame.x + frame.size / 2 + (position.x - viewCenter.x) * frame.scale,
    y: frame.y + frame.size / 2 + (position.y - viewCenter.y) * frame.scale,
  };
}

function mapCanvasToWorld(x: number, y: number, mapFrame: MapFrame): Position {
  return {
    x: view.center.x + (x - (mapFrame.x + mapFrame.size / 2)) / mapFrame.scale,
    y: view.center.y + (y - (mapFrame.y + mapFrame.size / 2)) / mapFrame.scale,
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

function positionMapOverlayControls(): void {
  if (!elements) {
    return;
  }
  const frame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
  const inset = 12;
  const size = 44;
  elements.center.style.left = `${Math.round(frame.x + frame.size - inset - size)}px`;
  elements.center.style.top = `${Math.round(frame.y + frame.size - inset - size)}px`;
  elements.center.style.right = 'auto';
  elements.center.style.bottom = 'auto';
  elements.zoomControls.style.left = `${Math.round(frame.x + inset)}px`;
  elements.zoomControls.style.top = `${Math.round(frame.y + frame.size - inset - size)}px`;
  elements.zoomControls.style.right = 'auto';
  elements.zoomControls.style.bottom = 'auto';
}

function updateLocateControl(): void {
  if (!elements) {
    return;
  }
  elements.center.setAttribute('aria-pressed', isNearbyLocalView() ? 'true' : 'false');
}

function syncMapInputChrome(): void {
  if (!elements) {
    return;
  }
  const touch = shouldUseTouchControls();
  elements.dialog.classList.toggle('universe-map-touch', touch);
  elements.toggle.classList.toggle('universe-map-touch', touch);
  elements.help.textContent = touch ? TOUCH_MAP_HELP : DESKTOP_MAP_HELP;
  elements.toggle.setAttribute('aria-label', touch ? 'Open universe map' : 'Open universe map (M)');
  if (touch) {
    elements.toggle.removeAttribute('aria-keyshortcuts');
    elements.center.removeAttribute('aria-keyshortcuts');
  } else {
    elements.toggle.setAttribute('aria-keyshortcuts', 'M');
    elements.center.setAttribute('aria-keyshortcuts', 'Home');
  }
}

function setViewCenter(center: Position): void {
  if (!elements) {
    return;
  }
  const frame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
  view.center = clampCenter(center, frame);
  updateLocateControl();
}

function setViewZoom(zoom: number, anchor?: { x: number; y: number }): void {
  const nextZoom = clampZoom(zoom);
  if (nextZoom === view.zoom) {
    return;
  }

  if (anchor) {
    const oldFrame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
    const anchorWorld = mapCanvasToWorld(anchor.x, anchor.y, oldFrame);
    view.zoom = nextZoom;
    const nextFrame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
    const nextAnchorWorld = mapCanvasToWorld(anchor.x, anchor.y, nextFrame);
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
  updateLocateControl();
}

function createButton(id: string, label: string, ariaLabel = label): HTMLButtonElement {
  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  return button;
}

const LOCATE_ICON = `<svg class="universe-map-locate-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><title>${UNIVERSE_MAP_LOCATE_LABEL}</title><circle class="universe-map-locate-dot" cx="12" cy="12" r="3"/><circle class="universe-map-locate-ring" cx="12" cy="12" r="7"/><path class="universe-map-locate-cross" d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2"/></svg>`;

function locateControlMarkup(): string {
  return `<button id="${UNIVERSE_MAP_IDS.center}" type="button" class="universe-map-locate" aria-label="${UNIVERSE_MAP_LOCATE_LABEL}" title="${UNIVERSE_MAP_LOCATE_LABEL}" aria-keyshortcuts="Home" aria-pressed="true">${LOCATE_ICON}</button>`;
}

function decorateLocateControl(button: HTMLButtonElement, stage: Element): void {
  button.classList.add('universe-map-locate');
  button.type = 'button';
  button.setAttribute('aria-label', UNIVERSE_MAP_LOCATE_LABEL);
  button.setAttribute('title', UNIVERSE_MAP_LOCATE_LABEL);
  button.setAttribute('aria-keyshortcuts', 'Home');
  if (!button.querySelector('svg')) {
    button.innerHTML = LOCATE_ICON;
  }
  if (button.parentElement !== stage) {
    stage.append(button);
  }
}

function createDialogMarkup(dialog: HTMLDialogElement): void {
  if (dialog.querySelector(`#${UNIVERSE_MAP_IDS.canvas}`)) {
    return;
  }
  dialog.innerHTML = `
    <header class="universe-map-header">
      <div>
        <p class="universe-map-eyebrow">Shared field cartography</p>
        <h2 id="universe-map-title">Universe map</h2>
        <p class="universe-map-subtitle">Your nearby discoveries. Zoom out to explore the whole world.</p>
      </div>
      <div class="universe-map-actions">
        <button id="${UNIVERSE_MAP_IDS.close}" type="button" aria-label="Close">Close <kbd>Esc</kbd></button>
      </div>
    </header>
    <div class="universe-map-stage">
      <canvas id="${UNIVERSE_MAP_IDS.canvas}" tabindex="0" role="img" aria-label="Shared universe map" aria-details="${UNIVERSE_MAP_IDS.locations}"></canvas>
      <ul id="${UNIVERSE_MAP_IDS.locations}" class="universe-map-accessible" aria-label="Revealed landmarks and crew coordinates"></ul>
      <div class="universe-map-compass" aria-hidden="true"><span>N</span><i></i></div>
      <div class="universe-map-zoom">
        <button id="${UNIVERSE_MAP_IDS.zoomOut}" type="button" aria-label="Zoom out">−</button>
        <button id="${UNIVERSE_MAP_IDS.zoomIn}" type="button" aria-label="Zoom in">+</button>
      </div>
      ${locateControlMarkup()}
    </div>
    <footer class="universe-map-footer">
      <div class="universe-map-legend"></div>
      <p id="${UNIVERSE_MAP_IDS.status}" aria-live="polite"></p>
      <p class="universe-map-help">${DESKTOP_MAP_HELP}</p>
    </footer>`;
}

function drawMapLegend(dialog: HTMLDialogElement): void {
  const legend = dialog.querySelector('.universe-map-legend');
  if (!legend) {
    return;
  }
  legend.replaceChildren();
  for (const kind of ['You', 'Crew', 'Furnace', 'Court', 'Resources', 'Nest', 'Uncharted']) {
    const item = document.createElement('span');
    const canvas = document.createElement('canvas');
    canvas.className = 'map-key';
    canvas.width = 32;
    canvas.height = 32;
    canvas.setAttribute('aria-hidden', 'true');
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
    item.append(canvas, kind);
    legend.append(item);
  }
}

function ensureElements(): UniverseMapElements | null {
  if (typeof document === 'undefined') {
    return null;
  }

  let dialog = document.querySelector<HTMLDialogElement>(`#${UNIVERSE_MAP_IDS.dialog}`);
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = UNIVERSE_MAP_IDS.dialog;
    document.body.appendChild(dialog);
  }
  dialog.setAttribute('aria-labelledby', 'universe-map-title');
  dialog.classList.add('universe-map-dialog');
  createDialogMarkup(dialog);

  let toggle = document.querySelector<HTMLButtonElement>(`#${UNIVERSE_MAP_IDS.toggle}`);
  if (!toggle) {
    const gameArea = document.querySelector('#gameArea') ?? document.body;
    toggle = createButton(UNIVERSE_MAP_IDS.toggle, 'Map', 'Open universe map (M)');
    toggle.setAttribute('aria-keyshortcuts', 'M');
    gameArea.appendChild(toggle);
  }
  toggle.classList.add('universe-map-toggle');
  toggle.setAttribute('aria-keyshortcuts', 'M');

  const canvas = dialog.querySelector(`#${UNIVERSE_MAP_IDS.canvas}`) as HTMLCanvasElement | null;
  const close = dialog.querySelector(`#${UNIVERSE_MAP_IDS.close}`) as HTMLButtonElement | null;
  const center = dialog.querySelector(`#${UNIVERSE_MAP_IDS.center}`) as HTMLButtonElement | null;
  const stage = dialog.querySelector('.universe-map-stage');
  const zoomControls = dialog.querySelector('.universe-map-zoom') as HTMLElement | null;
  const zoomIn = dialog.querySelector(`#${UNIVERSE_MAP_IDS.zoomIn}`) as HTMLButtonElement | null;
  const zoomOut = dialog.querySelector(`#${UNIVERSE_MAP_IDS.zoomOut}`) as HTMLButtonElement | null;
  const status = dialog.querySelector(`#${UNIVERSE_MAP_IDS.status}`) as HTMLElement | null;
  const locations = dialog.querySelector(
    `#${UNIVERSE_MAP_IDS.locations}`
  ) as HTMLUListElement | null;
  const help = dialog.querySelector('.universe-map-help') as HTMLElement | null;
  if (
    !canvas ||
    !close ||
    !center ||
    !stage ||
    !zoomControls ||
    !zoomIn ||
    !zoomOut ||
    !status ||
    !locations ||
    !help
  ) {
    return null;
  }
  decorateLocateControl(center, stage);
  if (zoomControls.parentElement !== stage) {
    stage.append(zoomControls);
  }
  close.setAttribute('aria-label', 'Close');
  return {
    dialog,
    canvas,
    toggle,
    close,
    center,
    zoomIn,
    zoomOut,
    zoomControls,
    status,
    locations,
    help,
  };
}

function resizeCanvas(): void {
  if (!elements) {
    return;
  }
  const rect = elements.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || window.innerWidth || 800));
  const height = Math.max(1, Math.round(rect.height || window.innerHeight || 600));
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  if (
    dimensions.width === width &&
    dimensions.height === height &&
    dimensions.dpr === dpr &&
    elements.canvas.width === Math.round(width * dpr) &&
    elements.canvas.height === Math.round(height * dpr)
  ) {
    return;
  }
  elements.canvas.width = Math.round(width * dpr);
  elements.canvas.height = Math.round(height * dpr);
  dimensions = { width, height, dpr };
  setViewCenter(view.center);
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
    context.font = `${11 / frame.scale}px monospace`;
    context.fillText('ASTEROID BELT', label.x + 12 / frame.scale, label.y - 15 / frame.scale);
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
    context.font = `${12 / frame.scale}px "Courier New", monospace`;
    context.fillStyle = hexToRgba(PALETTE.HUD, 0.86);
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillText(asset.name, 0, size * 1.6);
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
    // Wreckage and cores already have persistent landmark entries.
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
      PALETTE.DANGER
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
  occupied: MapLabelRect[]
): number {
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
      canPlaceMapCrewLabel(player.name, position, size, frame, view.center, occupied)
    ) {
      context.font = `${11 / frame.scale}px "Courier New", monospace`;
      context.fillStyle = hexToRgba(PALETTE.HUD, 0.9);
      context.textAlign = 'left';
      context.textBaseline = 'bottom';
      context.fillText(player.name, size * 1.4, -size);
    }
    context.restore();
  }
  return players.length;
}

function formatCoordinate(value: number): string {
  return `${value >= 0 ? '+' : ''}${Math.round(value)}`;
}

const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function exploredCellCount(tiles: readonly ExplorationTile[]): number {
  let count = 0;
  for (const tile of tiles) {
    for (const char of tile.bits) {
      const nibble = Number.parseInt(char, 16);
      count += NIBBLE_POPCOUNT[nibble] ?? 0;
    }
  }
  return count;
}

function updateStatus(revealedAssetCount: number, crewCount: number): void {
  if (!elements) {
    return;
  }
  const exploredCells = exploredCellCount(getWorldExploration());
  elements.status.textContent = `X ${formatCoordinate(view.center.x)} Y ${formatCoordinate(view.center.y)} · ${revealedAssetCount} revealed assets · ${crewCount} crew · ${exploredCells} explored cells`;
}

function updateAccessibleLocations(assets: readonly MapAsset[]): void {
  if (!elements || performance.now() < nextLocationUpdateAt) {
    return;
  }
  nextLocationUpdateAt = performance.now() + 1000;
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
      .map((nest) => ({ name: 'Spider nest · guarded resource', position: nest.position })),
    ...players
      .filter((player) => isFiniteMapPosition(player.ship.position))
      .map((player) => ({
        name: `${player.name}${player.type === 'local' ? ' (you)' : ' (crew)'}`,
        position: player.ship.position,
      })),
  ];
  elements.locations.replaceChildren(
    ...locations.map(({ name, position }) => {
      const item = document.createElement('li');
      item.textContent = `${name}: X ${formatCoordinate(position.x)}, Y ${formatCoordinate(position.y)}`;
      return item;
    })
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
  labelRects: MapLabelRect[]
): void {
  const markSize = universeMapMarkScreenSize(UNIVERSE_MAP_LANDMARK_SIZE, frame.zoom);
  const showLabel = canPlaceMapAssetLabel(
    { name: RICOCHET_COURT.name, position: RICOCHET_COURT.center },
    frame,
    view.center,
    labelRects
  );
  context.save();
  context.translate(RICOCHET_COURT.center.x, RICOCHET_COURT.center.y);
  context.scale(1 / frame.scale, 1 / frame.scale);
  drawCourtMapMark(context, 0, 0, markSize);
  if (showLabel) {
    context.font = '12px "Courier New", monospace';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillStyle = hexToRgba(PALETTE.REMOTE, 0.9);
    context.fillText(RICOCHET_COURT.name, 0, markSize * 1.6);
  }
  context.restore();
}

function renderMap(): void {
  if (!elements || !mapOpen) {
    return;
  }
  resizeCanvas();
  positionMapOverlayControls();
  updateLocateControl();
  const context = elements.canvas.getContext('2d');
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
  context.scale(frame.scale, frame.scale);
  context.translate(-view.center.x, -view.center.y);

  const exploration = getWorldExploration();
  drawMapBackground(context, frame);
  drawLitFurnacePipes(context, frame);
  drawNearbyResources(context, frame, exploration);
  drawDiscoveredBelt(context, frame, exploration);
  let revealedAssetCount = 0;
  let drawnLabelCount = 0;
  const revealedAssets = getWorldMapAssets().filter((asset) => chartShowsAsset(asset, exploration));
  updateAccessibleLocations(revealedAssets);
  const labelRects: MapLabelRect[] = [];
  drawCourtLandmark(context, frame, labelRects);
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
    revealedAssetCount++;
    const labelAllowed = view.zoom >= MAP_LABEL_ZOOM || drawnLabelCount < MAP_DEFAULT_LABEL_LIMIT;
    const showLabel = labelAllowed && canPlaceMapAssetLabel(asset, frame, view.center, labelRects);
    if (showLabel) {
      drawnLabelCount++;
    }
    drawMapAsset(context, asset, frame, showLabel);
  }
  drawNestMarks(context, frame, exploration);
  const crewCount = drawCrew(context, frame, labelRects);
  context.restore();

  context.save();
  context.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, 0.45);
  context.lineWidth = 1;
  context.strokeRect(frame.x, frame.y, frame.size, frame.size);
  context.fillStyle = hexToRgba(PALETTE.HUD, 0.72);
  context.font = '10px "Courier New", monospace';
  context.textAlign = 'left';
  context.textBaseline = 'top';
  context.fillText('NORTH', frame.x + 8, frame.y + 8);
  context.textAlign = 'right';
  context.fillText(
    `${Number((WORLD_DIAMETER / view.zoom / 1000).toFixed(1))}k across`,
    frame.x + frame.size - 8,
    frame.y + 8
  );
  context.restore();
  updateStatus(revealedAssetCount, crewCount);
}

function renderLoop(): void {
  if (!mapOpen) {
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

function openMap(): void {
  if (!elements || mapOpen || !document.body.classList.contains('in-play')) {
    return;
  }
  requestTownStoreClose();
  try {
    elements.dialog.showModal();
  } catch (error) {
    logger.error(
      'UI',
      'Could not open the universe map',
      error instanceof Error ? error : new Error(String(error))
    );
    return;
  }
  const local = PlayerManager.getInstance().getLocalPlayer();
  mapOpen = true;
  nextLocationUpdateAt = 0;
  syncMapInputChrome();
  drawMapLegend(elements.dialog);
  view.zoom = UNIVERSE_MAP_ZOOM.initial;
  view.center = local?.ship.position ? { ...local.ship.position } : { x: 0, y: 0 };
  resizeCanvas();
  setViewCenter(view.center);
  openInputRelease?.();
  window.dispatchEvent(new CustomEvent('gameMapOpen'));
  playFeedback('interface');
  renderMap();
  startRenderLoop();
  elements.close.focus({ preventScroll: true });
}

function closeMap(): void {
  if (!elements || !mapOpen || closeInProgress) {
    return;
  }
  closeInProgress = true;
  mapOpen = false;
  pointerPan = null;
  stopRenderLoop();
  elements.dialog.close();
  closeInProgress = false;
  window.dispatchEvent(new CustomEvent('gameMapClose'));
  playFeedback('interface');
}

function handleDialogClosed(): void {
  if (closeInProgress || !mapOpen) {
    return;
  }
  mapOpen = false;
  pointerPan = null;
  stopRenderLoop();
  window.dispatchEvent(new CustomEvent('gameMapClose'));
  playFeedback('interface');
}

function handleMapKeydown(ev: KeyboardEvent): void {
  if (ev.code === 'KeyM') {
    const target = ev.target;
    if (
      !mapOpen &&
      (!document.body.classList.contains('in-play') ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || target.matches('input, textarea, select'))))
    ) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.repeat) {
      return;
    }
    if (mapOpen) {
      closeMap();
    } else {
      openMap();
    }
    return;
  }
  if (!mapOpen) {
    return;
  }
  if (ev.code === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closeMap();
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
    setViewCenter({ x: view.center.x + panX, y: view.center.y + panY });
  }
  ev.preventDefault();
  ev.stopPropagation();
}

function canvasPoint(ev: PointerEvent | WheelEvent): { x: number; y: number } | null {
  if (!elements) {
    return null;
  }
  const rect = elements.canvas.getBoundingClientRect();
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

function onPointerDown(ev: PointerEvent): void {
  if (!elements || !mapOpen || (ev.button !== 0 && ev.pointerType !== 'touch')) {
    return;
  }
  const point = canvasPoint(ev);
  if (!point) {
    return;
  }
  pointerPan = { id: ev.pointerId, x: point.x, y: point.y };
  elements.canvas.setPointerCapture?.(ev.pointerId);
  ev.preventDefault();
}

function onPointerMove(ev: PointerEvent): void {
  if (!elements || !pointerPan || pointerPan.id !== ev.pointerId) {
    return;
  }
  const point = canvasPoint(ev);
  if (!point) {
    return;
  }
  const frame = mapFrameFor(dimensions.width, dimensions.height, view.zoom);
  setViewCenter({
    x: view.center.x - (point.x - pointerPan.x) / frame.scale,
    y: view.center.y - (point.y - pointerPan.y) / frame.scale,
  });
  pointerPan.x = point.x;
  pointerPan.y = point.y;
  ev.preventDefault();
}

function onPointerUp(ev: PointerEvent): void {
  if (!elements || !pointerPan || pointerPan.id !== ev.pointerId) {
    return;
  }
  elements.canvas.releasePointerCapture?.(ev.pointerId);
  pointerPan = null;
}

function onWheel(ev: WheelEvent): void {
  if (!mapOpen) {
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

export function isUniverseMapOpen(): boolean {
  return mapOpen;
}

export function initializeUniverseMap(options?: { onOpen?: () => void }): void {
  if (initialized || typeof document === 'undefined') {
    return;
  }
  elements = ensureElements();
  if (!elements) {
    return;
  }
  openInputRelease = options?.onOpen;
  initialized = true;

  elements.toggle.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openMap();
  });
  elements.close.addEventListener('click', closeMap);
  elements.center.addEventListener('click', centerOnLocalPlayer);
  elements.zoomIn.addEventListener('click', () => setViewZoom(view.zoom * UNIVERSE_MAP_ZOOM.step));
  elements.zoomOut.addEventListener('click', () => setViewZoom(view.zoom / UNIVERSE_MAP_ZOOM.step));
  elements.dialog.addEventListener('close', handleDialogClosed);
  elements.dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    closeMap();
  });
  elements.canvas.addEventListener('pointerdown', onPointerDown);
  elements.canvas.addEventListener('pointermove', onPointerMove);
  elements.canvas.addEventListener('pointerup', onPointerUp);
  elements.canvas.addEventListener('pointercancel', onPointerUp);
  elements.canvas.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', handleMapKeydown, true);
  window.addEventListener('resize', () => {
    syncMapInputChrome();
    if (mapOpen) {
      resizeCanvas();
      renderMap();
    }
  });
  window.addEventListener('playViewOff', () => {
    const wasOpen = mapOpen;
    closeMap();
    if (wasOpen) {
      document.querySelector<HTMLInputElement>('#playerNameInput')?.focus({ preventScroll: true });
    }
  });
  syncMapInputChrome();
}

export function closeUniverseMap(): void {
  closeMap();
}
