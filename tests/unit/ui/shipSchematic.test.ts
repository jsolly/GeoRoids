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

  test('selecting Tow Cable then Resource Tap updates the ACTIVE card', () => {
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
      'Keeps the asteroid intact'
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
});
