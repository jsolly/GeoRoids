import type { AbilityBody, AbilityHost } from './shipAbilities';
import { hullRadiusForKit } from './shipKits';

const cables = new WeakMap<AbilityHost, { targetId: string | undefined; length: number }>();
const TOW_HULL_GAP = 16;

function cargoRadius(rock: AbilityBody): number {
  const value = rock.r ?? rock.size;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 20;
}

/** Attaching preserves the rock's position and momentum; thrust makes the cable taut. */
export function attachTowCable(host: AbilityHost, rock: AbilityBody): void {
  cables.set(host, {
    targetId: rock.id,
    length: Math.max(
      hullRadiusForKit(host.kitId) + cargoRadius(rock) + TOW_HULL_GAP,
      Math.hypot(rock.position.x - host.position.x, rock.position.y - host.position.y)
    ),
  });
}

/** A damped cable only pulls when stretched. It never reels or throws cargo. */
export function tickTowCable(host: AbilityHost, rock: AbilityBody | undefined): void {
  const cable = cables.get(host);
  if (!cable) {
    return;
  }
  if (
    !rock ||
    !host.harpoonTargetId ||
    host.harpoonTargetId !== cable.targetId ||
    rock.id !== cable.targetId ||
    host.exploding ||
    host.health <= 0 ||
    rock.health === 0
  ) {
    cables.delete(host);
    return;
  }
  // Mild cargo drag damps swing while the Hauler supplies towing force.
  rock.velocity.x *= 0.98;
  rock.velocity.y *= 0.98;
  const dx = host.position.x - rock.position.x;
  const dy = host.position.y - rock.position.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= cable.length) {
    return;
  }
  const nx = dx / distance;
  const ny = dy / distance;
  const separatingSpeed =
    (host.velocity.x - rock.velocity.x) * nx + (host.velocity.y - rock.velocity.y) * ny;
  const impulse = Math.max(
    0,
    Math.min(0.08, (distance - cable.length) * 0.015 + separatingSpeed * 0.12)
  );
  rock.velocity.x += nx * impulse;
  rock.velocity.y += ny * impulse;
}
