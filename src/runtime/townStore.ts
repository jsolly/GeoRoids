import { TOWN_HEARTH } from '../../shared/furnaces';
import { litTravelDestinations, nearestTravelFurnace } from '../../shared/furnaceTravel';
import { insideTownStore, STORE_OFFERS, storeOffer } from '../../shared/townStore';
import { playFeedback } from '../audio/feedbackSounds';
import { PlayerManager } from '../entities/player/PlayerManager';
import { NetworkManager } from '../network/networkManager';
import { getSettlement, worldFurnaces } from '../network/worldExploration';
import { travelCameraRotation } from '../rendering/travelCamera';
import {
  closeGameOverlay,
  getOpenGameOverlay,
  isGameOverlayOpen,
  openGameOverlay,
  subscribeGameOverlay,
} from './overlayState';

export type TownView = 'entry' | 'store' | 'travel';
export interface TownStoreView {
  readonly mode: TownView;
  readonly title: string;
  readonly sourceName: string;
  readonly bank: number;
  readonly level: number;
  readonly status: string;
  readonly atTown: boolean;
  readonly offers: readonly {
    readonly id: string;
    readonly name: string;
    readonly cost: number;
    readonly level: number;
    readonly owned: boolean;
    readonly locked: boolean;
    readonly available: boolean;
  }[];
}

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
let view: TownView = 'entry';
let status = '';
let mounted = false;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) {
    listener();
  }
}

function reset(): void {
  view = 'entry';
  status = '';
}

export function subscribeTownStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function canEnterTownStore(): boolean {
  if (typeof document === 'undefined' || !document.body.classList.contains('in-play')) {
    return false;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  return (
    player !== null &&
    !player.ship.exploding &&
    player.ship.health > 0 &&
    !player.ship.furnaceTransit &&
    nearestTravelFurnace(player.ship.position, worldFurnaces) !== undefined
  );
}

export function isAtTownSquare(): boolean {
  const player = PlayerManager.getInstance().getLocalPlayer();
  return (
    player !== null &&
    nearestTravelFurnace(player.ship.position, worldFurnaces)?.id === TOWN_HEARTH.id
  );
}

/** World geometry is consumed only by the isolated travel-map host, never the presentation store. */
export function readTownTravelMap() {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const source = player ? nearestTravelFurnace(player.ship.position, worldFurnaces) : undefined;
  return {
    source,
    destinations: source ? litTravelDestinations(source.id, worldFurnaces) : [],
    rotation: player ? travelCameraRotation(player.ship) : 0,
  };
}

export function readTownStoreView(): TownStoreView {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const source = player ? nearestTravelFurnace(player.ship.position, worldFurnaces) : undefined;
  const atTown = source?.id === TOWN_HEARTH.id;
  const mode = atTown ? view : 'travel';
  const bank = player?.score ?? 0;
  const level = getSettlement().level;
  const shopping =
    isGameOverlayOpen('town-store') &&
    canEnterTownStore() &&
    atTown &&
    player !== null &&
    insideTownStore(player.ship.position) &&
    NetworkManager.getInstance().isConnected;
  return Object.freeze({
    mode,
    title: mode === 'entry' ? 'Town Square' : mode === 'store' ? 'Store' : 'Furnace travel',
    sourceName: source?.name ?? 'FURNACE',
    bank,
    level,
    status,
    atTown,
    offers: Object.freeze(
      STORE_OFFERS.map((offer) => {
        const owned = player?.purchases.includes(offer.id) ?? false;
        const locked = level < offer.level;
        return Object.freeze({
          ...offer,
          owned,
          locked,
          available: shopping && !owned && !locked && bank >= offer.cost,
        });
      })
    ),
  });
}

export function selectTownView(mode: TownView): void {
  if (
    !isGameOverlayOpen('town-store') ||
    !canEnterTownStore() ||
    (!isAtTownSquare() && mode !== 'travel')
  ) {
    return;
  }
  view = mode;
  status = '';
  publish();
}

export function openTownStore(): boolean {
  if (isGameOverlayOpen('town-store') || !canEnterTownStore()) {
    return false;
  }
  reset();
  view = isAtTownSquare() ? 'entry' : 'travel';
  openGameOverlay('town-store');
  playFeedback('interface');
  publish();
  return true;
}

export function closeTownStore(): void {
  if (!isGameOverlayOpen('town-store')) {
    return;
  }
  closeGameOverlay('town-store');
  reset();
  playFeedback('interface');
  publish();
}

export function purchaseTownOffer(id: string): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const network = NetworkManager.getInstance();
  const offer = storeOffer(id);
  if (
    !player ||
    !offer ||
    !network.isConnected ||
    !isGameOverlayOpen('town-store') ||
    !canEnterTownStore() ||
    !insideTownStore(player.ship.position) ||
    getSettlement().level < offer.level ||
    player.score < offer.cost ||
    player.purchases.includes(id)
  ) {
    return;
  }
  network.sendMessage({ type: 'buyStoreItem', id: player.id, data: { offerId: id } });
}

