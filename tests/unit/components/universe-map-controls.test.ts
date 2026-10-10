import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import UniverseMap from '../../../src/components/game/UniverseMap.svelte';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { NetworkManager } from '../../../src/network/networkManager';
import {
  UNIVERSE_MAP_LOCATE_LABEL,
  type UniverseMapChrome,
  type UniverseMapController,
} from '../../../src/ui/universeMap';

let component: ReturnType<typeof mount> | undefined;
const initial: UniverseMapChrome = {
  frame: { x: 25, y: 35, size: 400 },
  heading: 0,
  centered: true,
  zoom: 24,
  locations: ['Town Hearth: X +0, Y +0'],
  locationPage: 0,
  locationPages: 2,
  locationCount: 25,
};
let publish: (next: UniverseMapChrome) => void;
const controller: UniverseMapController = {
  center: vi.fn(),
  zoomBy: vi.fn(),
  keydown: vi.fn(),
  setLocationPage: vi.fn(),
  setOcclusions: vi.fn(),
  dispose: vi.fn(),
};
async function settle() {
  flushSync();
  await Promise.resolve();
  await vi.runAllTimersAsync();
  flushSync();
  await Promise.resolve();
}
function element<T extends Element>(selector: string, type: { new (...args: never[]): T }): T {
  const result = document.querySelector(selector);
  if (!(result instanceof type)) {
    throw new Error(`Missing ${selector}`);
  }
  return result;
}
function button(label: string) {
  const result = [...document.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label
  );
  if (!result) {
    throw new Error(`Missing ${label}`);
  }
  return result;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  const network = NetworkManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
  vi.spyOn(network, 'getAllPlayers').mockReturnValue([]);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML =
    '<button id="map-opener">Map</button><canvas id="flight" tabindex="-1"></canvas>';
});
afterEach(async () => {
  if (component) {
    await unmount(component);
  }
  component = undefined;
  await vi.runAllTimersAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function start(touch = false, restoreFocus = true) {
  const open = writable(false);
  const state = fromStore(open);
  const onclose = vi.fn(() => open.set(false));
  const mountMap = vi.fn(
    (_canvas: HTMLCanvasElement, onChrome: (next: UniverseMapChrome) => void) => {
      publish = onChrome;
      onChrome(initial);
      return controller;
    }
  );
  component = mount(UniverseMap, {
    target: document.body,
    props: {
      get open() {
        return state.current;
      },
      touch,
      onclose,
      mountMap,
      restoreFocus,
      fallbackFocusTarget: () => document.querySelector<HTMLCanvasElement>('#flight'),
    },
  });
  await settle();
  element('#map-opener', HTMLButtonElement).focus();
  open.set(true);
  await settle();
  return { open, onclose, mountMap };
}

test('pilots open an accessible Svelte map with canvas, North compass, full legend and inset Locate', async () => {
  const { mountMap } = await start();
  const dialog = element('[role="dialog"]', HTMLDivElement);
  expect(dialog.id).toBe('universe-map-dialog');
  expect(dialog.dataset['slot']).toBe('dialog-content');
  expect(document.querySelector('dialog')).toBeNull();
  const title = dialog.getAttribute('aria-labelledby');
  expect(title && document.querySelector(`[id="${title}"]`)?.textContent).toBe('Universe map');
  const canvas = element('#universe-map-canvas', HTMLCanvasElement);
  expect(canvas.getAttribute('aria-describedby')).toBe('universe-map-navigation');
  expect(document.querySelector('#universe-map-navigation')?.textContent).toContain(
    'Arrow keys pan'
  );
  expect(canvas.tabIndex).toBe(0);
  expect(canvas.getAttribute('aria-details')).toBe('universe-map-locations');
  expect(mountMap).toHaveBeenCalledTimes(1);
  expect(mountMap.mock.calls[0]?.[0]).toBe(canvas);
  expect(document.activeElement).toBe(button('Close'));
  const compass = element('.universe-map-compass', HTMLDivElement);
  expect(compass.textContent?.trim()).toBe('N');
  expect(compass.querySelectorAll('span')).toHaveLength(1);
  expect(compass.querySelector('i')).not.toBeNull();
  expect(compass.style.transform).toBe('rotate(0rad)');
  expect(compass.style.left).toBe('37px');
  const legend = element('.universe-map-legend', HTMLDivElement);
  expect(legend.querySelectorAll('canvas')).toHaveLength(7);
  for (const label of ['You', 'Crew', 'Furnace', 'Court', 'Resources', 'Nest', 'Uncharted']) {
    expect(legend.textContent).toContain(label);
  }
  const locate = button(UNIVERSE_MAP_LOCATE_LABEL);
  expect(locate.parentElement).toBe(canvas.parentElement);
  expect(locate.style.left).toBe('369px');
  expect(locate.style.top).toBe('379px');
  expect(locate.querySelector('svg')).not.toBeNull();
  expect(locate.getAttribute('aria-keyshortcuts')).toBe('Home');
  expect(locate.getAttribute('aria-pressed')).toBe('true');
  publish({ ...initial, centered: false });
  await settle();
  expect(locate.getAttribute('aria-pressed')).toBe('false');
  locate.click();
  expect(controller.center).toHaveBeenCalledTimes(1);
  button('Zoom in').click();
  button('Zoom out').click();
  expect(controller.zoomBy).toHaveBeenCalledTimes(2);
  canvas.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'Home', bubbles: true, cancelable: true })
  );
  expect(controller.keydown).toHaveBeenCalledTimes(1);
});

