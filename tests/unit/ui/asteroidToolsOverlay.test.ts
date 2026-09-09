import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';
import type { AsteroidToolsState } from '../../../src/asteroidTools/AsteroidToolsController';
import {
  AsteroidToolsOverlay,
  type AsteroidToolsOverlayCallbacks,
} from '../../../src/asteroidTools/AsteroidToolsOverlay';

function state(overrides: Partial<AsteroidToolsState> = {}): AsteroidToolsState {
  return {
    active: true,
    targets: [
      { id: 'roid-1', position: { x: 1, y: 2 }, size: 28, material: 'metal' },
      { id: 'roid-2', position: { x: 3, y: 4 }, size: 18, material: 'ice' },
    ],
    selectedTargetId: 'roid-1',
    pilot: {
      id: 'pilot',
      position: { x: 0, y: 0 },
      kitId: 'hauler',
      alive: true,
      asteroidMotion: { epoch: 2, mode: 'latched', ack: 7 },
    },
    status: 'Ready',
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

test('overlay exposes target selection, readable distance labels, and Hauler controls', () => {
  const container = document.createElement('main');
  document.body.append(container);
  const overlay = AsteroidToolsOverlay.mount({ container });
  overlay.update(state());

  const root = overlay.getElement();
  expect(root.hidden).toBe(false);
  expect(
    root.querySelector('[data-asteroid-tools-target] option[value="roid-1"]')?.textContent
  ).toBe('Metal · 2m');
  expect(root.querySelectorAll('[data-asteroid-tools-target] option')).toHaveLength(3);
  expect(root.querySelectorAll('[data-asteroid-tools-motion]')).toHaveLength(5);
  expect(
    root
      .querySelector<HTMLButtonElement>('[data-asteroid-tools-motion="anchor"]')
      ?.getAttribute('aria-label')
  ).toBe('Attach the selected second rock');
});

test('overlay callbacks receive open, close, target, and motion actions', () => {
  const callbacks: AsteroidToolsOverlayCallbacks = {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onSelectTarget: vi.fn(),
    onMotion: vi.fn(),
  };
  const overlay = AsteroidToolsOverlay.mount({ callbacks });
  overlay.update(state());
  const root = overlay.getElement();

  document.querySelector<HTMLButtonElement>('[data-asteroid-tools-action="open"]')?.click();
  root.querySelector<HTMLButtonElement>('[data-asteroid-tools-action="close"]')?.click();
  const targetSelect = root.querySelector<HTMLSelectElement>('[data-asteroid-tools-target]');
  assert.ok(targetSelect);
  targetSelect.value = 'roid-2';
  targetSelect.dispatchEvent(new Event('change'));
  root.querySelector<HTMLButtonElement>('[data-asteroid-tools-motion="release"]')?.click();

  expect(callbacks.onSelectTarget).toHaveBeenCalledWith('roid-2');
  expect(callbacks.onMotion).toHaveBeenCalledWith('release');
  expect(callbacks.onOpen).toHaveBeenCalledOnce();
  expect(callbacks.onClose).toHaveBeenCalledOnce();
});

test('overlay keeps option nodes and a live native selection while asteroid poses move', () => {
  const overlay = AsteroidToolsOverlay.mount();
  const initial = state({ selectedTargetId: 'roid-2' });
  overlay.update(initial);

  const root = overlay.getElement();
  const select = root.querySelector<HTMLSelectElement>('[data-asteroid-tools-target]');
  const firstOption = root.querySelector<HTMLOptionElement>('option[value="roid-1"]');
  const secondOption = root.querySelector<HTMLOptionElement>('option[value="roid-2"]');
  if (!select || !firstOption || !secondOption) {
    throw new Error('Asteroid target controls were not mounted');
  }
  expect(select.value).toBe('roid-2');

  // A user can have a native picker open while the next network pose arrives.
  // Keep that transient DOM choice until the controller publishes a new one.
  select.value = 'roid-1';
  overlay.update(
    state({
      selectedTargetId: 'roid-2',
      targets: [
        { id: 'roid-1', position: { x: 11, y: 12 }, size: 28, material: 'metal' },
        { id: 'roid-2', position: { x: 13, y: 14 }, size: 18, material: 'ice' },
      ],
      pilot: {
        id: 'pilot',
        position: { x: 10, y: 10 },
        kitId: 'hauler',
        alive: true,
        asteroidMotion: { epoch: 2, mode: 'latched', ack: 7 },
      },
    })
  );

  expect(root.querySelector('option[value="roid-1"]')).toBe(firstOption);
  expect(root.querySelector('option[value="roid-2"]')).toBe(secondOption);
  expect(select.value).toBe('roid-1');
  expect(firstOption.textContent).toBe('Metal · 2m');
});

test('overlay moves focus into the panel on open and restores the launcher on close', () => {
  const overlay = AsteroidToolsOverlay.mount();
  const root = overlay.getElement();
  const launcher = document.querySelector<HTMLButtonElement>('[data-asteroid-tools-action="open"]');
  const close = root.querySelector<HTMLButtonElement>('[data-asteroid-tools-action="close"]');
  const select = root.querySelector<HTMLSelectElement>('[data-asteroid-tools-target]');
  if (!launcher || !close || !select) {
    throw new Error('Asteroid tools focus controls were not mounted');
  }

  overlay.update(state({ active: false }));
  expect(launcher.hidden).toBe(false);
  launcher.focus();

  overlay.update(state({ active: true }));
  expect(document.activeElement).toBe(close);

  select.focus();
  overlay.update(
    state({
      active: true,
      targets: [
        { id: 'roid-1', position: { x: 9, y: 10 }, size: 28, material: 'metal' },
        { id: 'roid-2', position: { x: 11, y: 12 }, size: 18, material: 'ice' },
      ],
    })
  );
  expect(document.activeElement).toBe(select);

  overlay.update(state({ active: false }));
  expect(launcher.hidden).toBe(false);
  expect(document.activeElement).toBe(launcher);
});

test('overlay renders reflection preview and only live laser upgrade charges', () => {
  const expiresAt = Date.now() + 9_000;
  const overlay = AsteroidToolsOverlay.mount();
  overlay.update(
    state({
      pilot: {
        id: 'pilot',
        kitId: 'dart',
        alive: true,
        laserUpgrade: { charges: 2, expiresAt },
      },
      reflectionPreview: {
        segments: [{ start: { x: 0, y: 0 }, end: { x: 12, y: 0 }, asteroidId: 'roid-1' }],
        impacts: [],
        finalDirection: { x: 1, y: 0 },
        traveledDistance: 12,
        termination: 'distance',
      },
    })
  );
  const text = overlay.getElement().textContent ?? '';
  expect(text).toContain('Predicted bounce path');
  expect(text).toContain('2 charges');
  expect(text).toContain('s remaining');
  expect(text).toContain('Range limit');
  expect(overlay.getElement().querySelector('[data-asteroid-tools-motion]')).toBeTruthy();
  expect(overlay.getElement().querySelector('fieldset[aria-hidden="true"]')).toBeTruthy();

  overlay.update(
    state({
      pilot: {
        id: 'pilot',
        kitId: 'dart',
        alive: true,
        laserUpgrade: { charges: 2, expiresAt: Date.now() - 1 },
      },
    })
  );
  expect(
    (overlay.getElement().querySelector('.asteroid-tools-overlay__upgrade') as HTMLElement | null)
      ?.hidden
  ).toBe(true);
});

test('overlay hides motion controls for other kits and disables target actions without a selection', () => {
  const overlay = AsteroidToolsOverlay.mount();
  overlay.update(state({ pilot: { kitId: 'warden', alive: true } }));
  const motion = overlay.getElement().querySelector('fieldset[aria-hidden="true"]');
  expect(motion).toBeTruthy();
  expect((motion as HTMLElement).hidden).toBe(true);

  const unselectedState = state({
    pilot: { kitId: 'hauler', alive: true, asteroidMotion: { epoch: 2, mode: 'latched', ack: 7 } },
  });
  delete unselectedState.selectedTargetId;
  overlay.update(unselectedState);
  expect(
    (
      overlay
        .getElement()
        .querySelector('[data-asteroid-tools-motion="anchor"]') as HTMLButtonElement
    ).disabled
  ).toBe(true);
  expect(
    (
      overlay
        .getElement()
        .querySelector('[data-asteroid-tools-motion="brake"]') as HTMLButtonElement
    ).disabled
  ).toBe(true);
});
