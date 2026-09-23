import type { Player } from '../entities/player/Player';
import { canvasManager } from '../rendering/canvasSurface';
import { isShipSchematicOpen } from '../ui/shipSchematicState';
import { isTownStoreOpen } from '../ui/townStoreState';
import { logger } from '../utils/Logger';
import { controlSources } from './controlSources';
import { reconcilePlayerInput } from './keybindings';
import { pointerHeadingFromCenter } from './pointerSteering';

/* =============
Mouse Input Handling
============= */

function isSyntheticTouchMouse(ev: MouseEvent): boolean {
  return Boolean(
    (ev as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities
      ?.firesTouchEvents
  );
}

export function handleMouseMove(ev: MouseEvent, player: Player): void {
  if (isSyntheticTouchMouse(ev)) {
    return;
  }
  if (player.ship.health <= 0 || player.ship.exploding) {
    return;
  }

  const canvas = canvasManager.getCanvas();
  if (!canvas) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const dx = ev.clientX - rect.left - rect.width / 2;
  const dy = ev.clientY - rect.top - rect.height / 2;
  controlSources.pointerHeading = pointerHeadingFromCenter(dx, dy, player.ship.r);
  reconcilePlayerInput(player);
}

export function handleMouseDown(ev: MouseEvent, player: Player): void {
  if (isSyntheticTouchMouse(ev)) {
    return;
  }
  logger.debug('MOUSE', 'Mouse down event', {
    button: ev.button,
    playerId: player.id,
    exploding: player.ship.exploding,
  });
  if (
    isShipSchematicOpen() ||
    isTownStoreOpen() ||
    player.ship.health <= 0 ||
    player.ship.exploding
  ) {
    logger.debug('MOUSE', 'Mouse down ignored - player dead or exploding', { playerId: player.id });
    return;
  }

  // Left mouse fires; right mouse toggles boost like Shift.
  if (ev.button === 0) {
    logger.debug('MOUSE', 'Left mouse click - shooting', { playerId: player.id });
    player.ship.shoot();
  } else if (ev.button === 2) {
    player.ship.toggleBoost();
  }
}

export function handleMouseUp(ev: MouseEvent, player: Player): void {
  if (isSyntheticTouchMouse(ev)) {
    return;
  }
  // Early return for dead/exploding players
  if (player.ship.health <= 0 || player.ship.exploding) {
    return;
  }

  if (ev.button === 0) {
    // Allow next laser shot on release (mirrors Space key previous behavior)
    player.ship.canShoot = true;
  }
}

export function preventContextMenu(ev: MouseEvent): void {
  ev.preventDefault();
}
