import { describe, expect, it as test } from 'vitest';
import type { ServerEntityData } from '../../../shared-types';
import { Ship } from '../../../src/entities/ship/Ship';
import { PlayerMotionReconciliation } from '../../../src/network/services/PlayerMotionReconciliation';
import { snapshotFixture } from './snapshotFixture';

const OMITTED_MOTION_PATTERN = /omitted/u;

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
  test('a server blast survives the flight cap and then decays back to normal control speed', () => {
    const { ship, prediction } = fixture();
    prediction.rebase(
      row({
        position: { x: 0, y: 0 },
        velocity: { x: 24, y: 0 },
        playerMotion: { epoch: 3, mode: 'free', ack: 0 },
      }),
      ship,
      17
    );
    ship.thrusting = false;
    ship.update();
    expect(ship.position.x).toBeGreaterThan(20);
    expect(ship.velocity.x).toBeGreaterThan(ship.maxVelocity * 2);
    for (let frame = 0; frame < 90; frame++) {
      ship.update();
    }
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeLessThanOrEqual(ship.maxVelocity);
  });

  test('keeps handoff movement suppressed until a free-mode snapshot confirms the anchored acknowledgment', () => {
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
  });

  test('rejects older epochs and acknowledgments and never resurrects local predicted death', () => {
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

  test('holds predicted flight until the first authoritative pose after join', () => {
    const ship = new Ship({ kitId: 'hauler' });
    ship.position = { x: 12, y: 34 };
    const prediction = new PlayerMotionReconciliation();
    prediction.awaitAuthoritativePose();
    expect(prediction.shouldSuppressShipMove()).toBe(true);
    expect(prediction.buildHandoffPose(ship)).toBeNull();
    expect(
      prediction.rebase(
        row({
          position: { x: 80, y: 20 },
          velocity: { x: 3, y: 0 },
          playerMotion: { epoch: 2, mode: 'free', ack: 0 },
        }),
        ship,
        0
      )
    ).toBe(true);
    expect(ship.position).toEqual({ x: 80, y: 20 });
    expect(prediction.shouldSuppressShipMove()).toBe(false);
  });

  test('discards old socket predictions and resumes at the fresh authoritative pose without a stale snapback', () => {
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

  test('fails loudly on malformed snapshots and input without applying a corrupt transform', () => {
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
    expect(() => prediction.rebase(missingMotion, ship, 1)).toThrow(OMITTED_MOTION_PATTERN);
  });
});

test('late snapshots cannot undo boost toggles, refill an active tank, or restart an exhausted one', () => {
  const { ship, prediction } = fixture();
  ship.toggleBoost();
  ship.update();
  prediction.rebase(row(), ship, 10);
  expect(ship.boosting).toBe(true);
  const start = prediction.buildHandoffPose(ship);
  expect(start).not.toBeNull();
  if (!start) {
    throw new Error('Missing pose');
  }
  prediction.rebase(
    row({
      boost: { phase: 'active', charge: 1 },
      playerMotion: { epoch: 2, mode: 'free', ack: start.motionSequence },
    }),
    ship,
    20
  );
  expect(ship.boost.charge).toBeLessThan(1);
  ship.toggleBoost();
  const stoppedCharge = ship.boost.charge;
  prediction.rebase(
    row({
      boost: { phase: 'active', charge: 0.999 },
      playerMotion: { epoch: 2, mode: 'free', ack: start.motionSequence },
    }),
    ship,
    25
  );
  expect(ship.boost).toEqual({ phase: 'idle', charge: stoppedCharge });
  prediction.rebase(
    row({
      boost: { phase: 'active', charge: 0.9 },
      playerMotion: { epoch: 2, mode: 'free', ack: start.motionSequence },
    }),
    ship,
    30
  );
  expect(ship.boosting).toBe(false);
  ship.toggleBoost();
  const next = prediction.buildHandoffPose(ship);
  if (!next) {
    throw new Error('Missing pose');
  }
  for (let frame = 0; frame < 162; frame++) {
    ship.update();
  }
  expect(ship.boost.phase).toBe('exhausted');
  const depleted = prediction.buildHandoffPose(ship);
  if (!depleted) {
    throw new Error('Missing depleted pose');
  }
  prediction.rebase(
    row({
      boost: { phase: 'active', charge: 0.1 },
      playerMotion: { epoch: 2, mode: 'free', ack: next.motionSequence },
    }),
    ship,
    40
  );
  expect(ship.boost.phase).toBe('exhausted');
  prediction.rebase(
    row({
      boost: { phase: 'exhausted', charge: 0.5 },
      playerMotion: { epoch: 2, mode: 'free', ack: next.motionSequence },
    }),
    ship,
    50
  );
  expect(ship.toggleBoost()).toBe(true);
  const restarted = prediction.buildHandoffPose(ship);
  if (!restarted) {
    throw new Error('Missing restarted pose');
  }
  ship.update();
  const partialCharge = ship.boost.charge;
  // A recharge echo from before this activation must not cancel it or add fuel.
  prediction.rebase(
    row({
      boost: { phase: 'exhausted', charge: 0.7 },
      playerMotion: { epoch: 2, mode: 'free', ack: depleted.motionSequence },
    }),
    ship,
    60
  );
  expect(ship.boost).toEqual({ phase: 'active', charge: partialCharge });
  prediction.rebase(
    row({
      boost: { phase: 'active', charge: 0.49 },
      playerMotion: { epoch: 2, mode: 'free', ack: restarted.motionSequence },
    }),
    ship,
    70
  );
  expect(ship.boost).toEqual({ phase: 'active', charge: 0.49 });
  // An acknowledged server depletion still ends the burst.
  prediction.rebase(
    row({
      boost: { phase: 'exhausted', charge: 0 },
      playerMotion: { epoch: 2, mode: 'free', ack: restarted.motionSequence },
    }),
    ship,
    80
  );
  expect(ship.boosting).toBe(false);
});

test.each(['menu', 'death'])(
  'a delayed active snapshot cannot undo the local %s stop',
  (reason) => {
    const { ship, prediction } = fixture();
    ship.toggleBoost();
    const pose = prediction.buildHandoffPose(ship);
    if (!pose) {
      throw new Error('Missing active pose');
    }
    const active = row({
      boost: { phase: 'active', charge: 0.8 },
      playerMotion: { epoch: 2, mode: 'free', ack: pose.motionSequence },
    });
    prediction.rebase(active, ship, 10);
    if (reason === 'menu') {
      ship.movementLocked = true;
      ship.update();
    } else {
      ship.explode('asteroid');
    }
    prediction.rebase(active, ship, 20);
    expect(ship.boosting).toBe(false);
  }
);

test('an older server row leaves the finite predicted tank unchanged during rollout', () => {
  const { ship, prediction } = fixture();
  ship.toggleBoost();
  for (let frame = 0; frame < 90; frame++) {
    ship.update();
  }
  const previous = { ...ship.boost };
  const oldRow = row();
  delete oldRow.boost;
  prediction.rebase(oldRow, ship, 100);
  expect(ship.boost).toEqual(previous);
  for (let frame = 0; frame < 90; frame++) {
    ship.update();
  }
  prediction.rebase(oldRow, ship, 200);
  expect(ship.boost).toEqual({ phase: 'exhausted', charge: 0 });
});
