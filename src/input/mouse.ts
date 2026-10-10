import type { Player } from '../entities/player/Player';
import { canvasManager } from '../rendering/canvasSurface';
import { getOpenGameOverlay } from '../runtime/overlayState';
import { controlSources } from './controlSources';
import { reconcilePlayerInput, togglePlayerContourLock } from './keybindings';
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
  if (player.ship.contourLocked || player.ship.health <= 0 || player.ship.exploding) {
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

  if (getOpenGameOverlay() !== null || player.ship.health <= 0 || player.ship.exploding) {
    return;
  }

  // Left mouse fires; right mouse toggles Contour Lock like Shift.
  if (ev.button === 0) {
    player.ship.shoot();
  } else if (ev.button === 2) {
    togglePlayerContourLock(player);
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
