import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { emptySettlement } from '../../../shared/economy';
import { civicLot, TOWN_HEARTH } from '../../../shared/furnaces';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { NetworkManager } from '../../../src/network/networkManager';
import {
  resetWorldExploration,
  setSettlement,
  worldFurnaces,
} from '../../../src/network/worldExploration';
import {
  closeGameOverlay,
  getOpenGameOverlay,
  openGameOverlay,
} from '../../../src/runtime/overlayState';
import {
  applyTownStoreResult,
  canEnterTownStore,
  mountTownStore,
  openTownStore,
  purchaseTownOffer,
  readTownStoreView,
  readTownTravelMap,
  requestFurnaceTravel,
  selectTownView,
  subscribeTownStore,
} from '../../../src/runtime/townStore';

const network = NetworkManager.getInstance();
let dispose: () => void;
function pilot() {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing test pilot');
  }
  return player;
}
function key(code: string, target: EventTarget = document, repeat = false) {
  const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, repeat });
  target.dispatchEvent(event);
  return event;
}

beforeAll(() => {
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});
beforeEach(() => {
  resetWorldExploration();
  const current = getOpenGameOverlay();
  if (current) {
    closeGameOverlay(current);
  }
  document.body.classList.add('in-play');
  const player = PlayerManager.getInstance().createLocalPlayer('hauler');
  player.ship.position = { x: 40, y: 0 };
  player.score = 100;
  vi.spyOn(network, 'isConnected', 'get').mockReturnValue(true);
  vi.spyOn(network, 'sendMessage').mockReturnValue(true);
  dispose = mountTownStore();
});
afterEach(() => {
  dispose();
  const current = getOpenGameOverlay();
  if (current) {
    closeGameOverlay(current);
  }
  document.body.classList.remove('in-play');
  resetWorldExploration();
  vi.restoreAllMocks();
});

test('E boards only unobstructed flight while B replaces another overlay and Escape restores flight', () => {
  openGameOverlay('inventory');
  expect(key('KeyE').defaultPrevented).toBe(false);
  expect(getOpenGameOverlay()).toBe('inventory');
  openGameOverlay('universe-map');
  key('KeyE');
  expect(getOpenGameOverlay()).toBe('universe-map');
  expect(key('KeyB').defaultPrevented).toBe(true);
  expect(getOpenGameOverlay()).toBe('town-store');
  expect(readTownStoreView()).toMatchObject({ mode: 'entry', title: 'Town Square', atTown: true });
  expect(key('KeyB', document, true).defaultPrevented).toBe(true);
  expect(getOpenGameOverlay()).toBe('town-store');
  expect(key('Escape').defaultPrevented).toBe(true);
  expect(getOpenGameOverlay()).toBeNull();
  const input = document.createElement('input');
  document.body.append(input);
  try {
    key('KeyE', input);
    key('KeyB', input);
    expect(getOpenGameOverlay()).toBeNull();
  } finally {
    input.remove();
  }
  key('KeyE');
  expect(getOpenGameOverlay()).toBe('town-store');
  const button = document.createElement('button');
  document.body.append(button);
  try {
    expect(key('Space', button).defaultPrevented).toBe(false);
    expect(key('Space').defaultPrevented).toBe(true);
    expect(key('KeyA').defaultPrevented).toBe(true);
  } finally {
    button.remove();
  }
});

test('boarding rejects dead, exploding, travelling and out-of-range pilots', () => {
  const player = pilot();
  player.ship.health = 0;
  expect(openTownStore()).toBe(false);
  player.ship.health = 100;
  player.ship.exploding = true;
  expect(openTownStore()).toBe(false);
  player.ship.exploding = false;
  player.ship.furnaceTransit = { sourceId: 'a', destinationId: 'b', startedAt: 0, durationMs: 500 };
  expect(openTownStore()).toBe(false);
  player.ship.furnaceTransit = null;
  player.ship.position = { x: 1_000_000, y: 0 };
  expect(canEnterTownStore()).toBe(false);
  player.ship.position = { x: 0, y: 0 };
  document.body.classList.remove('in-play');
  expect(openTownStore()).toBe(false);
});

