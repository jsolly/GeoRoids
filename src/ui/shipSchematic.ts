import type { HaulerUtilityId } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { PlayerManager } from '../entities/player/PlayerManager';
import {
  HAULER_UTILITY,
  HAULER_UTILITY_IDS,
  haulerUtilityOf,
  preferredHaulerUtility,
  rememberHaulerUtility,
} from '../entities/ship/haulerUtility';
import { getKitHullOutline, projectHullPolyline } from '../entities/ship/hullOutlines';
import { NetworkManager } from '../network/networkManager';
import { hexToRgba } from '../utils/colorUtils';
import { logger } from '../utils/Logger';
import { isShipSchematicOpen, setShipSchematicOpen } from './shipSchematicState';
import { closeUniverseMap, isUniverseMapOpen } from './universeMap';

export const SHIP_SCHEMATIC_IDS = {
  dialog: 'ship-schematic-dialog',
  close: 'ship-schematic-close',
  canvas: 'ship-schematic-canvas',
  tool: 'ship-schematic-tool',
  title: 'ship-schematic-part-title',
  copy: 'ship-schematic-part-copy',
  return: 'ship-schematic-return',
  cards: 'ship-schematic-cards',
} as const;

export const SHIP_SCHEMATIC_LONG_PRESS_MS = 700;

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

type SchematicElements = {
  dialog: HTMLDialogElement;
  close: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  tool: HTMLCanvasElement;
  title: HTMLElement;
  copy: HTMLElement;
  return: HTMLButtonElement;
  cards: HTMLElement;
};

let initialized = false;
let closeInProgress = false;
let frameRequest: number | null = null;
let openInputRelease: (() => void) | undefined;
let elements: SchematicElements | null = null;
let selectedUtility: HaulerUtilityId = preferredHaulerUtility();

function createDialogMarkup(dialog: HTMLDialogElement): void {
  if (dialog.querySelector(`#${SHIP_SCHEMATIC_IDS.canvas}`)) {
    return;
  }
  dialog.classList.add('ship-schematic-dialog');
  dialog.setAttribute('aria-labelledby', 'ship-schematic-title');
  dialog.innerHTML = `
    <header class="ship-schematic-header">
      <div>
        <p class="ship-schematic-eyebrow">HAULER</p>
        <h2 id="ship-schematic-title">Ship schematic</h2>
      </div>
      <button id="${SHIP_SCHEMATIC_IDS.close}" type="button" aria-label="Close schematic">×</button>
    </header>
    <div class="ship-schematic-stage">
      <canvas id="${SHIP_SCHEMATIC_IDS.canvas}" role="img" aria-label="Hauler exploded schematic"></canvas>
      <div id="${SHIP_SCHEMATIC_IDS.cards}" class="ship-schematic-cards"></div>
    </div>
    <footer class="ship-schematic-footer">
      <div class="ship-schematic-detail">
        <h3 id="${SHIP_SCHEMATIC_IDS.title}"></h3>
        <p id="${SHIP_SCHEMATIC_IDS.copy}"></p>
      </div>
      <canvas id="${SHIP_SCHEMATIC_IDS.tool}" role="img" aria-label="Tool in use"></canvas>
      <button id="${SHIP_SCHEMATIC_IDS.return}" type="button">Return to flight</button>
    </footer>
  `;
}

function ensureElements(): SchematicElements | null {
  if (typeof document === 'undefined') {
    return null;
  }
  let dialog = document.querySelector<HTMLDialogElement>(`#${SHIP_SCHEMATIC_IDS.dialog}`);
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = SHIP_SCHEMATIC_IDS.dialog;
    document.body.appendChild(dialog);
  }
  createDialogMarkup(dialog);
  const canvas = dialog.querySelector<HTMLCanvasElement>(`#${SHIP_SCHEMATIC_IDS.canvas}`);
  const tool = dialog.querySelector<HTMLCanvasElement>(`#${SHIP_SCHEMATIC_IDS.tool}`);
  const close = dialog.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.close}`);
  const title = dialog.querySelector<HTMLElement>(`#${SHIP_SCHEMATIC_IDS.title}`);
  const copy = dialog.querySelector<HTMLElement>(`#${SHIP_SCHEMATIC_IDS.copy}`);
  const ret = dialog.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.return}`);
  const cards = dialog.querySelector<HTMLElement>(`#${SHIP_SCHEMATIC_IDS.cards}`);
  if (!canvas || !tool || !close || !title || !copy || !ret || !cards) {
    return null;
  }
  return { dialog, canvas, tool, close, title, copy, return: ret, cards };
}

