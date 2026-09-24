import type { FurnaceTransit, Position } from '../../shared-types';

/** Game headings are Y-up; Canvas rotations are clockwise in Y-down space. */
type Traveler = { angle: number; velocity: Position; furnaceTransit?: FurnaceTransit | null };
const courses = new WeakMap<Traveler, number>();

/** Hold the last course while stopped. A new ship starts with its nose pointing up. */
export function travelCameraRotation(ship: Traveler): number {
  const moving = Math.hypot(ship.velocity.x, ship.velocity.y) > 0.01;
  // Pipe rides set the nose from the route tangent and zero free-flight velocity.
  const course = ship.furnaceTransit
    ? ship.angle
    : moving
      ? Math.atan2(-ship.velocity.y, ship.velocity.x)
      : (courses.get(ship) ?? ship.angle);
  courses.set(ship, course);
  return course - Math.PI / 2;
}

export function rotateVectorInto(out: Position, x: number, y: number, rotation: number): Position {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  out.x = x * cosine - y * sine;
  out.y = x * sine + y * cosine;
  return out;
}

/** World-axis bounds enclosing every corner of a rotated viewport. */
export function rotatedViewSize(width: number, height: number, rotation: number) {
  const cosine = Math.abs(Math.cos(rotation));
  const sine = Math.abs(Math.sin(rotation));
  return { width: width * cosine + height * sine, height: width * sine + height * cosine };
}
