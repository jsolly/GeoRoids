import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { InputManager } from '../../../src/core/services/InputManager';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import {
  bindPlayerNetworkPort,
  resetPlayerNetworkPort,
} from '../../../src/entities/player/playerNetworkPort';
import {
  BOOST_COUPLING_DEMO_DURATION_MS,
  closeShipSchematic,
  equipUtility,
  getBoostCouplingDemoFrame,
  initializeShipSchematic,
  openShipSchematic,
  SHIP_SCHEMATIC_IDS,
} from '../../../src/ui/shipSchematic';
import { isShipSchematicOpen } from '../../../src/ui/shipSchematicState';
import {
  closeUniverseMap,
  initializeUniverseMap,
  isUniverseMapOpen,
  UNIVERSE_MAP_IDS,
} from '../../../src/ui/universeMap';

describe('Hauler ship schematic overlay', () => {
  const releaseInput = vi.fn();
  const canvasContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => null);

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
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    document.body.classList.add('in-play');
    const flightCanvas = document.createElement('canvas');
    flightCanvas.id = 'gameCanvas';
    document.body.append(flightCanvas);
    PlayerManager.getInstance().createLocalPlayer('hauler');
    bindPlayerNetworkPort({
      getAllPlayers: () => [],
      setLocalPlayerName: () => undefined,
      updatePlayerState: () => undefined,
    });
    initializeShipSchematic({ onOpen: releaseInput });
    initializeUniverseMap({ onOpen: releaseInput });
    InputManager.getInstance().initializeListeners();
  });

  afterAll(() => {
    closeShipSchematic();
    closeUniverseMap();
    resetPlayerNetworkPort();
    canvasContext.mockRestore();
    document.body.classList.remove('in-play');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    vi.unstubAllGlobals();
  });

  test('V opens the local Hauler schematic and Return to flight closes it', () => {
    const opened = vi.fn();
    window.addEventListener('gameSchematicOpen', opened);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }));
    expect(isShipSchematicOpen()).toBe(true);
    expect(document.querySelector(`#${SHIP_SCHEMATIC_IDS.dialog}`)?.hasAttribute('open')).toBe(
      true
    );
    expect(releaseInput).toHaveBeenCalled();
    expect(opened).toHaveBeenCalledOnce();

    const blocked = new KeyboardEvent('keydown', {
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    const ret = document.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.return}`);
    expect(ret).toBeInstanceOf(HTMLButtonElement);
    ret?.click();
    expect(isShipSchematicOpen()).toBe(false);
    expect(document.activeElement?.id).toBe('gameCanvas');
    window.removeEventListener('gameSchematicOpen', opened);
  });

  test('opening the schematic from the map keeps the hull held without blinking', () => {
    const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
    expect(ship).toBeDefined();
    if (!ship) {
      return;
    }
    ship.spawnProtectionTimer = 0;
    ship.blinkCount = 0;
    (document.querySelector(`#${UNIVERSE_MAP_IDS.toggle}`) as HTMLButtonElement).click();
    InputManager.getInstance().updateMovementLock();
    expect(isUniverseMapOpen()).toBe(true);
    expect(ship.movementLocked).toBe(true);
    expect(ship.blinkCount).toBe(0);

    expect(openShipSchematic()).toBe(true);
    expect(isUniverseMapOpen()).toBe(false);
    expect(isShipSchematicOpen()).toBe(true);
    expect(ship.movementLocked).toBe(true);
    expect(ship.blinkCount).toBe(0);

    closeShipSchematic();
    expect(ship.movementLocked).toBe(false);
    expect(ship.blinkCount).toBeGreaterThan(0);
  });

  test('uncollected tools stay locked and unlock while inventory is open', () => {
    const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
    if (!ship) {
      throw new Error('Missing local ship');
    }
    ship.equipment = [];
    expect(openShipSchematic()).toBe(true);
    const tap = document.querySelector<HTMLButtonElement>('[data-utility-id="resource_tap"]');
    expect(tap?.disabled).toBe(true);
    expect(tap?.textContent).toContain('Find in spider nests');
    equipUtility('resource_tap');
    expect(
      document.querySelector('[data-utility-id="tow_cable"]')?.classList.contains('is-active')
    ).toBe(true);
    ship.equipment = ['resource_tap'];
    const render = vi.mocked(requestAnimationFrame).mock.lastCall?.[0];
    render?.(0);
    expect(tap?.disabled).toBe(false);
    equipUtility('resource_tap');
    expect(tap?.classList.contains('is-active')).toBe(true);
    closeShipSchematic();
  });

  test('selecting Tow Cable then Resource Tap updates the ACTIVE card', () => {
    const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
    if (!ship) {
      throw new Error('Missing local ship');
    }
    ship.equipment = ['resource_tap'];
    expect(openShipSchematic()).toBe(true);
    equipUtility('tow_cable');
    const tow = document.querySelector('[data-utility-id="tow_cable"]');
    const tap = document.querySelector('[data-utility-id="resource_tap"]');
    expect(tow?.classList.contains('is-active')).toBe(true);
    expect(tap?.classList.contains('is-active')).toBe(false);
    expect(document.querySelector(`#${SHIP_SCHEMATIC_IDS.title}`)?.textContent).toBe('Tow Cable');

    equipUtility('resource_tap');
    expect(tap?.classList.contains('is-active')).toBe(true);
    expect(document.querySelector(`#${SHIP_SCHEMATIC_IDS.copy}`)?.textContent).toContain(
      'spider for silk'
    );
    closeShipSchematic();
  });

  test('Boost Coupling turns the demonstration roid, ignites, and boosts away before looping', () => {
    const turning = getBoostCouplingDemoFrame(600, 180, 48);
    expect(turning.phase).toBe('turning');
    expect(turning.cableVisible).toBe(true);
    expect(turning.rockAngle).toBeGreaterThan(0);
    expect(turning.flameStrength).toBe(0);

    const igniting = getBoostCouplingDemoFrame(950, 180, 48);
    expect(igniting.phase).toBe('igniting');
    expect(igniting.rockAngle).toBeCloseTo(Math.PI / 2);
    expect(igniting.cableVisible).toBe(false);
    expect(igniting.flameStrength).toBeGreaterThan(0);

    const boosting = getBoostCouplingDemoFrame(1500, 180, 48);
    const coast = getBoostCouplingDemoFrame(2100, 180, 48);
    expect(boosting.phase).toBe('boosting');
    expect(boosting.rockX).toBeGreaterThan(igniting.rockX);
    expect(boosting.flameStrength).toBeGreaterThan(0);
    expect(coast.phase).toBe('coasting');
    expect(coast.rockX).toBeGreaterThan(boosting.rockX);

    const looped = getBoostCouplingDemoFrame(BOOST_COUPLING_DEMO_DURATION_MS + 600, 180, 48);
    expect(looped.phase).toBe(turning.phase);
    expect(looped.rockX).toBe(turning.rockX);
    expect(looped.rockAngle).toBe(turning.rockAngle);
  });

  test('the desktop Inventory button shows V and opens the ship view', () => {
    const toggle = document.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.toggle}`);
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.hidden).toBe(false);
    expect(toggle?.getAttribute('aria-keyshortcuts')).toBe('V');
    expect(toggle?.querySelector('kbd')?.textContent).toBe('V');
    expect(toggle?.textContent).toMatch(/Inventory/u);
    const map = document.querySelector(`#${UNIVERSE_MAP_IDS.toggle}`);
    expect(toggle && map ? toggle.compareDocumentPosition(map) : 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    toggle?.click();
    expect(isShipSchematicOpen()).toBe(true);
    closeShipSchematic();
  });

  test('a pilot cannot open inventory or change tools during a furnace ride', () => {
    const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
    if (!ship) {
      throw new Error('Missing pilot');
    }
    closeShipSchematic();
    const utility = ship.haulerUtility;
    const equipment = ship.equipment;
    ship.haulerUtility = 'tow_cable';
    ship.equipment = ['resource_tap'];
    ship.furnaceTransit = {
      sourceId: 'town-square',
      destinationId: 'street-1-0',
      startedAt: 0,
      durationMs: 1000,
    };
    try {
      openShipSchematic();
      expect(isShipSchematicOpen()).toBe(false);
      equipUtility('resource_tap');
      expect(ship.haulerUtility).toBe('tow_cable');
    } finally {
      ship.furnaceTransit = null;
      if (utility === undefined) {
        delete ship.haulerUtility;
      } else {
        ship.haulerUtility = utility;
      }
      ship.equipment = equipment;
    }
  });

  test('touch chrome keeps the Inventory button and hides its keyboard badge', () => {
    const toggle = document.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.toggle}`);
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    try {
      window.dispatchEvent(new Event('resize'));
      expect(toggle?.hidden).toBe(false);
      expect(toggle?.classList.contains('ship-schematic-touch')).toBe(true);
      expect(toggle?.getAttribute('aria-keyshortcuts')).toBeNull();
      expect(toggle?.textContent).toMatch(/Inventory/u);
    } finally {
      if (innerWidth) {
        Object.defineProperty(window, 'innerWidth', innerWidth);
      }
      if (innerHeight) {
        Object.defineProperty(window, 'innerHeight', innerHeight);
      }
      window.dispatchEvent(new Event('resize'));
    }
    expect(toggle?.hidden).toBe(false);
    expect(toggle?.getAttribute('aria-keyshortcuts')).toBe('V');
  });
});
