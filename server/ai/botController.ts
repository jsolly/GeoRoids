import type { Position, SoftFactionId, Velocity } from '../../shared-types';
import { DEBUG, SHIP } from '../../src/constants';
import { canDealCombatDamage } from '../../src/entities/player/softFactions';
import { calculateLaserStartPosition } from '../../src/entities/ship/shipUtils';
import type { GameEntity } from '../core/EntityManager';
import type { RNGService } from '../core/RNGService';
import {
  headingTo,
  laserSpeedPerFrame,
  STEER_IN_RADIUS,
  shipTurnPerFrame,
  shortestAngleDelta,
  turnToward,
} from './shipMotion';

/** Controller-only knobs. Hull/collision stay on the shared ship constants. */
export const BOT_AI = {
  /** Start shooting / chasing inside this distance (px). */
  ENGAGE_RANGE: 720,
  /** Coast / hold fire-pocket around this range. */
  PREFERRED_RANGE: 260,
  /** Too close — stop thrusting into the target. */
  CLOSE_RANGE: 120,
  /** Max |heading error| to fire at preferred range (radians). */
  FIRE_ALIGN_NEAR: 0.28,
  /** Tighter cone at long range so they do not snipe with wild lead. */
  FIRE_ALIGN_FAR: 0.1,
  /** Face-target cone that still allows thrust (radians). */
  THRUST_ALIGN: 0.7,
  SHOT_COOLDOWN_TICKS: 10, // ~320ms at 30 Hz
  REACTION_TICKS: 3, // ~100ms acquire delay
  BURST_SIZE: 2,
  BURST_PAUSE_TICKS: 16, // ~530ms after a pair
  AIM_JITTER_MAX: 0.09,
  LEAD_SCALE_MIN: 0.78,
  LEAD_SCALE_MAX: 1.04,
  MOTION_STEPS: 2,
} as const;

export interface Combatant {
  id: string;
  position: Position;
  velocity: Velocity;
  health: number;
  exploding: boolean;
  spawnProtectionTimer?: number;
  factionId?: SoftFactionId;
}

export interface BotShot {
  botId: string;
  laserStart: Position;
  laserDirection: Velocity;
}

export interface BotDecision {
  angle: number;
  thrusting: boolean;
  fire: boolean;
}

export interface BotMemory {
  ticks: number;
  lastShotTick: number;
  burstShots: number;
  burstPauseUntilTick: number;
  nextFireTick: number;
  wasAligned: boolean;
  aimBias: number;
  leadScale: number;
  wanderAngle: number;
}

export function isCombatantAlive(entity: Combatant): boolean {
  return !entity.exploding && entity.health > 0;
}

export function isSpawnProtected(entity: Combatant): boolean {
  return (entity.spawnProtectionTimer ?? 0) > 0;
}

export function chooseTarget(bot: Combatant, humans: Combatant[]): Combatant | null {
  let best: Combatant | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const human of humans) {
    if (!isCombatantAlive(human) || !canDealCombatDamage(bot.factionId, human.factionId)) {
      continue;
    }
    const dist = Math.hypot(human.position.x - bot.position.x, human.position.y - bot.position.y);
    if (dist < bestDist) {
      best = human;
      bestDist = dist;
    }
  }

  return best;
}

/**
 * Quadratic intercept in the shooter's inertial frame. Laser inherits ship
 * velocity, so relative velocity is target − shooter.
 */
export function interceptTime(
  relPos: Position,
  relVel: Velocity,
  projectileSpeed: number
): number | null {
  const a = relVel.x * relVel.x + relVel.y * relVel.y - projectileSpeed * projectileSpeed;
  const b = 2 * (relPos.x * relVel.x + relPos.y * relVel.y);
  const c = relPos.x * relPos.x + relPos.y * relPos.y;

  if (Math.abs(a) < 1e-8) {
    if (Math.abs(b) < 1e-8) {
      return null;
    }
    const t = -c / b;
    return t > 0 ? t : null;
  }

  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    return null;
  }

  const sqrt = Math.sqrt(disc);
  const t1 = (-b - sqrt) / (2 * a);
  const t2 = (-b + sqrt) / (2 * a);
  const hits = [t1, t2].filter((t) => t > 0);
  if (hits.length === 0) {
    return null;
  }
  return Math.min(...hits);
}

export function leadAimPoint(shooter: Combatant, target: Combatant, leadScale: number): Position {
  const relPos = {
    x: target.position.x - shooter.position.x,
    y: target.position.y - shooter.position.y,
  };
  const relVel = {
    x: target.velocity.x - shooter.velocity.x,
    y: target.velocity.y - shooter.velocity.y,
  };
  const t = interceptTime(relPos, relVel, laserSpeedPerFrame());
  if (t === null) {
    return { x: target.position.x, y: target.position.y };
  }
  const scaled = t * leadScale;
  return {
    x: target.position.x + target.velocity.x * scaled,
    y: target.position.y + target.velocity.y * scaled,
  };
}

export function fireAlignThreshold(range: number): number {
  const t = Math.max(0, Math.min(1, range / BOT_AI.ENGAGE_RANGE));
  return BOT_AI.FIRE_ALIGN_NEAR + (BOT_AI.FIRE_ALIGN_FAR - BOT_AI.FIRE_ALIGN_NEAR) * t;
}

