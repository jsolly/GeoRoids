import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { shipPaintById, TOWN_STORE_RADIUS } from '../../../shared/townStore';
import { InputManager } from '../../../src/core/services/InputManager';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import {
  bindPlayerNetworkPort,
  resetPlayerNetworkPort,
} from '../../../src/entities/player/playerNetworkPort';
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

test('the store opens at Town Square, lists paints, and wears a purchased hull', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.position = { x: 0, y: 0 };
  player.score = 0;
  syncTownStoreChrome();
  const toggle = document.querySelector<HTMLButtonElement>(`#${TOWN_STORE_IDS.toggle}`);
  expect(toggle?.hidden).toBe(false);
  expect(toggle?.textContent).toMatch(/Store/u);
  player.ship.position = { x: TOWN_STORE_RADIUS + 20, y: 0 };
  syncTownStoreChrome();
  expect(toggle?.hidden).toBe(true);
  expect(openTownStore()).toBe(false);
  player.ship.position = { x: 40, y: 0 };
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }));
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
