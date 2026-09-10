import { assert, expect, test } from 'vitest';
import {
  bindHarpoonFieldSource,
  harpoonBodyFromRock,
  publishHarpoonField,
} from '../../../src/entities/ship/harpoonField';
import { Ship } from '../../../src/entities/ship/Ship';
import {
  type AbilityHost,
  absorbDamageWithShield,
  activateAbilityOnHost,
  applySharedHarpoonLatch,
  applyShockPulse,
  canActivateAbility,
  diagnoseHarpoonLatch,
  findHarpoonTarget,
  harpoonLatchRange,
  harpoonSurfaceGap,
  isEnvironmentLatchBody,
  pullHarpoonTarget,
  tickAbilityHost,
} from '../../../src/entities/ship/shipAbilities';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';

function host(kitId: AbilityHost['kitId']): AbilityHost {
  return {
    kitId,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    shieldTimer: 0,
    harpoonTimer: 0,
  };
}

test('Dart boost dash adds forward velocity', () => {
  const dart = host('dart');
  const result = activateAbilityOnHost(dart);
  expect(result.activated).toBe(true);
  expect(result.abilityId).toBe('boostDash');
  expect(dart.velocity.x).toBeCloseTo(SHIP_ABILITY.DASH_BOOST);
  expect(canActivateAbility(dart)).toBe(false);
  expect(dart.harpoonTimer).toBe(0);
});

test('a Hauler surface latch survives render ticks until release without replacing its cable with E', () => {
  const hauler = host('hauler');
  hauler.harpoonTimer = 1;
  hauler.harpoonTargetId = 'surface-rock';
  hauler.harpoonLatchPos = { x: 32, y: 0 };
  hauler.asteroidMotion = { epoch: 1, mode: 'latched', ack: 0, asteroidId: 'surface-rock' };
  for (let frame = 0; frame < 120; frame++) {
    tickAbilityHost(hauler);
  }
  expect(hauler.harpoonTimer).toBe(1);
  expect(hauler.harpoonLatchPos).toEqual({ x: 32, y: 0 });
  expect(activateAbilityOnHost(hauler).activated).toBe(false);
  hauler.asteroidMotion = { epoch: 2, mode: 'released', ack: 0 };
  tickAbilityHost(hauler);
  expect(hauler.harpoonTimer).toBe(0);
  expect(hauler.harpoonTargetId).toBeUndefined();
  expect(canActivateAbility(hauler)).toBe(true);
});

test('Hauler harpoon latches one rock and hauls only that rock', () => {
  const hauler = host('hauler');
  const near = { id: 'near-rock', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } };
  const far = { id: 'far-rock', position: { x: 200, y: 0 }, velocity: { x: 0, y: 0 } };
  const result = activateAbilityOnHost(hauler, { asteroids: [near, far], entities: [] });
  expect(result.activated).toBe(true);
  expect(result.abilityId).toBe('harpoon');
  expect(hauler.harpoonTargetId).toBe('near-rock');
  expect(hauler.harpoonTimer).toBe(SHIP_ABILITY.HARPOON_FRAMES);
  pullHarpoonTarget(hauler, [near, far]);
  expect(near.velocity.x).toBeLessThan(0);
  expect(far.velocity.x).toBe(0);
});

test('harpoon latches the nearer rock even if a farther rock is ahead', () => {
  const hauler = host('hauler');
  hauler.angle = 0;
  const behind = { id: 'behind', position: { x: -40, y: 0 }, velocity: { x: 0, y: 0 } };
  const ahead = { id: 'ahead', position: { x: 90, y: 0 }, velocity: { x: 0, y: 0 } };
  expect(findHarpoonTarget(hauler, [behind, ahead])?.id).toBe('behind');
});

test('non-Hauler kits never latch or haul', () => {
  const dart = host('dart');
  const rock = { id: 'rock', position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 } };
  activateAbilityOnHost(dart, { asteroids: [rock], entities: [] });
  expect(dart.harpoonTargetId).toBeUndefined();
  dart.harpoonTimer = 90;
  dart.harpoonTargetId = 'rock';
  dart.kitId = 'dart';
  pullHarpoonTarget(dart, [rock]);
  expect(rock.velocity.x).toBe(0);
  expect(dart.harpoonTimer).toBe(0);
});

