import assert from 'node:assert/strict';
import { beforeEach, expect, test } from 'vitest';
import { listShipKits } from '../../../src/entities/ship/shipKits';
import {
  getSelectedShipKitId,
  mountShipKitSelect,
  setSelectedShipKitId,
} from '../../../src/ui/shipKitSelect';

beforeEach(() => {
  setSelectedShipKitId('scout');
  mountShipKitSelect();
});

test('kit picker lists the two kits and selects Scout by default', () => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#ship-kit-grid [data-kit-id]')];
  expect(buttons.map((button) => button.dataset['kitId'])).toEqual(
    listShipKits().map((kit) => kit.id)
  );
  expect(getSelectedShipKitId()).toBe('scout');
  expect(buttons[0]?.classList.contains('is-selected')).toBe(true);
  expect(buttons.every((button) => button.querySelector('svg.ship-kit-silhouette'))).toBe(true);
});

test('clicking Hauler stores that kit for join', () => {
  const hauler = document.querySelector<HTMLButtonElement>('[data-kit-id="hauler"]');
  assert.ok(hauler);
  hauler.click();
  expect(getSelectedShipKitId()).toBe('hauler');
  expect(hauler.getAttribute('aria-pressed')).toBe('true');
});

test('Hauler selection survives a remount so join is not stuck on Scout', () => {
  const hauler = document.querySelector<HTMLButtonElement>('[data-kit-id="hauler"]');
  assert.ok(hauler);
  hauler.click();
  expect(getSelectedShipKitId()).toBe('hauler');
  mountShipKitSelect();
  expect(getSelectedShipKitId()).toBe('hauler');
  expect(
    document
      .querySelector<HTMLButtonElement>('[data-kit-id="hauler"]')
      ?.getAttribute('aria-pressed')
  ).toBe('true');
});