export function requestFurnaceTravel(id: string): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const network = NetworkManager.getInstance();
  if (!player || !network.isConnected || !isGameOverlayOpen('town-store') || !canEnterTownStore()) {
    return;
  }
  const { destinations } = readTownTravelMap();
  if (!destinations.some((destination) => destination.id === id)) {
    return;
  }
  network.sendMessage({ type: 'travelFurnace', id: player.id, data: { destinationId: id } });
  status = 'Preparing rocket…';
  publish();
}

export function applyTownStoreResult(data: unknown): void {
  status = (
    typeof data === 'string'
      ? data
      : data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message
        : ''
  ).slice(0, 500);
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (player && data && typeof data === 'object') {
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
  }
  publish();
}

function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches('input, textarea, select'))
  );
}

function handleKeydown(event: KeyboardEvent): void {
  const open = isGameOverlayOpen('town-store');
  if (event.code === 'KeyE' && !open) {
    if (
      !event.repeat &&
      getOpenGameOverlay() === null &&
      !editable(event.target) &&
      canEnterTownStore()
    ) {
      event.preventDefault();
      event.stopPropagation();
      openTownStore();
    }
    return;
  }
  if (event.code === 'KeyB') {
    if (!open && (editable(event.target) || !canEnterTownStore())) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      if (open) {
        closeTownStore();
      } else {
        openTownStore();
      }
    }
    return;
  }
  if (!open) {
    return;
  }
  if (event.code === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeTownStore();
  } else if (event.code === 'Space' && event.target instanceof HTMLButtonElement) {
    event.stopPropagation();
  } else if (BLOCKED_GAMEPLAY_KEYS.has(event.code)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

export function mountTownStore(): () => void {
  if (mounted) {
    throw new Error('Town store already mounted');
  }
  mounted = true;
  reset();
  const scope = new AbortController();
  const unsubscribeOverlay = subscribeGameOverlay((next, previous) => {
    if (previous === 'town-store' && next !== 'town-store') {
      reset();
      publish();
    }
  });
  const dispose = () => {
    if (scope.signal.aborted) {
      return;
    }
    scope.abort();
    unsubscribeOverlay();
    closeTownStore();
    reset();
    mounted = false;
  };
  try {
    document.addEventListener('keydown', handleKeydown, { capture: true, signal: scope.signal });
    window.addEventListener('playViewOff', closeTownStore, { signal: scope.signal });
    window.addEventListener(
      'townStoreResult',
      (event) => {
        if (event instanceof CustomEvent) {
          applyTownStoreResult(event.detail);
        }
      },
      { signal: scope.signal }
    );
    window.addEventListener(
      'furnaceTravelResult',
      (event) => {
        if (!(event instanceof CustomEvent)) {
          return;
        }
        const data: unknown = event.detail;
        if (data && typeof data === 'object' && 'ok' in data && data.ok === true) {
          closeTownStore();
        } else {
          applyTownStoreResult(data);
        }
      },
      { signal: scope.signal }
    );
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
