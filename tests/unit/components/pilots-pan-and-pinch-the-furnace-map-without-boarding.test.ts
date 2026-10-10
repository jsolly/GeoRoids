import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CIVIC_LOTS, TOWN_HEARTH } from '../../../shared/furnaces';
import FurnaceTravelMap from '../../../src/components/game/FurnaceTravelMap.svelte';
import type { FurnaceSite } from '../../../src/ui/furnaceTravelMap';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const mounted = new Set<ReturnType<typeof mount>>();
afterEach(async () => {
  for (const component of mounted) {
    await unmount(component);
  }
  mounted.clear();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function mountMap(
  container: HTMLElement,
  source: FurnaceSite,
  destinations: readonly FurnaceSite[],
  ontravel: (id: string) => void,
  rotation = 0
) {
  document.body.append(container);
  const component = mount(FurnaceTravelMap, {
    target: container,
    props: { view: { source, destinations, rotation }, ontravel },
  });
  mounted.add(component);
  flushSync();
  return async () => {
    if (mounted.delete(component)) {
      await unmount(component);
    }
  };
}

test('a pilot pinches, continues dragging with one finger, and taps only after releasing the gesture', () => {
  const destination = CIVIC_LOTS.find((lot) => lot.parentId === TOWN_HEARTH.id);
  if (!destination) {
    throw new Error('Missing town furnace');
  }
  const container = document.createElement('div');
  const travel = vi.fn();
  mountMap(container, TOWN_HEARTH, [destination], travel);
  const viewport = container.querySelector<HTMLElement>('.furnace-travel-viewport');
  const map = container.querySelector<HTMLElement>('.furnace-travel-map');
  const marker = container.querySelector<HTMLButtonElement>('[data-furnace-id]');
  if (!viewport || !map || !marker || !map.parentElement) {
    throw new Error('Missing map');
  }
  const bounds = map.parentElement;
  const originalWidth = Number.parseFloat(bounds.style.width);
  viewport.setPointerCapture = vi.fn();
  viewport.scrollLeft = 100;
  viewport.scrollTop = 80;
  const pointer = (type: string, id: number, x: number, y: number) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    viewport.dispatchEvent(event);
  };
  pointer('pointerdown', 1, 100, 100);
  pointer('pointerdown', 2, 200, 100);
  pointer('pointermove', 2, 300, 100);
  expect(map.style.transform).toBe('scale(2)');
  expect(Number.parseFloat(bounds.style.width)).toBe(originalWidth * 2);
  expect(viewport.scrollLeft).toBe(300);
  expect(viewport.scrollTop).toBe(260);
  pointer('pointerup', 2, 300, 100);
  pointer('pointermove', 1, 120, 110);
  expect(viewport.scrollLeft).toBe(280);
  expect(viewport.scrollTop).toBe(250);
  marker.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }));
  expect(travel).not.toHaveBeenCalled();
  pointer('pointercancel', 1, 120, 110);
  pointer('pointerdown', 3, 100, 100);
  pointer('pointerup', 3, 100, 100);
  marker.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
  expect(travel).toHaveBeenCalledExactlyOnceWith(destination.id);
});

test('a keyboard pilot can zoom the focused furnace map without shrinking its touch targets below 44 pixels', () => {
  const container = document.createElement('div');
  mountMap(container, TOWN_HEARTH, CIVIC_LOTS, vi.fn());
  const viewport = container.querySelector<HTMLElement>('.furnace-travel-viewport');
  const map = container.querySelector<HTMLElement>('.furnace-travel-map');
  if (!viewport || !map) {
    throw new Error('Missing map');
  }
  const zoom = (key: string, count: number) => {
    for (let i = 0; i < count; i++) {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
  };
  zoom('+', 1);
  expect(map.style.transform).toBe('scale(1.25)');
  zoom('+', 20);
  expect(map.style.transform).toBe('scale(3)');
  zoom('-', 20);
  expect(map.style.transform).toBe('scale(0.7)');
  const markers = [...container.querySelectorAll<HTMLElement>('.furnace-travel-marker')];
  for (const marker of markers) {
    expect(Number.parseFloat(marker.style.width) * 0.7).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(marker.style.height) * 0.7).toBeGreaterThanOrEqual(44);
    for (const other of markers) {
      if (marker === other) {
        continue;
      }
      const separation =
        Math.max(
          Math.abs(Number.parseFloat(marker.style.left) - Number.parseFloat(other.style.left)),
          Math.abs(Number.parseFloat(marker.style.top) - Number.parseFloat(other.style.top))
        ) * 0.7;
      expect(separation).toBeGreaterThanOrEqual(53.19);
    }
  }
});

test('disposing the travel map releases captured fingers and retires detached controls', async () => {
  const destination = CIVIC_LOTS[0];
  if (!destination) {
    throw new Error('Missing destination');
  }
  const container = document.createElement('div');
  const travel = vi.fn();
  const dispose = mountMap(container, TOWN_HEARTH, [destination], travel);
  const marker = container.querySelector<HTMLButtonElement>('[data-furnace-id]');
  if (!marker) {
    throw new Error('Missing destination marker');
  }
  marker.setPointerCapture = vi.fn();
  marker.hasPointerCapture = vi.fn().mockReturnValue(true);
  marker.releasePointerCapture = vi.fn();
  marker.dispatchEvent(
    new PointerEvent('pointerdown', {
      pointerId: 41,
      pointerType: 'touch',
      button: 0,
      bubbles: true,
    })
  );
  expect(marker.setPointerCapture).toHaveBeenCalledWith(41);
  await dispose();
  await dispose();
  expect(marker.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(41);
  expect(container.childNodes).toHaveLength(0);
  marker.click();
  expect(travel).not.toHaveBeenCalled();
});

test('five pixels of marker drag suppresses pointer boarding while keyboard activation stays available', () => {
  const destination = CIVIC_LOTS[0];
  if (!destination) {
    throw new Error('Missing destination');
  }
  const container = document.createElement('div');
  const travel = vi.fn();
  mountMap(container, TOWN_HEARTH, [destination], travel);
  const viewport = container.querySelector<HTMLElement>('.furnace-travel-viewport');
  const marker = container.querySelector<HTMLButtonElement>('[data-furnace-id]');
  const symbol = marker?.querySelector('span');
  const map = container.querySelector<HTMLElement>('.furnace-travel-map');
  if (!viewport || !marker || !symbol || !map) {
    throw new Error('Missing map');
  }
  symbol.setPointerCapture = vi.fn();
  symbol.hasPointerCapture = vi.fn().mockReturnValue(true);
  symbol.releasePointerCapture = vi.fn();
  const pointer = (type: string, x: number) =>
    symbol.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 7,
        pointerType: 'touch',
        button: 0,
        clientX: x,
        clientY: 100,
        bubbles: true,
        cancelable: true,
      })
    );
  viewport.scrollLeft = 100;
  pointer('pointerdown', 100);
  expect(symbol.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  pointer('pointermove', 104);
  expect(viewport.scrollLeft).toBe(100);
  pointer('pointermove', 105);
  expect(viewport.scrollLeft).toBe(95);
  pointer('pointerup', 105);
  expect(symbol.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  const click = new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true });
  symbol.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(travel).not.toHaveBeenCalled();
  marker.click();
  expect(travel).toHaveBeenCalledExactlyOnceWith(destination.id);
  marker.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
  expect(map.style.transform).toBe('scale(1)');
  pointer('pointerdown', 150);
  pointer('lostpointercapture', 150);
  pointer('pointermove', 170);
  expect(viewport.scrollLeft).toBe(95);
});