test('zoomed playfields widen local latch range so a visually-near rock hooks', () => {
  expect(harpoonLatchRange(1)).toBeGreaterThanOrEqual(SHIP_ABILITY.HARPOON_RANGE);
  expect(harpoonLatchRange(0.25)).toBeGreaterThan(1000);
  const hauler = host('hauler');
  const almostNear = {
    id: 'zoom-rock',
    position: { x: 400, y: 0 },
    velocity: { x: 0, y: 0 },
  };
  expect(findHarpoonTarget(hauler, [almostNear])).toBeUndefined();
  expect(findHarpoonTarget(hauler, [almostNear], harpoonLatchRange(0.25))?.id).toBe('zoom-rock');
});

test('1:1 large canvas latches a rock past the old 320wu / 1600wu #480 cap', () => {
  const hd = { width: 1920, height: 1080 };
  expect(harpoonLatchRange(1, hd)).toBeGreaterThan(500);
  expect(harpoonLatchRange(0.1, hd)).toBeGreaterThan(2000);
  // #485 kept the 8000wu cap. 1080p at scale 0.1 puts a 900px-near rock at 9000wu.
  expect(harpoonLatchRange(0.1, hd)).toBeGreaterThan(9000);
  const hauler = host('hauler');
  const liveNear = {
    id: 'live-near',
    position: { x: 520, y: 0 },
    velocity: { x: 0, y: 0 },
  };
  expect(findHarpoonTarget(hauler, [liveNear])).toBeUndefined();
  expect(findHarpoonTarget(hauler, [liveNear], harpoonLatchRange(1, hd))?.id).toBe('live-near');
  const result = activateAbilityOnHost(hauler, {
    asteroids: [liveNear],
    entities: [],
    playfieldScale: 1,
    canvas: hd,
  });
  expect(result.activated).toBe(true);
  expect(hauler.harpoonTargetId).toBe('live-near');
  expect(hauler.harpoonLatchPos?.x).toBe(520);
});

test('a large rock whose surface is within 280wu latches even if its center is farther', () => {
  const hauler = host('hauler');
  hauler.r = 19;
  const rock = {
    id: 'big-rock',
    position: { x: 330, y: 0 },
    velocity: { x: 0, y: 0 },
    r: 80,
  };
  expect(harpoonSurfaceGap(hauler, rock)).toBeLessThan(SHIP_ABILITY.HARPOON_RANGE);
  expect(findHarpoonTarget(hauler, [rock])?.id).toBe('big-rock');
});

test('overlapping a rock still latches (center gap under 1wu)', () => {
  const hauler = host('hauler');
  const rock = { id: 'on-top', position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, r: 80 };
  expect(findHarpoonTarget(hauler, [rock])?.id).toBe('on-top');
});

test('same-side faction does not block a rock with no faction', () => {
  const hauler = host('hauler');
  hauler.factionId = 'ember';
  const rock = { id: 'neutral-rock', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } };
  const mate = {
    id: 'mate-bot',
    position: { x: 240, y: 0 },
    velocity: { x: 0, y: 0 },
    factionId: 'ember' as const,
    health: 100,
  };
  expect(findHarpoonTarget(hauler, [mate, rock])?.id).toBe('neutral-rock');
});

test('Hauler E syncs the live belt so an unpublished field still latches', () => {
  publishHarpoonField([]);
  bindHarpoonFieldSource(() => ({
    bodies: [{ id: 'live-rock', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } }],
    playfieldScale: 1,
  }));
  const hauler = host('hauler');
  const result = activateAbilityOnHost(hauler);
  bindHarpoonFieldSource(null);
  expect(result.activated).toBe(true);
  expect(hauler.harpoonTargetId).toBe('live-rock');
  expect(hauler.harpoonLatchPos?.x).toBe(80);
});

test('Hauler harpoon whiffs without a rock in range', () => {
  const hauler = host('hauler');
  const result = activateAbilityOnHost(hauler, { asteroids: [], entities: [] });
  expect(result.activated).toBe(false);
  expect(hauler.abilityCooldownFrames).toBe(0);
  expect(hauler.harpoonTimer).toBe(0);
});

test('Hauler harpoon latches a nearby ship and hauls only that ship', () => {
  const hauler = host('hauler');
  hauler.id = 'hauler-1';
  const near = { id: 'dart-1', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 }, health: 100 };
  const far = { id: 'dart-2', position: { x: 200, y: 0 }, velocity: { x: 0, y: 0 }, health: 100 };
  const result = activateAbilityOnHost(hauler, { asteroids: [], entities: [near, far] });
  expect(result.activated).toBe(true);
  expect(hauler.harpoonTargetId).toBe('dart-1');
  pullHarpoonTarget(hauler, [near, far]);
  expect(near.velocity.x).toBeLessThan(0);
  expect(far.velocity.x).toBe(0);
});