function canOpenForLocalHauler(): boolean {
  if (!document.body.classList.contains('in-play')) {
    return false;
  }
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  return ship?.kitId === 'hauler' && ship.health > 0 && !ship.exploding;
}

function mountCards(): void {
  if (!elements) {
    return;
  }
  elements.cards.replaceChildren();
  for (const id of HAULER_UTILITY_IDS) {
    const part = HAULER_UTILITY[id];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ship-schematic-card';
    button.dataset['utilityId'] = id;
    button.innerHTML = `<span class="ship-schematic-card-name">${part.name}</span><span class="ship-schematic-card-hint">${part.hint}</span><span class="ship-schematic-badge">ACTIVE</span>`;
    button.addEventListener('click', () => {
      equipUtility(id);
    });
    elements.cards.appendChild(button);
  }
}

function syncCards(): void {
  if (!elements) {
    return;
  }
  const part = HAULER_UTILITY[selectedUtility];
  elements.title.textContent = part.name;
  elements.copy.textContent = part.copy;
  for (const button of elements.cards.querySelectorAll<HTMLButtonElement>('[data-utility-id]')) {
    const active = button.dataset['utilityId'] === selectedUtility;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

export function equipUtility(utilityId: HaulerUtilityId): void {
  selectedUtility = utilityId;
  rememberHaulerUtility(utilityId);
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (player?.ship.kitId === 'hauler') {
    player.ship.haulerUtility = utilityId;
  }
  if (player) {
    const network = NetworkManager.getInstance();
    if (network.isConnected) {
      network.sendMessage({
        type: 'setHaulerUtility',
        id: network.getLocalPlayerId() || player.id,
        data: { utilityId },
      });
    }
  }
  syncCards();
}

function resizeCanvas(canvas: HTMLCanvasElement, fallbackW: number, fallbackH: number): void {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || fallbackW));
  const height = Math.max(1, Math.round(rect.height || fallbackH));
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
}

function strokePolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  closed: boolean
): void {
  const first = points[0];
  if (!first) {
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    if (point) {
      ctx.lineTo(point.x, point.y);
    }
  }
  if (closed) {
    ctx.closePath();
  }
  ctx.stroke();
}

