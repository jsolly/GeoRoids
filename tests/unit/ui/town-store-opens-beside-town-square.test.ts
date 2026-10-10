import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { CIVIC_LOTS, civicLot, TOWN_HEARTH } from '../../../shared/furnaces';
import { TOWN_STORE_RADIUS } from '../../../shared/townStore';
import { InputManager } from '../../../src/core/services/InputManager';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { readAbilityChrome } from '../../../src/input/touchAbility';
import { triggerTouchAbility } from '../../../src/input/touchControls';
import { NetworkManager } from '../../../src/network/networkManager';
import { worldFurnaces } from '../../../src/network/worldExploration';
import { isGameOverlayOpen } from '../../../src/runtime/overlayState';
import {
  applyTownStoreResult,
  closeTownStore,
  mountTownStore,
  openTownStore,
  purchaseTownOffer,
  readTownStoreView,
  readTownTravelMap,
  requestFurnaceTravel,
  selectTownView,
} from '../../../src/runtime/townStore';
import { SCOUT_ONLY_BUILD_HINT } from '../../../src/ui/constants';
import { activateFieldHint, hideFieldHints, readFieldHints } from '../../../src/ui/fieldHint';
import { syncFurnaceTravelPrompt } from '../../../src/ui/furnaceTravelPrompt';
import { setWindowViewport } from '../../support/viewport';

let stopStore: () => void;
beforeAll(() => {
  const network = NetworkManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
  document.body.classList.add('in-play');
  PlayerManager.getInstance().createLocalPlayer('hauler');
  vi.spyOn(NetworkManager.getInstance(), 'getAllPlayers').mockReturnValue([]);
  vi.spyOn(network, 'isConnected', 'get').mockReturnValue(true);
  stopStore = mountTownStore();
  InputManager.getInstance().initializeListeners();
});

afterAll(() => {
  InputManager.getInstance().detachRuntime();
  stopStore();
  closeTownStore();
  vi.restoreAllMocks();
  document.body.classList.remove('in-play');
  hideFieldHints();
});

test('the store opens at Town Square via E and buys a placeholder without an upgrade', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  expect(document.querySelector('#town-store-toggle')).toBeNull();
  player.ship.position = { x: 0, y: 0 };
  player.score = 100;
  player.ship.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES.hauler;
  const near = readAbilityChrome(player.ship);
  expect(near.label).toBe('HOOK');
  expect(near.name).toBe('Harpoon');
  expect(near.ready).toBe(false);
  expect(near.cooldownRatio).toBe(1);
  player.ship.position = { x: TOWN_STORE_RADIUS + 20, y: 0 };
  expect(openTownStore()).toBe(false);
  expect(readAbilityChrome(player.ship).label).toBe('HOOK');
  player.ship.position = { x: 40, y: 0 };
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
  expect(isGameOverlayOpen('town-store')).toBe(true);
  expect(readTownStoreView().mode).toBe('entry');
  selectTownView('store');
  const view = readTownStoreView();
  expect(view.mode).toBe('store');
  expect(view.offers[0]).toMatchObject({ name: 'Placeholder A', cost: 100, available: true });
  expect(player.ship.movementLocked).toBe(true);
  const send = vi.spyOn(NetworkManager.getInstance(), 'sendMessage').mockReturnValue(true);
  purchaseTownOffer('placeholder-1');
  expect(send).toHaveBeenCalledWith({
    type: 'buyStoreItem',
    id: player.id,
    data: { offerId: 'placeholder-1' },
  });
  applyTownStoreResult({
    message: 'Placeholder A purchased. No upgrade granted.',
    score: 0,
    purchases: ['placeholder-1'],
  });
  expect(player.score).toBe(0);
  expect(readTownStoreView().offers[0]).toMatchObject({ owned: true, available: false });
  expect(readTownStoreView().status).toBe('Placeholder A purchased. No upgrade granted.');

  closeTownStore();
  expect(isGameOverlayOpen('town-store')).toBe(false);
  expect(player.ship.movementLocked).toBe(false);
  send.mockRestore();
});

test('B still toggles the store on a keyboard without an on-screen Store button', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.position = { x: 0, y: 0 };
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }));
  expect(isGameOverlayOpen('town-store')).toBe(true);
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }));
  expect(isGameOverlayOpen('town-store')).toBe(false);
});

