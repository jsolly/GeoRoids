import { strict as assert } from 'node:assert';
import { describe, expect, test } from 'vitest';
import {
  BOT_AI,
  type Combatant,
  chooseTarget,
  createBotMemory,
  decideBotAction,
  fireAlignThreshold,
  interceptTime,
  leadAimPoint,
  makeBotShot,
} from '../../../server/ai/botController';
import {
  applyShipMotionSteps,
  headingTo,
  laserSpeedPerFrame,
  shipTurnPerFrame,
  shortestAngleDelta,
  turnToward,
} from '../../../server/ai/shipMotion';
import { radiusFromMass } from '../../../shared/shipGrowth';
import type { ShipKitId } from '../../../shared-types';
import { GAME, LASER } from '../../../src/constants';
import { generateLaserVelocity } from '../../../src/entities/laser/laserUtils';
import { calculateLaserStartPosition } from '../../../src/entities/ship/shipUtils';

const fixedRng = { random: () => 0.5 };

function combatant(
  overrides: Partial<Combatant> & { angle?: number; kitId?: ShipKitId } = {}
): Combatant & {
  angle: number;
  kitId: ShipKitId;
} {
  return {
    id: overrides.id ?? 'bot',
    kitId: overrides.kitId ?? 'surveyor',
    position: overrides.position ?? { x: 0, y: 0 },
    velocity: overrides.velocity ?? { x: 0, y: 0 },
    health: overrides.health ?? 100,
    exploding: overrides.exploding ?? false,
    ...(overrides.spawnProtectionTimer !== undefined
      ? { spawnProtectionTimer: overrides.spawnProtectionTimer }
      : {}),
    ...(overrides.factionId !== undefined ? { factionId: overrides.factionId } : {}),
    angle: overrides.angle ?? 0,
  };
}

function memoryReadyToFire() {
  const memory = createBotMemory(fixedRng, 0);
  memory.wasAligned = true;
  memory.nextFireTick = 0;
  memory.lastShotTick = Number.NEGATIVE_INFINITY;
  memory.burstPauseUntilTick = 0;
  return memory;
}

