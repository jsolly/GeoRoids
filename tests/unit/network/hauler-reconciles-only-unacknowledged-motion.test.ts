import { describe, expect, it } from 'vitest';
import { stepReleasedMotion } from '../../../shared/asteroidMotion';
import type { ServerEntityData } from '../../../shared-types';
import { Ship } from '../../../src/entities/ship/Ship';
import { AsteroidMotionPrediction } from '../../../src/network/services/AsteroidMotionPrediction';

function row(overrides: Partial<ServerEntityData> = {}): ServerEntityData {
  return {
    id: 'pilot',
    name: 'Pilot',
    type: 'human',
    position: { x: 0, y: 0 },
    velocity: { x: 10, y: 0 },
    angle: 0,
    exploding: false,
    thrusting: false,
    color: '#5EEAD4',
    lives: 3,
    score: 0,
    health: 140,
    maxHealth: 140,
    fuel: 30,
    maxFuel: 100,
    mass: 1,
    kitId: 'hauler',
    factionId: 'ion',
    asteroidMotion: { epoch: 2, mode: 'released', ack: 0 },
    ...overrides,
  };
}

function fixture() {
  const ship = new Ship({ kitId: 'hauler' });
  const prediction = new AsteroidMotionPrediction();
  prediction.rebase(row(), ship, 0);
  return { ship, prediction };
}

