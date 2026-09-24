import { expect, test, vi } from 'vitest';
import { CIVIC_LOTS, TOWN_HEARTH } from '../../../shared/furnaces';
import { renderFurnaceTravelMap } from '../../../src/ui/furnaceTravelMap';

test('the destination map preserves bearings, shows pipes, and sends only chosen destinations', () => {
  const container = document.createElement('div');
  const travel = vi.fn();
  const east = CIVIC_LOTS.find((site) => site.id === 'street-1-0');
  if (!east) {
    throw new Error('Missing east street');
  }
  renderFurnaceTravelMap(container, TOWN_HEARTH, [east], travel);
  const current = container.querySelector<HTMLButtonElement>('[aria-current="location"]');
  const destination = container.querySelector<HTMLButtonElement>(`[data-furnace-id="${east.id}"]`);
  expect(current?.disabled).toBe(true);
  expect(current?.textContent).toContain('Here');
  expect(container.querySelector('.furnace-travel-viewport')?.scrollTop).toBe(0);
  const map = container.querySelector<HTMLElement>('.furnace-travel-map');
  expect(Number.parseFloat(map?.style.height ?? '')).toBeLessThanOrEqual(
    Math.min(window.innerHeight * 0.42, 340)
  );
  expect(current?.getAttribute('aria-label')).toContain('Town Square');
  expect(destination?.getAttribute('aria-label')).toBe(`Travel to ${east.name}`);
  expect(Number.parseFloat(destination?.style.left ?? '')).toBeGreaterThan(
    Number.parseFloat(current?.style.left ?? '')
  );
  expect(container.querySelector('polyline')?.getAttribute('points')).toBeTruthy();
  current?.click();
  expect(travel).not.toHaveBeenCalled();
  destination?.dispatchEvent(new Event('pointerdown'));
  expect(container.querySelector('.furnace-travel-caption')?.textContent).toBe(
    `Travel to ${east.name}`
  );
  destination?.click();
  expect(travel).toHaveBeenCalledExactlyOnceWith(east.id);
});

test('all lit furnaces retain separate touch targets on a dense map', () => {
  const container = document.createElement('div');
  renderFurnaceTravelMap(container, TOWN_HEARTH, CIVIC_LOTS, vi.fn());
  const markers = [...container.querySelectorAll<HTMLButtonElement>('.furnace-travel-marker')];
  expect(markers).toHaveLength(CIVIC_LOTS.length + 1);
  for (let a = 0; a < markers.length; a++) {
    const left = markers[a];
    if (!left) {
      continue;
    }
    for (let b = a + 1; b < markers.length; b++) {
      const right = markers[b];
      if (!right) {
        continue;
      }
      expect(
        Math.max(
          Math.abs(Number.parseFloat(left.style.left) - Number.parseFloat(right.style.left)),
          Math.abs(Number.parseFloat(left.style.top) - Number.parseFloat(right.style.top))
        )
      ).toBeGreaterThanOrEqual(75.99);
    }
  }
});

test('an isolated source remains visible with an explanation instead of an empty map', () => {
  const container = document.createElement('div');
  renderFurnaceTravelMap(container, TOWN_HEARTH, [], vi.fn());
  expect(container.querySelector('[aria-current="location"]')).not.toBeNull();
  expect(container.textContent).toContain('No other furnaces are lit yet');
  expect(container.querySelector('[data-furnace-id]')).toBeNull();
});

test('pilots see a destination along their course above them with pipes attached', () => {
  const container = document.createElement('div');
  const east = CIVIC_LOTS.find((site) => site.id === 'street-1-0');
  if (!east) {
    throw new Error('Missing east street');
  }
  const course = Math.atan2(
    -(east.position.y - TOWN_HEARTH.position.y),
    east.position.x - TOWN_HEARTH.position.x
  );
  renderFurnaceTravelMap(container, TOWN_HEARTH, [east], vi.fn(), course - Math.PI / 2);
  const current = container.querySelector<HTMLElement>('[aria-current="location"]');
  const destination = container.querySelector<HTMLElement>('[data-furnace-id="street-1-0"]');
  if (!current || !destination) {
    throw new Error('Missing furnace marker');
  }
  expect(Number.parseFloat(destination.style.left)).toBeCloseTo(
    Number.parseFloat(current.style.left)
  );
  expect(Number.parseFloat(destination.style.top)).toBeLessThan(
    Number.parseFloat(current.style.top)
  );
  const points = [...container.querySelectorAll('polyline')].flatMap((line) =>
    (line.getAttribute('points') ?? '').split(' ')
  );
  expect(points).toContain(
    `${Number.parseFloat(destination.style.left)},${Number.parseFloat(destination.style.top)}`
  );
});