test('harpoon latches a touching rock instead of a distant forward ship', () => {
  const hauler = host('hauler');
  hauler.id = 'hauler-1';
  hauler.angle = 0;
  const rockBehind = { id: 'rock', position: { x: -40, y: 0 }, velocity: { x: 0, y: 0 } };
  const shipAhead = {
    id: 'foe',
    position: { x: 90, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
    kind: 'ship' as const,
  };
  expect(findHarpoonTarget(hauler, [rockBehind, shipAhead])?.id).toBe('rock');
});

test('harpoonBodyFromRock tags belt rows as asteroid so ship filters cannot reject them', () => {
  const body = harpoonBodyFromRock({
    position: { x: 10, y: 4 },
    velocity: { x: 0, y: 0 },
    r: 50,
    health: 0,
  });
  assert.exists(body);
  expect(body.kind).toBe('asteroid');
  expect(body.id).toMatch(/^rock:/);
  expect(isEnvironmentLatchBody(body)).toBe(true);
});

test('an environment rock without an id still latches via pose', () => {
  const hauler = host('hauler');
  const rock = { position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 }, r: 40 };
  expect(isEnvironmentLatchBody(rock)).toBe(true);
  expect(findHarpoonTarget(hauler, [rock])).toBe(rock);
  const result = activateAbilityOnHost(hauler, { asteroids: [rock], entities: [] });
  expect(result.activated).toBe(true);
  expect(hauler.harpoonTimer).toBeGreaterThan(0);
  expect(hauler.harpoonLatchPos?.x).toBe(80);
});

