import type { HaulerUtilityId, ShipKitId, SurveyorUtilityId } from '../../shared-types';
import { playFeedback } from '../audio/feedbackSounds';
import { PALETTE, VISUAL } from '../constants';
import { traceTapCanister } from '../entities/loot/lootRenderer';
import { PlayerManager } from '../entities/player/PlayerManager';
import { latchShudderOffset } from '../entities/roid/latchShudder';
import {
  HAULER_UTILITY,
  HAULER_UTILITY_IDS,
  haulerUtilityOf,
  preferredHaulerUtility,
  rememberHaulerUtility,
} from '../entities/ship/haulerUtility';
import {
  getHaulerEquipment,
  getKitHullOutline,
  projectHullPoint,
  projectHullPolyline,
} from '../entities/ship/hullOutlines';
import { setHaulerUtilityOnHost, setSurveyorUtilityOnHost } from '../entities/ship/shipAbilities';
import { SHIP_ABILITY } from '../entities/ship/shipKits';
import { strokeKitHullOutline } from '../entities/ship/shipRenderer';
import {
  preferredSurveyorUtility,
  rememberSurveyorUtility,
  SURVEYOR_UTILITY,
  SURVEYOR_UTILITY_IDS,
  surveyorUtilityOf,
} from '../entities/ship/surveyorUtility';
import { NetworkManager } from '../network/networkManager';
import { hexToRgba } from '../utils/colorUtils';
import { logger } from '../utils/Logger';
import { renderSatelliteInventory, satelliteInventoryDescription } from './satelliteInventory';
import { isShipSchematicOpen, setShipSchematicOpen } from './shipSchematicState';
import { requestTownStoreClose } from './townStoreState';
import { closeUniverseMap, isUniverseMapOpen } from './universeMap';
import { shouldUseTouchControls } from './viewportChrome';

export const SHIP_SCHEMATIC_IDS = {
  dialog: 'ship-schematic-dialog',
  close: 'ship-schematic-close',
  canvas: 'ship-schematic-canvas',
  tool: 'ship-schematic-tool',
  title: 'ship-schematic-part-title',
  copy: 'ship-schematic-part-copy',
  return: 'ship-schematic-return',
  cards: 'ship-schematic-cards',
  inventory: 'ship-schematic-inventory',
  toggle: 'ship-schematic-toggle',
} as const;

export const SHIP_SCHEMATIC_LONG_PRESS_MS = 700;
export const BOOST_COUPLING_DEMO_DURATION_MS = 3200;

const BOOST_COUPLING_ATTACH_START_MS = 220;
const BOOST_COUPLING_TURN_START_MS = 300;
const BOOST_COUPLING_TURN_END_MS = 800;
const BOOST_COUPLING_IGNITE_END_MS = 1100;
const BOOST_COUPLING_BOOST_END_MS = 1850;
const BOOST_COUPLING_FLAME_FADE_START_MS = 2600;
const BOOST_COUPLING_BOOST_DISTANCE = 52;
const DEMO_ASTEROID_RADIUS_FACTORS = {
  asymmetric: [1, 0.72, 0.92, 0.66, 1.08, 0.8, 0.9],
  default: [1, 0.78, 1, 0.78, 1, 0.78, 1, 0.78, 1],
} as const;

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
  inventory: HTMLElement;
  inventoryStatus: HTMLElement;
  toggle: HTMLButtonElement;
};

type BoostCouplingDemoFrame = {
  phase: 'idle' | 'turning' | 'igniting' | 'boosting' | 'coasting';
  rockX: number;
  rockY: number;
  rockAngle: number;
  cableVisible: boolean;
  headingVisible: boolean;
  flameStrength: number;
};

let initialized = false;
let closeInProgress = false;
let frameRequest: number | null = null;
let openInputRelease: (() => void) | undefined;
let elements: SchematicElements | null = null;
let selectedUtility: HaulerUtilityId = preferredHaulerUtility();
let selectedSurveyorUtility: SurveyorUtilityId = preferredSurveyorUtility();

function decorateSchematicToggle(toggle: HTMLButtonElement): void {
  toggle.type = 'button';
  toggle.classList.add('ship-schematic-toggle');
  if (!toggle.querySelector('kbd')) {
    const shortcut = document.createElement('kbd');
    shortcut.textContent = 'V';
    toggle.replaceChildren('Schematic ', shortcut);
  }
}

