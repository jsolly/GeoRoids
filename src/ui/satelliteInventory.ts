import type { SatellitePickupData } from '../../shared-types';
import { GAME, SATELLITE_PICKUP } from '../constants';
import { PlayerManager } from '../entities/player/PlayerManager';
import { SatellitePickupManager } from '../entities/satellitePickup/SatellitePickupManager';
import { NetworkManager } from '../network/networkManager';

const rendered = new WeakMap<
  HTMLElement,
  { signature: string; pickups: Map<string, { name: string; state: string }> }
>();

/** Refresh only changed values so snapshot ticks do not steal keyboard focus. */
export function renderSatelliteInventory(
  container: HTMLElement,
  status: HTMLElement,
  fallbackFocus: HTMLButtonElement
): void {
  const player = PlayerManager.getInstance().getLocalPlayer();
  const network = NetworkManager.getInstance();
  const owned = SatellitePickupManager.getInstance()
    .getAll()
    .filter(
      (pickup) =>
        pickup.ownerId === player?.id && (pickup.state === 'stored' || pickup.state === 'orbiting')
    );
  const active = owned.find((pickup) => pickup.state === 'orbiting');
  const canEquip =
    network.isConnected &&
    player !== null &&
    player.ship.health > 0 &&
    !player.ship.exploding &&
    !active;
  const signature = JSON.stringify([
    canEquip,
    player?.silk ?? 0,
    owned.map((pickup) => [
      pickup.id,
      pickup.state,
      Math.ceil(pickup.health),
      remainingSeconds(pickup),
    ]),
  ]);
  const previous = rendered.get(container);
  if (previous?.signature === signature) {
    return;
  }
  const pickups = new Map(owned.map(({ id, name, state }) => [id, { name, state }]));
  rendered.set(container, { signature, pickups });
  if (previous) {
    const announcements: string[] = [];
    for (const [id, pickup] of pickups) {
      if (previous.pickups.get(id)?.state !== pickup.state) {
        announcements.push(
          `${pickup.name} ${pickup.state === 'orbiting' ? 'equipped' : 'acquired'}.`
        );
      }
    }
    for (const [id, pickup] of previous.pickups) {
      if (!pickups.has(id)) {
        announcements.push(
          `${pickup.name} ${pickup.state === 'orbiting' ? 'no longer equipped' : 'removed from inventory'}.`
        );
      }
    }
    if (announcements.length > 0) {
      status.textContent = announcements.join(' ');
    }
  }
  const previousFocus =
    container.contains(document.activeElement) && document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset['pickupId']
      : undefined;
  container.replaceChildren();
  const silk = document.createElement('p');
  silk.className = 'satellite-inventory-silk';
  const silkCount = player?.silk ?? 0;
  silk.textContent = `Spider silk: ${silkCount} ${silkCount === 1 ? 'bundle' : 'bundles'} stored. No use yet.`;
  container.append(silk);
  if (owned.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'satellite-inventory-empty';
    empty.textContent = 'No satellites stored. Fly near a loose satellite to collect it.';
    container.append(empty);
    if (previousFocus) {
      fallbackFocus.focus({ preventScroll: true });
    }
    return;
  }
  for (const pickup of owned) {
    const row = document.createElement('div');
    row.className = 'satellite-inventory-row';
    const info = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = pickup.name;
    const detail = document.createElement('span');
    const seconds = remainingSeconds(pickup);
    detail.textContent =
      pickup.state === 'orbiting'
        ? `Equipped · ${Math.ceil(pickup.health)}/${pickup.maxHealth} HP · ${seconds}s remaining`
        : `Stored · ${Math.ceil(pickup.health)}/${pickup.maxHealth} HP · ${seconds}s lifetime`;
    info.append(name, detail);
    row.append(info);
    if (pickup.state === 'stored') {
      const equip = document.createElement('button');
      equip.type = 'button';
      equip.textContent = 'Equip';
      equip.dataset['pickupId'] = pickup.id;
      equip.setAttribute('aria-label', `Equip ${pickup.name}`);
      equip.disabled = !canEquip;
      equip.addEventListener('click', () => {
        if (!player || !network.isConnected) {
          return;
        }
        network.sendMessage({
          type: 'equipSatellite',
          id: network.getLocalPlayerId() || player.id,
          data: { pickupId: pickup.id },
        });
      });
      row.append(equip);
    }
    container.append(row);
  }
  if (previousFocus) {
    for (const button of container.querySelectorAll<HTMLButtonElement>('button[data-pickup-id]')) {
      if (button.dataset['pickupId'] === previousFocus && !button.disabled) {
        button.focus({ preventScroll: true });
        return;
      }
    }
    fallbackFocus.focus({ preventScroll: true });
  }
}

export function satelliteInventoryDescription(): string {
  return `Equip one satellite to identify asteroids within ${SATELLITE_PICKUP.SCAN_RANGE} units. Full health lasts ${SATELLITE_PICKUP.LIFETIME_FRAMES / GAME.FPS} seconds of flight. Health drains while equipped; damage shortens its remaining lifetime.`;
}

function remainingSeconds(pickup: Pick<SatellitePickupData, 'health' | 'maxHealth'>): number {
  return Math.ceil(
    ((pickup.health / pickup.maxHealth) * SATELLITE_PICKUP.LIFETIME_FRAMES) / GAME.FPS
  );
}
