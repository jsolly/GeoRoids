import {
  insideTownStore,
  purchasedHullColor,
  SHIP_PAINTS,
  TOWN_YIELD_PER_MODULE,
  townDeliveryBonusPercent,
} from '../../shared/townStore';
import { playFeedback } from '../audio/feedbackSounds';
import { PlayerManager } from '../entities/player/PlayerManager';
import { NetworkManager } from '../network/networkManager';
import { worldFurnaces } from '../network/worldExploration';
import { logger } from '../utils/Logger';
import { closeShipSchematic } from './shipSchematic';
import { isShipSchematicOpen } from './shipSchematicState';
import { bindTownStoreClose, isTownStoreOpen, setTownStoreOpen } from './townStoreState';
import { closeUniverseMap, isUniverseMapOpen } from './universeMap';

export const TOWN_STORE_IDS = {
  dialog: 'town-store-dialog',
  close: 'town-store-close',
  yield: 'town-store-yield',
  score: 'town-store-score',
  paints: 'town-store-paints',
  status: 'town-store-status',
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
  yieldLine: HTMLElement;
  score: HTMLElement;
  paints: HTMLElement;
  status: HTMLElement;
  return: HTMLButtonElement;
};

let initialized = false;
let closeInProgress = false;
let elements: StoreElements | null = null;
let openInputRelease: (() => void) | undefined;
let paintSignature = '';

/** Alive local pilot inside the Town Square shopping radius during flight. */
export function canEnterTownStore(): boolean {
  if (typeof document === 'undefined' || !document.body.classList.contains('in-play')) {
    return false;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || player.lives <= 0 || player.ship.exploding || player.ship.health <= 0) {
    return false;
  }
  return insideTownStore(player.ship.position);
}

function streetsBuiltByLocal() {
  const id = PlayerManager.getInstance().getLocalPlayer()?.id;
  if (!id) {
    return 0;
  }
  return worldFurnaces.modulesBuiltBy(id);
}

function paintRows(): void {
  if (!elements) {
    return;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  const worn = player?.ship.color;
  elements.paints.replaceChildren(
    ...SHIP_PAINTS.map((paint) => {
      const row = document.createElement('div');
      row.className = 'town-store-row';
      const swatch = document.createElement('span');
      swatch.className = 'town-store-swatch';
      swatch.style.background = paint.color;
      swatch.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'town-store-copy';
      const name = document.createElement('strong');
      name.textContent = paint.name;
      const price = document.createElement('small');
      price.textContent = `${paint.cost.toLocaleString('en-US')} score`;
      copy.append(name, price);
      const buy = document.createElement('button');
      buy.type = 'button';
      buy.dataset['paintId'] = paint.id;
      const already = worn === paint.color;
      buy.textContent = already ? 'Worn' : 'Buy';
      buy.disabled = already;
      buy.addEventListener('click', () => {
        purchasePaint(paint.id);
      });
      row.append(swatch, copy, buy);
      return row;
    })
  );
}

function refreshStoreCopy(): void {
  if (!elements) {
    return;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  const built = streetsBuiltByLocal();
  const bonus = townDeliveryBonusPercent(built);
  const perStreet = Math.round(TOWN_YIELD_PER_MODULE * 100);
  elements.yieldLine.textContent =
    built === 0
      ? `Each street you build adds ${perStreet}% to your own furnace deliveries.`
      : `You built ${built} ${built === 1 ? 'street' : 'streets'}. Your deliveries pay ${bonus}% more.`;
  elements.score.textContent = `Score ${Math.max(0, Math.floor(player?.score ?? 0)).toLocaleString('en-US')}`;
  const signature = `${player?.ship.color ?? ''}:${built}:${player?.score ?? 0}`;
  if (signature !== paintSignature) {
    paintSignature = signature;
    paintRows();
  }
}

function createDialogMarkup(dialog: HTMLDialogElement): void {
  if (dialog.querySelector(`#${TOWN_STORE_IDS.paints}`)) {
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
    <div id="${TOWN_STORE_IDS.paints}"></div>
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
  const paints = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.paints}`);
  const status = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.status}`);
  const returnButton = dialog.querySelector<HTMLButtonElement>(`#${TOWN_STORE_IDS.return}`);
  if (!close || !yieldLine || !score || !paints || !status || !returnButton) {
    return null;
  }
  return { dialog, close, yieldLine, score, paints, status, return: returnButton };
}

function purchasePaint(paintId: string): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || !isTownStoreOpen()) {
    return;
  }
  NetworkManager.getInstance().sendMessage({
    type: 'buyShipPaint',
    id: player.id,
    data: { paintId },
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
  if ('color' in data && typeof data.color === 'string' && purchasedHullColor(data.color)) {
    player.color = data.color;
    player.ship.color = data.color;
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
