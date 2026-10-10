import { logger } from '../../setup/serverLogger';
import { type ContourReleaseReason, contourLockGeometry } from '../../shared/contourLock';
import type { GameEntity } from './EntityManager';

/** Log the actual transition once, before any caller clears or rebases the transform. */
export function releaseActorContourLock(
  actor: GameEntity,
  reason: ContourReleaseReason,
  now?: number
): void {
  const lock = actor.contourLock;
  if (!lock) {
    return;
  }
  logger.info('STATE', 'contour_lock_released', {
    playerId: actor.id,
    reason,
    ...(now !== undefined ? { receivedAt: now } : {}),
    motionEpoch: actor.playerMotion?.epoch,
    motionAck: actor.playerMotion?.ack,
    position: { ...actor.position },
    velocity: { ...actor.velocity },
    lock: { ...lock },
    ...contourLockGeometry(actor.position, lock),
  });
  actor.contourLock = null;
}
