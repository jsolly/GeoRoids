import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  clampUniverseMapZoom,
  closeUniverseMap,
  initializeUniverseMap,
  isUniverseMapOpen,
  mapWorldToCanvas,
  UNIVERSE_MAP_IDS,
  UNIVERSE_MAP_ZOOM,
} from '../../../src/ui/universeMap';
import { logger } from '../../../src/utils/Logger';

describe('universe map play chrome', () => {
  const releaseInput = vi.fn();
  const canvasContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => null);

  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  beforeAll(() => {
    // jsdom does not implement dialog methods; browser coverage verifies native modality.
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value: showModal },
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
    initializeUniverseMap({ onOpen: releaseInput });
  });

  afterAll(() => {
    closeUniverseMap();
    canvasContext.mockRestore();
    document.body.classList.remove('in-play');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    vi.unstubAllGlobals();
  });

  test('exposes an accessible native dialog and map toggle', () => {
    const dialog = document.querySelector(`#${UNIVERSE_MAP_IDS.dialog}`);
    const toggle = document.querySelector(`#${UNIVERSE_MAP_IDS.toggle}`);
    const mapCanvas = document.querySelector(`#${UNIVERSE_MAP_IDS.canvas}`);

    expect(dialog?.tagName).toBe('DIALOG');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('universe-map-title');
    expect(toggle?.getAttribute('aria-keyshortcuts')).toBe('M');
    expect(mapCanvas?.getAttribute('role')).toBe('img');
    expect(mapCanvas?.getAttribute('tabindex')).toBe('0');
  });

  test('opens from the map button, releases gameplay input, and closes with M or Escape', () => {
    const toggle = document.querySelector(`#${UNIVERSE_MAP_IDS.toggle}`) as HTMLButtonElement;
    const dialog = document.querySelector(`#${UNIVERSE_MAP_IDS.dialog}`) as HTMLDialogElement;
    const opened = vi.fn();
    const closed = vi.fn();
    window.addEventListener('gameMapOpen', opened);
    window.addEventListener('gameMapClose', closed);

    toggle.click();

    expect(isUniverseMapOpen()).toBe(true);
    expect(dialog.hasAttribute('open') || dialog.open).toBe(true);
    expect(releaseInput).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledOnce();

    const blocked = new KeyboardEvent('keydown', {
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    const closeWithEscape = new KeyboardEvent('keydown', {
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(closeWithEscape);
    expect(isUniverseMapOpen()).toBe(false);
    expect(closed).toHaveBeenCalledOnce();

    const reopen = new KeyboardEvent('keydown', {
      code: 'KeyM',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(reopen);
    expect(isUniverseMapOpen()).toBe(true);

    const closeWithM = new KeyboardEvent('keydown', {
      code: 'KeyM',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(closeWithM);
    expect(isUniverseMapOpen()).toBe(false);
    expect(closed).toHaveBeenCalledTimes(2);

    window.removeEventListener('gameMapOpen', opened);
    window.removeEventListener('gameMapClose', closed);
  });

  test('holding M does not toggle repeatedly or capture name entry outside play', () => {
    const toggle = document.querySelector(`#${UNIVERSE_MAP_IDS.toggle}`) as HTMLButtonElement;
    toggle.click();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyM', repeat: true, bubbles: true })
    );
    expect(isUniverseMapOpen()).toBe(true);
    closeUniverseMap();
    document.body.classList.remove('in-play');
    const name = document.createElement('input');
    document.body.append(name);
    const event = new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true, cancelable: true });
    name.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(isUniverseMapOpen()).toBe(false);
    name.remove();
    document.body.classList.add('in-play');
  });

  test('a failed native dialog leaves gameplay available and reports the error', () => {
    const error = new Error('dialog failed');
    showModal.mockImplementationOnce(() => {
      throw error;
    });
    const report = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const releasedBefore = releaseInput.mock.calls.length;
    (document.querySelector(`#${UNIVERSE_MAP_IDS.toggle}`) as HTMLButtonElement).click();
    expect(isUniverseMapOpen()).toBe(false);
    expect(releaseInput.mock.calls.length).toBe(releasedBefore);
    expect(report).toHaveBeenCalledWith('UI', 'Could not open the universe map', error);
    report.mockRestore();
  });

  test('keeps map zoom bounded and projects world coordinates from the active view', () => {
    expect(clampUniverseMapZoom(0)).toBe(UNIVERSE_MAP_ZOOM.min);
    expect(clampUniverseMapZoom(Number.POSITIVE_INFINITY)).toBe(UNIVERSE_MAP_ZOOM.max);
    expect(
      mapWorldToCanvas({ x: 100, y: -50 }, { x: 0, y: 0 }, { x: 20, y: 30, size: 400, scale: 2 })
    ).toEqual({ x: 420, y: 130 });
  });
});
