import { describe, expect, it } from 'vitest';
import type { ServerEntityData } from '../../../shared-types';
import { Ship } from '../../../src/entities/ship/Ship';
import { PlayerMotionReconciliation } from '../../../src/network/services/PlayerMotionReconciliation';
import { snapshotFixture } from './snapshotFixture';

function row(overrides: Partial<ServerEntityData> = {}): ServerEntityData {
  const entity = snapshotFixture().entities[0];
  if (!entity) {
    throw new Error('Missing fixture pilot');
  }
  return { ...entity, playerMotion: { epoch: 2, mode: 'free', ack: 0 }, ...overrides };
}
function fixture() {
  const ship = new Ship({ kitId: 'hauler' });
  const prediction = new PlayerMotionReconciliation();
  prediction.rebase(row(), ship, 0);
  return { ship, prediction };
}

describe('player motion recovery', () => {
  it('keeps handoff movement suppressed until a free-mode snapshot confirms the anchored acknowledgment', () => {
    const { ship, prediction } = fixture();
    prediction.rebase(
      row({
        position: { x: 100, y: 50 },
        velocity: { x: 4, y: 0 },
        playerMotion: { epoch: 3, mode: 'handoff', ack: 0, anchor: { x: 100, y: 50 } },
      }),
      ship,
      17
    );
    expect(prediction.shouldSuppressPose()).toBe(true);
    const ack = prediction.buildHandoffPose(ship);
    expect(ack).toMatchObject({
      motionEpoch: 3,
      position: { x: 100, y: 50 },
      velocity: { x: 4, y: 0 },
    });
    expect(prediction.shouldSuppressShipMove()).toBe(true);
    expect(ship.position).toEqual({ x: 100, y: 50 });
    prediction.rebase(
      row({
        position: { x: 100, y: 50 },
        velocity: { x: 4, y: 0 },
        playerMotion: { epoch: 3, mode: 'free', ack: ack?.motionSequence ?? 0 },
      }),
      ship,
      34
    );
    expect(prediction.shouldSuppressShipMove()).toBe(false);
    ship.position.x += 4;
    ship.fuel = 5;
    ship.lastLocalFuelWriteMs = 49;
    prediction.rebase(
      row({
        position: { x: 100, y: 50 },
        velocity: { x: 4, y: 0 },
        playerMotion: { epoch: 3, mode: 'free', ack: ack?.motionSequence ?? 0 },
      }),
      ship,
      50
    );
    expect(ship.position.x).toBe(104); // Ordinary client prediction remains local.
    expect(ship.fuel).toBe(5); // Motion reconciliation preserves local fuel prediction.
    expect(ship.lastLocalFuelWriteMs).toBe(49);
  });

  it('rejects older epochs and acknowledgments and never resurrects local predicted death', () => {
    const { ship, prediction } = fixture();
    prediction.rebase(row({ playerMotion: { epoch: 2, mode: 'free', ack: 5 } }), ship, 10);
    const before = { ...ship.position };
    expect(
      prediction.rebase(
        row({
          position: { x: 999, y: 999 },
          playerMotion: { epoch: 2, mode: 'free', ack: 4 },
        }),
        ship,
        11
      )
    ).toBe(false);
    expect(
      prediction.rebase(
        row({ position: { x: 999, y: 999 }, playerMotion: { epoch: 1, mode: 'free', ack: 99 } }),
        ship,
        12
      )
    ).toBe(false);
    expect(ship.position).toEqual(before);
    ship.health = 0;
    ship.exploding = true;
    prediction.rebase(row({ health: 140 }), ship, 13);
    expect(ship.health).toBe(0);
    expect(ship.exploding).toBe(true);
  });

  it('discards old socket predictions and resumes at the fresh authoritative pose without a stale snapback', () => {
    const { ship, prediction } = fixture();
    prediction.transportClosed();
    expect(prediction.buildHandoffPose(ship)).toBeNull();
    expect(prediction.shouldSuppressShipMove()).toBe(true);
    prediction.rebase(
      row({
        position: { x: 300, y: 100 },
        velocity: { x: 7, y: 0 },
        playerMotion: { epoch: 2, mode: 'free', ack: 8 },
      }),
      ship,
      50
    );
    expect(ship.position).toEqual({ x: 300, y: 100 });
    expect(prediction.buildHandoffPose(ship)?.motionSequence).toBe(9);
    prediction.reset();
    expect(prediction.shouldSuppressShipMove()).toBe(false);
    expect(prediction.buildHandoffPose(ship)).toBeNull();
  });

  it('fails loudly on malformed snapshots and input without applying a corrupt transform', () => {
    const { ship, prediction } = fixture();
    const position = { ...ship.position };
    expect(() => prediction.rebase(row({ position: { x: NaN, y: 0 } }), ship, 1)).toThrow(
      RangeError
    );
    expect(ship.position).toEqual(position);
    expect(() =>
      prediction.rebase(row({ playerMotion: { epoch: 2, mode: 'handoff', ack: 0 } }), ship, 1)
    ).toThrow(RangeError);
    const missingMotion = row();
    delete missingMotion.playerMotion;
    expect(() => prediction.rebase(missingMotion, ship, 1)).toThrow(/omitted/);
  });
});
