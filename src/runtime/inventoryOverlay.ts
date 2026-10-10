import { playFeedback } from '../audio/feedbackSounds';
import { PlayerManager } from '../entities/player/PlayerManager';
import {
  closeGameOverlay,
  isGameOverlayOpen,
  openGameOverlay,
  subscribeGameOverlay,
} from './overlayState';

export function openInventory(inPlay: boolean): void {
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  if (!inPlay || !ship || ship.health <= 0 || ship.exploding || ship.furnaceTransit) {
    return;
  }
  openGameOverlay('inventory');
}

/** Scoped shortcuts live beside the command port, never in the component or simulation. */
export function mountInventoryShortcuts(inPlay: () => boolean): () => void {
  const scope = new AbortController();
  document.addEventListener(
    'keydown',
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable]')
      ) {
        return;
      }
      if (event.code === 'KeyV' && inPlay()) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          if (isGameOverlayOpen('inventory')) {
            closeGameOverlay('inventory');
          } else {
            openInventory(true);
          }
        }
        return;
      }
      if (!isGameOverlayOpen('inventory')) {
        return;
      }
      if (event.code === 'KeyM' || event.code === 'KeyB') {
        // The map and store command listeners handle these shortcuts.
        return;
      }
      if (event.code === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeGameOverlay('inventory');
      } else if (event.code === 'Space' && event.target instanceof HTMLButtonElement) {
        event.stopPropagation();
      } else if (
        [
          'Space',
          'KeyE',
          'KeyA',
          'KeyD',
          'ArrowLeft',
          'ArrowRight',
          'ShiftLeft',
          'ShiftRight',
        ].includes(event.code)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { capture: true, signal: scope.signal }
  );
  const stopFeedback = subscribeInventoryFeedback();
  return () => {
    scope.abort();
    stopFeedback();
    closeGameOverlay('inventory');
  };
}

function subscribeInventoryFeedback(): () => void {
  return subscribeGameOverlay((next, previous) => {
    if (next === 'inventory') {
      window.dispatchEvent(new CustomEvent('gameSchematicOpen'));
    }
    if (next === 'inventory' || previous === 'inventory') {
      playFeedback('interface');
    }
  });
}