describe('the local Hauler reconciles pending commands against its server motion epoch', () => {
  it('rebases from server motion and replays only commands beyond the acknowledged sequence', () => {
    const { ship, prediction } = fixture();
    const first = prediction.buildInput(ship, 0);
    prediction.predictFrame(ship, 0);
    const acknowledged = {
      position: { ...ship.position },
      velocity: { ...ship.velocity },
      angle: ship.angle,
    };
    const second = prediction.buildInput(ship, 17);
    prediction.predictFrame(ship, 17);
    expect(first?.sequence).toBe(1);
    expect(second?.sequence).toBe(2);
    const expected = {
      position: { ...acknowledged.position },
      velocity: { ...acknowledged.velocity },
      angle: acknowledged.angle,
    };
    if (!second) throw new Error('Missing pending input');
    stepReleasedMotion(expected, second, 4 / 60, 380, 1);
    ship.position.x = -999;
    prediction.rebase(
      row({ ...acknowledged, fuel: 29, asteroidMotion: { epoch: 2, mode: 'released', ack: 1 } }),
      ship,
      30
    );
    expect(ship.position).toEqual(expected.position);
    expect(ship.velocity).toEqual(expected.velocity);
    expect(ship.fuel).toBe(29);
    prediction.predictFrame(ship, 31);
    expect(ship.position).toEqual(expected.position);
    prediction.rebase(
      row({
        position: expected.position,
        velocity: expected.velocity,
        asteroidMotion: { epoch: 2, mode: 'released', ack: 2 },
      }),
      ship,
      40
    );
    prediction.predictFrame(ship, 41);
    expect(ship.position).toEqual(expected.position);
  });

  it('uses actual thrust, angular-velocity and aim input while assigning one sequence stream to UI actions', () => {
    const { ship, prediction } = fixture();
    ship.thrusting = true;
    ship.angularVelocity = -0.1;
    ship.angle = 8 * Math.PI + 0.2;
    const move = prediction.buildInput(ship, 0);
    const action = prediction.buildInput(ship, 0, { action: 'release' });
    expect(move).toMatchObject({ epoch: 2, sequence: 1, thrust: true, turn: -1 });
    expect(move?.aimAngle).toBeCloseTo(0.2, 10);
    expect(action).toMatchObject({ sequence: 2, action: 'release' });
    const before = {
      position: { ...ship.position },
      velocity: { ...ship.velocity },
      angle: ship.angle,
    };
    if (!move) throw new Error('Missing command');
    stepReleasedMotion(before, move, 4 / 60, 380, 1);
    prediction.predictFrame(ship, 0);
    expect(ship.position).toEqual(before.position);
    prediction.predictFrame(ship, 100);
    expect(ship.position).toEqual(before.position);
  });

  it('follows a supplied authoritative rock pose without simulating fuel, torque or spin on the client', () => {
    const { ship, prediction } = fixture();
    const rock = {
      id: 'spinner',
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      rotation: 0,
      angularVelocity: 0.1,
    };
    prediction.rebase(
      row({
        position: { x: 80, y: 0 },
        asteroidMotion: { epoch: 3, mode: 'latched', ack: 0, asteroidId: rock.id, latchAngle: 0 },
      }),
      ship,
      1,
      [rock]
    );
    rock.rotation = Math.PI / 2;
    rock.position = { x: 10, y: 20 };
    const authoritative = structuredClone(rock);
    prediction.buildInput(ship, 17, { thrust: true, aimAngle: -Math.PI / 2 });
    prediction.predictFrame(ship, 17, [rock]);
    expect(ship.position.x).toBeCloseTo(10, 10);
    expect(ship.position.y).toBeCloseTo(100, 10);
    expect(ship.fuel).toBe(30);
    expect(rock).toEqual(authoritative);
    expect(prediction.shouldSuppressShipMove()).toBe(true);
    const held = { ...ship.position };
    prediction.buildInput(ship, 34);
    prediction.predictFrame(ship, 34, []);
    expect(ship.position).toEqual(held);
  });

  it('keeps handoff movement suppressed until a free-mode snapshot confirms the anchored acknowledgment', () => {
    const { ship, prediction } = fixture();
    prediction.buildInput(ship, 0);
    prediction.rebase(
      row({
        position: { x: 100, y: 50 },
        velocity: { x: 4, y: 0 },
        asteroidMotion: { epoch: 3, mode: 'handoff', ack: 0, anchor: { x: 100, y: 50 } },
      }),
      ship,
      17
    );
    expect(prediction.shouldSuppressPose()).toBe(true);
    expect(prediction.buildInput(ship, 18)).toBeNull();
    const ack = prediction.buildHandoffPose(ship);
    expect(ack).toMatchObject({
      motionEpoch: 3,
      position: { x: 100, y: 50 },
      velocity: { x: 4, y: 0 },
    });
    expect(prediction.shouldSuppressShipMove()).toBe(true);
    prediction.predictFrame(ship, 33);
    expect(ship.position).toEqual({ x: 100, y: 50 });
    prediction.rebase(
      row({
        position: { x: 100, y: 50 },
        velocity: { x: 4, y: 0 },
        asteroidMotion: { epoch: 3, mode: 'free', ack: ack?.motionSequence ?? 0 },
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
        asteroidMotion: { epoch: 3, mode: 'free', ack: ack?.motionSequence ?? 0 },
      }),
      ship,
      50
    );
    expect(ship.position.x).toBe(104); // Ordinary client prediction remains local.
    expect(ship.fuel).toBe(5); // Ordinary EMP echo handling remains in its existing owner.
    expect(ship.lastLocalFuelWriteMs).toBe(49);
  });

  it('rejects older epochs and acknowledgments and never resurrects local predicted death', () => {
    const { ship, prediction } = fixture();
    prediction.rebase(row({ asteroidMotion: { epoch: 2, mode: 'released', ack: 5 } }), ship, 10);
    const before = { ...ship.position };
    expect(
      prediction.rebase(
        row({
          position: { x: 999, y: 999 },
          asteroidMotion: { epoch: 2, mode: 'released', ack: 4 },
        }),
        ship,
        11
      )
    ).toBe(false);
    expect(
      prediction.rebase(
        row({ position: { x: 999, y: 999 }, asteroidMotion: { epoch: 1, mode: 'free', ack: 99 } }),
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
    expect(prediction.buildInput(ship, 14)).toBeNull();
  });

  it('discards old socket predictions and resumes at the fresh authoritative pose without a stale snapback', () => {
    const { ship, prediction } = fixture();
    prediction.buildInput(ship, 0);
    prediction.predictFrame(ship, 0);
    prediction.transportClosed();
    expect(prediction.buildInput(ship, 17)).toBeNull();
    expect(prediction.buildHandoffPose(ship)).toBeNull();
    expect(prediction.shouldSuppressShipMove()).toBe(true);
    prediction.rebase(
      row({
        position: { x: 300, y: 100 },
        velocity: { x: 7, y: 0 },
        asteroidMotion: { epoch: 2, mode: 'released', ack: 8 },
      }),
      ship,
      50
    );
    expect(ship.position).toEqual({ x: 300, y: 100 });
    prediction.predictFrame(ship, 51);
    expect(ship.position).toEqual({ x: 300, y: 100 });
    expect(prediction.buildInput(ship, 67)?.sequence).toBe(9);
    prediction.reset();
    expect(prediction.shouldSuppressShipMove()).toBe(false);
    expect(prediction.getState()).toBeUndefined();
    expect(prediction.buildInput(ship, 68)).toBeNull();
  });

  it('stops producing commands on acknowledgment overflow and exposes a recovery reason until the server catches up', () => {
    const { ship, prediction } = fixture();
    for (let index = 0; index < 32; index += 1) {
      expect(prediction.buildInput(ship, index * 17)).not.toBeNull();
    }
    expect(prediction.buildInput(ship, 32 * 17)).toBeNull();
    expect(prediction.recoveryReason()).toMatch(/acknowledgment queue exhausted/);
    expect(prediction.shouldSuppressPose()).toBe(true);
    prediction.rebase(
      row({ position: { x: 20, y: 0 }, asteroidMotion: { epoch: 2, mode: 'released', ack: 32 } }),
      ship,
      600
    );
    expect(prediction.recoveryReason()).toBeUndefined();
    expect(prediction.buildInput(ship, 617)?.sequence).toBe(33);
  });

  it('fails loudly on malformed snapshots and input without applying a corrupt transform', () => {
    const { ship, prediction } = fixture();
    const position = { ...ship.position };
    expect(() => prediction.rebase(row({ position: { x: NaN, y: 0 } }), ship, 1)).toThrow(
      RangeError
    );
    expect(ship.position).toEqual(position);
    expect(() =>
      prediction.rebase(row({ asteroidMotion: { epoch: 2, mode: 'handoff', ack: 0 } }), ship, 1)
    ).toThrow(RangeError);
    expect(() => prediction.rebase(row({ asteroidMotion: undefined }), ship, 1)).toThrow(/omitted/);
    expect(() => prediction.buildInput(ship, 1, { aimAngle: Infinity })).toThrow(RangeError);
    expect(prediction.buildInput(ship, 1)?.sequence).toBe(1);
  });
});
