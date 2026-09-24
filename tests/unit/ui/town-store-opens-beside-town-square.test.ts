import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { civicLot, TOWN_HEARTH } from '../../../shared/furnaces';
import { TOWN_STORE_RADIUS } from '../../../shared/townStore';
import { InputManager } from '../../../src/core/services/InputManager';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import {
  bindPlayerNetworkPort,
  resetPlayerNetworkPort,
} from '../../../src/entities/player/playerNetworkPort';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { readAbilityChrome } from '../../../src/input/touchAbility';
import { triggerTouchAbility } from '../../../src/input/touchControls';
import { NetworkManager } from '../../../src/network/networkManager';
import { worldFurnaces } from '../../../src/network/worldExploration';
import { syncFurnaceTravelPrompt } from '../../../src/ui/furnaceTravelPrompt';
import {
  applyTownStoreResult,
  closeTownStore,
  initializeTownStore,
  openTownStore,
  syncTownStoreChrome,
  TOWN_STORE_IDS,
} from '../../../src/ui/townStore';
import { isTownStoreOpen } from '../../../src/ui/townStoreState';

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    },
  });
  document.body.classList.add('in-play');
  PlayerManager.getInstance().createLocalPlayer('hauler');
  bindPlayerNetworkPort({
    getAllPlayers: () => [],
    setLocalPlayerName: () => undefined,
    updatePlayerState: () => undefined,
  });
  initializeTownStore();
  InputManager.getInstance().initializeListeners();
});

afterAll(() => {
  closeTownStore();
  resetPlayerNetworkPort();
  document.body.classList.remove('in-play');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
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
  syncTownStoreChrome();
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
  expect(isTownStoreOpen()).toBe(true);
  const dialog = document.querySelector(`#${TOWN_STORE_IDS.dialog}`);
  expect(dialog?.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.offer}`)?.hidden).toBe(true);
  expect(dialog?.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.travel}`)?.hidden).toBe(true);
  dialog?.querySelector<HTMLButtonElement>('[data-town-view="store"]')?.click();
  expect(dialog?.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.offer}`)?.hidden).toBe(false);
  expect(dialog?.textContent).toContain('Placeholder A');
  expect(dialog?.textContent).toContain('100');
  expect(dialog?.textContent).not.toMatch(/deliveries|bonus|10%/iu);
  expect(dialog?.textContent).not.toContain('Ember');
  expect(player.ship.movementLocked).toBe(true);

  const send = vi.spyOn(NetworkManager.getInstance(), 'sendMessage').mockReturnValue(true);
  const buy = dialog?.querySelector<HTMLButtonElement>('button[data-offer="placeholder-1"]');
  expect(buy?.textContent).toBe('Buy Placeholder A');
  expect(buy?.getAttribute('aria-describedby')).toBe('town-store-price-placeholder-1');
  buy?.focus();
  buy?.click();
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
  expect(buy?.textContent).toBe('Purchased');
  expect(buy?.disabled).toBe(true);
  expect(document.activeElement?.id).toBe(TOWN_STORE_IDS.return);
  expect(dialog?.textContent).toContain('Unlocks at level 2');

  const scoreNode = document.querySelector(`#${TOWN_STORE_IDS.score}`);
  expect(buy).toBeTruthy();
  expect(scoreNode).toBeTruthy();
  const priorLabel = buy?.textContent;
  const priorScore = scoreNode?.textContent;
  const labelTextNode = buy?.firstChild;
  const scoreTextNode = scoreNode?.firstChild;
  expect(labelTextNode).toBeTruthy();
  expect(scoreTextNode).toBeTruthy();
  for (let frame = 0; frame < 8; frame += 1) {
    syncTownStoreChrome();
  }
  expect(buy?.textContent).toBe(priorLabel);
  expect(scoreNode?.textContent).toBe(priorScore);
  // Same-string textContent assigns replace the Text node; stable chrome must keep it.
  expect(buy?.firstChild).toBe(labelTextNode);
  expect(scoreNode?.firstChild).toBe(scoreTextNode);
  expect(document.querySelector('button[data-offer="placeholder-1"]')).toBe(buy);

  closeTownStore();
  expect(isTownStoreOpen()).toBe(false);
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
  expect(isTownStoreOpen()).toBe(true);
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }));
  expect(isTownStoreOpen()).toBe(false);
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
  expect(isTownStoreOpen()).toBe(false);
  activate.mockRestore();
  player.ship.position = { x: TOWN_STORE_RADIUS + 50, y: 0 };
  expect(readAbilityChrome(player.ship).label).toBe('HOOK');
  expect(triggerTouchAbility(player)).toBe(false);
  expect(isTownStoreOpen()).toBe(false);
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
  expect(document.querySelector<HTMLElement>(`#${TOWN_STORE_IDS.offer}`)?.hidden).toBe(true);
  expect(document.querySelector(`[data-furnace-id="${street.id}"]`)).toBeNull();
  expect(document.querySelector('[data-furnace-id="street-1-1"]')).not.toBeNull();
  expect(document.querySelector('[data-furnace-id="street-1-2"]')).toBeNull();
  const send = vi.spyOn(NetworkManager.getInstance(), 'sendMessage').mockReturnValue(true);
  document.querySelector<HTMLButtonElement>(`[data-furnace-id="${TOWN_HEARTH.id}"]`)?.click();
  expect(send).toHaveBeenCalledWith({
    type: 'travelFurnace',
    id: player.id,
    data: { destinationId: TOWN_HEARTH.id },
  });
  window.dispatchEvent(new CustomEvent('furnaceTravelResult', { detail: { ok: true } }));
  expect(isTownStoreOpen()).toBe(false);
  send.mockRestore();
  worldFurnaces.replaceLit([]);
});

test('a touch boarding gesture opens the map only after its click completes', () => {
  closeTownStore();
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.position = { x: 0, y: 0 };
  player.ship.health = 100;
  player.ship.exploding = false;
  player.ship.furnaceTransit = null;
  const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  syncFurnaceTravelPrompt();
  const ability = document.querySelector<HTMLButtonElement>('#furnace-travel-prompt button');
  if (!ability) {
    throw new Error('Missing furnace prompt');
  }
  expect(ability.textContent).toBe('Enter');
  ability.setPointerCapture = vi.fn();
  ability.hasPointerCapture = vi.fn().mockReturnValue(true);
  ability.releasePointerCapture = vi.fn();
  ability.dispatchEvent(
    new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'touch', bubbles: true })
  );
  expect(isTownStoreOpen()).toBe(false);
  ability.dispatchEvent(
    new PointerEvent('pointerup', { pointerId: 7, pointerType: 'touch', bubbles: true })
  );
  expect(isTownStoreOpen()).toBe(false);
  ability.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
  expect(isTownStoreOpen()).toBe(true);
  closeTownStore();
  width.mockRestore();
});
