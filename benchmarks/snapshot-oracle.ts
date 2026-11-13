import assert from 'node:assert/strict';
import type { GameEngine } from '../server/core/GameEngine';
import { canCollectEquipment, isEquipmentId } from '../shared/equipment';
import { validateSnapshotDto } from '../shared/snapshotDto';
import { quantizeSnapshotKinematics } from '../shared/snapshotPrecision';
import { isActiveScanner } from '../shared/surveyScan';
import { nearbyAsteroidRows, nearbyWorldRows } from '../shared/world';
import type { ServerGameSnapshot } from '../shared-types';

/** Public engine state is independent of broadcaster preparation/baselines. */
export function recipientSnapshotOracle(engine: GameEngine, id: string): ServerGameSnapshot {
  const player = engine.getPlayer(id);
  assert(player, 'Oracle pilot is missing');
  const common = engine.getSnapshotState();
  const source = {
    ...common,
    asteroids: nearbyAsteroidRows(
      engine.getAllAsteroids(),
      player.position,
      isActiveScanner(player)
    ),
    loot: nearbyWorldRows(engine.getLoot(), player.position).filter(
      (drop) => !isEquipmentId(drop.kind) || canCollectEquipment(player, drop.kind)
    ),
    satellitePickups: [
      ...common.satellitePickups.filter((pickup) => pickup.ownerId === id),
      ...nearbyWorldRows(
        common.satellitePickups.filter(
          (pickup) => pickup.ownerId !== id && pickup.state !== 'stored'
        ),
        player.position
      ),
    ],
    playerProjectiles: nearbyWorldRows(engine.getPlayerProjectiles(), player.position),
  } satisfies ServerGameSnapshot;
  const owned: unknown = JSON.parse(JSON.stringify(source));
  validateSnapshotDto(owned);
  quantizeSnapshotKinematics(owned);
  return owned;
}
