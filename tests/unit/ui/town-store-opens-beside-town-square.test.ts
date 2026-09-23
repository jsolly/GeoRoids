import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { civicLot, TOWN_HEARTH } from '../../../shared/furnaces';
import { EXTRA_LIFE_COST, MAX_LIVES, TOWN_STORE_RADIUS } from '../../../shared/townStore';
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

test('the store opens at Town Square via E and buys one extra life', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  expect(document.querySelector('#town-store-toggle')).toBeNull();
  player.ship.position = { x: 0, y: 0 };
  player.score = 0;
  player.lives = 3;
  player.ship.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES.hauler;
  syncTownStoreChrome();
  const near = readAbilityChrome(player.ship);
  expect(near.label).toBe('TRAVEL');
  expect(near.name).toBe('Choose furnace destination');
  expect(near.ready).toBe(true);
  expect(near.cooldownRatio).toBe(0);
  player.ship.position = { x: TOWN_STORE_RADIUS + 20, y: 0 };
  expect(openTownStore()).toBe(false);
  expect(readAbilityChrome(player.ship).label).toBe('HOOK');
  player.ship.position = { x: 40, y: 0 };
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
  expect(isTownStoreOpen()).toBe(true);
  const dialog = document.querySelector(`#${TOWN_STORE_IDS.dialog}`);
  expect(dialog?.textContent).toContain('Extra life');
  expect(dialog?.textContent).toContain(EXTRA_LIFE_COST.toLocaleString('en-US'));
  expect(dialog?.textContent).toContain('10%');
  expect(dialog?.textContent).not.toContain('Ember');
  expect(player.ship.movementLocked).toBe(true);

  const send = vi.spyOn(NetworkManager.getInstance(), 'sendMessage').mockReturnValue(true);
  const buy = dialog?.querySelector<HTMLButtonElement>('button[data-offer="extra-life"]');
  expect(buy?.textContent).toBe('Buy extra life');
  expect(buy?.getAttribute('aria-describedby')).toBe(TOWN_STORE_IDS.price);
  buy?.click();
  expect(send).toHaveBeenCalledWith({
    type: 'buyExtraLife',
    id: player.id,
    data: {},
  });
  applyTownStoreResult({ message: `You need ${EXTRA_LIFE_COST} more score` });
  expect(document.querySelector(`#${TOWN_STORE_IDS.status}`)?.textContent).toContain(
    `${EXTRA_LIFE_COST}`
  );
  expect(player.lives).toBe(3);
  expect(dialog?.querySelector('button[data-offer="extra-life"]')).toBe(buy);

  buy?.focus();
  player.score = EXTRA_LIFE_COST;
  applyTownStoreResult({
    message: 'You have 4 lives',
    score: 0,
    lives: 4,
  });
  expect(player.lives).toBe(4);
  expect(player.score).toBe(0);
  expect(dialog?.querySelector('button[data-offer="extra-life"]')).toBe(buy);
  expect(document.activeElement).toBe(buy);

  player.lives = MAX_LIVES;
  buy?.focus();
  applyTownStoreResult({ message: `You already hold ${MAX_LIVES} lives` });
  expect(buy?.textContent).toBe('Extra life, lives full');
  expect(buy?.disabled).toBe(true);
  expect(document.activeElement?.id).toBe(TOWN_STORE_IDS.return);

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
  expect(document.querySelector('button[data-offer="extra-life"]')).toBe(buy);

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

test('touch ability opens the store near Town Square instead of firing the kit tool', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.position = { x: 0, y: 0 };
  player.ship.abilityCooldownFrames = 0;
  expect(triggerTouchAbility(player)).toBe(true);
  expect(isTownStoreOpen()).toBe(true);
  closeTownStore();
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
  expect(readAbilityChrome(player.ship).label).toBe('TRAVEL');
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
  player.lives = 5;
  player.ship.health = 100;
  player.ship.exploding = false;
  player.ship.furnaceTransit = null;
  const ability = document.querySelector<HTMLButtonElement>('#touch-ability');
  if (!ability) {
    throw new Error('Missing touch ability');
  }
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
});
