import { expect, test, vi } from 'vitest';
import { CIVIC_LOTS, TOWN_HEARTH } from '../../../shared/furnaces';
import { renderFurnaceTravelMap } from '../../../src/ui/furnaceTravelMap';

test('a pilot pinches, continues dragging with one finger, and taps only after releasing the gesture', () => {
  const destination = CIVIC_LOTS.find((lot) => lot.parentId === TOWN_HEARTH.id);
  if (!destination) {
    throw new Error('Missing town furnace');
  }
  const container = document.createElement('div');
  const travel = vi.fn();
  renderFurnaceTravelMap(container, TOWN_HEARTH, [destination], travel);
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

test('a keyboard pilot can zoom the focused furnace map within its bounds', () => {
  const container = document.createElement('div');
  renderFurnaceTravelMap(container, TOWN_HEARTH, [], vi.fn());
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
  expect(map.style.transform).toBe('scale(0.4)');
});
