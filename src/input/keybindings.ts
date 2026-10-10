import { GAME } from '../constants';
import type { Player } from '../entities/player/Player';
import { worldFurnaces } from '../network/worldExploration';
import { canvasManager } from '../rendering/canvasSurface';
import { getOpenGameOverlay } from '../runtime/overlayState';
import { logger } from '../utils/Logger';
import { controlSources } from './controlSources';
import { steeringTurn } from './pointerSteering';

interface KeyStates {
  ArrowLeft: boolean;
  ArrowRight: boolean;
  Space: boolean;
  [key: string]: boolean;
}

export const keys: KeyStates = {
  ArrowLeft: false,
  ArrowRight: false,
  Space: false,
};

// Track pressed keys per-player to avoid cross-player/global interference (e.g., parallel tests)
const playerPressedKeys = new WeakMap<Player, Set<string>>();

export function getPressedKeysForPlayer(player: Player): Set<string> {
  let set = playerPressedKeys.get(player);
  if (!set) {
    set = new Set<string>();
    playerPressedKeys.set(player, set);
  }
  return set;
}

const TURN_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD']);

/** Explicit lock controls discard steering that predates the new flight mode. */
export function togglePlayerContourLock(player: Player): boolean {
  const wasLocked = player.ship.contourLocked;
  const active = player.ship.toggleContourLock();
  if (wasLocked !== active) {
    controlSources.pointerHeading = null;
    controlSources.steeringEpoch++;
    const pressed = getPressedKeysForPlayer(player);
    for (const code of TURN_KEYS) {
      pressed.delete(code);
      keys[code] = false;
    }
    player.ship.angularVelocity = 0;
  }
  return active;
}

const cargoHoverSessions = new WeakMap<Player, { furnaceId: string; released: boolean }>();

/** Cargo catches a lit intake rim; fresh steering releases the current visit. */
function updateCruise(player: Player): void {
  const alive = player.ship.health > 0 && !player.ship.exploding;
  const furnace =
    alive && player.cargo > 0
      ? worldFurnaces.intakeAt(player.ship.position, player.ship.r)
      : undefined;
  if (!furnace) {
    cargoHoverSessions.delete(player);
    player.ship.cargoHover = false;
  } else {
    let visit = cargoHoverSessions.get(player);
    if (!visit || visit.furnaceId !== furnace.id) {
      visit = { furnaceId: furnace.id, released: false };
      cargoHoverSessions.set(player, visit);
      // Discard the approach heading so an unfinished mouse/touch turn cannot
      // defeat docking. Held keys and subsequent steering still release it.
      controlSources.pointerHeading = null;
      player.ship.angularVelocity = 0;
    }
    const steering =
      player.ship.angularVelocity !== 0 ||
      [...getPressedKeysForPlayer(player)].some((code) => TURN_KEYS.has(code));
    if (steering) {
      visit.released = true;
    }
    player.ship.cargoHover = !visit.released;
  }
  player.ship.thrusting = alive && !player.ship.movementLocked && !player.ship.cargoHover;
  if (!alive) {
    player.ship.releaseContourLock('inactive');
  }
}

// Helper to set angular velocity from the aggregate turn-key state. Supports
// both arrow keys (ArrowLeft/ArrowRight) and WASD (KeyA/KeyD); opposing keys
// held together cancel out. Using the per-player pressed set (rather than the
// global `keys` map) keeps combinations correct across arrow/WASD mixes.
function turnSpeedForShip(player: Player): number {
  return (player.ship.turnSpeed * Math.PI) / (180 * GAME.FPS);
}

function updateTurnFromKeys(player: Player): void {
  if (player.ship.movementLocked || player.ship.health <= 0 || player.ship.exploding) {
    player.ship.angularVelocity = 0;
    return;
  }
  if (player.ship.contourLocked) {
    player.ship.angularVelocity = 0;
    return;
  }
  const pressed = getPressedKeysForPlayer(player);
  const turningLeft = pressed.has('ArrowLeft') || pressed.has('KeyA');
  const turningRight = pressed.has('ArrowRight') || pressed.has('KeyD');
  const turnSpeed = turnSpeedForShip(player);

  if (turningLeft && !turningRight) {
    player.ship.angularVelocity = turnSpeed;
  } else if (turningRight && !turningLeft) {
    player.ship.angularVelocity = -turnSpeed;
  } else {
    // Neither held, or both held (opposing turns cancel).
    player.ship.angularVelocity = 0;
  }

  if (!turningLeft && !turningRight) {
    const heading = controlSources.pointerHeading;
    player.ship.angularVelocity =
      heading === null
        ? 0
        : steeringTurn(player.ship.angle, heading + canvasManager.getCameraRotation(), turnSpeed);
  }
}

/** Reconcile steering and cruise once per simulation step, also after input changes. */
export function reconcilePlayerInput(player: Player): void {
  updateTurnFromKeys(player);
  updateCruise(player);
}

export function keyDown(ev: KeyboardEvent, player: Player): void {
  if (getOpenGameOverlay() !== null) {
    return;
  }
  logger.debug('KEYBINDINGS', 'KeyDown called', {
    key: ev.code,
    shipExploding: player.ship.exploding,
  });

  if (
    TURN_KEYS.has(ev.code) &&
    (player.ship.contourLocked || (ev.repeat && !getPressedKeysForPlayer(player).has(ev.code)))
  ) {
    return;
  }
  if (player.ship.health > 0 && !player.ship.exploding) {
    if (ev.code in keys) {
      keys[ev.code] = true;
    }
    // Record pressed key for this player
    getPressedKeysForPlayer(player).add(ev.code);
    switch (ev.code) {
      case 'Space':
        // Space fires while automatic cruise continues.
        if (getOpenGameOverlay() === null) {
          player.ship.shoot();
        }
        break;
      case 'KeyE':
        if (!ev.repeat && getOpenGameOverlay() === null) {
          player.ship.activateAbility();
        }
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        if (!ev.repeat) {
          togglePlayerContourLock(player);
        }
        break;
      case 'ArrowLeft':
      case 'KeyA':
      case 'ArrowRight':
      case 'KeyD':
        controlSources.pointerHeading = null;
        logger.debug('KEYBINDINGS', 'Updating rotation', { key: ev.code });
        reconcilePlayerInput(player);
        break;
      default:
        break;
    }
  }
}

export function keyUp(ev: KeyboardEvent, player: Player): void {
  logger.debug('KEYBINDINGS', 'KeyUp called', {
    key: ev.code,
    shipExploding: player.ship.exploding,
  });

  // Always update keys state first
  if (ev.code in keys) {
    keys[ev.code] = false;
  }

  // Update per-player pressed keys set
  getPressedKeysForPlayer(player).delete(ev.code);

  logger.debug('KEYBINDINGS', 'After key removal', {
    remainingKeys: Array.from(getPressedKeysForPlayer(player)),
    globalKeys: { ...keys },
  });

  // Space is the fire key; on release simply re-arm the next shot (mirrors the
  // left-mouse behavior). Handled regardless of alive state so it never sticks.
  if (ev.code === 'Space') {
    player.ship.canShoot = true;
    return;
  }

  // Reconcile cruise/turn from the remaining held keys. Done regardless of
  // health/exploding so releasing a key never leaves a dead ship stuck
  // thrusting or spinning. Both arrows and WASD funnel through the same
  // aggregate helpers.
  switch (ev.code) {
    case 'ArrowLeft':
    case 'KeyA':
    case 'ArrowRight':
    case 'KeyD':
      reconcilePlayerInput(player);
      break;
    default:
      break;
  }
}
