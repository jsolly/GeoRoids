import { afterEach, expect, test } from 'vitest';
import {
  bindHarpoonFieldSource,
  publishHarpoonField,
} from '../../../src/entities/ship/harpoonField';
import {
  type AbilityBody,
  type AbilityHost,
  activateAbilityOnHost,
  applySharedHarpoonLatch,
  diagnoseHarpoonLatch,
  findHarpoonTarget,
  harpoonSurfaceGap,
  pullHarpoonTarget,
  tickAbilityHost,
} from '../../../src/entities/ship/shipAbilities';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { attachTowCable, tickTowCable } from '../../../src/entities/ship/towCable';

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
    harpoonTargetId: null,
  };
}

afterEach(() => {
  bindHarpoonFieldSource(null);
  publishHarpoonField([]);
});

test('Hauler attaches the nearest rock and only pulls that rock when the cable is taut', () => {
  const hauler = host('hauler');
  const near: AbilityBody = {
    id: 'near-rock',
    position: { x: 80, y: 0 },
    velocity: { x: 0, y: 0 },
  };
  const far: AbilityBody = {
    id: 'far-rock',
    position: { x: 200, y: 0 },
    velocity: { x: 0, y: 0 },
  };
  const result = activateAbilityOnHost(hauler, { asteroids: [near, far] });
  expect(result.activated).toBe(true);
  expect(result.abilityId).toBe('harpoon');
  expect(hauler.harpoonTargetId).toBe('near-rock');
  expect(hauler.harpoonLatchPos).toEqual({ x: 80, y: 0 });

  hauler.position.x = -100;
  pullHarpoonTarget(hauler, [near, far]);

  expect(hauler.harpoonTargetId).toBe('near-rock');
  expect(near.velocity.x).toBeLessThan(0);
  expect(far.velocity.x).toBe(0);
  expect(Math.abs(near.velocity.x)).toBeLessThan(1);
});

test('harpoon latches the nearer rock even if a farther rock is ahead', () => {
  const hauler = host('hauler');
  hauler.angle = 0;
  const behind = { id: 'behind', position: { x: -40, y: 0 }, velocity: { x: 0, y: 0 } };
  const ahead = { id: 'ahead', position: { x: 90, y: 0 }, velocity: { x: 0, y: 0 } };
  expect(findHarpoonTarget(hauler, [behind, ahead])?.id).toBe('behind');
});

test('non-Hauler kits never latch or haul', () => {
  const surveyor = host('surveyor');
  const rock = { id: 'rock', position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 } };
  expect(activateAbilityOnHost(surveyor, { asteroids: [rock] }).abilityId).toBe('surveyScan');
  expect(surveyor.harpoonTargetId).toBeNull();
  surveyor.harpoonTargetId = 'rock';
  pullHarpoonTarget(surveyor, [rock]);
  expect(rock.velocity.x).toBe(0);
  expect(surveyor.harpoonTargetId).toBeNull();
});

test('physical reach keeps an intake-bound rock near enough to tow', () => {
  const hauler = host('hauler');
  const liveNear = {
    id: 'live-near',
    position: { x: 260, y: 0 },
    velocity: { x: 0, y: 0 },
  };
  expect(findHarpoonTarget(hauler, [liveNear])?.id).toBe('live-near');
  const result = activateAbilityOnHost(hauler, {
    asteroids: [liveNear],
  });
  expect(result.activated).toBe(true);
  expect(hauler.harpoonTargetId).toBe('live-near');
  expect(hauler.harpoonLatchPos?.x).toBe(260);
});

