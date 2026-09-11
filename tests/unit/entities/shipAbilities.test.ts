import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { FUEL } from '../../../src/constants';
import {
  bindHarpoonFieldSource,
  harpoonBodyFromRock,
  publishHarpoonField,
} from '../../../src/entities/ship/harpoonField';
import {
  type AbilityBody,
  type AbilityHost,
  activateAbilityOnHost,
  applySharedHarpoonLatch,
  applyShockPulse,
  canActivateAbility,
  diagnoseHarpoonLatch,
  findFriendlyShieldTarget,
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
    fuel: FUEL.START,
    maxFuel: FUEL.MAX,
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

test('Hauler reels only the latched rock toward itself when no enemy or momentum exists', () => {
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

test('unpublished canvas still reaches a 1080p-near rock', () => {
  expect(harpoonLatchRange()).toBeGreaterThanOrEqual(900);
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
  const near: AbilityBody = {
    kind: 'ship',
    id: 'dart-1',
    position: { x: 80, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  const far: AbilityBody = {
    kind: 'ship',
    id: 'dart-2',
    position: { x: 200, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  const result = activateAbilityOnHost(hauler, { asteroids: [], entities: [near, far] });
  expect(result.activated).toBe(true);
  expect(hauler.harpoonTargetId).toBe('dart-1');
  pullHarpoonTarget(hauler, [near, far]);
  expect(near.velocity.x).toBeLessThan(0);
  expect(far.velocity.x).toBe(0);
});

test('a rock in reach wins over a closer hostile ship', () => {
  const hauler = host('hauler');
  hauler.id = 'hauler-1';
  const rock = {
    id: 'rock',
    position: { x: 220, y: 0 },
    velocity: { x: 0, y: 0 },
    kind: 'asteroid' as const,
  };
  const foe = {
    id: 'falcon',
    position: { x: 50, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
    kind: 'ship' as const,
  };
  expect(findHarpoonTarget(hauler, [foe, rock], 280)?.id).toBe('rock');
});

test('an asteroid-tagged rock still latches when a faction field leaked onto it', () => {
  const hauler = host('hauler');
  hauler.factionId = 'ion';
  const rock = {
    id: 'leaky-rock',
    position: { x: 80, y: 0 },
    velocity: { x: 0, y: 0 },
    kind: 'asteroid' as const,
    factionId: 'ion' as const,
  };
  expect(isEnvironmentLatchBody(rock)).toBe(true);
  expect(findHarpoonTarget(hauler, [rock])?.id).toBe('leaky-rock');
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
  assert.ok(body);
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

test('Warden E projects a reflecting shield onto a nearby friendly ship', () => {
  const warden = host('warden');
  warden.id = 'warden-1';
  warden.factionId = 'ion';
  const friendly: AbilityBody = {
    id: 'friendly-1',
    kind: 'ship' as const,
    factionId: 'ion' as const,
    position: { x: 100, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  const enemy: AbilityBody = {
    id: 'enemy-1',
    kind: 'ship' as const,
    factionId: 'ember' as const,
    position: { x: 40, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  const result = activateAbilityOnHost(warden, { asteroids: [], entities: [friendly, enemy] });
  expect(result).toEqual({ activated: true, abilityId: 'shieldFocus' });
  expect(warden.shieldTargetId).toBe('friendly-1');
  expect(warden.shieldTimer).toBe(0);
  expect(warden.abilityActiveFrames).toBe(SHIP_ABILITY.SHIELD_PROJECTION_FRAMES);
  expect(friendly.shieldTimer).toBe(SHIP_ABILITY.SHIELD_PROJECTION_FRAMES);
  expect(friendly.shieldSourceId).toBe('warden-1');
  expect(enemy.shieldTimer).toBeUndefined();
});

test('Warden E prefers any forward teammate before a nearer rear teammate', () => {
  const warden = host('warden');
  warden.id = 'warden-1';
  warden.factionId = 'ion';
  const rear = {
    id: 'rear',
    kind: 'ship' as const,
    factionId: 'ion' as const,
    position: { x: -20, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  const forward = {
    id: 'forward',
    kind: 'ship' as const,
    factionId: 'ion' as const,
    position: { x: 100, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  expect(findFriendlyShieldTarget(warden, [rear, forward])?.id).toBe('forward');
});

test('Warden E falls back to the nearest valid rear teammate with a stable tie break', () => {
  const warden = host('warden');
  warden.id = 'warden-1';
  warden.factionId = 'ion';
  const farther = {
    id: 'z-friend',
    kind: 'ship' as const,
    factionId: 'ion' as const,
    position: { x: -100, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  const nearer = {
    id: 'a-friend',
    kind: 'ship' as const,
    factionId: 'ion' as const,
    position: { x: -60, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  expect(findFriendlyShieldTarget(warden, [farther, nearer])?.id).toBe('a-friend');
  const tieB = { ...farther, id: 'b-friend' };
  const tieA = { ...farther, id: 'a-friend' };
  expect(findFriendlyShieldTarget(warden, [tieB, tieA])?.id).toBe('a-friend');
});

test('Warden ignores forged viewport reach and falls back from an out-of-range forward ally', () => {
  const warden = host('warden');
  warden.id = 'warden-1';
  warden.factionId = 'ion';
  const far: AbilityBody = {
    id: 'far-forward',
    kind: 'ship',
    factionId: 'ion',
    position: { x: 1000, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  const viewport = {
    playfieldScale: Number.MIN_VALUE,
    canvas: { width: Number.MAX_VALUE, height: Number.MAX_VALUE },
  };
  expect(activateAbilityOnHost(warden, { asteroids: [], entities: [far], ...viewport })).toEqual({
    activated: false,
  });
  expect(warden.abilityCooldownFrames).toBe(0);
  expect(far.shieldTimer).toBeUndefined();
  const near: AbilityBody = {
    ...far,
    id: 'near-rear',
    position: { x: -100, y: 0 },
  };
  expect(
    activateAbilityOnHost(warden, { asteroids: [], entities: [far, near], ...viewport }).activated
  ).toBe(true);
  expect(warden.shieldTargetId).toBe('near-rear');
  expect(near.shieldTimer).toBe(SHIP_ABILITY.SHIELD_PROJECTION_FRAMES);
  expect(far.shieldTimer).toBeUndefined();
});

test('Warden E whiffs without a live same-faction teammate and keeps cooldown ready', () => {
  const warden = host('warden');
  warden.id = 'warden-1';
  warden.factionId = 'ion';
  const result = activateAbilityOnHost(warden, {
    asteroids: [],
    entities: [
      {
        id: 'enemy',
        kind: 'ship',
        factionId: 'ember',
        position: { x: 40, y: 0 },
        velocity: { x: 0, y: 0 },
        health: 100,
      },
      {
        id: 'dead-mate',
        kind: 'ship',
        factionId: 'ion',
        position: { x: 40, y: 0 },
        velocity: { x: 0, y: 0 },
        health: 0,
      },
    ],
  });
  expect(result).toEqual({ activated: false });
  expect(warden.abilityCooldownFrames).toBe(0);
  expect(warden.abilityActiveFrames).toBe(0);
  expect(warden.shieldTargetId).toBeUndefined();
});

test('projected shield timers expire on both the caster and recipient', () => {
  const warden = host('warden');
  warden.id = 'warden-1';
  warden.factionId = 'ion';
  const friend = {
    ...host('dart'),
    id: 'friend-1',
    kind: 'ship' as const,
    factionId: 'ion' as const,
    position: { x: 80, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
  };
  expect(activateAbilityOnHost(warden, { asteroids: [], entities: [friend] }).activated).toBe(true);
  for (let frame = 0; frame < SHIP_ABILITY.SHIELD_PROJECTION_FRAMES; frame += 1) {
    tickAbilityHost(warden);
    tickAbilityHost(friend);
  }
  expect(warden.abilityActiveFrames).toBe(0);
  expect(warden.shieldTargetId).toBeUndefined();
  expect(friend.shieldTimer).toBe(0);
  expect(friend.shieldSourceId).toBeUndefined();
});

test('Skirmisher E marks a full ring volley', () => {
  const skirmisher = host('skirmisher');
  const result = activateAbilityOnHost(skirmisher);
  expect(result.abilityId).toBe('ringFire');
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

function slingScene() {
  const hauler: AbilityHost = { ...host('hauler'), id: 'hauler', factionId: 'ion' };
  const rock: AbilityBody = {
    id: 'rock',
    kind: 'asteroid',
    position: { x: 80, y: 0 },
    velocity: { x: 2, y: 0 },
  };
  const enemy = (id: string, x: number, y: number): AbilityBody => ({
    id,
    kind: 'ship',
    position: { x, y },
    velocity: { x: 0, y: 0 },
    health: 100,
  });
  return { hauler, rock, enemy };
}

test('Hauler favors an enemy in the momentum path over a closer sideways or rear enemy', () => {
  const { hauler, rock, enemy } = slingScene();
  activateAbilityOnHost(hauler, {
    asteroids: [rock],
    entities: [enemy('side', 80, 120), enemy('rear', 20, 0), enemy('ahead', 560, 0)],
  });
  expect(rock.velocity.x).toBe(SHIP_ABILITY.HARPOON_SLING_SPEED);
  expect(rock.velocity.y).toBe(0);
});

function reelUntilRelease(hauler: AbilityHost, rock: AbilityBody, enemies: AbilityBody[]): void {
  for (let frame = 0; frame < SHIP_ABILITY.HARPOON_FRAMES; frame++) {
    pullHarpoonTarget(hauler, [rock, ...enemies]);
    if (
      Math.hypot(rock.velocity.x, rock.velocity.y) >= SHIP_ABILITY.HARPOON_SLING_SPEED - 1e-8 &&
      Math.hypot(rock.position.x - hauler.position.x, rock.position.y - hauler.position.y) <=
        (hauler.r ?? 20) + (rock.r ?? rock.size ?? 20) + SHIP_ABILITY.HARPOON_RELEASE_GAP
    ) {
      return;
    }
    rock.position.x += rock.velocity.x;
    rock.position.y += rock.velocity.y;
    tickAbilityHost(hauler);
  }
  throw new Error('Rock never reached the Hauler and released');
}

test('a sideways enemy makes the rock reel before bouncing toward its predicted position', () => {
  const { hauler, rock, enemy } = slingScene();
  const moving = enemy('moving', 440, 300);
  moving.velocity.y = 3;
  const original = { ...rock.velocity };
  activateAbilityOnHost(hauler, { asteroids: [rock], entities: [moving] });
  expect(rock.velocity).toEqual(original);
  pullHarpoonTarget(hauler, [rock, moving]);
  expect(rock.velocity.x).toBeLessThan(original.x);
  expect(rock.velocity.x).toBeGreaterThan(0);
  expect(rock.velocity.y).toBe(0);
  reelUntilRelease(hauler, rock, [moving]);
  const flightTime = (moving.position.x - rock.position.x) / rock.velocity.x;
  expect(rock.position.y + rock.velocity.y * flightTime).toBeCloseTo(
    moving.position.y + moving.velocity.y * flightTime
  );
  const launched = { ...rock.velocity };
  moving.velocity.y = -6;
  for (let frame = 0; frame < SHIP_ABILITY.HARPOON_FRAMES + 1; frame++) {
    pullHarpoonTarget(hauler, [rock, moving]);
    tickAbilityHost(hauler);
  }
  expect(rock.velocity).toEqual(launched);
});

test('a nearby enemy in the forward collision corridor does not bend the original momentum', () => {
  const { hauler, rock, enemy } = slingScene();
  activateAbilityOnHost(hauler, { asteroids: [rock], entities: [enemy('ahead', 500, 10)] });
  expect(rock.velocity).toEqual({ x: SHIP_ABILITY.HARPOON_SLING_SPEED, y: 0 });
});

test('an expired tether stops reeling without a delayed launch', () => {
  const { hauler, rock, enemy } = slingScene();
  const enemies = [enemy('side', 80, 300)];
  activateAbilityOnHost(hauler, { asteroids: [rock], entities: enemies });
  pullHarpoonTarget(hauler, [rock, ...enemies]);
  const velocity = { ...rock.velocity };
  hauler.harpoonTimer = 0;
  pullHarpoonTarget(hauler, [rock, ...enemies]);
  expect(rock.velocity).toEqual(velocity);
});

test('Hauler ignores allies, self, dead, respawning, shielded, and unreachable enemies', () => {
  const { hauler, rock, enemy } = slingScene();
  const excluded: AbilityBody[] = [
    { ...enemy('ally', 180, 0), factionId: 'ion' },
    { ...enemy('dead', 180, 0), health: 0 },
    { ...enemy('exploding', 180, 0), exploding: true },
    { ...enemy('respawning', 180, 0), respawnTimer: 30 },
    { ...enemy('spawn', 180, 0), spawnProtectionTimer: 30 },
    { ...enemy('shield', 180, 0), shieldActive: true },
    { ...enemy('projection', 180, 0), shieldTimer: 30 },
    { ...enemy('escaping', 180, 0), velocity: { x: 20, y: 0 } },
    enemy('distant', 10000, 0),
    hauler,
  ];
  activateAbilityOnHost(hauler, {
    asteroids: [rock],
    entities: [...excluded, enemy('valid', 80, 240)],
  });
  const valid = enemy('valid', 80, 240);
  reelUntilRelease(hauler, rock, [...excluded, valid]);
  expect(rock.velocity.y).toBeGreaterThan(11);
  expect(rock.velocity.x).toBeGreaterThan(0);
});

test('A stationary rock reels before choosing the quickest intercept with stable target ties', () => {
  for (const reverse of [false, true]) {
    const { hauler, rock, enemy } = slingScene();
    rock.velocity.x = 0;
    const enemies = [enemy('b', 80, -240), enemy('a', 80, 240), enemy('far', 560, 0)];
    activateAbilityOnHost(hauler, {
      asteroids: [rock],
      entities: reverse ? enemies.reverse() : enemies,
    });
    expect(rock.velocity).toEqual({ x: 0, y: 0 });
    reelUntilRelease(hauler, rock, enemies);
    expect(rock.velocity.y).toBeGreaterThan(11);
  }
});

test('A fast rock without reachable enemies starts reeling without snapping its momentum', () => {
  const { hauler, rock } = slingScene();
  rock.velocity = { x: 15, y: 20 };
  activateAbilityOnHost(hauler, { asteroids: [rock], entities: [] });
  expect(rock.velocity).toEqual({ x: 15, y: 20 });
  pullHarpoonTarget(hauler, [rock]);
  expect(Math.hypot(rock.velocity.x - 15, rock.velocity.y - 20)).toBeCloseTo(
    SHIP_ABILITY.HARPOON_REEL_ACCELERATION
  );
});

test('a distant visible rock gets enough tether time to reel in and bounce', () => {
  const { hauler, rock, enemy } = slingScene();
  rock.position.x = 9000;
  rock.velocity.x = 0;
  const target = enemy('target', 300, 400);
  activateAbilityOnHost(hauler, {
    asteroids: [rock],
    entities: [target],
    playfieldScale: 0.1,
    canvas: { width: 1920, height: 1080 },
  });
  expect(hauler.harpoonTimer).toBeGreaterThan(SHIP_ABILITY.HARPOON_FRAMES);
  const duration = hauler.harpoonTimer;
  let released = false;
  for (let frame = 0; frame < duration; frame++) {
    pullHarpoonTarget(hauler, [rock, target]);
    if (rock.velocity.y > 0) {
      released = true;
      expect(Math.hypot(rock.velocity.x, rock.velocity.y)).toBeCloseTo(12);
      break;
    }
    rock.position.x += rock.velocity.x;
    rock.position.y += rock.velocity.y;
    tickAbilityHost(hauler);
  }
  expect(released).toBe(true);
});

test('local latch prediction waits for the server to launch the rock', () => {
  const { hauler, rock } = slingScene();
  bindHarpoonFieldSource(null);
  publishHarpoonField([
    {
      id: 'rock',
      kind: 'asteroid',
      position: rock.position,
      velocity: rock.velocity,
    },
  ]);
  try {
    const before = { ...rock.velocity };
    expect(activateAbilityOnHost(hauler).activated).toBe(true);
    expect(hauler.harpoonTargetId).toBe('rock');
    expect(rock.velocity).toEqual(before);
  } finally {
    publishHarpoonField([]);
  }
});
