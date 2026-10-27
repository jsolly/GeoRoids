import { GAME, SHIP } from '../../shared/constants/gameplay';
import { sampleGradient } from '../../shared/heightfield';
import { getTerrainField } from '../../shared/terrainField';
import type { Player } from '../entities/player/Player';
import { stopNavigation } from '../entities/ship/navigation';
import { worldFurnaces } from '../network/worldExploration';
import { getOpenGameOverlay } from '../runtime/overlayState';
import { controlSources } from './controlSources';
import { steeringTurn } from './pointerSteering';

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
  if (active) {
    player.ship.navigation = null;
    player.ship.pendingObjectAction = null;
  }
  if (wasLocked !== active) {
    controlSources.pointerHeading = null;
    controlSources.steeringEpoch++;
    const pressed = getPressedKeysForPlayer(player);
    for (const code of TURN_KEYS) {
      pressed.delete(code);
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
      getPressedKeysForPlayer(player).has('KeyW') ||
      getPressedKeysForPlayer(player).has('ArrowUp') ||
      player.ship.navigation !== null ||
      player.ship.angularVelocity !== 0 ||
      [...getPressedKeysForPlayer(player)].some((code) => TURN_KEYS.has(code));
    if (steering) {
      visit.released = true;
    }
    player.ship.cargoHover = !visit.released;
  }
  const pressed = getPressedKeysForPlayer(player);
  player.ship.thrusting =
    alive &&
    !player.ship.movementLocked &&
    !player.ship.cargoHover &&
    (pressed.has('KeyW') || pressed.has('ArrowUp') || player.ship.navigation !== null);
  if (player.ship.navigation) {
    player.ship.cargoHover = false;
  }
  if (!alive) {
    player.ship.releaseContourLock();
  }
}

// Set angular velocity from the aggregate turn-key state. Supports
// both arrow keys (ArrowLeft/ArrowRight) and WASD (KeyA/KeyD); opposing keys
// held together cancel out. Using the per-player pressed set rather than
// another player's state) keeps combinations correct across arrow/WASD mixes.
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
  const turnSpeed = (SHIP.TURN_SPEED * Math.PI) / (180 * GAME.FPS);

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
      heading === null ? 0 : steeringTurn(player.ship.angle, heading, turnSpeed);
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

  if (
    TURN_KEYS.has(ev.code) &&
    (player.ship.contourLocked || (ev.repeat && !getPressedKeysForPlayer(player).has(ev.code)))
  ) {
    return;
  }
  if (player.ship.health > 0 && !player.ship.exploding) {
    // Record pressed key for this player
    getPressedKeysForPlayer(player).add(ev.code);
    switch (ev.code) {
      case 'KeyF':
        if (!ev.repeat) {
          player.ship.beginWeaponCharge();
        }
        break;
      case 'BracketLeft':
      case 'BracketRight': {
        if (!ev.repeat && player.ship.contourLock) {
          const gradient = sampleGradient(
            getTerrainField(),
            player.ship.position.x,
            player.ship.position.y
          );
          const side = ev.code === 'BracketLeft' ? -1 : 1;
          player.ship.hopContour({ x: gradient.x * side, y: gradient.y * side }, true);
        }
        break;
      }
      case 'Space':
        // Space fires independently of propulsion.
        player.ship.shoot();
        break;
      case 'KeyE':
        if (!ev.repeat) {
          player.ship.activateAbility();
        }
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        if (!ev.repeat) {
          togglePlayerContourLock(player);
        }
        break;
      case 'KeyW':
      case 'ArrowUp':
        if (!ev.repeat) {
          stopNavigation(player.ship);
        }
        reconcilePlayerInput(player);
        break;
      case 'ArrowLeft':
      case 'KeyA':
      case 'ArrowRight':
      case 'KeyD':
        controlSources.pointerHeading = null;

        reconcilePlayerInput(player);
        break;
      default:
        break;
    }
  }
}

export function keyUp(ev: KeyboardEvent, player: Player): void {
  if (ev.code === 'KeyF') {
    player.ship.finishWeaponCharge(getOpenGameOverlay() === null);
  }

  // Update per-player pressed keys set
  getPressedKeysForPlayer(player).delete(ev.code);

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
    case 'KeyW':
    case 'ArrowUp':
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
