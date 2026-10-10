import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { InputManager } from '../../../src/core/services/InputManager';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { getPressedKeysForPlayer, keys } from '../../../src/input/keybindings';
import { NetworkManager } from '../../../src/network/networkManager';
import { mountInventoryShortcuts, openInventory } from '../../../src/runtime/inventoryOverlay';
import { closeGameOverlay, getOpenGameOverlay } from '../../../src/runtime/overlayState';

let stopShortcuts: () => void;
let input: InputManager;

beforeEach(() => {
  const network = NetworkManager.getInstance();
  const players = PlayerManager.getInstance({
    networkPort: network,
    combatNetwork: network.combatNetwork,
  });
  players.createLocalPlayer('hauler');
  vi.spyOn(network, 'getAllPlayers').mockReturnValue([]);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
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
  stopShortcuts = mountInventoryShortcuts(() => document.body.classList.contains('in-play'));
  input = InputManager.getInstance();
  input.initializeListeners();
});

afterEach(() => {
  input.detachRuntime();
  stopShortcuts();
  document.body.classList.remove('in-play');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  vi.restoreAllMocks();
});

test('switching from map to inventory cancels held controls without releasing the hull', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.spawnProtectionTimer = 0;
  player.ship.blinkCount = 0;
  keys['Space'] = true;
  getPressedKeysForPlayer(player).add('KeyA');
  const shoot = vi.spyOn(player.ship, 'shoot').mockImplementation(() => {});
  const mapToggle = document.querySelector<HTMLButtonElement>('#universe-map-toggle');
  if (!mapToggle) {
    throw new Error('Missing map toggle');
  }
  mapToggle.click();
  expect(getOpenGameOverlay()).toBe('universe-map');
  expect(player.ship.movementLocked).toBe(true);
  expect(keys['Space']).toBe(false);
  expect(getPressedKeysForPlayer(player).size).toBe(0);
  document.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true, cancelable: true })
  );
  expect(getOpenGameOverlay()).toBe('inventory');
  expect(document.querySelector<HTMLDialogElement>('#universe-map-dialog')?.open).toBe(false);
  expect(player.ship.movementLocked).toBe(true);
  expect(player.ship.blinkCount).toBe(0);
  const fire = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
  document.dispatchEvent(fire);
  expect(fire.defaultPrevented).toBe(true);
  expect(shoot).not.toHaveBeenCalled();
  closeGameOverlay('inventory');
  expect(player.ship.movementLocked).toBe(false);
  expect(player.ship.blinkCount).toBeGreaterThan(0);
});

test('editable fields and repeat gestures do not open inventory and teardown retires shortcuts', () => {
  const field = document.createElement('input');
  document.body.append(field);
  field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }));
  document.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'KeyV', repeat: true, bubbles: true })
  );
  expect(getOpenGameOverlay()).toBeNull();
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  if (!ship) {
    throw new Error('Missing local ship');
  }
  ship.furnaceTransit = {
    sourceId: 'town-square',
    destinationId: 'street-1-0',
    startedAt: 0,
    durationMs: 1000,
  };
  openInventory(true);
  expect(getOpenGameOverlay()).toBeNull();
  ship.furnaceTransit = null;
  openInventory(true);
  expect(getOpenGameOverlay()).toBe('inventory');
  stopShortcuts();
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }));
  expect(getOpenGameOverlay()).toBeNull();
  field.remove();
});
