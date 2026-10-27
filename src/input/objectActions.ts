import { COOPERATIVE } from '../../shared/cooperativeRules';
import { CIVIC_LOTS, civicLot, TOWN_HEARTH } from '../../shared/furnaces';
import { WORLD } from '../../shared/world';
import type { Position } from '../../shared-types';
import type { Player } from '../entities/player/Player';
import { Roid } from '../entities/roid/Roid';
import { beginNavigation, stopNavigation } from '../entities/ship/navigation';
import { readAsteroidBelt } from '../network/services/asteroidFieldSync';
import { ConnectionManager } from '../network/services/ConnectionManager';
import { cooperativeActive } from '../network/worldCampaign';
import { getWorldMapAssets, worldFurnaces } from '../network/worldExploration';
import { canvasManager } from '../rendering/canvasSurface';
import { canEnterTownStore, openTownStore } from '../runtime/townStore';

type ActionTarget = {
  id: string;
  name: string;
  kind: 'furnace' | 'foundation' | 'asteroid' | 'ship' | 'location';
  position: Position;
  radius: number;
  detail: string;
};
export type ObjectAction = 'fly' | 'inspect' | 'signal' | 'enter' | 'unload' | 'build';
export type ObjectMenu = {
  x: number;
  y: number;
  target: ActionTarget;
  actions: { action: ObjectAction; label: string; disabled: boolean }[];
};

/** Furnace prompts use the local hearth index and fixed civic catalogue, never the asteroid field. */
export function nearbyFurnaceTarget(player: Player): ActionTarget | undefined {
  let nearest: { id: string; name: string; position: Position; radius: number } | undefined;
  let nearestDistance = Infinity;
  for (const sites of [
    CIVIC_LOTS,
    worldFurnaces.nearby(player.ship.position, TOWN_HEARTH.radius + 2 * player.ship.r),
  ]) {
    for (const site of sites) {
      const distance = Math.hypot(
        site.position.x - player.ship.position.x,
        site.position.y - player.ship.position.y
      );
      if (distance <= site.radius + 2 * player.ship.r && distance < nearestDistance) {
        nearest = site;
        nearestDistance = distance;
      }
    }
  }
  return nearest
    ? {
        ...nearest,
        kind: worldFurnaces.isLit(nearest.id) ? 'furnace' : 'foundation',
        detail: nearest.name,
      }
    : undefined;
}

export function interactionTargets(player: Player): ActionTarget[] {
  const assets: ActionTarget[] = getWorldMapAssets()
    .filter((a) => a.kind === 'furnace' || a.kind === 'foundation')
    .map((a) => ({
      ...a,
      kind: a.kind === 'furnace' ? 'furnace' : 'foundation',
      radius: civicLot(a.id)?.radius ?? TOWN_HEARTH.radius,
      detail: a.name,
    }));
  if (!assets.some((a) => a.id === TOWN_HEARTH.id)) {
    assets.push({ ...TOWN_HEARTH, kind: 'furnace', detail: 'Store and furnace travel' });
  }
  for (const r of readAsteroidBelt().filter((rock) => rock instanceof Roid)) {
    assets.push({
      id: r.id,
      name: 'Asteroid',
      kind: 'asteroid',
      position: r.position,
      radius: r.r,
      detail: `Hull ${Math.ceil(r.health)} / ${r.maxHealth}`,
    });
  }
  for (const p of ConnectionManager.getInstance().getAllPlayers()) {
    if (p.id !== player.id && p.ship.health > 0) {
      assets.push({
        id: p.id,
        name: p.name,
        kind: 'ship',
        position: p.ship.position,
        radius: p.ship.r,
        detail: `${p.name} · ${Math.ceil(p.ship.health)} hull`,
      });
    }
  }
  const frame = canvasManager.getViewportSize();
  const scale = canvasManager.readInputScale();
  return assets.filter(
    (a) =>
      Math.abs(a.position.x - player.ship.position.x) * scale <=
        frame.width / 2 + a.radius * scale &&
      Math.abs(a.position.y - player.ship.position.y) * scale <= frame.height / 2 + a.radius * scale
  );
}

export function worldPoint(player: Player, x: number, y: number): Position {
  const rect = canvasManager.getCanvas()?.getBoundingClientRect();
  const frame = canvasManager.getViewportSize();
  const scale = canvasManager.readInputScale();
  const point = {
    x: player.ship.position.x + (x - (rect?.left ?? 0) - frame.width / 2) / scale,
    y: player.ship.position.y + (y - (rect?.top ?? 0) - frame.height / 2) / scale,
  };
  const distance = Math.hypot(point.x, point.y);
  return distance > WORLD.radius
    ? { x: (point.x * WORLD.radius) / distance, y: (point.y * WORLD.radius) / distance }
    : point;
}

