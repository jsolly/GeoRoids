import { TOWN_HEARTH } from '../../shared/furnaces';
import { litTravelDestinations, nearestTravelFurnace } from '../../shared/furnaceTravel';
import {
  EXTRA_LIFE_COST,
  insideTownStore,
  MAX_LIVES,
  TOWN_YIELD_PER_MODULE,
  townDeliveryBonusPercent,
} from '../../shared/townStore';
import { playFeedback } from '../audio/feedbackSounds';
import { PlayerManager } from '../entities/player/PlayerManager';
import { NetworkManager } from '../network/networkManager';
import { worldFurnaces } from '../network/worldExploration';
import { logger } from '../utils/Logger';
import { renderFurnaceTravelMap } from './furnaceTravelMap';
import { closeShipSchematic } from './shipSchematic';
import { isShipSchematicOpen } from './shipSchematicState';
import { bindTownStoreClose, isTownStoreOpen, setTownStoreOpen } from './townStoreState';
import { closeUniverseMap, isUniverseMapOpen } from './universeMap';

export const TOWN_STORE_IDS = {
  dialog: 'town-store-dialog',
  close: 'town-store-close',
  yield: 'town-store-yield',
  score: 'town-store-score',
  offer: 'town-store-offer',
  price: 'town-store-life-price',
  status: 'town-store-status',
  return: 'town-store-return',
  destinations: 'town-store-destinations',
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

type StoreElements = {
  dialog: HTMLDialogElement;
  close: HTMLButtonElement;
  yieldLine: HTMLElement;
  score: HTMLElement;
  offer: HTMLElement;
  destinations: HTMLElement;
  status: HTMLElement;
  return: HTMLButtonElement;
};

let initialized = false;
let closeInProgress = false;
let elements: StoreElements | null = null;
let openInputRelease: (() => void) | undefined;

/** Alive local pilot inside the Town Square shopping radius during flight. */
export function canEnterTownStore(): boolean {
  if (typeof document === 'undefined' || !document.body.classList.contains('in-play')) {
    return false;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || player.lives <= 0 || player.ship.exploding || player.ship.health <= 0) {
    return false;
  }
  if (player.ship.furnaceTransit) {
    return false;
  }
  return nearestTravelFurnace(player.ship.position, worldFurnaces) !== undefined;
}

function streetsBuiltByLocal() {
  const id = PlayerManager.getInstance().getLocalPlayer()?.id;
  if (!id) {
    return 0;
  }
  return worldFurnaces.modulesBuiltBy(id);
}

function setTextIfChanged(node: HTMLElement, text: string): void {
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

function lifeButton(): HTMLButtonElement | null {
  if (!elements) {
    return null;
  }
  const existing = elements.offer.querySelector<HTMLButtonElement>(
    'button[data-offer="extra-life"]'
  );
  if (existing) {
    return existing;
  }
  const row = document.createElement('div');
  row.className = 'town-store-row';
  const copy = document.createElement('span');
  copy.className = 'town-store-copy';
  const name = document.createElement('strong');
  name.textContent = 'Extra life';
  const price = document.createElement('small');
  price.id = TOWN_STORE_IDS.price;
  price.textContent = `${EXTRA_LIFE_COST.toLocaleString('en-US')} score`;
  copy.append(name, price);
  const buy = document.createElement('button');
  buy.type = 'button';
  buy.dataset['offer'] = 'extra-life';
  buy.setAttribute('aria-describedby', TOWN_STORE_IDS.price);
  buy.addEventListener('click', () => {
    purchaseExtraLife();
  });
  row.append(copy, buy);
  elements.offer.replaceChildren(row);
  return buy;
}

function requestFurnaceTravel(destinationId: string): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || !canEnterTownStore()) {
    return;
  }
  NetworkManager.getInstance().sendMessage({
    type: 'travelFurnace',
    id: player.id,
    data: { destinationId },
  });
  if (elements) {
    elements.status.textContent = 'Preparing rocket…';
  }
}

