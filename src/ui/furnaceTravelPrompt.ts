import './furnaceTravelPrompt.css';
import { isShipSchematicOpen } from './shipSchematicState';
import { canEnterTownStore, openTownStore } from './townStore';
import { isTownStoreOpen } from './townStoreState';
import { isUniverseMapOpen } from './universeMap';
import { shouldUseTouchControls } from './viewportChrome';

let prompt: HTMLDivElement | null = null;
let travelButton: HTMLButtonElement | null = null;
let keyboardHint: HTMLSpanElement | null = null;

/** Boarding is a contextual touch action; desktop keeps its E shortcut. */
export function syncFurnaceTravelPrompt(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const visible =
    canEnterTownStore() && !isTownStoreOpen() && !isShipSchematicOpen() && !isUniverseMapOpen();
  if (!visible) {
    if (prompt) {
      prompt.hidden = true;
    }
    return;
  }
  if (!prompt?.isConnected) {
    prompt = document.createElement('div');
    prompt.id = 'furnace-travel-prompt';
    travelButton = document.createElement('button');
    travelButton.type = 'button';
    travelButton.textContent = 'Tap to travel';
    travelButton.addEventListener('click', (event) => {
      event.stopPropagation();
      // Open after the tap completes so it cannot land on a new modal control.
      if (shouldUseTouchControls() && !isShipSchematicOpen() && !isUniverseMapOpen()) {
        openTownStore();
        syncFurnaceTravelPrompt();
      }
    });
    for (const type of ['keydown', 'keyup']) {
      travelButton.addEventListener(type, (event) => {
        if (event instanceof KeyboardEvent && (event.code === 'Space' || event.code === 'Enter')) {
          event.stopPropagation();
        }
      });
    }
    keyboardHint = document.createElement('span');
    keyboardHint.textContent = 'Press E to travel';
    keyboardHint.setAttribute('role', 'status');
    prompt.append(travelButton, keyboardHint);
    document.body.append(prompt);
  }
  const touch = shouldUseTouchControls();
  if (travelButton && keyboardHint) {
    travelButton.hidden = !touch;
    keyboardHint.hidden = touch;
  }
  prompt.hidden = false;
}

if (typeof window !== 'undefined') {
  window.addEventListener('playViewOff', () => {
    if (prompt) {
      prompt.hidden = true;
    }
  });
}
