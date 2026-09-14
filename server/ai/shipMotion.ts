import { PLAYER_MOTION } from '../../shared/playerMotion';
import { cruiseSpeed } from '../../shared/shipFlight';
import { GROWTH, thrustScaleFromMass } from '../../shared/shipGrowth';
import type { Position, ShipKitId, Velocity } from '../../shared-types';
import { GAME } from '../../src/constants';
import { getShipKit } from '../../src/entities/ship/shipKits';
import { applySharedShipSlope } from '../../src/physics/terrain/applyShipSlope';

interface MovableShip {
  kitId: ShipKitId;
  position: Position;
  velocity: Velocity;
  angle: number;
  thrusting: boolean;
  mass?: number;
  knockbackVelocityLimit?: number;
}

/**
 * One client-frame of shared ship motion (thrust, mass cap, friction, slope).
 */
export function applyShipMotionFrame(ship: MovableShip): void {
  const kit = getShipKit(ship.kitId);
  const mass = ship.mass ?? GROWTH.BASE_MASS;
  const thrustScale = thrustScaleFromMass(mass);
  const blastLimit = ship.knockbackVelocityLimit ?? 0;
  const maxVelocity = Math.max(cruiseSpeed(mass, kit.maxVelocity), blastLimit);

  if (ship.thrusting) {
    ship.velocity.x += (Math.cos(ship.angle) * kit.thrust * thrustScale) / GAME.FPS;
    ship.velocity.y -= (Math.sin(ship.angle) * kit.thrust * thrustScale) / GAME.FPS;
    const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
    if (speed > maxVelocity) {
      const scale = maxVelocity / speed;
      ship.velocity.x *= scale;
      ship.velocity.y *= scale;
    }
  } else {
    const drag = 1 - GAME.FRICTION / GAME.FPS;
    ship.velocity.x *= drag;
    ship.velocity.y *= drag;
  }

  applySharedShipSlope(ship.velocity, ship.position);
  const afterSlope = Math.hypot(ship.velocity.x, ship.velocity.y);
  const absoluteLimit = Math.max(kit.maxVelocity, blastLimit);
  if (afterSlope > absoluteLimit) {
    const scale = absoluteLimit / afterSlope;
    ship.velocity.x *= scale;
    ship.velocity.y *= scale;
  }

  if (ship.knockbackVelocityLimit !== undefined) {
    ship.knockbackVelocityLimit *= PLAYER_MOTION.knockbackRetention;
  }
  ship.position.x += ship.velocity.x;
  ship.position.y += ship.velocity.y;
}
