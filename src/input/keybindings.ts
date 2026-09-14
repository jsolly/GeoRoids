import { GAME } from '../constants';
import type { Player } from '../entities/player/Player';
import { applyShipKitToShip, DEFAULT_SHIP_KIT_ID } from '../entities/ship/shipKits';
import { getSelectedShipKitId } from '../ui/shipKitSelect';
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

/** The live local ship cruises regardless of which controls are held. */
function updateCruise(player: Player): void {
  const alive = player.lives > 0 && player.ship.health > 0 && !player.ship.exploding;
  player.ship.thrusting = alive;
}

// Helper to set angular velocity from the aggregate turn-key state. Supports
// both arrow keys (ArrowLeft/ArrowRight) and WASD (KeyA/KeyD); opposing keys
// held together cancel out. Using the per-player pressed set (rather than the
// global `keys` map) keeps combinations correct across arrow/WASD mixes.
function turnSpeedForShip(player: Player): number {
  return (player.ship.turnSpeed * Math.PI) / (180 * GAME.FPS);
}

function updateTurnFromKeys(player: Player): void {
  if (player.lives <= 0 || player.ship.health <= 0 || player.ship.exploding) {
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
      heading === null ? 0 : steeringTurn(player.ship.angle, heading, turnSpeed);
  }
}

/** Reconcile steering and cruise once per simulation step, also after input changes. */
export function reconcilePlayerInput(player: Player): void {
  updateTurnFromKeys(player);
  updateCruise(player);
}

export function keyDown(ev: KeyboardEvent, player: Player): void {
  logger.debug('KEYBINDINGS', 'KeyDown called', {
    key: ev.code,
    playerLives: player.lives,
    shipExploding: player.ship.exploding,
  });

  if (player.lives > 0 && !player.ship.exploding) {
    if (ev.code in keys) {
      keys[ev.code] = true;
    }
    // Record pressed key for this player
    getPressedKeysForPlayer(player).add(ev.code);
    switch (ev.code) {
      case 'Space':
        // Space fires while automatic cruise continues.
        player.ship.shoot();
        break;
      case 'KeyE':
        if (!ev.repeat) {
          const selectedKit = getSelectedShipKitId();
          // Title kit only wins when the live ship is still the default Dart.
          // A stale dart menu must not strip Quake / Hauler mid-match.
          if (player.ship.kitId === DEFAULT_SHIP_KIT_ID && selectedKit !== player.ship.kitId) {
            applyShipKitToShip(player.ship, selectedKit);
          }
          player.ship.activateAbility();
        }
        break;
      case 'KeyF':
        if (!ev.repeat) {
          player.ship.requestShieldToggle();
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
    }
  }
}

export function keyUp(ev: KeyboardEvent, player: Player): void {
  logger.debug('KEYBINDINGS', 'KeyUp called', {
    key: ev.code,
    playerLives: player.lives,
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
  // lives/exploding so releasing a key never leaves a dead ship stuck
  // thrusting or spinning. Both arrows and WASD funnel through the same
  // aggregate helpers.
  switch (ev.code) {
    case 'ArrowLeft':
    case 'KeyA':
    case 'ArrowRight':
    case 'KeyD':
      reconcilePlayerInput(player);
      break;
  }
}
