import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
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
    initializeShipSchematic({ onOpen: releaseInput });
  });

  afterAll(() => {
    closeShipSchematic();
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

  test('the desktop Schematic button shows V and opens the overlay', () => {
    const toggle = document.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.toggle}`);
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.hidden).toBe(false);
    expect(toggle?.getAttribute('aria-keyshortcuts')).toBe('V');
    expect(toggle?.querySelector('kbd')?.textContent).toBe('V');
    expect(toggle?.textContent).toMatch(/Schematic/u);
    toggle?.click();
    expect(isShipSchematicOpen()).toBe(true);
    closeShipSchematic();
  });

  test('touch chrome hides the Schematic button', () => {
    const toggle = document.querySelector<HTMLButtonElement>(`#${SHIP_SCHEMATIC_IDS.toggle}`);
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    try {
      window.dispatchEvent(new Event('resize'));
      expect(toggle?.hidden).toBe(true);
      expect(toggle?.classList.contains('ship-schematic-touch')).toBe(true);
      expect(toggle?.getAttribute('aria-keyshortcuts')).toBeNull();
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