test('a large rock whose surface is within range latches even if its center is farther', () => {
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

test('overlapping a rock still latches', () => {
  const hauler = host('hauler');
  const rock = { id: 'on-top', position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, r: 80 };
  expect(findHarpoonTarget(hauler, [rock])?.id).toBe('on-top');
});

test('Hauler E syncs the live belt so an unpublished field still latches', () => {
  publishHarpoonField([]);
  bindHarpoonFieldSource(() => [
    { id: 'live-rock', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } },
  ]);
  const hauler = host('hauler');
  const result = activateAbilityOnHost(hauler);
  expect(result.activated).toBe(true);
  expect(hauler.harpoonTargetId).toBe('live-rock');
  expect(hauler.harpoonLatchPos?.x).toBe(80);
});

test('Hauler harpoon whiffs without a rock in range', () => {
  const hauler = host('hauler');
  const result = activateAbilityOnHost(hauler, { asteroids: [] });
  expect(result.activated).toBe(false);
  expect(hauler.abilityCooldownFrames).toBe(0);
  expect(hauler.harpoonTargetId).toBeNull();
});

test('a depleted rock is not a tow target', () => {
  const hauler = host('hauler');
  const rock = {
    id: 'chip-rock',
    position: { x: 80, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 0,
    r: 40,
  };
  expect(findHarpoonTarget(hauler, [rock])).toBeUndefined();
  expect(activateAbilityOnHost(hauler, { asteroids: [rock] }).activated).toBe(false);
});

test('pull clears a latch when its asteroid leaves the authoritative world', () => {
  const hauler = host('hauler');
  hauler.harpoonTargetId = 'server-asteroid-3';
  hauler.harpoonLatchPos = { x: 40, y: 0 };
  pullHarpoonTarget(hauler, []);
  expect(hauler.harpoonTargetId).toBeNull();
  expect(hauler.harpoonLatchPos).toBeUndefined();
});

test('diagnoseHarpoonLatch reports kit, nearest gap, and chosen target', () => {
  const hauler = host('hauler');
  const rock = { id: 'near-rock', position: { x: 60, y: 0 }, velocity: { x: 0, y: 0 }, r: 20 };
  const probe = diagnoseHarpoonLatch(hauler, { asteroids: [rock] });
  expect(probe.kitId).toBe('hauler');
  expect(probe.canActivate).toBe(true);
  expect(probe.fieldCount).toBe(1);
  expect(probe.targetId).toBe('near-rock');
  expect(probe.nearest?.reason).toBe('ok');
});

test('server latch copies the field pose and explicit null clears it', () => {
  publishHarpoonField([{ id: 'rock-1', position: { x: 90, y: 10 }, velocity: { x: 0, y: 0 } }]);
  const local = host('hauler');
  applySharedHarpoonLatch(local, { harpoonTargetId: 'rock-1' });
  expect(local.harpoonTargetId).toBe('rock-1');
  expect(local.harpoonLatchPos).toEqual({ x: 90, y: 10 });
  applySharedHarpoonLatch(local, { harpoonTargetId: null });
  expect(local.harpoonTargetId).toBeNull();
  expect(local.harpoonLatchPos).toBeUndefined();
});

test('an omitted server latch field leaves the previous persistent latch alone', () => {
  const local = host('hauler');
  local.harpoonTargetId = 'rock-1';
  local.harpoonLatchPos = { x: 90, y: 10 };
  applySharedHarpoonLatch(local, {});
  expect(local.harpoonTargetId).toBe('rock-1');
  expect(local.harpoonLatchPos).toEqual({ x: 90, y: 10 });
});

test('ability cooldown ticks down', () => {
  const surveyor = host('surveyor');
  activateAbilityOnHost(surveyor);
  const start = surveyor.abilityCooldownFrames;
  tickAbilityHost(surveyor);
  expect(surveyor.abilityCooldownFrames).toBe(start - 1);
});

test('a rock beyond physical reach stays untowable regardless of zoom', () => {
  const hauler = host('hauler');
  const liveNear = {
    id: 'zoom-edge',
    position: { x: 9000, y: 0 },
    velocity: { x: 0, y: 0 },
    r: 40,
  };
  expect(findHarpoonTarget(hauler, [liveNear])).toBeUndefined();
  expect(activateAbilityOnHost(hauler, { asteroids: [liveNear] }).activated).toBe(false);
});

test('attaching a tow cable preserves the rock pose and momentum', () => {
  const hauler = host('hauler');
  const rock = {
    id: 'rock',
    position: { x: 80, y: 0 },
    velocity: { x: 2, y: -1 },
  };
  hauler.harpoonTargetId = rock.id ?? null;
  const position = { ...rock.position };
  const velocity = { ...rock.velocity };

  attachTowCable(hauler, rock);

  expect(rock.position).toEqual(position);
  expect(rock.velocity).toEqual(velocity);
});

test('a Hauler E release detaches the tow without a delayed launch', () => {
  const hauler = host('hauler');
  const rock: AbilityBody = {
    id: 'rock',
    position: { x: 80, y: 0 },
    velocity: { x: 2, y: 0 },
  };
  expect(activateAbilityOnHost(hauler, { asteroids: [rock] }).activated).toBe(true);
  const beforeRelease = { ...rock.velocity };
  expect(activateAbilityOnHost(hauler, { asteroids: [rock] }).activated).toBe(true);
  expect(hauler.harpoonTargetId).toBeNull();
  tickTowCable(hauler, rock);
  expect(rock.velocity).toEqual(beforeRelease);
});

test('local latch prediction records the target while leaving server rock momentum alone', () => {
  const hauler: AbilityHost = { ...host('hauler'), id: 'hauler' };
  const rock = {
    id: 'rock',
    position: { x: 80, y: 0 },
    velocity: { x: 2, y: 0 },
  };
  publishHarpoonField([rock]);
  const before = { ...rock.velocity };
  expect(activateAbilityOnHost(hauler).activated).toBe(true);
  expect(hauler.harpoonTargetId).toBe('rock');
  expect(rock.velocity).toEqual(before);
});