function syncSchematicInputChrome(): void {
  if (!elements) {
    return;
  }
  const touch = shouldUseTouchControls();
  elements.toggle.classList.toggle('ship-schematic-touch', touch);
  elements.toggle.hidden = touch;
  if (touch) {
    elements.toggle.removeAttribute('aria-keyshortcuts');
    elements.toggle.setAttribute('aria-label', 'Open ship schematic');
    return;
  }
  elements.toggle.setAttribute('aria-keyshortcuts', 'V');
  elements.toggle.setAttribute('aria-label', 'Open ship schematic (V)');
}

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
      <canvas id="${SHIP_SCHEMATIC_IDS.canvas}" role="img" aria-label="Hauler equipment schematic"></canvas>
      <div id="${SHIP_SCHEMATIC_IDS.cards}" class="ship-schematic-cards"></div>
    </div>
    <section class="satellite-inventory" aria-labelledby="satellite-inventory-title">
      <h3 id="satellite-inventory-title">Inventory</h3>
      <p>${satelliteInventoryDescription()}</p>
      <div id="${SHIP_SCHEMATIC_IDS.inventory}"></div>
      <span id="satellite-inventory-status" class="satellite-inventory-status" role="status" aria-atomic="true"></span>
    </section>
    <footer class="ship-schematic-footer">
      <div class="ship-schematic-detail">
        <div>
          <h3 id="${SHIP_SCHEMATIC_IDS.title}"></h3>
          <p id="${SHIP_SCHEMATIC_IDS.copy}"></p>
        </div>
        ${HAULER_UTILITY_IDS.map(
          (id) => `
          <div class="ship-schematic-detail-reserve" aria-hidden="true">
            <h3>${HAULER_UTILITY[id].name}</h3>
            <p>${HAULER_UTILITY[id].copy}</p>
          </div>
        `
        ).join('')}
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
  let toggle = document.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.toggle}`);
  if (!toggle) {
    const gameArea = document.querySelector('#gameArea') ?? document.body;
    toggle = document.createElement('button');
    toggle.id = SHIP_SCHEMATIC_IDS.toggle;
    const mapToggle = gameArea.querySelector('#universe-map-toggle');
    if (mapToggle) {
      gameArea.insertBefore(toggle, mapToggle);
    } else {
      gameArea.appendChild(toggle);
    }
  }
  decorateSchematicToggle(toggle);
  const canvas = dialog.querySelector<HTMLCanvasElement>(`#${SHIP_SCHEMATIC_IDS.canvas}`);
  const tool = dialog.querySelector<HTMLCanvasElement>(`#${SHIP_SCHEMATIC_IDS.tool}`);
  const close = dialog.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.close}`);
  const title = dialog.querySelector<HTMLElement>(`#${SHIP_SCHEMATIC_IDS.title}`);
  const copy = dialog.querySelector<HTMLElement>(`#${SHIP_SCHEMATIC_IDS.copy}`);
  const ret = dialog.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.return}`);
  const cards = dialog.querySelector<HTMLElement>(`#${SHIP_SCHEMATIC_IDS.cards}`);
  const inventory = dialog.querySelector<HTMLElement>(`#${SHIP_SCHEMATIC_IDS.inventory}`);
  const inventoryStatus = dialog.querySelector<HTMLElement>('#satellite-inventory-status');
  if (
    !canvas ||
    !tool ||
    !close ||
    !title ||
    !copy ||
    !ret ||
    !cards ||
    !inventory ||
    !inventoryStatus
  ) {
    return null;
  }
  return {
    dialog,
    canvas,
    tool,
    close,
    title,
    copy,
    return: ret,
    cards,
    inventory,
    inventoryStatus,
    toggle,
  };
}

function canOpenForLocalShip(): boolean {
  if (!document.body.classList.contains('in-play')) {
    return false;
  }
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  return ship !== undefined && ship.health > 0 && !ship.exploding;
}

function mountCards(): void {
  if (!elements) {
    return;
  }
  const kitId: ShipKitId = PlayerManager.getInstance().getLocalPlayer()?.ship.kitId ?? 'hauler';
  const cards = elements.cards;
  cards.dataset['kitId'] = kitId;
  cards.replaceChildren();
  const appendCard = (id: string, name: string, hint: string, select: () => void): void => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ship-schematic-card';
    button.dataset['utilityId'] = id;
    button.innerHTML = `<span class="ship-schematic-card-name">${name}</span><span class="ship-schematic-card-hint">${hint}</span><span class="ship-schematic-badge">ACTIVE</span>`;
    button.addEventListener('click', select);
    cards.appendChild(button);
  };
  if (kitId === 'hauler') {
    for (const id of HAULER_UTILITY_IDS) {
      const part = HAULER_UTILITY[id];
      appendCard(id, part.name, part.hint, () => equipUtility(id));
    }
  } else {
    for (const id of SURVEYOR_UTILITY_IDS) {
      const part = SURVEYOR_UTILITY[id];
      appendCard(id, part.name, part.hint, () => equipSurveyorUtility(id));
    }
  }
}

