import { EXTRA_LIFE_COST, insideTownStore, MAX_LIVES } from '../../shared/townStore';
import { playFeedback } from '../audio/feedbackSounds';
import { PlayerManager } from '../entities/player/PlayerManager';
import { NetworkManager } from '../network/networkManager';
import { logger } from '../utils/Logger';
import { closeShipSchematic } from './shipSchematic';
import { bindTownStoreClose, isTownStoreOpen, setTownStoreOpen } from './townStoreState';
import { closeUniverseMap, isUniverseMapOpen } from './universeMap';
import { shouldUseTouchControls } from './viewportChrome';

export const TOWN_STORE_IDS = {
  dialog: 'town-store-dialog',
  close: 'town-store-close',
  score: 'town-store-score',
  offer: 'town-store-offer',
  price: 'town-store-life-price',
  status: 'town-store-status',
  toggle: 'town-store-toggle',
  return: 'town-store-return',
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
  score: HTMLElement;
  offer: HTMLElement;
  status: HTMLElement;
  toggle: HTMLButtonElement;
  return: HTMLButtonElement;
};

let initialized = false;
let closeInProgress = false;
let elements: StoreElements | null = null;
let openInputRelease: (() => void) | undefined;

function townStoreAvailable(): boolean {
  if (typeof document === 'undefined' || !document.body.classList.contains('in-play')) {
    return false;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || player.lives <= 0 || player.ship.exploding || player.ship.health <= 0) {
    return false;
  }
  return insideTownStore(player.ship.position);
}

function syncToggleChrome(): void {
  if (!elements) {
    return;
  }
  const touch = shouldUseTouchControls();
  elements.toggle.classList.toggle('town-store-touch', touch);
  const available = townStoreAvailable();
  elements.toggle.hidden = !available;
  elements.toggle.setAttribute('aria-hidden', available ? 'false' : 'true');
  if (touch) {
    elements.toggle.removeAttribute('aria-keyshortcuts');
    elements.toggle.setAttribute('aria-label', 'Open town store');
    return;
  }
  elements.toggle.setAttribute('aria-keyshortcuts', 'B');
  elements.toggle.setAttribute('aria-label', 'Open town store (B)');
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

function refreshStoreCopy(): void {
  if (!elements) {
    return;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  elements.score.textContent = `Score ${Math.max(0, Math.floor(player?.score ?? 0)).toLocaleString('en-US')}`;
  const buy = lifeButton();
  if (!buy) {
    return;
  }
  const full = (player?.lives ?? 0) >= MAX_LIVES;
  const wasFocused = document.activeElement === buy;
  buy.textContent = full ? 'Extra life, lives full' : 'Buy extra life';
  buy.disabled = full;
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
    <p id="${TOWN_STORE_IDS.score}"></p>
    <div id="${TOWN_STORE_IDS.offer}"></div>
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
  let toggle = document.querySelector<HTMLButtonElement>(`#${TOWN_STORE_IDS.toggle}`);
  if (!toggle) {
    const gameArea = document.querySelector('#gameArea') ?? document.body;
    toggle = document.createElement('button');
    toggle.id = TOWN_STORE_IDS.toggle;
    toggle.type = 'button';
    toggle.className = 'town-store-toggle';
    toggle.innerHTML = 'Store <kbd>B</kbd>';
    const schematic = gameArea.querySelector('#ship-schematic-toggle');
    if (schematic) {
      gameArea.insertBefore(toggle, schematic);
    } else {
      gameArea.appendChild(toggle);
    }
  }
  const close = dialog.querySelector<HTMLButtonElement>(`#${TOWN_STORE_IDS.close}`);
  const score = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.score}`);
  const offer = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.offer}`);
  const status = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.status}`);
  const returnButton = dialog.querySelector<HTMLButtonElement>(`#${TOWN_STORE_IDS.return}`);
  if (!close || !score || !offer || !status || !returnButton) {
    return null;
  }
  return { dialog, close, score, offer, status, toggle, return: returnButton };
}

function purchaseExtraLife(): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || !isTownStoreOpen()) {
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
  syncToggleChrome();
  if (isTownStoreOpen()) {
    refreshStoreCopy();
  }
}

export function openTownStore(): boolean {
  if (!elements || isTownStoreOpen() || !townStoreAvailable()) {
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
  syncToggleChrome();
  elements.toggle.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (isTownStoreOpen()) {
      closeTownStore();
      return;
    }
    openTownStore();
  });
  elements.close.addEventListener('click', () => {
    closeTownStore();
  });
  elements.return.addEventListener('click', () => {
    closeTownStore();
  });
  elements.dialog.addEventListener('close', handleDialogClosed);
  elements.dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    closeTownStore();
  });
  document.addEventListener('keydown', handleStoreKeydown, true);
  window.addEventListener('resize', syncToggleChrome);
  window.addEventListener('playViewOn', syncToggleChrome);
  window.addEventListener('playViewOff', () => {
    closeTownStore();
    syncToggleChrome();
  });
  window.addEventListener('gameStoreClose', syncToggleChrome);
}