export function objectMenuAt(player: Player, x: number, y: number): ObjectMenu {
  const position = worldPoint(player, x, y);
  const scale = canvasManager.readInputScale();
  const target = interactionTargets(player)
    .filter(
      (a) =>
        Math.hypot(a.position.x - position.x, a.position.y - position.y) <=
        Math.max(a.radius, 22 / scale)
    )
    .sort(
      (a, b) =>
        Math.hypot(a.position.x - position.x, a.position.y - position.y) -
        Math.hypot(b.position.x - position.x, b.position.y - position.y)
    )[0] ?? { id: '', kind: 'location', name: 'Location', position, radius: 0, detail: '' };
  return { x, y, target, actions: actionsForTarget(player, target) };
}

export function actionsForTarget(player: Player, target: ActionTarget): ObjectMenu['actions'] {
  const actions: ObjectMenu['actions'] = [{ action: 'fly', label: 'Fly here', disabled: false }];
  if (target.kind !== 'location') {
    actions.push({ action: 'inspect', label: 'Inspect', disabled: false });
  }
  const canSignal =
    cooperativeActive() &&
    Math.hypot(
      target.position.x - player.ship.position.x,
      target.position.y - player.ship.position.y
    ) <= COOPERATIVE.signalRadius;
  actions.push({
    action: 'signal',
    label: !cooperativeActive()
      ? 'Signal · campaign required'
      : canSignal
        ? 'Signal crew'
        : 'Signal · out of range',
    disabled: !canSignal,
  });
  if (target.kind === 'furnace') {
    actions.push({
      action: 'enter',
      label: target.id === TOWN_HEARTH.id ? 'Enter' : 'Travel',
      disabled: false,
    });
    actions.push({
      action: 'unload',
      label: player.cargo > 0 ? 'Unload cargo' : 'Unload · hold empty',
      disabled: player.cargo <= 0,
    });
  }
  if (target.kind === 'foundation') {
    const lot = civicLot(target.id);
    const reason =
      player.ship.kitId !== 'scout'
        ? 'Scout required'
        : player.score < (lot?.cost ?? Infinity)
          ? 'More points required'
          : null;
    actions.push({
      action: 'build',
      label: reason ? `Build · ${reason}` : 'Build furnace',
      disabled: reason !== null,
    });
  }
  return actions;
}

export function chooseObjectAction(
  player: Player,
  target: ActionTarget,
  action: ObjectAction
): string {
  const offered = actionsForTarget(player, target).find((item) => item.action === action);
  if (!offered || offered.disabled) {
    return offered?.label ?? 'Action unavailable';
  }
  if (action === 'inspect') {
    return `${target.name}: ${target.detail}`;
  }
  if (action === 'signal') {
    ConnectionManager.getInstance().sendMessage({
      type: 'crewAction',
      id: player.id,
      data: { kind: 'signal', signal: 'help', position: target.position },
    });
    return 'Crew signal requested';
  }
  stopNavigation(player.ship);
  beginNavigation(player.ship, target.position);
  if (action !== 'fly') {
    player.ship.pendingObjectAction = { id: target.id, action };
    tickObjectApproach(player);
  }
  return action === 'fly'
    ? ''
    : player.ship.pendingObjectAction
      ? `Approaching ${target.name}`
      : player.ship.navigationStatus;
}

export function tickObjectApproach(player: Player): void {
  const pending = player.ship.pendingObjectAction;
  if (!pending) {
    return;
  }
  const asset = getWorldMapAssets().find((a) => a.id === pending.id);
  const position = pending.id === TOWN_HEARTH.id ? TOWN_HEARTH.position : asset?.position;
  if (
    !position ||
    (pending.action === 'build'
      ? worldFurnaces.isLit(pending.id)
      : !worldFurnaces.isLit(pending.id))
  ) {
    stopNavigation(player.ship);
    player.ship.navigationStatus = 'Action no longer available';
    return;
  }
  const distance = Math.hypot(
    position.x - player.ship.position.x,
    position.y - player.ship.position.y
  );
  const radius = civicLot(pending.id)?.radius ?? TOWN_HEARTH.radius;
  if (distance > radius - player.ship.r) {
    return;
  }
  stopNavigation(player.ship);
  player.ship.velocity = { x: 0, y: 0 };
  if (pending.action === 'enter' && canEnterTownStore()) {
    openTownStore();
  }
  if (pending.action === 'build') {
    player.ship.activateAbility();
  }
  // Cargo offloading is already automatic at the authoritative intake.
  player.ship.navigationStatus = pending.action === 'unload' ? 'Unloading cargo' : '';
}