function refreshStoreCopy(): void {
  if (!elements) {
    return;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  const source = player ? nearestTravelFurnace(player.ship.position, worldFurnaces) : undefined;
  const town = source?.id === TOWN_HEARTH.id;
  elements.offer.hidden = !town;
  const heading = elements.dialog.querySelector('#town-store-title');
  const eyebrow = elements.dialog.querySelector('.town-store-eyebrow');
  if (heading) {
    heading.textContent = 'Furnace travel';
  }
  if (eyebrow) {
    eyebrow.textContent = source?.name ?? 'FURNACE';
  }
  const destinations = source ? litTravelDestinations(source.id, worldFurnaces) : [];
  const signature = `${source?.id ?? ''}|${destinations
    .map((destination) => `${destination.id}:${destination.name}`)
    .join('|')}`;
  if (elements.destinations.dataset['destinations'] !== signature) {
    elements.destinations.dataset['destinations'] = signature;
    if (source) {
      renderFurnaceTravelMap(elements.destinations, source, destinations, requestFurnaceTravel);
    } else {
      elements.destinations.replaceChildren();
    }
  }
  const built = streetsBuiltByLocal();
  const bonus = townDeliveryBonusPercent(built);
  const perStreet = Math.round(TOWN_YIELD_PER_MODULE * 100);
  setTextIfChanged(
    elements.yieldLine,
    built === 0
      ? `Each street you build adds ${perStreet}% to your own furnace deliveries.`
      : `You built ${built} ${built === 1 ? 'street' : 'streets'}. Your deliveries pay ${bonus}% more.`
  );
  setTextIfChanged(
    elements.score,
    `Score ${Math.max(0, Math.floor(player?.score ?? 0)).toLocaleString('en-US')}`
  );
  const buy = lifeButton();
  if (!buy) {
    return;
  }
  const full = (player?.lives ?? 0) >= MAX_LIVES;
  const label = full ? 'Extra life, lives full' : 'Buy extra life';
  const wasFocused = document.activeElement === buy;
  setTextIfChanged(buy, label);
  if (buy.disabled !== full) {
    buy.disabled = full;
  }
  if (wasFocused && buy.disabled) {
    elements.return.focus({ preventScroll: true });
  }
}

function createDialogMarkup(dialog: HTMLDialogElement): void {
  if (dialog.querySelector(`#${TOWN_STORE_IDS.offer}`)) {
    return;
  }
  dialog.classList.add('town-store-dialog');
  dialog.setAttribute('aria-labelledby', 'town-store-title');
  dialog.innerHTML = `
    <header class="town-store-header">
      <div>
        <p class="town-store-eyebrow">TOWN SQUARE</p>
        <h2 id="town-store-title">Store</h2>
      </div>
      <button id="${TOWN_STORE_IDS.close}" type="button" aria-label="Close store">×</button>
    </header>
    <p id="${TOWN_STORE_IDS.yield}"></p>
    <p id="${TOWN_STORE_IDS.score}"></p>
    <div id="${TOWN_STORE_IDS.offer}"></div>
    <h3>Destination map</h3>
    <p>Ride a rocket along the pipes to any lit furnace. Travel is free.</p>
    <div id="${TOWN_STORE_IDS.destinations}" class="furnace-destinations"></div>
    <p id="${TOWN_STORE_IDS.status}" role="status" aria-live="polite"></p>
    <button id="${TOWN_STORE_IDS.return}" type="button">Return to flight</button>
  `;
}

function ensureElements(): StoreElements | null {
  if (typeof document === 'undefined') {
    return null;
  }
  let dialog = document.querySelector<HTMLDialogElement>(`#${TOWN_STORE_IDS.dialog}`);
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = TOWN_STORE_IDS.dialog;
    document.body.appendChild(dialog);
  }
  createDialogMarkup(dialog);
  const close = dialog.querySelector<HTMLButtonElement>(`#${TOWN_STORE_IDS.close}`);
  const yieldLine = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.yield}`);
  const score = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.score}`);
  const offer = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.offer}`);
  const destinations = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.destinations}`);
  const status = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.status}`);
  const returnButton = dialog.querySelector<HTMLButtonElement>(`#${TOWN_STORE_IDS.return}`);
  if (!close || !yieldLine || !score || !offer || !destinations || !status || !returnButton) {
    return null;
  }
  return { dialog, close, yieldLine, score, offer, destinations, status, return: returnButton };
}

function purchaseExtraLife(): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || !isTownStoreOpen() || !insideTownStore(player.ship.position)) {
    return;
  }
  NetworkManager.getInstance().sendMessage({
    type: 'buyExtraLife',
    id: player.id,
    data: {},
  });
}

