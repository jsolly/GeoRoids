import type { ShipKitId } from '../../shared-types';
import { parseShipKitId } from '../entities/ship/shipKits';
import { getStoredItem, setStoredItem } from '../utils/safeStorage';

const SELECTED_KIT_STORAGE_KEY = 'georoids.selectedShipKit';

let selectedKitId: ShipKitId = parseShipKitId(getStoredItem(SELECTED_KIT_STORAGE_KEY));

export function getSelectedShipKitId(): ShipKitId {
  return selectedKitId;
}

export function setSelectedShipKitId(kitId: unknown): ShipKitId {
  selectedKitId = parseShipKitId(kitId);
  setStoredItem(SELECTED_KIT_STORAGE_KEY, selectedKitId);
  return selectedKitId;
}
