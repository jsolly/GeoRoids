import { GAME, SHIP } from '../../../shared/constants/gameplay';
import { contourDraftMultiplier } from '../../../shared/contourBridge';
import { contourLockSpeed } from '../../../shared/contourLock';
import { capMotionVelocity } from '../../../shared/playerMotion';
import { terrainSpeedLimit } from '../../../shared/terrainTravel';
import type { ServerEntityData } from '../../../shared-types';
import type { Ship } from '../ship/Ship';

// Presentation only. Velocity is pixels per simulation tick, not pixels per second.
const EXTRAPOLATION_FRAMES = GAME.FPS / 10;
const CORRECTION_FRAMES = GAME.FPS / 10;
const MAX_CORRECTION_DISTANCE = SHIP.SIZE * 4;

type Pose = Pick<ServerEntityData, 'position' | 'velocity' | 'angle'>;
type MotionSample = Pose & {
  epoch: number | undefined;
  receivedAt: number;
  ageFrames: number;
  offset: Pose['position'];
  angleOffset: number;
};

/** A bounded display projection. Never feed the rendered pose back into its baseline. */
export class RemoteShipMotion {
  private sample: MotionSample | null = null;

  reset(): void {
    this.sample = null;
  }

  receive(ship: Ship, pose: Pose, blocked: boolean): void {
    const epoch = ship.playerMotion?.epoch;
    const previous = this.sample;
    const dx = ship.position.x - pose.position.x;
    const dy = ship.position.y - pose.position.y;
    const reset =
      blocked ||
      !previous ||
      previous.epoch !== epoch ||
      Math.hypot(dx, dy) > MAX_CORRECTION_DISTANCE;
    const maximum = ship.contourLock
      ? contourLockSpeed(SHIP.MAX_VELOCITY) * contourDraftMultiplier(ship.contourDraftFrames)
      : terrainSpeedLimit(pose.position, SHIP.MAX_VELOCITY);
    this.sample = blocked
      ? null
      : {
          position: { ...pose.position },
          velocity: capMotionVelocity(pose.velocity, maximum),
          angle: pose.angle,
          epoch,
          receivedAt: performance.now(),
          ageFrames: 0,
          offset: reset ? { x: 0, y: 0 } : { x: dx, y: dy },
          angleOffset: reset
            ? 0
            : Math.atan2(Math.sin(ship.angle - pose.angle), Math.cos(ship.angle - pose.angle)),
        };
    if (reset) {
      ship.position.x = pose.position.x;
      ship.position.y = pose.position.y;
      ship.angle = pose.angle;
    }
  }

  advance(ship: Ship): void {
    const sample = this.sample;
    if (!sample) {
      return;
    }
    // Receipt age also expires hidden-tab or stalled-loop samples, even when
    // the game deliberately discards its old simulation debt on resume.
    sample.ageFrames = Math.min(EXTRAPOLATION_FRAMES, sample.ageFrames + 1);
    const ageFrames = Math.min(
      EXTRAPOLATION_FRAMES,
      Math.max(sample.ageFrames, ((performance.now() - sample.receivedAt) * GAME.FPS) / 1000)
    );
    const remainingCorrection = Math.max(0, 1 - ageFrames / CORRECTION_FRAMES);
    ship.position.x =
      sample.position.x + sample.velocity.x * ageFrames + sample.offset.x * remainingCorrection;
    ship.position.y =
      sample.position.y + sample.velocity.y * ageFrames + sample.offset.y * remainingCorrection;
    ship.angle = sample.angle + sample.angleOffset * remainingCorrection;
  }
}
