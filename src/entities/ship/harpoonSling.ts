import { areAllied } from '../../../shared/factions';
import type { AbilityBody, AbilityHost } from './shipAbilities';
import { SHIP_ABILITY } from './shipKits';

/** Time to meet a constant-velocity ship with a rock launched at a fixed speed. */
function interceptFrames(dx: number, dy: number, vx: number, vy: number, speed: number): number {
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (dx * vx + dy * vy);
  const c = dx * dx + dy * dy;
  if (Math.abs(a) < 1e-8) {
    return b < 0 ? -c / b : Number.POSITIVE_INFINITY;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return Number.POSITIVE_INFINITY;
  }
  const root = Math.sqrt(discriminant);
  return Math.min(...[(-b - root) / (2 * a), (-b + root) / (2 * a)].filter((time) => time > 0));
}

interface SlingAim {
  x: number;
  y: number;
  time: number;
  id: string;
}

// Only authoritative activation creates this state; snapshots never predict forces.
const reels = new WeakMap<AbilityHost, { targetId: string | undefined; speed: number }>();

function chooseAim(
  host: AbilityHost,
  rock: AbilityBody,
  enemies: readonly AbilityBody[],
  speed: number,
  straightOnly = false
): SlingAim | undefined {
  let best: SlingAim | undefined;
  const momentum = Math.hypot(rock.velocity.x, rock.velocity.y);
  for (const enemy of enemies) {
    if (
      !enemy.id ||
      enemy.id === host.id ||
      enemy.kind === 'asteroid' ||
      areAllied(host.factionId, enemy.factionId) ||
      enemy.exploding ||
      (enemy.health !== undefined && enemy.health <= 0) ||
      (enemy.respawnTimer ?? 0) > 0 ||
      (enemy.spawnProtectionTimer ?? 0) > 0 ||
      enemy.shieldActive ||
      (enemy.shieldTimer ?? 0) > 0
    ) {
      continue;
    }
    const dx = enemy.position.x - rock.position.x;
    const dy = enemy.position.y - rock.position.y;
    const time = interceptFrames(dx, dy, enemy.velocity.x, enemy.velocity.y, speed);
    if (!Number.isFinite(time) || time > SHIP_ABILITY.HARPOON_INTERCEPT_FRAMES) {
      continue;
    }
    const x = dx + enemy.velocity.x * time;
    const y = dy + enemy.velocity.y * time;
    const distance = Math.hypot(x, y);
    if (distance === 0) {
      continue;
    }
    if (straightOnly) {
      if (momentum === 0) {
        continue;
      }
      const forwardX = rock.velocity.x / momentum;
      const forwardY = rock.velocity.y / momentum;
      // Test the actual unchanged trajectory at the predicted meeting time.
      const miss = Math.hypot(x - forwardX * speed * time, y - forwardY * speed * time);
      const corridor = (rock.r ?? rock.size ?? 20) + (enemy.r ?? enemy.size ?? 20);
      if (
        (x * forwardX + y * forwardY) / distance < SHIP_ABILITY.HARPOON_PATH_ALIGNMENT ||
        miss > corridor
      ) {
        continue;
      }
    }
    if (!best || time < best.time || (time === best.time && enemy.id < best.id)) {
      best = { x: x / distance, y: y / distance, time, id: enemy.id };
    }
  }
  return best;
}

/** Boost a clear momentum path; otherwise tension the tether before redirecting. */
export function slingHarpoonAsteroid(
  host: AbilityHost,
  rock: AbilityBody,
  enemies: readonly AbilityBody[]
): void {
  reels.delete(host);
  const momentum = Math.hypot(rock.velocity.x, rock.velocity.y);
  const speed = Math.max(SHIP_ABILITY.HARPOON_SLING_SPEED, momentum);
  if (chooseAim(host, rock, enemies, speed, true)) {
    rock.velocity.x *= speed / momentum;
    rock.velocity.y *= speed / momentum;
    return;
  }
  // View-aware latches can be far beyond the base range. Give the bounded
  // pull time to brake existing relative motion and cover that distance.
  const distance = Math.hypot(host.position.x - rock.position.x, host.position.y - rock.position.y);
  const relativeSpeed = Math.hypot(
    rock.velocity.x - host.velocity.x,
    rock.velocity.y - host.velocity.y
  );
  const acceleration = SHIP_ABILITY.HARPOON_REEL_ACCELERATION;
  const cruise = SHIP_ABILITY.HARPOON_REEL_SPEED;
  const brakingDistance = (relativeSpeed * relativeSpeed) / (2 * acceleration);
  const reelFrames = Math.ceil(
    (distance + brakingDistance) / cruise + (2 * (relativeSpeed + cruise)) / acceleration
  );
  host.harpoonTimer = Math.max(host.harpoonTimer, reelFrames);
  host.abilityActiveFrames = host.harpoonTimer;
  reels.set(host, { targetId: rock.id, speed });
}

/** Reel with bounded acceleration, then bounce once near the Hauler and coast. */
export function tickHarpoonSling(
  host: AbilityHost,
  rock: AbilityBody | undefined,
  enemies: readonly AbilityBody[]
): void {
  const reel = reels.get(host);
  if (!reel) {
    return;
  }
  if (
    !rock ||
    host.kitId !== 'hauler' ||
    host.harpoonTimer <= 0 ||
    host.exploding ||
    host.health <= 0 ||
    rock.exploding ||
    reel.targetId !== host.harpoonTargetId ||
    rock.id !== reel.targetId
  ) {
    reels.delete(host);
    return;
  }
  const dx = host.position.x - rock.position.x;
  const dy = host.position.y - rock.position.y;
  const distance = Math.hypot(dx, dy);
  const releaseRadius =
    (host.r ?? 20) + (rock.r ?? rock.size ?? 20) + SHIP_ABILITY.HARPOON_RELEASE_GAP;
  if (distance <= releaseRadius) {
    const aim = chooseAim(host, rock, enemies, reel.speed);
    // If the target disappeared, release away from the hull instead of chasing it.
    const x = aim?.x ?? (distance > 0 ? -dx / distance : Math.cos(host.angle));
    const y = aim?.y ?? (distance > 0 ? -dy / distance : -Math.sin(host.angle));
    rock.velocity.x = x * reel.speed;
    rock.velocity.y = y * reel.speed;
    reels.delete(host);
    return;
  }
  const desiredX = (dx / distance) * SHIP_ABILITY.HARPOON_REEL_SPEED + host.velocity.x;
  const desiredY = (dy / distance) * SHIP_ABILITY.HARPOON_REEL_SPEED + host.velocity.y;
  const changeX = desiredX - rock.velocity.x;
  const changeY = desiredY - rock.velocity.y;
  const change = Math.hypot(changeX, changeY);
  const fraction = change > 0 ? Math.min(1, SHIP_ABILITY.HARPOON_REEL_ACCELERATION / change) : 0;
  rock.velocity.x += changeX * fraction;
  rock.velocity.y += changeY * fraction;
}
