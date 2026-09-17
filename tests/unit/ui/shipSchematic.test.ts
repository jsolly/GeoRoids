import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import {
  closeShipSchematic,
  equipUtility,
  initializeShipSchematic,
  isShipSchematicOpen,
  openShipSchematic,
  SHIP_SCHEMATIC_IDS,
} from '../../../src/ui/shipSchematic';

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
});
