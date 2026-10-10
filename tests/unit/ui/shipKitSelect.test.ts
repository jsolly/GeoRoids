import { expect, test } from 'vitest';
import { getSelectedShipKitId, setSelectedShipKitId } from '../../../src/runtime/shipSelection';

test('a selected Hauler is stored for the next join and invalid choices restore Scout', () => {
  setSelectedShipKitId('hauler');
  expect(getSelectedShipKitId()).toBe('hauler');
  expect(localStorage.getItem('georoids.selectedShipKit')).toBe('hauler');
  setSelectedShipKitId('unknown');
  expect(getSelectedShipKitId()).toBe('scout');
  expect(localStorage.getItem('georoids.selectedShipKit')).toBe('scout');
});
