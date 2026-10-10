import { canEquipUtility } from '../../shared/equipment';
import type { HaulerUtilityId, ScoutUtilityId } from '../../shared-types';
import { playFeedback } from '../audio/feedbackSounds';
import { GAME, SATELLITE_PICKUP } from '../constants';
import { PlayerManager } from '../entities/player/PlayerManager';
import {
  SATELLITE_INVENTORY_PAGE_SIZE,
  SatellitePickupManager,
} from '../entities/satellitePickup/SatellitePickupManager';
import {
  HAULER_UTILITY,
  HAULER_UTILITY_IDS,
  haulerUtilityOf,
  isHaulerUtilityId,
  preferredHaulerUtility,
  rememberHaulerUtility,
} from '../entities/ship/haulerUtility';
import {
  isScoutUtilityId,
  preferredScoutUtility,
  rememberScoutUtility,
  SCOUT_UTILITY,
  SCOUT_UTILITY_IDS,
  scoutUtilityOf,
} from '../entities/ship/scoutUtility';
import { setHaulerUtilityOnHost, setScoutUtilityOnHost } from '../entities/ship/shipAbilities';
import { getShipKit } from '../entities/ship/shipKits';
import { NetworkManager } from '../network/networkManager';
import type { SchematicSelection } from '../rendering/shipSchematicCanvas';
import type { InventoryView } from './uiTypes';

function canUseInventory(): boolean {
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  return ship !== undefined && ship.health > 0 && !ship.exploding && !ship.furnaceTransit;
}

export function readSchematicSelection(): SchematicSelection {
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  return Object.freeze({
    kitId: ship?.kitId ?? 'hauler',
    haulerUtility: ship ? haulerUtilityOf(ship) : preferredHaulerUtility(),
    scoutUtility: ship ? scoutUtilityOf(ship) : preferredScoutUtility(),
  });
}

export function readInventoryView(requestedPage: number): InventoryView {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const ship = player?.ship;
  const manager = SatellitePickupManager.getInstance();
  const total = player ? manager.getOwnedCount(player.id) : 0;
  const pages = Math.max(1, Math.ceil(total / SATELLITE_INVENTORY_PAGE_SIZE));
  const page = Number.isFinite(requestedPage)
    ? Math.min(pages - 1, Math.max(0, Math.floor(requestedPage)))
    : 0;
  const selection = readSchematicSelection();
  const tools: InventoryView['tools'] =
    selection.kitId === 'hauler'
      ? HAULER_UTILITY_IDS.map((id) =>
          Object.freeze({
            id,
            name: HAULER_UTILITY[id].name,
            copy: HAULER_UTILITY[id].copy,
            selected: selection.haulerUtility === id,
            available: ship !== undefined && canUseInventory() && canEquipUtility(ship, id),
          })
        )
      : SCOUT_UTILITY_IDS.map((id) =>
          Object.freeze({
            id,
            name: SCOUT_UTILITY[id].name,
            copy: SCOUT_UTILITY[id].copy,
            selected: selection.scoutUtility === id,
            available: ship !== undefined && canUseInventory() && canEquipUtility(ship, id),
          })
        );
  return Object.freeze({
    page,
    pages,
    total,
    silk: player?.silk ?? 0,
    description: `Equip one satellite to identify asteroids within ${SATELLITE_PICKUP.SCAN_RANGE} units. Full health lasts ${SATELLITE_PICKUP.LIFETIME_FRAMES / GAME.FPS} seconds of flight. Health drains while equipped; damage shortens its remaining lifetime.`,
    canEquipSatellite:
      player !== null &&
      NetworkManager.getInstance().isConnected &&
      canUseInventory() &&
      manager.getEquipped(player.id) === undefined,
    kitName: getShipKit(selection.kitId).name,
    items: Object.freeze(
      (player ? manager.getOwnedPage(player.id, page) : []).map((pickup) =>
        Object.freeze({
          id: pickup.id,
          name: pickup.name,
          health: Math.ceil(pickup.health),
          maxHealth: pickup.maxHealth,
          remainingSeconds: Math.ceil(
            ((pickup.health / pickup.maxHealth) * SATELLITE_PICKUP.LIFETIME_FRAMES) / GAME.FPS
          ),
          equipped: pickup.state === 'orbiting',
        })
      )
    ),
    tools: Object.freeze(tools),
  });
}

export function equipInventorySatellite(id: string): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const network = NetworkManager.getInstance();
  const manager = SatellitePickupManager.getInstance();
  const pickup = manager.get(id);
  if (
    !player ||
    !network.isConnected ||
    !canUseInventory() ||
    !pickup ||
    pickup.ownerId !== player.id ||
    pickup.state !== 'stored' ||
    pickup.health <= 0 ||
    manager.getEquipped(player.id)
  ) {
    return;
  }
  network.sendMessage({
    type: 'equipSatellite',
    id: network.getLocalPlayerId() || player.id,
    data: { pickupId: id },
  });
}

export function equipInventoryUtility(id: HaulerUtilityId | ScoutUtilityId): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || !canUseInventory() || !canEquipUtility(player.ship, id)) {
    return;
  }
  const ship = player.ship;
  const network = NetworkManager.getInstance();
  if (ship.kitId === 'hauler' && isHaulerUtilityId(id)) {
    if (haulerUtilityOf(ship) !== id) {
      playFeedback('interface');
    }
    rememberHaulerUtility(id);
    setHaulerUtilityOnHost(ship, id);
    if (network.isConnected) {
      network.sendMessage({
        type: 'setHaulerUtility',
        id: network.getLocalPlayerId() || player.id,
        data: { utilityId: id },
      });
    }
  } else if (ship.kitId === 'scout' && isScoutUtilityId(id)) {
    if (scoutUtilityOf(ship) !== id) {
      playFeedback('interface');
    }
    rememberScoutUtility(id);
    setScoutUtilityOnHost(ship, id);
    if (network.isConnected) {
      network.sendMessage({
        type: 'setScoutUtility',
        id: network.getLocalPlayerId() || player.id,
        data: { utilityId: id },
      });
    }
  }
}
