import type { ShipKitId } from '../../shared-types';
import { activateAudio } from '../audio/audioRuntime';
import { playFeedback } from '../audio/feedbackSounds';
import { kitHullPickerSvg } from '../entities/ship/hullOutlines';
import { listShipKits, parseShipKitId } from '../entities/ship/shipKits';
import { attachEventListener, getElementById } from '../utils/dom';
import { getStoredItem, setStoredItem } from '../utils/safeStorage';

const SELECTED_KIT_STORAGE_KEY = 'georoids.selectedShipKit';

let selectedKitId: ShipKitId = parseShipKitId(getStoredItem(SELECTED_KIT_STORAGE_KEY));

export function getSelectedShipKitId(): ShipKitId {
  return selectedKitId;
}

export function setSelectedShipKitId(kitId: unknown): ShipKitId {
  selectedKitId = parseShipKitId(kitId);
  setStoredItem(SELECTED_KIT_STORAGE_KEY, selectedKitId);
  syncKitButtons();
  return selectedKitId;
}

function syncKitButtons(): void {
  const grid = document.querySelector('#ship-kit-grid');
  if (!grid) {
    return;
  }
  const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>('[data-kit-id]'));
  for (const button of buttons) {
    const isSelected = button.dataset['kitId'] === selectedKitId;
    button.classList.toggle('is-selected', isSelected);
    button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  }
}

export function mountShipKitSelect(): void {
  const grid = getElementById<HTMLElement>('ship-kit-grid');
  if (!grid) {
    return;
  }

  grid.replaceChildren();
  for (const kit of listShipKits()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ship-kit-card';
    button.dataset['kitId'] = kit.id;
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `${kitHullPickerSvg(kit.id)}<span class="ship-kit-name">${kit.name}</span><span class="ship-kit-ability">${kit.abilityName}</span><span class="ship-kit-role">${kit.abilityHint}</span>`;
    attachEventListener(button, 'click', () => {
      activateAudio();
      const changed = getSelectedShipKitId() !== kit.id;
      setSelectedShipKitId(kit.id);
      if (changed) {
        playFeedback('interface');
      }
    });
    grid.appendChild(button);
  }
  syncKitButtons();
}
