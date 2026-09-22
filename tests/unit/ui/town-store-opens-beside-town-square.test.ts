import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { shipPaintById, TOWN_STORE_RADIUS } from '../../../shared/townStore';
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
import {
  applyTownStoreResult,
  closeTownStore,
  initializeTownStore,
  openTownStore,
  syncTownStoreChrome,
  TOWN_STORE_IDS,
} from '../../../src/ui/townStore';
import { isTownStoreOpen } from '../../../src/ui/townStoreState';

const ember = shipPaintById('ember');
if (!ember) {
  throw new Error('Missing Ember paint');
}

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

test('the store opens at Town Square via E, lists paints, and wears a purchased hull', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  expect(document.querySelector('#town-store-toggle')).toBeNull();
  player.ship.position = { x: 0, y: 0 };
  player.score = 0;
  player.ship.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES.hauler;
  syncTownStoreChrome();
  const near = readAbilityChrome(player.ship);
  expect(near.label).toBe('ENTER');
  expect(near.name).toBe('Enter store');
  expect(near.ready).toBe(true);
  expect(near.cooldownRatio).toBe(0);
  player.ship.position = { x: TOWN_STORE_RADIUS + 20, y: 0 };
  expect(openTownStore()).toBe(false);
  expect(readAbilityChrome(player.ship).label).toBe('HOOK');
  player.ship.position = { x: 40, y: 0 };
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
  expect(isTownStoreOpen()).toBe(true);
  const dialog = document.querySelector(`#${TOWN_STORE_IDS.dialog}`);
  expect(dialog?.textContent).toContain('Ember');
  expect(dialog?.textContent).toContain(ember.cost.toLocaleString('en-US'));
  expect(dialog?.textContent).toContain('10%');
  expect(player.ship.movementLocked).toBe(true);

  const send = vi.spyOn(NetworkManager.getInstance(), 'sendMessage').mockReturnValue(true);
  dialog?.querySelector<HTMLButtonElement>('button[data-paint-id="ember"]')?.click();
  expect(send).toHaveBeenCalledWith({
    type: 'buyShipPaint',
    id: player.id,
    data: { paintId: 'ember' },
  });
  applyTownStoreResult({ message: `You need ${ember.cost} more score` });
  expect(document.querySelector(`#${TOWN_STORE_IDS.status}`)?.textContent).toContain(
    `${ember.cost}`
  );
  expect(player.ship.color).not.toBe(ember.color);

  player.score = ember.cost;
  applyTownStoreResult({
    message: 'Ember is on your hull',
    score: 0,
    color: ember.color,
  });
  expect(player.ship.color).toBe(ember.color);
  expect(player.score).toBe(0);
  expect(dialog?.textContent).toContain('Worn');
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

test('a hooked Hauler keeps tow chrome instead of Enter store inside Town Square', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.position = { x: 0, y: 0 };
  player.ship.harpoonTargetId = 'tow-rock';
  player.ship.abilityCooldownFrames = 0;
  syncTownStoreChrome();
  const chrome = readAbilityChrome(player.ship);
  expect(chrome.label).not.toBe('ENTER');
  expect(chrome.name).not.toBe('Enter store');
  expect(openTownStore()).toBe(false);
  expect(isTownStoreOpen()).toBe(false);
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }));
  expect(isTownStoreOpen()).toBe(false);
  // Touch still fires the kit tool (tow/ignite); it must not open the store.
  triggerTouchAbility(player);
  expect(isTownStoreOpen()).toBe(false);
  player.ship.harpoonTargetId = null;
  syncTownStoreChrome();
  expect(readAbilityChrome(player.ship).label).toBe('ENTER');
  expect(openTownStore()).toBe(true);
  closeTownStore();
});
