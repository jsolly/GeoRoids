import { onDarkFurnaceFootprint } from '../../shared/furnaceField';
import { civicLotAt } from '../../shared/furnaces';
import { PlayerManager } from '../entities/player/PlayerManager';
import { actionsForTarget, chooseObjectAction, nearbyFurnaceTarget } from '../input/objectActions';
import { worldFurnaces } from '../network/worldExploration';
import { getOpenGameOverlay } from '../runtime/overlayState';
import { canEnterTownStore, isAtTownSquare, openTownStore } from '../runtime/townStore';
import { formatPoints } from '../utils/formatPoints';
import { SCOUT_ONLY_BUILD_HINT } from './constants';
import { hideFieldHints, setFieldHint } from './fieldHint';
import { isPlayViewOn } from './uiUtils';
import { shouldUseTouchControls } from './viewportChrome';

/** Explain who can build, or the Scout's missing points, on a dark foundation. */
function darkLotBuildHint(): string | undefined {
  if (!isPlayViewOn()) {
    return undefined;
  }
  const player = PlayerManager.getInstance().getLocalPlayer();
  const ship = player?.ship;
  if (!player || !ship || ship.exploding || ship.health <= 0 || ship.furnaceTransit) {
    return undefined;
  }
  if (!onDarkFurnaceFootprint(ship.position, (id) => worldFurnaces.isLit(id))) {
    return undefined;
  }
  if (ship.kitId === 'hauler') {
    return SCOUT_ONLY_BUILD_HINT;
  }
  const lot = civicLotAt(ship.position);
  if (ship.kitId === 'scout' && lot && player.score < lot.cost) {
    const remaining = lot.cost - Math.max(0, player.score);
    return `You need ${formatPoints(remaining)} more ${remaining === 1 ? 'point' : 'points'} to build this furnace`;
  }
  return undefined;
}

function boardFromTap(): void {
  // Open after the tap completes so it cannot land on a new modal control,
  // and only while the ship is still on the footprint that offered it.
  if (canEnterTownStore() && getOpenGameOverlay() === null) {
    openTownStore();
    syncFurnaceTravelPrompt();
  }
}

/** Furnace footprint prompts: boarding on lit furnaces, the Scout-only note on dark lots. */
export function syncFurnaceTravelPrompt(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const overlaysClosed = getOpenGameOverlay() === null;
  const player = PlayerManager.getInstance().getLocalPlayer();
  const candidate =
    player &&
    player.ship.health > 0 &&
    !player.ship.exploding &&
    !player.ship.furnaceTransit &&
    isPlayViewOn()
      ? nearbyFurnaceTarget(player)
      : undefined;
  const canBoard = canEnterTownStore();
  const touchMode = (candidate !== undefined || canBoard) && shouldUseTouchControls();
  const nearby = candidate && touchMode ? candidate : undefined;
  const offer =
    nearby && player
      ? actionsForTarget(player, nearby).find(
          (a) => a.action === (nearby.kind === 'foundation' ? 'build' : 'enter')
        )
      : undefined;
  const unavailableBuild = offer?.action === 'build' && offer.disabled;
  const travel = overlaysClosed && (canBoard || (nearby !== undefined && !unavailableBuild));
  if (travel) {
    const town = isAtTownSquare();
    // Boarding is a contextual touch action; desktop keeps its E shortcut.
    setFieldHint(
      'furnace-travel-prompt',
      true,
      touchMode
        ? offer?.disabled
          ? { text: offer.label }
          : {
              action: {
                label: offer?.label ?? (town ? 'Enter' : 'Travel'),
                run: () => {
                  if (nearby && player) {
                    chooseObjectAction(
                      player,
                      nearby,
                      nearby.kind === 'foundation' ? 'build' : 'enter'
                    );
                    syncFurnaceTravelPrompt();
                  } else {
                    boardFromTap();
                  }
                },
              },
            }
        : { text: town ? 'Press E to enter' : 'Press E to travel' }
    );
  } else {
    // Hidden hints ignore content; skip viewport/media queries until boarding is available.
    setFieldHint('furnace-travel-prompt', false);
  }
  const buildHint =
    overlaysClosed && !travel
      ? (darkLotBuildHint() ?? (unavailableBuild ? offer.label : undefined))
      : undefined;
  setFieldHint(
    'furnace-build-hint',
    buildHint !== undefined,
    buildHint === undefined ? {} : { text: buildHint }
  );
}

export function mountFurnaceTravelPrompt(signal: AbortSignal): void {
  window.addEventListener('playViewOff', hideFieldHints, { signal });
}