test('buying validates the live offer and applies only the authoritative score and receipt', () => {
  const player = pilot();
  purchaseTownOffer('placeholder-1');
  expect(network.sendMessage).not.toHaveBeenCalled();
  openTownStore();
  selectTownView('store');
  const original = readTownStoreView();
  expect(original.offers).toHaveLength(4);
  expect(original.offers[0]).toMatchObject({ available: true, owned: false, locked: false });
  expect(original.offers[1]).toMatchObject({ available: false, locked: true });
  purchaseTownOffer('bogus');
  purchaseTownOffer('placeholder-2');
  setSettlement({ ...emptySettlement(), level: 4 });
  expect(readTownStoreView().offers[3]).toMatchObject({ locked: false, available: false });
  player.score = 99;
  purchaseTownOffer('placeholder-1');
  player.score = 100;
  vi.spyOn(network, 'isConnected', 'get').mockReturnValue(false);
  purchaseTownOffer('placeholder-1');
  vi.spyOn(network, 'isConnected', 'get').mockReturnValue(true);
  player.purchases = ['placeholder-1'];
  purchaseTownOffer('placeholder-1');
  player.purchases = [];
  player.ship.position = { x: 1_000_000, y: 0 };
  purchaseTownOffer('placeholder-1');
  expect(network.sendMessage).not.toHaveBeenCalled();
  player.ship.position = { x: 0, y: 0 };
  purchaseTownOffer('placeholder-1');
  expect(network.sendMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'buyStoreItem',
    id: player.id,
    data: { offerId: 'placeholder-1' },
  });
  expect(player.score).toBe(100);
  expect(player.purchases).toEqual([]);
  const message = 'Purchased. '.repeat(100);
  applyTownStoreResult({ score: 0, purchases: ['placeholder-1'], message });
  expect(player.score).toBe(0);
  expect(player.purchases).toEqual(['placeholder-1']);
  expect(readTownStoreView().status).toBe(message.slice(0, 500));
  expect(readTownStoreView().offers[0]).toMatchObject({ available: false, owned: true });
  expect(original.bank).toBe(100);
  expect(Object.isFrozen(original.offers[0])).toBe(true);
  applyTownStoreResult({ score: Number.NaN, purchases: [1], message: 5 });
  expect(player.score).toBe(0);
  expect(player.purchases).toEqual(['placeholder-1']);
  expect(readTownStoreView().status).toBe('');
});

test('lit furnace travel uses separate geometry, rejects unknown destinations and closes only on success', () => {
  const lot = civicLot('street-1-0');
  if (!lot) {
    throw new Error('Missing test furnace');
  }
  worldFurnaces.replaceLit([{ id: lot.id, builderName: 'Test pilot' }]);
  openTownStore();
  selectTownView('travel');
  expect(readTownStoreView().mode).toBe('travel');
  expect(readTownStoreView()).not.toHaveProperty('destinations');
  expect(readTownTravelMap().source?.id).toBe(TOWN_HEARTH.id);
  requestFurnaceTravel('missing');
  requestFurnaceTravel(TOWN_HEARTH.id);
  expect(network.sendMessage).not.toHaveBeenCalled();
  requestFurnaceTravel(lot.id);
  expect(network.sendMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'travelFurnace',
    id: pilot().id,
    data: { destinationId: lot.id },
  });
  expect(readTownStoreView().status).toBe('Preparing rocket…');
  window.dispatchEvent(
    new CustomEvent('furnaceTravelResult', { detail: { ok: false, message: 'Unavailable' } })
  );
  expect(getOpenGameOverlay()).toBe('town-store');
  expect(readTownStoreView().status).toBe('Unavailable');
  window.dispatchEvent(new CustomEvent('furnaceTravelResult', { detail: { ok: true } }));
  expect(getOpenGameOverlay()).toBeNull();
  pilot().ship.position = { ...lot.position };
  openTownStore();
  selectTownView('store');
  expect(readTownStoreView()).toMatchObject({ mode: 'travel', atTown: false });
});

test('unmount retires keyboard and result subscriptions, resets state and supports one clean remount', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeTownStore(listener);
  try {
    openTownStore();
    applyTownStoreResult('Pending');
    openGameOverlay('inventory');
    expect(readTownStoreView().status).toBe('');
    openTownStore();
    window.dispatchEvent(new Event('playViewOff'));
    expect(getOpenGameOverlay()).toBeNull();
    document.body.classList.add('in-play');
    expect(openTownStore()).toBe(true);
    dispose();
    dispose();
    expect(getOpenGameOverlay()).toBeNull();
    listener.mockClear();
    key('KeyE');
    window.dispatchEvent(
      new CustomEvent('townStoreResult', { detail: { score: 4, message: 'late' } })
    );
    expect(getOpenGameOverlay()).toBeNull();
    expect(pilot().score).toBe(100);
    expect(listener).not.toHaveBeenCalled();
    dispose = mountTownStore();
    key('KeyE');
    expect(getOpenGameOverlay()).toBe('town-store');
    expect(readTownStoreView().status).toBe('');
    window.dispatchEvent(
      new CustomEvent('townStoreResult', { detail: { score: 4, message: 'current' } })
    );
    expect(pilot().score).toBe(4);
    expect(readTownStoreView().status).toBe('current');
  } finally {
    unsubscribe();
  }
});

test('failed listener setup unwinds the partial mount before retry', () => {
  dispose();
  const add = vi.spyOn(window, 'addEventListener').mockImplementationOnce(() => {
    throw new Error('Listener setup failed');
  });
  expect(() => mountTownStore()).toThrow('Listener setup failed');
  add.mockRestore();
  key('KeyE');
  expect(getOpenGameOverlay()).toBeNull();
  dispose = mountTownStore();
  key('KeyE');
  expect(getOpenGameOverlay()).toBe('town-store');
});
