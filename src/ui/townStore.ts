import { TOWN_HEARTH } from '../../shared/furnaces';
import { litTravelDestinations, nearestTravelFurnace } from '../../shared/furnaceTravel';
import { insideTownStore, STORE_OFFERS } from '../../shared/townStore';
import { playFeedback } from '../audio/feedbackSounds';
import { PlayerManager } from '../entities/player/PlayerManager';
import { NetworkManager } from '../network/networkManager';
import { getSettlement, worldFurnaces } from '../network/worldExploration';
import { logger } from '../utils/Logger';
import { renderFurnaceTravelMap } from './furnaceTravelMap';
import { closeShipSchematic } from './shipSchematic';
import { isShipSchematicOpen } from './shipSchematicState';
import { bindTownStoreClose, isTownStoreOpen, setTownStoreOpen } from './townStoreState';
import { closeUniverseMap, isUniverseMapOpen } from './universeMap';

export const TOWN_STORE_IDS = {
  dialog: 'town-store-dialog',
  close: 'town-store-close',
  score: 'town-store-score',
  offer: 'town-store-offer',
  status: 'town-store-status',
  return: 'town-store-return',
  destinations: 'town-store-destinations',
  choices: 'town-store-choices',
  travel: 'town-store-travel',
  back: 'town-store-back',
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
  destinations: HTMLElement;
  choices: HTMLElement;
  travel: HTMLElement;
  back: HTMLButtonElement;
  status: HTMLElement;
  return: HTMLButtonElement;
};

type TownView = 'entry' | 'store' | 'travel';
let view: TownView = 'entry';
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
  if (!player || player.ship.exploding || player.ship.health <= 0) {
    return false;
  }
  if (player.ship.furnaceTransit) {
    return false;
  }
  return nearestTravelFurnace(player.ship.position, worldFurnaces) !== undefined;
}

/** Whether the current boarding stop also offers the Town Square store. */
export function isAtTownSquare(): boolean {
  const player = PlayerManager.getInstance().getLocalPlayer();
  return (
    player != null &&
    nearestTravelFurnace(player.ship.position, worldFurnaces)?.id === TOWN_HEARTH.id
  );
}

function selectView(next: TownView): void {
  view = next;
  if (!elements) {
    return;
  }
  elements.status.textContent = '';
  refreshStoreCopy();
  const panel =
    next === 'entry' ? elements.choices : next === 'store' ? elements.offer : elements.travel;
  const first = panel.querySelector<HTMLButtonElement>('button:not(:disabled)');
  (first ?? elements.back).focus({ preventScroll: true });
}