export function createBotMemory(rng: Pick<RNGService, 'random'>, heading: number): BotMemory {
  return {
    ticks: 0,
    lastShotTick: Number.NEGATIVE_INFINITY,
    burstShots: 0,
    burstPauseUntilTick: 0,
    nextFireTick: Number.POSITIVE_INFINITY,
    wasAligned: false,
    aimBias: (rng.random() - 0.5) * 2 * BOT_AI.AIM_JITTER_MAX,
    leadScale:
      BOT_AI.LEAD_SCALE_MIN + rng.random() * (BOT_AI.LEAD_SCALE_MAX - BOT_AI.LEAD_SCALE_MIN),
    wanderAngle: heading,
  };
}

export function decideBotAction(
  bot: Combatant & { angle: number },
  target: Combatant | null,
  memory: BotMemory,
  rng: Pick<RNGService, 'random'>
): BotDecision {
  memory.ticks += 1;

  const distFromCenter = Math.hypot(bot.position.x, bot.position.y);
  const nearWall = distFromCenter > STEER_IN_RADIUS;

  let desired = memory.wanderAngle;
  let range = Number.POSITIVE_INFINITY;
  let angleError = 0;

  if (nearWall) {
    desired = headingTo(bot.position, { x: 0, y: 0 });
  } else if (target) {
    const aim = leadAimPoint(bot, target, memory.leadScale);
    desired = headingTo(bot.position, aim) + memory.aimBias;
    range = Math.hypot(target.position.x - bot.position.x, target.position.y - bot.position.y);
  } else if (rng.random() < 0.04) {
    memory.wanderAngle += (rng.random() - 0.5) * 0.5;
    desired = memory.wanderAngle;
  }

  const maxTurn = shipTurnPerFrame() * BOT_AI.MOTION_STEPS;
  const nextAngle = turnToward(bot.angle, desired, maxTurn);
  angleError = shortestAngleDelta(nextAngle, desired);
  const facing = Math.abs(angleError) < BOT_AI.THRUST_ALIGN;

  let thrusting = false;
  if (nearWall) {
    thrusting = facing;
  } else if (!target) {
    thrusting = rng.random() > 0.3;
  } else if (range > BOT_AI.PREFERRED_RANGE + 40) {
    thrusting = facing;
  } else if (range < BOT_AI.CLOSE_RANGE) {
    thrusting = false;
  } else {
    thrusting = facing && range > BOT_AI.PREFERRED_RANGE;
  }

  const alignedForFire =
    !!target && range <= BOT_AI.ENGAGE_RANGE && Math.abs(angleError) <= fireAlignThreshold(range);

  if (alignedForFire && !memory.wasAligned) {
    memory.nextFireTick = memory.ticks + BOT_AI.REACTION_TICKS;
  }
  if (!alignedForFire) {
    memory.nextFireTick = Number.POSITIVE_INFINITY;
  }
  memory.wasAligned = alignedForFire;

  const canFireLasers = DEBUG.BOT_PLAYER.LASERS;
  const fire =
    canFireLasers &&
    alignedForFire &&
    !isSpawnProtected(bot) &&
    !!target &&
    !isSpawnProtected(target) &&
    memory.ticks >= memory.nextFireTick &&
    memory.ticks - memory.lastShotTick >= BOT_AI.SHOT_COOLDOWN_TICKS &&
    memory.ticks >= memory.burstPauseUntilTick;

  if (fire) {
    memory.lastShotTick = memory.ticks;
    memory.burstShots += 1;
    if (memory.burstShots >= BOT_AI.BURST_SIZE) {
      memory.burstShots = 0;
      memory.burstPauseUntilTick = memory.ticks + BOT_AI.BURST_PAUSE_TICKS;
    }
  }

  return { angle: nextAngle, thrusting, fire };
}

export function makeBotShot(
  bot: Pick<GameEntity, 'id' | 'position' | 'velocity' | 'angle'>
): BotShot {
  const speed = laserSpeedPerFrame();
  return {
    botId: bot.id,
    laserStart: calculateLaserStartPosition(bot.position, bot.angle, SHIP.SIZE / 2),
    laserDirection: {
      x: bot.velocity.x + Math.cos(bot.angle) * speed,
      y: bot.velocity.y - Math.sin(bot.angle) * speed,
    },
  };
}

/** Per-bot personality + cadence. Lives on the controller, not the hull. */
export class BotBrain {
  private memory = new Map<string, BotMemory>();

  remember(botId: string, rng: Pick<RNGService, 'random'>, heading: number): BotMemory {
    let state = this.memory.get(botId);
    if (!state) {
      state = createBotMemory(rng, heading);
      this.memory.set(botId, state);
    }
    return state;
  }

  decide(bot: GameEntity, humans: Combatant[], rng: Pick<RNGService, 'random'>): BotDecision {
    const memory = this.remember(bot.id, rng, bot.angle);
    const target = chooseTarget(bot, humans);
    return decideBotAction(bot, target, memory, rng);
  }

  forgetMissing(activeIds: Iterable<string>): void {
    const keep = new Set(activeIds);
    for (const id of this.memory.keys()) {
      if (!keep.has(id)) {
        this.memory.delete(id);
      }
    }
  }

  clear(): void {
    this.memory.clear();
  }
}