function drawExplodedHull(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const outline = getKitHullOutline('hauler');
  const cx = width * 0.5;
  const cy = height * 0.46;
  const radius = Math.min(width, height) * 0.28;
  const angle = Math.PI / 2;
  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = PALETTE.LOCAL;
  ctx.shadowColor = PALETTE.LOCAL;
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  strokePolyline(
    ctx,
    projectHullPolyline(cx, cy, radius, angle, outline.hull),
    outline.hull.closed
  );
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, 0.85);
  ctx.shadowBlur = 0;
  for (const extra of outline.extras) {
    const points = projectHullPolyline(cx, cy, radius, angle, extra);
    let ax = 0;
    let ay = 0;
    for (const point of points) {
      ax += point.x;
      ay += point.y;
    }
    const count = Math.max(1, points.length);
    ax /= count;
    ay /= count;
    const exploded = points.map((point) => ({
      x: point.x + (point.x - cx) * 0.12,
      y: point.y + (point.y - cy) * 0.12,
    }));
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ax + (ax - cx) * 0.12, ay + (ay - cy) * 0.12);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = selectedUtility === 'resource_tap' ? PALETTE.LOOT : PALETTE.LOCAL;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = VISUAL.SHIP_GLOW;
    strokePolyline(ctx, exploded, extra.closed);
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, 0.85);
    ctx.shadowBlur = 0;
  }
  ctx.setLineDash([]);
  const leftMount = { x: cx - radius * 0.72, y: cy - radius * 0.08 };
  const rightMount = { x: cx + radius * 0.72, y: cy - radius * 0.08 };
  const towActive = selectedUtility === 'tow_cable';
  ctx.lineWidth = 1;
  ctx.strokeStyle = towActive ? PALETTE.LOCAL : hexToRgba(PALETTE.HUD_MUTED, 0.85);
  ctx.shadowColor = towActive ? PALETTE.LOCAL : 'transparent';
  ctx.shadowBlur = towActive ? VISUAL.SHIP_GLOW : 0;
  ctx.beginPath();
  ctx.moveTo(width * 0.16, height * 0.22);
  ctx.lineTo(leftMount.x, leftMount.y);
  ctx.stroke();
  ctx.strokeStyle = towActive ? hexToRgba(PALETTE.HUD_MUTED, 0.85) : PALETTE.LOOT;
  ctx.shadowColor = towActive ? 'transparent' : PALETTE.LOOT;
  ctx.shadowBlur = towActive ? 0 : VISUAL.SHIP_GLOW;
  ctx.beginPath();
  ctx.moveTo(width * 0.84, height * 0.22);
  ctx.lineTo(rightMount.x, rightMount.y);
  ctx.stroke();
  ctx.strokeStyle = PALETTE.LASER_LOCAL;
  ctx.shadowColor = PALETTE.LASER_LOCAL;
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  ctx.beginPath();
  ctx.arc(cx, cy + radius * 0.08, 5, 0, Math.PI * 2);
  ctx.stroke();
}

