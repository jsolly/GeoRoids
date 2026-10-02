import { onDarkFurnaceFootprint } from '../../shared/furnaceField';
import { PlayerManager } from '../entities/player/PlayerManager';
import { worldFurnaces } from '../network/worldExploration';
import { SCOUT_ONLY_BUILD_HINT } from './constants';
import { hideFieldHints, setFieldHint } from './fieldHint';
import { isShipSchematicOpen } from './shipSchematicState';
import { canEnterTownStore, isAtTownSquare, openTownStore } from './townStore';
import { isTownStoreOpen } from './townStoreState';
import { isUniverseMapOpen } from './universeMap';
import { shouldUseTouchControls } from './viewportChrome';

/** A Hauler on a dark lot's footprint learns who can light it. */
function haulerOnDarkLot(): boolean {
  if (!document.body.classList.contains('in-play')) {
    return false;
  }
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  if (ship?.kitId !== 'hauler' || ship.exploding || ship.health <= 0 || ship.furnaceTransit) {
    return false;
  }
  return onDarkFurnaceFootprint(ship.position, (id) => worldFurnaces.isLit(id));
}

function boardFromTap(): void {
  // Open after the tap completes so it cannot land on a new modal control,
  // and only while the ship is still on the footprint that offered it.
  if (canEnterTownStore() && !isShipSchematicOpen() && !isUniverseMapOpen()) {
    openTownStore();
    syncFurnaceTravelPrompt();
  }
}

/** Furnace footprint prompts: boarding on lit furnaces, the Scout-only note on dark lots. */
export function syncFurnaceTravelPrompt(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const overlaysClosed = !isTownStoreOpen() && !isShipSchematicOpen() && !isUniverseMapOpen();
  const travel = overlaysClosed && canEnterTownStore();
  if (travel) {
    const town = isAtTownSquare();
    // Boarding is a contextual touch action; desktop keeps its E shortcut.
    setFieldHint(
      'furnace-travel-prompt',
      true,
      shouldUseTouchControls()
        ? { action: { label: town ? 'Enter' : 'Tap to travel', run: boardFromTap } }
        : { text: town ? 'Press E to enter' : 'Press E to travel' }
    );
  } else {
    // Hidden hints ignore content; skip viewport/media queries until boarding is available.
    setFieldHint('furnace-travel-prompt', false);
  }
  setFieldHint('furnace-build-hint', overlaysClosed && !travel && haulerOnDarkLot(), {
    text: SCOUT_ONLY_BUILD_HINT,
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('playViewOff', hideFieldHints);
}