test('a visible rock with health 0 still latches', () => {
  const hauler = host('hauler');
  const rock = {
    id: 'chip-rock',
    position: { x: 80, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 0,
    r: 40,
  };
  expect(isEnvironmentLatchBody(rock)).toBe(true);
  expect(findHarpoonTarget(hauler, [rock])?.id).toBe('chip-rock');
  const result = activateAbilityOnHost(hauler, { asteroids: [rock], entities: [] });
  expect(result.activated).toBe(true);
  expect(hauler.harpoonTimer).toBeGreaterThan(0);
});

test('pull keeps the latch when the field id is missing so cream VFX stays', () => {
  const hauler = host('hauler');
  hauler.harpoonTimer = 80;
  hauler.harpoonTargetId = 'server-asteroid-3';
  hauler.harpoonLatchPos = { x: 40, y: 0 };
  pullHarpoonTarget(hauler, []);
  expect(hauler.harpoonTimer).toBe(80);
  expect(hauler.harpoonTargetId).toBe('server-asteroid-3');
  expect(hauler.harpoonLatchPos?.x).toBe(40);
});

test('diagnoseHarpoonLatch reports kit, nearest gap, and chosen target', () => {
  const hauler = host('hauler');
  const rock = { id: 'near-rock', position: { x: 60, y: 0 }, velocity: { x: 0, y: 0 }, r: 20 };
  const probe = diagnoseHarpoonLatch(hauler, { asteroids: [rock], entities: [] });
  expect(probe.kitId).toBe('hauler');
  expect(probe.canActivate).toBe(true);
  expect(probe.fieldCount).toBe(1);
  expect(probe.targetId).toBe('near-rock');
  expect(probe.nearest?.reason).toBe('ok');
});

test('harpoon skips self, same-side mates, and a Warden shield', () => {
  const hauler = host('hauler');
  hauler.id = 'hauler-1';
  hauler.factionId = 'ion';
  const self = { id: 'hauler-1', position: { x: 30, y: 0 }, velocity: { x: 0, y: 0 }, health: 100 };
  const mate = {
    id: 'mate',
    position: { x: 40, y: 0 },
    velocity: { x: 0, y: 0 },
    factionId: 'ion' as const,
    health: 100,
  };
  const shielded = {
    id: 'warden',
    position: { x: 50, y: 0 },
    velocity: { x: 0, y: 0 },
    factionId: 'ember' as const,
    health: 100,
    shieldTimer: 40,
  };
  const foe = {
    id: 'foe',
    position: { x: 90, y: 0 },
    velocity: { x: 0, y: 0 },
    factionId: 'ember' as const,
    health: 100,
  };
  expect(findHarpoonTarget(hauler, [self, mate, shielded, foe])?.id).toBe('foe');
  expect(findHarpoonTarget(hauler, [self, shielded, foe])?.id).toBe('foe');
});

test('harpoon skips a timed ship shield', () => {
  const hauler = host('hauler');
  hauler.id = 'hauler-1';
  const shielded = {
    id: 'dart-1',
    position: { x: 50, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
    shieldActive: true,
  };
  const foe = { id: 'dart-2', position: { x: 90, y: 0 }, velocity: { x: 0, y: 0 }, health: 100 };
  expect(findHarpoonTarget(hauler, [shielded, foe])?.id).toBe('dart-2');
});

test('server latch copies the field pose so the cream tip has a world point', () => {
  publishHarpoonField([{ id: 'bot-1', position: { x: 90, y: 10 }, velocity: { x: 0, y: 0 } }]);
  const local = host('hauler');
  applySharedHarpoonLatch(local, { harpoonTimer: 80, harpoonTargetId: 'bot-1' }, 'predicting');
  expect(local.harpoonLatchPos?.x).toBe(90);
  expect(local.harpoonLatchPos?.y).toBe(10);
  applySharedHarpoonLatch(
    local,
    { harpoonTimer: 70, harpoonTargetId: 'bot-1', harpoonLatchPos: { x: 95, y: 12 } },
    'predicting'
  );
  expect(local.harpoonLatchPos?.x).toBe(95);
});

test('local and remote adopt the same server latch', () => {
  const local = host('hauler');
  applySharedHarpoonLatch(local, { harpoonTimer: 80, harpoonTargetId: 'bot-1' }, 'predicting');
  expect(local.harpoonTargetId).toBe('bot-1');
  expect(local.harpoonTimer).toBe(80);
  applySharedHarpoonLatch(local, { harpoonTimer: 0 }, 'predicting');
  expect(local.harpoonTimer).toBe(80);
  expect(local.harpoonTargetId).toBe('bot-1');

  const remote = host('hauler');
  remote.harpoonTimer = 40;
  remote.harpoonTargetId = 'old';
  applySharedHarpoonLatch(remote, { harpoonTimer: 80, harpoonTargetId: 'bot-1' }, 'authoritative');
  expect(remote.harpoonTargetId).toBe('bot-1');
  applySharedHarpoonLatch(remote, { harpoonTimer: 0 }, 'authoritative');
  expect(remote.harpoonTimer).toBe(0);
  expect(remote.harpoonTargetId).toBeUndefined();
});

test('Warden shield absorbs a hit', () => {
  const warden = host('warden');
  activateAbilityOnHost(warden);
  expect(absorbDamageWithShield(warden)).toBe(true);
  const ship = new Ship({ kitId: 'warden' });
  ship.activateAbility();
  expect(ship.shieldTimer).toBe(SHIP_ABILITY.SHIELD_FRAMES);
  expect(ship.shieldActive).toBe(false);
  const before = ship.health;
  ship.takeDamage(25, 'laser');
  expect(ship.health).toBe(before);
  expect(ship.shieldFlashTime).toBeGreaterThan(0);
});

test('Skirmisher burst marks a volley and the ship fires three lasers', () => {
  const skirmisher = host('skirmisher');
  const result = activateAbilityOnHost(skirmisher);
  expect(result.abilityId).toBe('burstFire');
  const ship = new Ship({ kitId: 'skirmisher' });
  ship.activateAbility();
  expect(ship.lasers.length).toBe(3);
});

test('Quake shock pulse knocks nearby rocks and ships without terrain', () => {
  const quake = host('quake');
  const rock = { position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 } };
  const other = { position: { x: -40, y: 0 }, velocity: { x: 0, y: 0 } };
  const result = activateAbilityOnHost(quake, { asteroids: [rock], entities: [other] });
  expect(result.abilityId).toBe('shockPulse');
  expect(rock.velocity.x).toBeGreaterThan(0);
  expect(other.velocity.x).toBeLessThan(0);
  applyShockPulse(quake, { asteroids: [], entities: [] });
});

test('ability cooldown ticks down', () => {
  const dart = host('dart');
  activateAbilityOnHost(dart);
  const start = dart.abilityCooldownFrames;
  tickAbilityHost(dart);
  expect(dart.abilityCooldownFrames).toBe(start - 1);
});

test('deep-zoom on-screen rock past the old 8000wu cap still latches', () => {
  const hd = { width: 1920, height: 1080 };
  const hauler = host('hauler');
  const liveNear = {
    id: 'zoom-edge',
    position: { x: 9000, y: 0 },
    velocity: { x: 0, y: 0 },
    r: 40,
  };
  const range = harpoonLatchRange(0.1, hd);
  expect(range).toBeGreaterThan(9000);
  expect(findHarpoonTarget(hauler, [liveNear], range)?.id).toBe('zoom-edge');
  const result = activateAbilityOnHost(hauler, {
    asteroids: [liveNear],
    entities: [],
    playfieldScale: 0.1,
    canvas: hd,
  });
  expect(result.activated).toBe(true);
  expect(hauler.harpoonLatchPos?.x).toBe(9000);
});