function drawToolLoop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  now: number
): void {
  ctx.clearRect(0, 0, width, height);
  const shipX = width * 0.22;
  const rockX = width * 0.78;
  const midY = height * 0.5;
  const t = (now / 1000) % 1;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.LOCAL;
  ctx.shadowColor = PALETTE.LOCAL;
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  ctx.beginPath();
  ctx.moveTo(shipX - 16, midY - 10);
  ctx.lineTo(shipX + 10, midY);
  ctx.lineTo(shipX - 16, midY + 10);
  ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(rockX, midY, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = PALETTE.LOOT;
  ctx.beginPath();
  ctx.moveTo(shipX + 10, midY);
  ctx.lineTo(rockX - 14, midY);
  ctx.stroke();
  ctx.strokeStyle = PALETTE.LASER_LOCAL;
  ctx.beginPath();
  ctx.arc(rockX - 14, midY, 2.2, 0, Math.PI * 2);
  ctx.stroke();
  if (selectedUtility === 'resource_tap') {
    for (let i = 0; i < 4; i++) {
      const u = (t + i / 4) % 1;
      const x = rockX - 14 + (shipX + 10 - (rockX - 14)) * u;
      ctx.strokeStyle = i === 3 ? PALETTE.LASER_LOCAL : PALETTE.LOOT;
      ctx.beginPath();
      ctx.arc(x, midY, 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    const haul = Math.sin(t * Math.PI * 2) * 6;
    ctx.strokeStyle = PALETTE.HUD_MUTED;
    ctx.beginPath();
    ctx.arc(rockX + haul, midY, 14, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function renderOverlay(): void {
  if (!elements || !isShipSchematicOpen()) {
    return;
  }
  resizeCanvas(elements.canvas, 640, 360);
  resizeCanvas(elements.tool, 220, 80);
  const hull = elements.canvas.getContext('2d');
  const tool = elements.tool.getContext('2d');
  if (hull) {
    hull.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    hull.scale(dpr, dpr);
    drawExplodedHull(hull, elements.canvas.width / dpr, elements.canvas.height / dpr);
  }
  if (tool) {
    tool.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    tool.scale(dpr, dpr);
    drawToolLoop(tool, elements.tool.width / dpr, elements.tool.height / dpr, performance.now());
  }
  frameRequest = window.requestAnimationFrame(renderOverlay);
}

function startRenderLoop(): void {
  if (frameRequest !== null) {
    return;
  }
  frameRequest = window.requestAnimationFrame(renderOverlay);
}

function stopRenderLoop(): void {
  if (frameRequest !== null) {
    window.cancelAnimationFrame(frameRequest);
    frameRequest = null;
  }
}

export function isPointerOnLocalHauler(clientX: number, clientY: number): boolean {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
  if (!player || !canvas || player.ship.kitId !== 'hauler' || player.lives <= 0) {
    return false;
  }
  const rect = canvas.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const scale = rect.width / Math.max(1, canvas.width);
  return Math.hypot(dx, dy) <= player.ship.r * scale + 20;
}

export function openShipSchematic(): boolean {
  if (!elements || isShipSchematicOpen() || !canOpenForLocalHauler()) {
    return false;
  }
  if (isUniverseMapOpen()) {
    closeUniverseMap();
  }
  try {
    elements.dialog.showModal();
  } catch (error) {
    logger.error(
      'UI',
      'Could not open the ship schematic',
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  }
  setShipSchematicOpen(true);
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  selectedUtility = ship ? haulerUtilityOf(ship) : preferredHaulerUtility();
  syncCards();
  openInputRelease?.();
  window.dispatchEvent(new CustomEvent('gameSchematicOpen'));
  startRenderLoop();
  elements.close.focus({ preventScroll: true });
  return true;
}

export function closeShipSchematic(): void {
  if (!elements || !isShipSchematicOpen() || closeInProgress) {
    return;
  }
  closeInProgress = true;
  setShipSchematicOpen(false);
  stopRenderLoop();
  elements.dialog.close();
  closeInProgress = false;
  window.dispatchEvent(new CustomEvent('gameSchematicClose'));
}

function handleDialogClosed(): void {
  if (closeInProgress || !isShipSchematicOpen()) {
    return;
  }
  setShipSchematicOpen(false);
  stopRenderLoop();
  window.dispatchEvent(new CustomEvent('gameSchematicClose'));
}

function handleSchematicKeydown(ev: KeyboardEvent): void {
  if (ev.code === 'KeyV') {
    const target = ev.target;
    if (
      !isShipSchematicOpen() &&
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
    if (isShipSchematicOpen()) {
      closeShipSchematic();
    } else {
      openShipSchematic();
    }
    return;
  }
  if (ev.code === 'KeyM' && isShipSchematicOpen()) {
    closeShipSchematic();
    return;
  }
  if (!isShipSchematicOpen()) {
    return;
  }
  if (ev.code === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closeShipSchematic();
    return;
  }
  if (BLOCKED_GAMEPLAY_KEYS.has(ev.code)) {
    ev.preventDefault();
    ev.stopPropagation();
  }
}

export function initializeShipSchematic(options?: { onOpen?: () => void }): void {
  if (initialized || typeof document === 'undefined') {
    return;
  }
  elements = ensureElements();
  if (!elements) {
    return;
  }
  openInputRelease = options?.onOpen;
  initialized = true;
  mountCards();
  syncCards();
  elements.close.addEventListener('click', () => {
    closeShipSchematic();
  });
  elements.return.addEventListener('click', () => {
    closeShipSchematic();
  });
  const hullCanvas = elements.canvas;
  hullCanvas.addEventListener('click', (ev) => {
    const rect = hullCanvas.getBoundingClientRect();
    equipUtility(ev.clientX < rect.left + rect.width / 2 ? 'tow_cable' : 'resource_tap');
  });
  elements.dialog.addEventListener('close', handleDialogClosed);
  elements.dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    closeShipSchematic();
  });
  elements.dialog.addEventListener('click', (ev) => {
    if (ev.target === elements?.dialog) {
      closeShipSchematic();
    }
  });
  document.addEventListener('keydown', handleSchematicKeydown, true);
  window.addEventListener('playViewOff', () => {
    closeShipSchematic();
  });
}
