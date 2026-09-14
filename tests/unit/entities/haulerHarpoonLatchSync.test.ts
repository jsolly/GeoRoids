import { expect, test } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { canDrawHaulerHarpoon } from '../../../src/entities/ship/shipRenderer';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

test('local Hauler adopts a server ship latch so the tether can draw', () => {
  const local = new Player({
    id: 'alice',
    name: 'Alice',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'hauler',
  });
  expect(canDrawHaulerHarpoon(local.ship)).toBe(false);

  local.updateFromServer({ harpoonTargetId: 'bob' });

  expect(local.ship.harpoonTargetId).toBe('bob');
  expect(canDrawHaulerHarpoon(local.ship)).toBe(true);
});

test('local Hauler keeps the cable through a brief socket rejoin snapshot gap', () => {
  const local = new Player({
    id: 'alice',
    name: 'Alice',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'hauler',
  });

  local.updateFromServer({
    harpoonTargetId: 'server-asteroid-1-0',
    harpoonLatchPos: { x: 120, y: 15 },
  });
  // handleJoined resets transient death state but intentionally preserves a
  // live predictive latch until a real authoritative latch arrives.
  local.resetCombatLifecycle();
  local.updateFromServer({});

  expect(local.ship.harpoonTargetId).toBe('server-asteroid-1-0');
  expect(local.ship.harpoonLatchPos).toEqual({ x: 120, y: 15 });
  expect(canDrawHaulerHarpoon(local.ship)).toBe(true);
});

test('local Hauler keeps its kit when a stale snapshot echoes surveyor', () => {
  const local = new Player({
    id: 'alice',
    name: 'Alice',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'hauler',
  });
  local.updateFromServer({
    kitId: 'surveyor',
    harpoonTargetId: 'server-asteroid-10',
  });
  expect(local.ship.kitId).toBe('hauler');
  expect(local.ship.harpoonTargetId).toBe('server-asteroid-10');
  expect(canDrawHaulerHarpoon(local.ship)).toBe(true);
});

test('remote Hauler matches the same server latch', () => {
  const remote = new Player({
    id: 'alice',
    name: 'Alice',
    type: 'remote',
    input: new MockPlayerInput(),
    kitId: 'hauler',
  });

  remote.updateFromServer({ harpoonTargetId: 'bob' });
  expect(remote.ship.harpoonTargetId).toBe('bob');
  expect(canDrawHaulerHarpoon(remote.ship)).toBe(true);

  remote.updateFromServer({ harpoonTargetId: null });
  expect(remote.ship.harpoonTargetId).toBeNull();
  expect(canDrawHaulerHarpoon(remote.ship)).toBe(false);
});
