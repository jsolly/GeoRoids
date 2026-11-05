import { GAME, SHIP } from '../../../shared/constants/gameplay';
import type { Position } from '../../../shared-types';
import { steeringTurn } from '../../input/pointerSteering';
import type { Ship } from './Ship';

export type NavigationOrder = {
  destination: Position;
  lastPosition: Position;
  stalledFrames: number;
};

/** A fixed world destination never moves with the camera. */
export function beginNavigation(ship: Ship, destination: Position): void {
  ship.releaseContourLock();
  ship.navigation = {
    destination: { ...destination },
    lastPosition: { ...ship.position },
    stalledFrames: 0,
  };
  ship.navigationStatus = '';
}

export function stopNavigation(ship: Ship): void {
  ship.navigation = null;
  ship.pendingObjectAction = null;
  ship.releaseContourLock();
  ship.thrusting = false;
  ship.angularVelocity = 0;
}

/** Returns the speed envelope for this frame, including arrival braking. */
export function steerNavigation(ship: Ship) {
  const order = ship.navigation;
  if (!order) {
    return null;
  }
  const dx = order.destination.x - ship.position.x;
  const dy = order.destination.y - ship.position.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= ship.r) {
    ship.navigation = null;
    ship.velocity = { x: 0, y: 0 };
    ship.thrusting = false;
    ship.angularVelocity = 0;
    ship.arrivalFrames = 12;
    return 0;
  }
  const moved = Math.hypot(
    ship.position.x - order.lastPosition.x,
    ship.position.y - order.lastPosition.y
  );
  order.lastPosition = { ...ship.position };
  // Only count a stall once the pilot has had time to turn and accelerate.
  order.stalledFrames = moved < 0.05 && ship.thrusting ? order.stalledFrames + 1 : 0;
  if (order.stalledFrames >= GAME.FPS) {
    stopNavigation(ship);
    ship.navigationStatus = 'Route blocked';
    return 0;
  }
  const desired = Math.atan2(-dy, dx);
  ship.angularVelocity = steeringTurn(
    ship.angle,
    desired,
    (SHIP.TURN_SPEED * Math.PI) / (180 * GAME.FPS)
  );
  const error = Math.atan2(Math.sin(desired - ship.angle), Math.cos(desired - ship.angle));
  ship.thrusting = Math.abs(error) < Math.PI / 3;
  return Math.min(
    SHIP.MAX_VELOCITY,
    Math.sqrt(((2 * SHIP.THRUST) / GAME.FPS) * Math.max(0, distance - ship.r))
  );
}