test('Close and Escape request controlled dismissal, retire the canvas and restore the connected opener', async () => {
  const { open, onclose, mountMap } = await start();
  button('Close').click();
  await settle();
  expect(onclose).toHaveBeenCalledOnce();
  expect(controller.dispose).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('#map-opener'));
  open.set(true);
  await settle();
  expect(mountMap).toHaveBeenCalledTimes(2);
  button('Close').dispatchEvent(
    new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })
  );
  await settle();
  expect(onclose).toHaveBeenCalledTimes(2);
  expect(controller.dispose).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('touch map chrome omits keyboard badges and every coordinate page is reachable with Svelte buttons', async () => {
  await start(true);
  expect(element('[role="dialog"]', HTMLDivElement).classList.contains('universe-map-touch')).toBe(
    true
  );
  expect(document.querySelector('kbd')).toBeNull();
  expect(button('Close').tagName).toBe('BUTTON');
  expect(button(UNIVERSE_MAP_LOCATE_LABEL).getAttribute('aria-keyshortcuts')).toBeNull();
  button('Locations').click();
  await settle();
  expect(document.querySelector('#universe-map-locations')?.textContent).toContain('Town Hearth');
  expect(button('Previous locations').disabled).toBe(true);
  button('Next locations').click();
  expect(controller.setLocationPage).toHaveBeenCalledWith(1);
  publish({ ...initial, locationPage: 1, locations: ['Far furnace: X +100, Y -300'] });
  await settle();
  expect(document.querySelector('#universe-map-locations')?.textContent).toContain('Far furnace');
  expect(document.querySelector('#universe-map-locations')?.textContent).not.toContain(
    'Town Hearth'
  );
  expect(button('Next locations').disabled).toBe(true);
  button('Previous locations').click();
  expect(controller.setLocationPage).toHaveBeenCalledWith(0);
});

test('closing after the opener disappears focuses the playfield and a handoff suppresses restoration', async () => {
  await start();
  element('#map-opener', HTMLButtonElement).remove();
  button('Close').click();
  await settle();
  expect(document.activeElement).toBe(document.querySelector('#flight'));
  if (component) {
    await unmount(component);
  }
  component = undefined;
  document.body.insertAdjacentHTML('afterbegin', '<button id="map-opener">Map</button>');
  await start(false, false);
  const focus = vi.spyOn(element('#map-opener', HTMLButtonElement), 'focus');
  button('Close').click();
  await settle();
  expect(focus).not.toHaveBeenCalled();
});