function setTextIfChanged(node: HTMLElement, text: string): void {
  if (node.textContent !== text) {
    node.textContent = text;
  }
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
  const activeView = town ? view : 'travel';
  elements.choices.hidden = !town || activeView !== 'entry';
  elements.offer.hidden = activeView !== 'store';
  elements.travel.hidden = activeView !== 'travel';
  elements.back.hidden = !town || activeView === 'entry';
  const heading = elements.dialog.querySelector<HTMLElement>('#town-store-title');
  const eyebrow = elements.dialog.querySelector('.town-store-eyebrow');
  if (heading) {
    setTextIfChanged(
      heading,
      activeView === 'entry' ? 'Town Square' : activeView === 'store' ? 'Store' : 'Furnace travel'
    );
  }
  if (eyebrow) {
    eyebrow.textContent = source?.name ?? 'FURNACE';
  }
  const destinations = source ? litTravelDestinations(source.id, worldFurnaces) : [];
  const signature = `${source?.id ?? ''}|${destinations
    .map((destination) => `${destination.id}:${destination.name}`)
    .join('|')}`;
  if (activeView === 'travel' && elements.destinations.dataset['destinations'] !== signature) {
    elements.destinations.dataset['destinations'] = signature;
    if (source) {
      renderFurnaceTravelMap(elements.destinations, source, destinations, requestFurnaceTravel);
    } else {
      elements.destinations.replaceChildren();
    }
  }
  const level = getSettlement().level;
  setTextIfChanged(
    elements.score,
    `Bank ${(player?.score ?? 0).toLocaleString()} · Settlement level ${level}`
  );
  if (!elements.offer.children.length) {
    for (const offer of STORE_OFFERS) {
      const row = document.createElement('div');
      row.className = 'town-store-row';
      const copy = document.createElement('span');
      copy.className = 'town-store-copy';
      const name = document.createElement('strong');
      name.textContent = offer.name;
      const price = document.createElement('small');
      price.id = `town-store-price-${offer.id}`;
      price.textContent = `${offer.cost} banked points · Level ${offer.level} · No gameplay effect`;
      copy.append(name, price);
      const buy = document.createElement('button');
      buy.type = 'button';
      buy.dataset['offer'] = offer.id;
      buy.setAttribute('aria-describedby', price.id);
      buy.addEventListener('click', () => purchasePlaceholder(offer.id));
      row.append(copy, buy);
      elements.offer.append(row);
    }
  }
  for (const offer of STORE_OFFERS) {
    const button = elements.offer.querySelector<HTMLButtonElement>(
      `button[data-offer="${offer.id}"]`
    );
    if (!button) {
      continue;
    }
    const owned = player?.purchases.includes(offer.id) ?? false;
    const locked = level < offer.level;
    const hadFocus = document.activeElement === button;
    button.disabled = owned || locked || (player?.score ?? 0) < offer.cost;
    if (button.disabled && hadFocus) {
      elements.return.focus();
    }
    setTextIfChanged(
      button,
      owned ? 'Purchased' : locked ? `Unlocks at level ${offer.level}` : `Buy ${offer.name}`
    );
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
      <button id="${TOWN_STORE_IDS.close}" type="button" aria-label="Close menu">×</button>
    </header>
    <p id="${TOWN_STORE_IDS.score}"></p>
    <div id="${TOWN_STORE_IDS.choices}" class="town-store-choices">
      <button type="button" data-town-view="store">Store</button>
      <button type="button" data-town-view="travel">Fast Travel</button>
    </div>
    <div id="${TOWN_STORE_IDS.offer}" hidden></div>
    <section id="${TOWN_STORE_IDS.travel}" hidden>
    <h3>Destination map</h3>
    <p>Ride your ship along the pipes to any lit furnace. Travel is free.</p>
    <div id="${TOWN_STORE_IDS.destinations}" class="furnace-destinations"></div>
    </section>
    <button id="${TOWN_STORE_IDS.back}" type="button" hidden>Back to Town Square</button>
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
  const score = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.score}`);
  const offer = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.offer}`);
  const destinations = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.destinations}`);
  const choices = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.choices}`);
  const travel = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.travel}`);
  const back = dialog.querySelector<HTMLButtonElement>(`#${TOWN_STORE_IDS.back}`);
  const status = dialog.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.status}`);
  const returnButton = dialog.querySelector<HTMLButtonElement>(`#${TOWN_STORE_IDS.return}`);
  if (
    !close ||
    !score ||
    !offer ||
    !destinations ||
    !status ||
    !returnButton ||
    !choices ||
    !travel ||
    !back
  ) {
    return null;
  }
  return {
    dialog,
    close,
    score,
    offer,
    destinations,
    choices,
    travel,
    back,
    status,
    return: returnButton,
  };
}

function purchasePlaceholder(offerId: string): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || !isTownStoreOpen() || !insideTownStore(player.ship.position)) {
    return;
  }
  NetworkManager.getInstance().sendMessage({
    type: 'buyStoreItem',
    id: player.id,
    data: { offerId },
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
  if (
    'purchases' in data &&
    Array.isArray(data.purchases) &&
    data.purchases.every((id) => typeof id === 'string')
  ) {
    player.purchases = [...data.purchases];
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
  view = isAtTownSquare() ? 'entry' : 'travel';
  setTownStoreOpen(true);
  elements.status.textContent = '';
  refreshStoreCopy();
  openInputRelease?.();
  window.dispatchEvent(new CustomEvent('gameStoreOpen'));
  playFeedback('interface');
  const firstChoice = elements.choices.querySelector<HTMLButtonElement>('button');
  (view === 'entry' && firstChoice ? firstChoice : elements.close).focus({ preventScroll: true });
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
  elements.choices
    .querySelector('[data-town-view="store"]')
    ?.addEventListener('click', () => selectView('store'));
  elements.choices
    .querySelector('[data-town-view="travel"]')
    ?.addEventListener('click', () => selectView('travel'));
  elements.back.addEventListener('click', () => selectView('entry'));
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