function syncCards(): void {
  if (!elements) {
    return;
  }
  const kit = PlayerManager.getInstance().getLocalPlayer()?.ship.kitId ?? 'hauler';
  const hauler = kit === 'hauler';
  if (elements.cards.dataset['kitId'] !== kit) {
    mountCards();
  }
  elements.cards.hidden = false;
  elements.tool.hidden = false;
  const eyebrow = elements.dialog.querySelector('.ship-schematic-eyebrow');
  if (eyebrow) {
    eyebrow.textContent = hauler ? 'HAULER' : 'SURVEYOR';
  }
  elements.canvas.setAttribute(
    'aria-label',
    `${hauler ? 'Hauler' : 'Surveyor'} equipment schematic`
  );
  if (!hauler) {
    const part = SURVEYOR_UTILITY[selectedSurveyorUtility];
    elements.title.textContent = part.name;
    elements.copy.textContent = part.copy;
    for (const button of elements.cards.querySelectorAll<HTMLButtonElement>('[data-utility-id]')) {
      const active = button.dataset['utilityId'] === selectedSurveyorUtility;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
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
  if (PlayerManager.getInstance().getLocalPlayer()?.ship.kitId !== 'hauler') {
    return;
  }
  if (selectedUtility !== utilityId) {
    playFeedback('interface');
  }
  selectedUtility = utilityId;
  rememberHaulerUtility(utilityId);
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (player?.ship.kitId === 'hauler') {
    setHaulerUtilityOnHost(player.ship, utilityId);
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

function equipSurveyorUtility(utilityId: SurveyorUtilityId): void {
  if (PlayerManager.getInstance().getLocalPlayer()?.ship.kitId !== 'surveyor') {
    return;
  }
  if (selectedSurveyorUtility !== utilityId) {
    playFeedback('interface');
  }
  selectedSurveyorUtility = utilityId;
  rememberSurveyorUtility(utilityId);
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (player?.ship.kitId === 'surveyor') {
    setSurveyorUtilityOnHost(player.ship, utilityId);
  }
  if (player) {
    const network = NetworkManager.getInstance();
    if (network.isConnected) {
      network.sendMessage({
        type: 'setSurveyorUtility',
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

function drawSchematicHull(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const kit = PlayerManager.getInstance().getLocalPlayer()?.ship.kitId ?? 'hauler';
  const outline = getKitHullOutline(kit);
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
  // Hull panels stay assembled and neutral; only the interchangeable tool is highlighted.
  for (const extra of outline.extras) {
    strokePolyline(ctx, projectHullPolyline(cx, cy, radius, angle, extra), extra.closed);
  }
  if (kit !== 'hauler') {
    return;
  }
  ctx.strokeStyle = PALETTE.LOOT;
  ctx.shadowColor = PALETTE.LOOT;
  for (const part of getHaulerEquipment(selectedUtility)) {
    strokePolyline(ctx, projectHullPolyline(cx, cy, radius, angle, part), part.closed);
  }
  if (window.matchMedia('(max-width: 700px)').matches) {
    return;
  }
  // Every utility uses the same central mount.
  const mount = projectHullPoint(cx, cy, radius, angle, { f: 0.35, p: 0 });
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hexToRgba(PALETTE.LOOT, 0.65);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const slot = HAULER_UTILITY_IDS.indexOf(selectedUtility);
  ctx.moveTo((width * (slot + 0.5)) / HAULER_UTILITY_IDS.length, height);
  ctx.lineTo(mount.x, mount.y);
  ctx.stroke();
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function easeInOut(value: number): number {
  const t = clampUnit(value);
  return t * t * (3 - 2 * t);
}

function intervalProgress(elapsed: number, start: number, end: number): number {
  return clampUnit((elapsed - start) / (end - start));
}

export function getBoostCouplingDemoFrame(
  now: number,
  width: number,
  height: number
): BoostCouplingDemoFrame {
  const elapsed =
    ((now % BOOST_COUPLING_DEMO_DURATION_MS) + BOOST_COUPLING_DEMO_DURATION_MS) %
    BOOST_COUPLING_DEMO_DURATION_MS;
  const baseX = width * 0.64;
  const baseY = height * 0.5;
  const boostDistance = Math.min(BOOST_COUPLING_BOOST_DISTANCE, Math.max(24, width * 0.24));
  const attached = elapsed >= BOOST_COUPLING_ATTACH_START_MS;
  const turning = elapsed >= BOOST_COUPLING_TURN_START_MS && elapsed < BOOST_COUPLING_TURN_END_MS;
  const igniting = elapsed >= BOOST_COUPLING_TURN_END_MS && elapsed < BOOST_COUPLING_IGNITE_END_MS;
  const boosting = elapsed >= BOOST_COUPLING_IGNITE_END_MS && elapsed < BOOST_COUPLING_BOOST_END_MS;
  const movement = boosting
    ? easeInOut(
        intervalProgress(elapsed, BOOST_COUPLING_IGNITE_END_MS, BOOST_COUPLING_BOOST_END_MS)
      ) * boostDistance
    : elapsed >= BOOST_COUPLING_BOOST_END_MS
      ? boostDistance
      : 0;
  const fade = intervalProgress(
    elapsed,
    BOOST_COUPLING_FLAME_FADE_START_MS,
    BOOST_COUPLING_DEMO_DURATION_MS
  );
  return {
    phase: boosting
      ? 'boosting'
      : igniting
        ? 'igniting'
        : turning
          ? 'turning'
          : elapsed >= BOOST_COUPLING_BOOST_END_MS
            ? 'coasting'
            : 'idle',
    rockX: baseX + movement,
    rockY: baseY,
    rockAngle:
      turning || igniting
        ? easeInOut(
            intervalProgress(elapsed, BOOST_COUPLING_TURN_START_MS, BOOST_COUPLING_TURN_END_MS)
          ) *
          (Math.PI / 2)
        : elapsed >= BOOST_COUPLING_TURN_END_MS
          ? Math.PI / 2
          : 0,
    cableVisible: attached && elapsed < BOOST_COUPLING_TURN_END_MS,
    headingVisible: attached && elapsed < BOOST_COUPLING_TURN_END_MS,
    flameStrength: igniting
      ? intervalProgress(elapsed, BOOST_COUPLING_TURN_END_MS, BOOST_COUPLING_IGNITE_END_MS)
      : boosting
        ? 0.85 + Math.sin(now / 55) * 0.1
        : elapsed >= BOOST_COUPLING_BOOST_END_MS
          ? 0.6 * (1 - fade)
          : 0,
  };
}

function drawDemoAsteroid(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  angle: number,
  asymmetric = false
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  const radii = asymmetric
    ? DEMO_ASTEROID_RADIUS_FACTORS.asymmetric
    : DEMO_ASTEROID_RADIUS_FACTORS.default;
  for (let i = 0; i < radii.length; i++) {
    const vertexAngle = (i / (radii.length - 1)) * Math.PI * 2;
    const vertexRadius = radius * (radii[i] ?? 1);
    const vertexX = Math.cos(vertexAngle) * vertexRadius;
    const vertexY = Math.sin(vertexAngle) * vertexRadius;
    if (i === 0) {
      ctx.moveTo(vertexX, vertexY);
    } else {
      ctx.lineTo(vertexX, vertexY);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawBoostHeading(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x + 18, y);
  ctx.lineTo(x + 34, y);
  ctx.lineTo(x + 28, y - 4);
  ctx.moveTo(x + 34, y);
  ctx.lineTo(x + 28, y + 4);
  ctx.stroke();
}

function drawBoostFlame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  strength: number,
  now: number
): void {
  if (strength <= 0) {
    return;
  }
  const flicker = 0.9 + Math.sin(now / 45) * 0.1;
  const length = 11 + strength * 18 * flicker;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.LASER_LOCAL;
  ctx.shadowColor = PALETTE.LASER_LOCAL;
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  ctx.beginPath();
  ctx.moveTo(x - 12, y - 5);
  ctx.lineTo(x - 12 - length, y);
  ctx.lineTo(x - 12, y + 5);
  ctx.stroke();
  ctx.strokeStyle = PALETTE.LOOT;
  ctx.shadowColor = PALETTE.LOOT;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(x - 13, y - 2.5);
  ctx.lineTo(x - 13 - length * 0.55, y);
  ctx.lineTo(x - 13, y + 2.5);
  ctx.stroke();
  ctx.restore();
}

function drawToolLoop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  now: number
): void {
  ctx.clearRect(0, 0, width, height);
  const kit = PlayerManager.getInstance().getLocalPlayer()?.ship.kitId ?? 'hauler';
  if (kit === 'surveyor') {
    const shipX = width * 0.2;
    const midY = height * 0.5;
    const radius = 18;
    const elapsed = now % 2600;
    const launching = elapsed < 520;
    const rockX = width * 0.76 + Math.sin(now / 520) * 5;
    const rockY = midY + Math.sin(now / 680) * 4;
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = PALETTE.LOCAL;
    ctx.shadowColor = PALETTE.LOCAL;
    ctx.shadowBlur = VISUAL.SHIP_GLOW;
    strokeKitHullOutline(ctx, shipX, midY, radius, 0, PALETTE.LOCAL, 'surveyor');
    ctx.shadowBlur = 0;
    ctx.strokeStyle = PALETTE.HUD_MUTED;
    drawDemoAsteroid(ctx, rockX, rockY, 13, now / 900);
    if (selectedSurveyorUtility === 'mineral_scan') {
      ctx.strokeStyle = PALETTE.LOOT;
      ctx.globalAlpha = 0.35 + pulse * 0.45;
      for (const ring of [14, 23, 32]) {
        ctx.beginPath();
        ctx.arc(shipX + 34, midY, ring + pulse * 3, -0.72, 0.72);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else {
      const probeX = rockX;
      const probeY = rockY - 15;
      ctx.strokeStyle = PALETTE.LOOT;
      if (launching) {
        ctx.globalAlpha = 1 - elapsed / 520;
        ctx.beginPath();
        ctx.moveTo(shipX + radius, midY);
        ctx.lineTo(probeX, probeY);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.moveTo(probeX, probeY - 7);
      ctx.lineTo(probeX + 7, probeY);
      ctx.lineTo(probeX, probeY + 7);
      ctx.lineTo(probeX - 7, probeY);
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 0.28 + pulse * 0.42;
      ctx.beginPath();
      ctx.arc(probeX, probeY, 16 + pulse * 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    return;
  }
  const shipX = width * 0.22;
  const elapsed = now % 2600;
  const boostFrame =
    selectedUtility === 'boost_coupling'
      ? getBoostCouplingDemoFrame(now, width, height)
      : undefined;
  const attached = elapsed >= 250 && elapsed < 1850;
  const midY = height * 0.5;
  const radius = 19;
  const haul = selectedUtility === 'tow_cable' && attached ? ((elapsed - 250) / 1600) * 12 : 0;
  const kick = attached ? latchShudderOffset(elapsed - 250) : 0;
  const rockX = boostFrame?.rockX ?? width * 0.78 - haul + kick;
  const rockY = boostFrame?.rockY ?? midY + kick * 0.35;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.LOCAL;
  ctx.shadowColor = PALETTE.LOCAL;
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  strokeKitHullOutline(ctx, shipX, midY, radius, 0, PALETTE.LOCAL, 'hauler', selectedUtility);
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  ctx.shadowBlur = 0;
  drawDemoAsteroid(ctx, rockX, rockY, 14, boostFrame?.rockAngle ?? 0, boostFrame !== undefined);
  if (selectedUtility === 'boost_coupling' && boostFrame?.cableVisible) {
    ctx.strokeStyle = PALETTE.LOOT;
    ctx.beginPath();
    ctx.moveTo(shipX + radius * 0.72, midY);
    ctx.lineTo(rockX - 14, rockY);
    ctx.stroke();
  } else if (attached && selectedUtility !== 'boost_coupling') {
    ctx.strokeStyle = PALETTE.LOOT;
    ctx.beginPath();
    ctx.moveTo(shipX + radius * 0.72, midY);
    ctx.lineTo(rockX - 14, rockY);
    ctx.stroke();
  }
  if (selectedUtility === 'boost_coupling') {
    ctx.strokeStyle = PALETTE.LOOT;
    if (boostFrame?.headingVisible) {
      drawBoostHeading(ctx, rockX, rockY);
    }
    drawBoostFlame(ctx, rockX, rockY, boostFrame?.flameStrength ?? 0, now);
  } else if (selectedUtility === 'resource_tap') {
    const extractMs = (SHIP_ABILITY.TAP_EXTRACT_FRAMES / 60) * 1000;
    for (let i = 0; i < SHIP_ABILITY.TAP_EXTRACT_BURSTS; i++) {
      const age = elapsed - 250 - ((i + 1) * extractMs) / SHIP_ABILITY.TAP_EXTRACT_BURSTS;
      if (age < 0 || age > 700) {
        continue;
      }
      const angle = -0.9 + i * 0.6;
      const travel = 13 + age * 0.045;
      const x = rockX + Math.cos(angle) * travel;
      const y = midY + Math.sin(angle) * travel;
      ctx.globalAlpha = 1 - age / 700;
      ctx.strokeStyle = PALETTE.LOOT;
      ctx.beginPath();
      traceTapCanister(ctx, x, y, 5);
      ctx.stroke();
      ctx.strokeStyle = PALETTE.LASER_LOCAL;
      ctx.beginPath();
      ctx.moveTo(x - 1, y - 3.9);
      ctx.lineTo(x + 1, y - 3.9);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function renderOverlay(): void {
  if (!elements || !isShipSchematicOpen()) {
    return;
  }
  renderSatelliteInventory(elements.inventory, elements.inventoryStatus, elements.return);
  resizeCanvas(elements.canvas, 640, 360);
  resizeCanvas(elements.tool, 220, 80);
  const hull = elements.canvas.getContext('2d');
  const tool = elements.tool.getContext('2d');
  if (hull) {
    hull.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    hull.scale(dpr, dpr);
    drawSchematicHull(hull, elements.canvas.width / dpr, elements.canvas.height / dpr);
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

export function isPointerOnLocalShip(clientX: number, clientY: number): boolean {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
  if (!player || !canvas || player.lives <= 0) {
    return false;
  }
  const rect = canvas.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const scale = rect.width / Math.max(1, canvas.width);
  return Math.hypot(dx, dy) <= player.ship.r * scale + 20;
}

export function openShipSchematic(): boolean {
  if (!elements || isShipSchematicOpen() || !canOpenForLocalShip()) {
    return false;
  }
  requestTownStoreClose();
  if (isUniverseMapOpen()) {
    setShipSchematicOpen(true);
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
    if (isShipSchematicOpen()) {
      setShipSchematicOpen(false);
    }
    return false;
  }
  setShipSchematicOpen(true);
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  if (ship?.kitId === 'hauler') {
    selectedUtility = haulerUtilityOf(ship);
  } else if (ship?.kitId === 'surveyor') {
    selectedSurveyorUtility = surveyorUtilityOf(ship);
  } else {
    selectedUtility = preferredHaulerUtility();
    selectedSurveyorUtility = preferredSurveyorUtility();
  }
  mountCards();
  syncCards();
  renderSatelliteInventory(elements.inventory, elements.inventoryStatus, elements.return);
  openInputRelease?.();
  window.dispatchEvent(new CustomEvent('gameSchematicOpen'));
  playFeedback('interface');
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
  playFeedback('interface');
}

function handleDialogClosed(): void {
  if (closeInProgress || !isShipSchematicOpen()) {
    return;
  }
  setShipSchematicOpen(false);
  stopRenderLoop();
  window.dispatchEvent(new CustomEvent('gameSchematicClose'));
  playFeedback('interface');
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
  if (ev.code === 'Space' && ev.target instanceof HTMLButtonElement) {
    ev.stopPropagation();
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
  syncSchematicInputChrome();
  elements.toggle.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openShipSchematic();
  });
  elements.close.addEventListener('click', () => {
    closeShipSchematic();
  });
  elements.return.addEventListener('click', () => {
    closeShipSchematic();
  });
  const hullCanvas = elements.canvas;
  hullCanvas.addEventListener('click', (ev) => {
    const rect = hullCanvas.getBoundingClientRect();
    const left = ev.clientX < rect.left + rect.width / 2;
    if (PlayerManager.getInstance().getLocalPlayer()?.ship.kitId === 'surveyor') {
      const index = Math.min(
        SURVEYOR_UTILITY_IDS.length - 1,
        Math.max(
          0,
          Math.floor(((ev.clientX - rect.left) / rect.width) * SURVEYOR_UTILITY_IDS.length)
        )
      );
      equipSurveyorUtility(SURVEYOR_UTILITY_IDS[index] ?? 'mineral_scan');
    } else {
      equipUtility(left ? 'tow_cable' : 'resource_tap');
    }
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
  window.addEventListener('resize', syncSchematicInputChrome);
  window.addEventListener('playViewOn', syncSchematicInputChrome);
  window.addEventListener('playViewOff', () => {
    closeShipSchematic();
  });
}