export function applyTownStoreResult(data: unknown): void {
  const message =
    typeof data === 'string'
      ? data
      : data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message
        : '';
  if (elements) {
    elements.status.textContent = message;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || !data || typeof data !== 'object') {
    refreshStoreCopy();
    return;
  }
  if ('score' in data && typeof data.score === 'number' && Number.isFinite(data.score)) {
    player.score = data.score;
  }
  if ('lives' in data && typeof data.lives === 'number' && Number.isInteger(data.lives)) {
    player.lives = data.lives;
  }
  refreshStoreCopy();
}

export function syncTownStoreChrome(): void {
  if (isTownStoreOpen()) {
    refreshStoreCopy();
  }
}

export function openTownStore(): boolean {
  if (!elements || isTownStoreOpen() || !canEnterTownStore()) {
    return false;
  }
  if (isUniverseMapOpen()) {
    closeUniverseMap();
  }
  closeShipSchematic();
  try {
    elements.dialog.showModal();
  } catch (error) {
    logger.error(
      'UI',
      'Could not open the town store',
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  }
  setTownStoreOpen(true);
  elements.status.textContent = '';
  refreshStoreCopy();
  openInputRelease?.();
  window.dispatchEvent(new CustomEvent('gameStoreOpen'));
  playFeedback('interface');
  elements.close.focus({ preventScroll: true });
  return true;
}

export function closeTownStore(): void {
  if (!elements || !isTownStoreOpen() || closeInProgress) {
    return;
  }
  closeInProgress = true;
  setTownStoreOpen(false);
  elements.dialog.close();
  closeInProgress = false;
  window.dispatchEvent(new CustomEvent('gameStoreClose'));
  playFeedback('interface');
}

function handleDialogClosed(): void {
  if (closeInProgress || !isTownStoreOpen()) {
    return;
  }
  setTownStoreOpen(false);
  window.dispatchEvent(new CustomEvent('gameStoreClose'));
  playFeedback('interface');
}

function handleStoreKeydown(ev: KeyboardEvent): void {
  if (ev.code === 'KeyE' && !isTownStoreOpen()) {
    if (!ev.repeat && !isShipSchematicOpen() && canEnterTownStore()) {
      const target = ev.target;
      if (
        !(target instanceof HTMLElement) ||
        (!target.isContentEditable && !target.matches('input, textarea, select'))
      ) {
        ev.preventDefault();
        ev.stopPropagation();
        openTownStore();
      }
    }
    return;
  }
  if (ev.code === 'KeyB') {
    const target = ev.target;
    if (
      !isTownStoreOpen() &&
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
    if (isTownStoreOpen()) {
      closeTownStore();
    } else {
      openTownStore();
    }
    return;
  }
  if (!isTownStoreOpen()) {
    return;
  }
  if (ev.code === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closeTownStore();
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

if (typeof window !== 'undefined') {
  window.addEventListener('furnaceTravelResult', (ev: Event) => {
    const data: unknown = (ev as CustomEvent<unknown>).detail;
    if (data && typeof data === 'object' && 'ok' in data && data.ok === true) {
      closeTownStore();
    } else {
      applyTownStoreResult(data);
    }
  });
  window.addEventListener('townStoreResult', (ev: Event) => {
    applyTownStoreResult((ev as CustomEvent<unknown>).detail);
  });
}

export function initializeTownStore(options?: { onOpen?: () => void }): void {
  if (initialized || typeof document === 'undefined') {
    return;
  }
  elements = ensureElements();
  if (!elements) {
    return;
  }
  openInputRelease = options?.onOpen;
  initialized = true;
  bindTownStoreClose(closeTownStore);
  elements.close.addEventListener('click', () => {
    closeTownStore();
  });
  elements.return.addEventListener('click', () => {
    closeTownStore();
    // Return to flight restores gameplay focus; native Space must not reopen the HUD button.
    const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
    if (canvas) {
      canvas.tabIndex = -1;
      canvas.focus({ preventScroll: true });
    }
  });
  elements.dialog.addEventListener('close', handleDialogClosed);
  elements.dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    closeTownStore();
  });
  document.addEventListener('keydown', handleStoreKeydown, true);
  window.addEventListener('playViewOff', () => {
    closeTownStore();
  });
}