describe('bot aim math', () => {
  test('heading uses screen-space forward (cos, -sin)', () => {
    expect(headingTo({ x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(0, 5);
    expect(headingTo({ x: 0, y: 0 }, { x: 0, y: -100 })).toBeCloseTo(Math.PI / 2, 5);
  });

  test('turnToward caps at the shared ship turn rate', () => {
    const maxTurn = shipTurnPerFrame('surveyor') * BOT_AI.MOTION_STEPS;
    const next = turnToward(0, Math.PI, maxTurn);
    expect(Math.abs(shortestAngleDelta(0, next))).toBeCloseTo(maxTurn, 5);
    expect(Math.abs(next)).toBeLessThan(Math.PI / 2);
  });

  test('lead aim points ahead of a crossing target', () => {
    const shooter = combatant({ position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } });
    const target = combatant({
      id: 'human',
      position: { x: 200, y: 0 },
      velocity: { x: 0, y: 4 * GAME.MOTION_SCALE },
    });
    const aim = leadAimPoint(shooter, target, 1);
    expect(aim.y).toBeGreaterThan(target.position.y);
    expect(aim.x).toBeGreaterThan(0);
  });

  test('intercept time matches |relPos + relVel t| = speed t', () => {
    const relPos = { x: 100, y: 0 };
    const relVel = { x: 0, y: 2 };
    const speed = laserSpeedPerFrame();
    const t = interceptTime(relPos, relVel, speed);
    assert.ok(t !== null && t !== undefined, 'intercept time');
    const range = Math.hypot(relPos.x + relVel.x * t, relPos.y + relVel.y * t);
    expect(range).toBeCloseTo(speed * t, 5);
  });

  test('fire cone tightens with range', () => {
    expect(fireAlignThreshold(0)).toBeCloseTo(BOT_AI.FIRE_ALIGN_NEAR, 5);
    expect(fireAlignThreshold(BOT_AI.ENGAGE_RANGE)).toBeCloseTo(BOT_AI.FIRE_ALIGN_FAR, 5);
    expect(fireAlignThreshold(BOT_AI.ENGAGE_RANGE / 2)).toBeLessThan(BOT_AI.FIRE_ALIGN_NEAR);
  });
});

describe('bot target choice', () => {
  test('picks the nearest living human', () => {
    const bot = combatant();
    const near = combatant({ id: 'near', position: { x: 80, y: 0 } });
    const far = combatant({ id: 'far', position: { x: 400, y: 0 } });
    expect(chooseTarget(bot, [far, near])?.id).toBe('near');
  });

  test('skips dead and exploding humans', () => {
    const bot = combatant();
    const dead = combatant({ id: 'dead', health: 0, position: { x: 10, y: 0 } });
    const boom = combatant({ id: 'boom', exploding: true, position: { x: 20, y: 0 } });
    const live = combatant({ id: 'live', position: { x: 300, y: 0 } });
    expect(chooseTarget(bot, [dead, boom, live])?.id).toBe('live');
  });

  test('skips same-faction humans when sides are assigned', () => {
    const bot = combatant({ factionId: 'ion' });
    const ally = combatant({ id: 'ally', position: { x: 80, y: 0 }, factionId: 'ion' });
    const foe = combatant({ id: 'foe', position: { x: 400, y: 0 }, factionId: 'ember' });
    expect(chooseTarget(bot, [ally, foe])?.id).toBe('foe');
  });
});

describe('bot fire cadence and thrust', () => {
  test('fires after reaction ticks when lined up in range', () => {
    const bot = combatant({ angle: 0 });
    const target = combatant({ id: 'human', position: { x: 220, y: 0 } });
    const memory = createBotMemory(fixedRng, 0);
    const decisions = [];
    for (let i = 0; i < BOT_AI.REACTION_TICKS + 2; i++) {
      decisions.push(decideBotAction(bot, target, memory, fixedRng));
    }
    expect(decisions.some((d) => d.fire)).toBe(true);
    expect(decisions[0]?.fire).toBe(false);
  });

  test('does not fire when heading is off', () => {
    const bot = combatant({ angle: 0 });
    const target = combatant({ id: 'human', position: { x: 0, y: 220 } });
    const memory = memoryReadyToFire();
    const decision = decideBotAction(bot, target, memory, fixedRng);
    expect(decision.fire).toBe(false);
    expect(Math.abs(shortestAngleDelta(0, decision.angle))).toBeGreaterThan(0);
  });

  test('respects shot cooldown between bursts', () => {
    const bot = combatant({ angle: 0 });
    const target = combatant({ id: 'human', position: { x: 220, y: 0 } });
    const memory = memoryReadyToFire();
    const first = decideBotAction(bot, target, memory, fixedRng);
    const second = decideBotAction(bot, target, memory, fixedRng);
    expect(first.fire).toBe(true);
    expect(second.fire).toBe(false);
  });

  test('pauses after a two-shot burst', () => {
    const bot = combatant({ angle: 0 });
    const target = combatant({ id: 'human', position: { x: 220, y: 0 } });
    const memory = memoryReadyToFire();
    expect(decideBotAction(bot, target, memory, fixedRng).fire).toBe(true);
    memory.lastShotTick = memory.ticks - BOT_AI.SHOT_COOLDOWN_TICKS;
    expect(decideBotAction(bot, target, memory, fixedRng).fire).toBe(true);
    memory.lastShotTick = memory.ticks - BOT_AI.SHOT_COOLDOWN_TICKS;
    expect(decideBotAction(bot, target, memory, fixedRng).fire).toBe(false);
  });

  test('does not fire while the bot or target is spawn-protected', () => {
    const target = combatant({ id: 'human', position: { x: 220, y: 0 } });
    const protectedBot = decideBotAction(
      combatant({ angle: 0, spawnProtectionTimer: 60 }),
      target,
      memoryReadyToFire(),
      fixedRng
    );
    const protectedTarget = decideBotAction(
      combatant({ angle: 0 }),
      combatant({ id: 'human', position: { x: 220, y: 0 }, spawnProtectionTimer: 60 }),
      memoryReadyToFire(),
      fixedRng
    );
    expect(protectedBot.fire).toBe(false);
    expect(protectedTarget.fire).toBe(false);
  });

  test('thrusts to close when far and facing, coasts when too close', () => {
    const far = decideBotAction(
      combatant({ angle: 0 }),
      combatant({ id: 'human', position: { x: 500, y: 0 } }),
      createBotMemory(fixedRng, 0),
      fixedRng
    );
    const close = decideBotAction(
      combatant({ angle: 0 }),
      combatant({ id: 'human', position: { x: 40, y: 0 } }),
      createBotMemory(fixedRng, 0),
      fixedRng
    );
    expect(far.thrusting).toBe(true);
    expect(close.thrusting).toBe(false);
  });
});

describe('shared ship motion and shot spawn', () => {
  test.each([
    { kitId: 'surveyor' as const, speed: 1.125, turn: 540, acceleration: 0.046875 },
    { kitId: 'hauler' as const, speed: 0.984375, turn: 380, acceleration: 0.0421875 },
  ])(
    '$kitId bots obey their advertised cruise cap and turn rate',
    ({ kitId, speed, turn, acceleration }) => {
      const ship = {
        kitId,
        position: { x: 0, y: 0 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        thrusting: true,
      };
      const idle = {
        ...ship,
        position: { ...ship.position },
        velocity: { ...ship.velocity },
        thrusting: false,
      };
      applyShipMotionSteps(idle, 1);
      applyShipMotionSteps(ship, 1);
      expect(ship.velocity.x - idle.velocity.x).toBeCloseTo(acceleration, 10);
      expect(ship.velocity.y).toBeCloseTo(idle.velocity.y, 10);
      applyShipMotionSteps(ship, 119);
      expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeLessThanOrEqual(speed + 1e-9);
      expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeGreaterThan(speed * 0.9);
      const bot = combatant({ kitId });
      const decision = decideBotAction(
        bot,
        combatant({ id: 'target', position: { x: -200, y: 0 } }),
        memoryReadyToFire(),
        fixedRng
      );
      expect(Math.abs(decision.angle)).toBeCloseTo(
        ((turn * Math.PI) / 180 / GAME.FPS) * BOT_AI.MOTION_STEPS,
        10
      );
    }
  );

  test.each([
    { kitId: 'surveyor' as const, radius: 15, mass: 1 },
    { kitId: 'hauler' as const, radius: 19, mass: 1 },
    { kitId: 'hauler' as const, radius: radiusFromMass(8), mass: 8 },
  ])('$kitId bot at mass $mass fires from its hull muzzle', ({ kitId, radius, mass }) => {
    const bot = {
      id: 'server-bot-0',
      kitId,
      mass,
      name: 'Crimson Falcon',
      type: 'bot' as const,
      position: { x: 10, y: -4 },
      velocity: { x: 1, y: -0.5 },
      angle: 0.4,
      exploding: false,
      thrusting: true,
      color: '#fff',
      lives: 3,
      score: 0,
      health: 100,
      maxHealth: 100,
      lastUpdate: 0,
    };
    if (mass > 1) {
      expect(radius).toBeGreaterThan(19);
    }
    const shot = makeBotShot(bot);
    const muzzle = calculateLaserStartPosition(bot.position, bot.angle, radius);
    const velocity = generateLaserVelocity(bot.angle, bot.velocity);
    expect(shot.laserStart.x).toBeCloseTo(muzzle.x, 10);
    expect(shot.laserStart.y).toBeCloseTo(muzzle.y, 10);
    expect(shot.laserDirection.x).toBeCloseTo(velocity.x, 10);
    expect(shot.laserDirection.y).toBeCloseTo(velocity.y, 10);
    expect(LASER.SPEED / GAME.FPS).toBeCloseTo(laserSpeedPerFrame(), 8);
  });
});