test('touch ability uses the kit tool over Town Square without opening the store', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.position = { x: 0, y: 0 };
  player.ship.abilityCooldownFrames = 0;
  const activate = vi.spyOn(player.ship, 'activateAbility').mockReturnValue(true);
  expect(triggerTouchAbility(player)).toBe(true);
  expect(activate).toHaveBeenCalledOnce();
  expect(isGameOverlayOpen('town-store')).toBe(false);
  activate.mockRestore();
  player.ship.position = { x: TOWN_STORE_RADIUS + 50, y: 0 };
  expect(readAbilityChrome(player.ship).label).toBe('HOOK');
  expect(triggerTouchAbility(player)).toBe(true);
  expect(player.ship.utilityFlight?.phase).toBe('outbound');
  expect(isGameOverlayOpen('town-store')).toBe(false);
});

test('a hooked Hauler opens furnace travel and keeps release controls away from furnaces', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.position = { x: 0, y: 0 };
  player.ship.harpoonTargetId = 'tow-rock';
  player.ship.abilityCooldownFrames = 0;
  expect(readAbilityChrome(player.ship).label).toBe('RELEASE');
  expect(openTownStore()).toBe(true);
  closeTownStore();
  player.ship.position = { x: 800, y: 0 };
  expect(readAbilityChrome(player.ship).label).toBe('RELEASE');
  expect(openTownStore()).toBe(false);
  player.ship.harpoonTargetId = null;
});

test('a lit street offers free travel to Town Square and other lit streets but no life store', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const street = civicLot('street-1-0');
  if (!player || !street) {
    throw new Error('Missing travel fixture');
  }
  worldFurnaces.replaceLit([
    { id: street.id, builderName: 'Pilot' },
    { id: 'street-1-1', builderName: 'Friend' },
  ]);
  player.ship.position = { ...street.position };
  expect(openTownStore()).toBe(true);
  expect(readTownStoreView().mode).toBe('travel');
  const travel = readTownTravelMap();
  expect(travel.source).toMatchObject({ id: street.id, position: street.position });
  expect(travel.destinations.map((destination) => destination.id)).toContain(TOWN_HEARTH.id);
  expect(travel.destinations.map((destination) => destination.id)).toContain('street-1-1');
  expect(travel.destinations.map((destination) => destination.id)).not.toContain(street.id);
  expect(travel.destinations.map((destination) => destination.id)).not.toContain('street-1-2');
  expect(travel.destinations.length).toBeLessThanOrEqual(CIVIC_LOTS.length + 1);
  expect(new Set(travel.destinations.map((destination) => destination.id)).size).toBe(
    travel.destinations.length
  );
  const send = vi.spyOn(NetworkManager.getInstance(), 'sendMessage').mockReturnValue(true);
  requestFurnaceTravel(street.id);
  requestFurnaceTravel('street-1-2');
  expect(send).not.toHaveBeenCalled();
  requestFurnaceTravel(TOWN_HEARTH.id);
  expect(send).toHaveBeenCalledWith({
    type: 'travelFurnace',
    id: player.id,
    data: { destinationId: TOWN_HEARTH.id },
  });
  window.dispatchEvent(new CustomEvent('furnaceTravelResult', { detail: { ok: true } }));
  expect(isGameOverlayOpen('town-store')).toBe(false);
  send.mockRestore();
  worldFurnaces.replaceLit([]);
});

test('a boarding command rechecks the current footprint before opening a furnace menu', () => {
  closeTownStore();
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.position = { x: 0, y: 0 };
  player.ship.health = 100;
  player.ship.exploding = false;
  player.ship.furnaceTransit = null;
  const restoreViewport = setWindowViewport(390, 844);
  try {
    syncFurnaceTravelPrompt();
    expect(readFieldHints().find((hint) => hint.id === 'furnace-travel-prompt')).toMatchObject({
      text: '',
      actionLabel: 'Enter',
    });
    expect(isGameOverlayOpen('town-store')).toBe(false);
    // A stored hint cannot board after the ship leaves the offered footprint.
    player.ship.position = { x: 800, y: 0 };
    activateFieldHint('furnace-travel-prompt');
    expect(isGameOverlayOpen('town-store')).toBe(false);
    player.ship.position = { x: 0, y: 0 };
    activateFieldHint('furnace-travel-prompt');
    expect(isGameOverlayOpen('town-store')).toBe(true);
    expect(readFieldHints().find((hint) => hint.id === 'furnace-travel-prompt')).toBeUndefined();
    closeTownStore();
  } finally {
    restoreViewport();
  }
});

