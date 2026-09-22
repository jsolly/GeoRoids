import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { EXTRA_LIFE_COST, MAX_LIVES, TOWN_STORE_RADIUS } from '../../../shared/townStore';
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

test('the store opens at Town Square and buys one extra life', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  player.ship.position = { x: 0, y: 0 };
  player.score = 0;
  player.lives = 3;
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
  expect(dialog?.textContent).toContain('Extra life');
  expect(dialog?.textContent).toContain(EXTRA_LIFE_COST.toLocaleString('en-US'));
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
