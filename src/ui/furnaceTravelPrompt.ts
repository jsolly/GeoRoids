import './furnaceTravelPrompt.css';
import { isShipSchematicOpen } from './shipSchematicState';
import { canEnterTownStore } from './townStore';
import { isTownStoreOpen } from './townStoreState';
import { isUniverseMapOpen } from './universeMap';
import { shouldUseTouchControls } from './viewportChrome';

let prompt: HTMLDivElement | null = null;

/** Contextual boarding hint uses the same eligibility as E and the touch ability. */
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
    prompt.setAttribute('role', 'status');
    prompt.setAttribute('aria-live', 'polite');
    document.body.append(prompt);
  }
  const text = shouldUseTouchControls() ? 'Tap TRAVEL to open map' : 'Press E to travel';
  if (prompt.textContent !== text) {
    prompt.textContent = text;
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
