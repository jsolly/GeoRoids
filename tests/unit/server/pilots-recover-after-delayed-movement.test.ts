import { afterEach, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { PLAYER_MOTION } from '../../../shared/playerMotion';
import { cruiseSpeed } from '../../../shared/shipFlight';
import { Ship } from '../../../src/entities/ship/Ship';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { PlayerMotionReconciliation } from '../../../src/network/services/PlayerMotionReconciliation';
import { RecordingSocket } from '../../support/recordingSocket';

const engines: GameEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.stopGameLoop();
  }
});

function flight() {
  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => 10_000, monotonicNow: () => elapsed });
  const engine = new GameEngine(42, clock);
  engines.push(engine);
  const socket = new RecordingSocket();
  const actor = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, 'hauler');
  actor.asteroidInteractions = 1;
  actor.spawnProtectionTimer = 0;
  expect(engine.playerMotion.register(actor, socket, 1, clock.now()).ok).toBe(true);
  const ship = new Ship({ kitId: 'hauler' });
  const prediction = new PlayerMotionReconciliation();
  const reconcile = () => {
    const row = engine.getGameState().entities.find((row) => row.id === actor.id);
    if (!row) {
      throw new Error('Pilot snapshot unavailable');
    }
    prediction.rebase(row, ship, clock.now());
    ship.serverOwnsMotion = prediction.shouldSuppressShipMove();
  };
  reconcile();
  ship.angle = 0;
  ship.thrusting = true;
  ship.velocity = { x: cruiseSpeed(ship.mass, getShipKit('hauler').maxVelocity), y: 0 };
  const report = () => {
    const pose = prediction.buildHandoffPose(ship);
    if (!pose) {
      throw new Error('Pilot pose unavailable');
    }
    const { motionEpoch, motionSequence, ...transform } = pose;
    return engine.playerMotion.acceptFreePose(
      socket,
      { ...transform, epoch: motionEpoch, sequence: motionSequence },
      clock.now()
    );
  };
  const advance = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      elapsed += 1000 / 60;
      ship.update();
    }
  };
  return { engine, actor, ship, prediction, clock, socket, reconcile, report, advance };
}

test.each([12, 30, 60])(
  'a Hauler keeps moving and firing after %i delayed simulation frames',
  (frames) => {
    const f = flight();
    const initial = { ...f.ship.position };
    f.advance(frames);
    expect(
      Math.hypot(f.ship.position.x - initial.x, f.ship.position.y - initial.y)
    ).toBeGreaterThan(frames / 2);
    expect(f.report().ok).toBe(true);
    expect(f.actor.position).toEqual(f.ship.position);
    f.reconcile();
    const afterDelay = { ...f.ship.position };
    for (let i = 0; i < 60; i++) {
      f.advance(1);
      expect(f.report().ok).toBe(true);
      f.reconcile();
    }
    expect(
      Math.hypot(f.ship.position.x - afterDelay.x, f.ship.position.y - afterDelay.y)
    ).toBeGreaterThan(30);
    const laser = f.ship.generateLaser();
    expect(
      f.engine.spawnPlayerLaser(f.actor.id, laser.position, laser.velocity, f.clock.now())
    ).not.toBeNull();
  }
);

test('a rejected pose rebases the pilot once, then movement, shooting and asteroid impacts work', () => {
  const f = flight();
  f.advance(2);
  expect(f.report().ok).toBe(true);
  const accepted = { ...f.actor.position };
  const oldEpoch = f.actor.playerMotion?.epoch;
  f.ship.position.x += 500;
  expect(f.report().ok).toBe(false);
  expect(f.actor.position).toEqual(accepted);
  expect(f.actor.playerMotion).toMatchObject({ mode: 'handoff', epoch: (oldEpoch ?? 0) + 1 });
  // Already-queued old poses cannot keep changing the recovery epoch.
  expect(f.report().ok).toBe(false);
  expect(f.actor.playerMotion?.epoch).toBe((oldEpoch ?? 0) + 1);
  f.reconcile();
  expect(f.ship.position).toEqual(accepted);
  expect(f.ship.serverOwnsMotion).toBe(true);
  expect(f.report().ok).toBe(true);
  f.reconcile();
  expect(f.ship.serverOwnsMotion).toBe(false);
  f.advance(12);
  expect(f.report().ok).toBe(true);
  const laser = f.ship.generateLaser();
  expect(
    f.engine.spawnPlayerLaser(f.actor.id, laser.position, laser.velocity, f.clock.now())
  ).not.toBeNull();
  for (const rock of f.engine.getAllAsteroids()) {
    f.engine.removeAsteroid(rock.id);
  }
  f.engine.addAsteroid({
    id: 'impact-rock',
    position: { ...f.ship.position },
    velocity: { x: 0, y: 0 },
    size: 10,
    jaggedness: 0.4,
    rotation: 0,
    angularVelocity: 0,
    health: 25,
    maxHealth: 25,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  });
  const health = f.actor.health;
  f.engine.resolveAuthoritativeCombat();
  expect(f.actor.health).toBeLessThan(health);
  expect(f.engine.getAsteroid('impact-rock')).toBeUndefined();
});

test('repeated invalid poses cannot refill spent movement credit', () => {
  const f = flight();
  const speed = f.engine.playerMotion.legalSpeed(f.actor, f.clock.now());
  // Spend all startup jitter credit without advancing server time.
  f.ship.position.x += speed * PLAYER_MOTION.poseLeadFrames;
  expect(f.report().ok).toBe(true);
  const accepted = { ...f.actor.position };
  for (let attempt = 0; attempt < 5; attempt++) {
    f.ship.position.x += speed;
    expect(f.report().ok).toBe(false);
    expect(f.actor.position).toEqual(accepted);
    f.reconcile();
    expect(f.report().ok).toBe(true);
    f.reconcile();
  }
  // Three frames span exactly 50 ms on the server's integer clock.
  f.advance(3);
  expect(f.report().ok).toBe(true);
  expect(f.actor.position.x).toBeGreaterThan(accepted.x);
});

test.each([120, 3600])('a silent pilot cannot bank %i frames of travel into one jump', (frames) => {
  const f = flight();
  const accepted = { ...f.actor.position };
  f.advance(frames);
  expect(f.report().ok).toBe(false);
  expect(f.actor.position).toEqual(accepted);
  expect(f.actor.playerMotion?.mode).toBe('handoff');
  f.reconcile();
  expect(f.report().ok).toBe(true);
  f.reconcile();
  f.advance(12);
  expect(f.report().ok).toBe(true);
});
