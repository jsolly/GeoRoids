import { describe, expect, test } from 'vitest';
import {
  captureSnapshot,
  encodeSnapshot,
  type SnapshotBaseline,
  SnapshotDecoder,
} from '../../../shared/snapshotProtocol';
import { snapshotFixture } from './snapshotFixture';

describe('pilots reconstruct complete authoritative worlds', () => {
  test('moving ticks preserve every field, effect clears, removal, death and respawn', () => {
    const decoder = new SnapshotDecoder();
    let baseline: SnapshotBaseline | undefined;
    let deltas = 0;
    for (let tick = 0; tick < 140; tick++) {
      const world = snapshotFixture(tick);
      const pilot = world.entities[1]!;
      for (const ship of world.entities) {
        ship.abilityActiveFrames = tick < 25 ? 25 - tick : 0;
        ship.abilityCooldownFrames = tick < 50 ? 50 - tick : 0;
        ship.shieldTimer = tick < 10 ? 10 - tick : 0;
        ship.shieldCooldown = tick < 50 ? 50 - tick : 0;
      }
      if (tick < 20) {
        pilot.harpoonTargetId = 'asteroid-1';
        pilot.harpoonLatchPos = { x: 90, y: 60 };
        pilot.harpoonTimer = 30 - tick;
        pilot.shieldActive = true;
        pilot.shieldTime = 30 - tick;
      }
      if (tick >= 30 && tick < 60) {
        pilot.health = 0;
        pilot.exploding = true;
        pilot.lives = 2;
        pilot.respawnTimer = 60 - tick;
        pilot.deathCause = 'boundary';
      }
      pilot.fuel = tick < 70 ? 50 - tick / 2 : 80;
      if (tick >= 80) {
        world.entities.pop();
        world.loot = [];
      }
      if (tick >= 100) {
        world.asteroids = [];
      }
      if (tick >= 45 && tick < 65) {
        world.satellites[0]!.exploding = true;
        world.satellites[0]!.health = 0;
        world.satelliteProjectiles = world.satelliteProjectiles.filter(
          (shot) => shot.satelliteId !== 'eo-0'
        );
      }
      if (tick === 25) {
        world.asteroids[0]!.material = 'metal';
        world.asteroids[0]!.health = 25;
        world.asteroids[0]!.offsets = [1, 0.6, 1.1, 0.8];
        world.asteroids[0]!.vertices = 4;
      }
      if (tick >= 130) {
        world.satellites = [];
        world.satelliteProjectiles = [];
        world.satellitePickups = [];
      }
      // New fields and collections cannot be dropped by a stale codec whitelist.
      const extended = Object.assign(world, {
        futureFeature: { active: tick < 50, value: [tick, null] },
        futureNpcs: [{ id: 'eo', pattern: 'fan', shots: tick < 60 ? ['a', 'b'] : [] }],
      });
      const state = captureSnapshot(extended);
      const frame = encodeSnapshot(state, tick + 1, tick % 90 ? baseline : undefined);
      if (frame.kind === 'delta') {
        deltas++;
      }
      expect(decoder.decode(JSON.parse(JSON.stringify(frame)))).toEqual(
        JSON.parse(JSON.stringify(extended))
      );
      baseline = { sequence: tick + 1, state };
    }
    expect(deltas).toBeGreaterThan(100);
  });

  test('explicit clears delete fields and nested arrays replace without retaining stale values', () => {
    const a = captureSnapshot(snapshotFixture());
    a.entities[0]!.harpoonTargetId = 'rock';
    a.entities[0]!.harpoonLatchPos = { x: 1, y: 2 };
    const b = captureSnapshot(snapshotFixture(1));
    b.asteroids[0]!.offsets = [0.2, 0.3];
    const decoder = new SnapshotDecoder();
    decoder.decode(encodeSnapshot(a, 1));
    const delta = encodeSnapshot(b, 2, { sequence: 1, state: a });
    expect(delta.kind).toBe('delta');
    const decoded = decoder.decode(delta);
    expect(decoded).toEqual(b);
    expect(Object.hasOwn(decoded.entities[0]!, 'harpoonTargetId')).toBe(false);
  });

  test('bad packets leave the last baseline intact and a fresh keyframe repairs gaps', () => {
    const decoder = new SnapshotDecoder();
    const state = captureSnapshot(snapshotFixture());
    decoder.decode(encodeSnapshot(state, 1));
    const next = captureSnapshot(snapshotFixture(1));
    const delta = encodeSnapshot(next, 2, { sequence: 1, state });
    expect(() => decoder.decode({ ...delta, sequence: 3 })).toThrow(/baseline/);
    expect(() =>
      decoder.decode({
        version: 1,
        sequence: 2,
        kind: 'delta',
        baseline: 1,
        patch: {
          set: {},
          clear: [],
          collections: {
            entities: { add: [], update: [['pilot-0', { health: 'invalid' }, []]], remove: [] },
          },
        },
      })
    ).toThrow(/DTO/);
    const invalidReference = captureSnapshot(snapshotFixture(2));
    invalidReference.satelliteProjectiles[0]!.satelliteId = 'missing-eo';
    expect(() => decoder.decode(encodeSnapshot(invalidReference, 2))).toThrow(/references/);
    expect(decoder.decode(delta)).toEqual(next);
    expect(() => decoder.decode(delta)).toThrow(/Stale/);
    expect(() =>
      decoder.decode(
        JSON.parse(
          '{"version":1,"sequence":3,"kind":"delta","baseline":2,"patch":{"set":{"__proto__":{"polluted":true}},"clear":[],"collections":{}}}'
        )
      )
    ).toThrow(/Unsafe/);
    expect(decoder.decode(encodeSnapshot(state, 50))).toEqual(state);
    decoder.reset();
    expect(() => decoder.decode(delta)).toThrow(/baseline/);
    expect(decoder.decode(encodeSnapshot(state, 1))).toEqual(state);
  });

  test('engine and application mutations never corrupt the other side of a baseline', () => {
    const engine = snapshotFixture();
    const captured = captureSnapshot(engine);
    engine.entities[0]!.position.x = -900;
    expect(captured.entities[0]!.position.x).toBe(500);
    const decoder = new SnapshotDecoder();
    const applied = decoder.decode(encodeSnapshot(captured, 1));
    applied.entities[0]!.position.x = -800;
    const changed = captureSnapshot(snapshotFixture());
    changed.gameTime = 1;
    expect(decoder.decode(encodeSnapshot(changed, 2, { sequence: 1, state: captured }))).toEqual(
      changed
    );
  });
});