test('boarding hints query the current touch mode only while a live pilot can board', () => {
  closeTownStore();
  const player = PlayerManager.getInstance().getLocalPlayer();
  const street = civicLot('street-1-0');
  if (!player || !street) {
    throw new Error('Missing travel fixture');
  }
  const previous = {
    position: { ...player.ship.position },
    health: player.ship.health,
    exploding: player.ship.exploding,
    furnaceTransit: player.ship.furnaceTransit,
    modules: worldFurnaces.litModules().map((module) => ({ ...module })),
  };
  const restoreViewport = setWindowViewport(1600, 1200);
  let coarse = false;
  const media = vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    Object.assign(new window.EventTarget(), {
      matches: coarse && query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
    })
  );
  const hint = () => readFieldHints().find((item) => item.id === 'furnace-travel-prompt');
  const shown = () => hint() !== undefined;
  try {
    worldFurnaces.replaceLit([{ id: street.id, builderName: 'Pilot' }]);
    player.ship.position = { x: 800, y: 0 };
    player.ship.health = 100;
    player.ship.exploding = false;
    player.ship.furnaceTransit = null;
    for (let frame = 0; frame < 120; frame += 1) {
      syncFurnaceTravelPrompt();
    }
    expect(shown()).toBe(false);
    expect(media).not.toHaveBeenCalled();

    // Positive work control: visible hints still read both actual media queries.
    player.ship.position = { ...TOWN_HEARTH.position };
    syncFurnaceTravelPrompt();
    expect(shown()).toBe(true);
    expect(hint()?.text).toBe('Press E to enter');
    expect(hint()?.actionLabel).toBeNull();
    expect(media.mock.calls).toEqual([['(pointer: coarse)'], ['(hover: none)']]);

    media.mockClear();
    player.ship.health = 0;
    coarse = true;
    syncFurnaceTravelPrompt();
    expect(shown()).toBe(false);
    expect(media).not.toHaveBeenCalled();
    player.ship.health = 100;
    syncFurnaceTravelPrompt();
    expect(shown()).toBe(true);
    expect(hint()?.actionLabel).not.toBeNull();
    expect(hint()?.actionLabel).toBe('Enter');
    expect(hint()?.text).toBe('');
    expect(media).toHaveBeenCalledTimes(2);

    media.mockClear();
    player.ship.position = { ...street.position };
    syncFurnaceTravelPrompt();
    expect(hint()?.actionLabel).toBe('Tap to travel');
    coarse = false;
    syncFurnaceTravelPrompt();
    expect(hint()?.text).toBe('Press E to travel');
    expect(hint()?.actionLabel).toBeNull();
    expect(media).toHaveBeenCalledTimes(4);

    media.mockClear();
    player.ship.exploding = true;
    syncFurnaceTravelPrompt();
    expect(shown()).toBe(false);
    expect(media).not.toHaveBeenCalled();
    player.ship.exploding = false;
    coarse = true;
    syncFurnaceTravelPrompt();
    expect(shown()).toBe(true);
    expect(hint()?.actionLabel).toBe('Tap to travel');
    expect(hint()?.actionLabel).not.toBeNull();
    expect(media).toHaveBeenCalledTimes(2);
  } finally {
    media.mockRestore();
    restoreViewport();
    Object.assign(player.ship, {
      position: previous.position,
      health: previous.health,
      exploding: previous.exploding,
      furnaceTransit: previous.furnaceTransit,
    });
    worldFurnaces.replaceLit(previous.modules);
    syncFurnaceTravelPrompt();
  }
});

test('a Hauler on an unbuilt furnace footprint is told only Scouts can build it', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const lot = civicLot('street-2-0');
  if (!player || !lot) {
    throw new Error('Missing dark lot fixture');
  }
  worldFurnaces.replaceLit([]);
  closeTownStore();
  const hint = () => readFieldHints().find((item) => item.id === 'furnace-build-hint');
  const shown = () => hint() !== undefined;
  player.ship.position = { x: lot.position.x + lot.radius - 5, y: lot.position.y };
  syncFurnaceTravelPrompt();
  expect(shown()).toBe(true);
  expect(hint()?.text).toBe(SCOUT_ONLY_BUILD_HINT);
  expect(hint()?.actionLabel).toBeNull();

  // Beside the grate but off it: the same footprint rule as Scout Build.
  player.ship.position = { x: lot.position.x + lot.radius + 40, y: lot.position.y };
  syncFurnaceTravelPrompt();
  expect(shown()).toBe(false);

  player.ship.position = { ...lot.position };
  const score = player.score;
  player.ship.kitId = 'scout';
  player.score = lot.cost - 25;
  syncFurnaceTravelPrompt();
  expect(shown()).toBe(true);
  expect(hint()?.text).toBe('You need 25 more points to build this furnace');
  player.score = lot.cost - 1;
  syncFurnaceTravelPrompt();
  expect(hint()?.text).toBe('You need 1 more point to build this furnace');
  player.score = lot.cost;
  syncFurnaceTravelPrompt();
  expect(shown()).toBe(false);
  player.score = score;
  player.ship.kitId = 'hauler';
});
