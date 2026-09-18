import { afterEach, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { MAX_CATCH_UP_TICKS } from '../../../shared/gameClock';
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
    const entityRow = engine
      .getGameState()
      .entities.find((candidateRow) => candidateRow.id === actor.id);
    if (!entityRow) {
      throw new Error('Pilot snapshot unavailable');
    }
    prediction.rebase(entityRow, ship, clock.now());
    ship.serverOwnsMotion = prediction.shouldSuppressShipMove();
  };
  reconcile();
  ship.angle = 0;
  ship.thrusting = true;
  ship.velocity = { x: cruiseSpeed(ship.mass, getShipKit('hauler').maxVelocity), y: 0 };
  // Build the pose now; the transport may deliver it later.
  const capture = () => {
    const pose = prediction.buildHandoffPose(ship);
    if (!pose) {
      throw new Error('Pilot pose unavailable');
    }
    const { motionEpoch, motionSequence, ...transform } = pose;
    return { ...transform, epoch: motionEpoch, sequence: motionSequence };
  };
  const submit = (pose: ReturnType<typeof capture>) =>
    engine.playerMotion.acceptFreePose(socket, pose, clock.now());
  const report = () => submit(capture());
  const advance = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      elapsed += 1000 / 60;
      ship.update();
    }
  };
  // Let time pass while the ship stays parked where it is.
  const wait = (frames: number) => {
    elapsed += (frames * 1000) / 60;
  };
  return {
    engine,
    actor,
    ship,
    prediction,
    clock,
    socket,
    reconcile,
    capture,
    submit,
    report,
    advance,
    wait,
  };
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
  const rejected = f.report();
  expect(rejected).toMatchObject({
    ok: false,
    error: 'Enhanced movement exceeds its server-time envelope',
    envelope: { check: 'displacement', mode: 'free', elapsedMs: 0 },
  });
  if (rejected.ok || !rejected.envelope) {
    throw new Error('Expected envelope diagnostics on the rejected pose');
  }
  // The previous accepted pose left the full lead in reserve and no time has
  // passed, so the credit is the lead; the ship itself still cruises legally.
  const speed = f.engine.playerMotion.legalSpeed(f.actor, f.clock.now());
  expect(rejected.envelope.displacement).toBe(500);
  expect(rejected.envelope.credit / speed).toBeCloseTo(PLAYER_MOTION.poseLeadFrames, 1);
  expect(rejected.envelope.speed).toBeCloseTo(speed, 6);
  expect(rejected.envelope.velocity).toBeCloseTo(speed, 2);
  expect(rejected.envelope.velocity).toBeLessThanOrEqual(speed);
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

test.each([200, 400, 900])(
  'a %i ms network hold that releases buffered 60 Hz poses together does not rewind the pilot',
  (holdMs) => {
    const f = flight();
    f.advance(2);
    expect(f.report().ok).toBe(true);
    f.reconcile();
    const lastAccepted = { ...f.actor.position };
    const epoch = f.actor.playerMotion?.epoch;
    // The client keeps flying and reporting every frame, but nothing reaches
    // the server until the hold ends; then every buffered pose lands at once.
    const buffered: ReturnType<typeof f.capture>[] = [];
    for (let frame = 0; frame < Math.round((holdMs * 60) / 1000); frame++) {
      f.advance(1);
      buffered.push(f.capture());
    }
    const outcomes = buffered.map((pose) => f.submit(pose));
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
    expect(f.actor.playerMotion).toMatchObject({ mode: 'free', epoch });
    expect(f.actor.position).toEqual(f.ship.position);
    // The whole hold was replayed: one frame of cruise travel per buffered pose.
    const speed = f.engine.playerMotion.legalSpeed(f.actor, f.clock.now());
    expect(f.actor.position.x - lastAccepted.x).toBeGreaterThan(buffered.length * speed * 0.95);
    // Ordinary flight continues from the delivered position, not the held one.
    f.reconcile();
    expect(f.ship.position).toEqual(f.actor.position);
    f.advance(12);
    expect(f.report().ok).toBe(true);
  }
);

/** Ambient rocks must not hit the pilot while the clock replays a blocked second. */
function clearAmbientField(f: ReturnType<typeof flight>): void {
  for (const rock of f.engine.getAllAsteroids()) {
    f.engine.removeAsteroid(rock.id);
  }
}

test('a network hold longer than the one-second catch-up window still rebases the pilot to the last delivered pose', () => {
  const f = flight();
  clearAmbientField(f);
  expect(f.engine.stepClock()).toBe(0);
  f.advance(2);
  expect(f.report().ok).toBe(true);
  f.reconcile();
  // The server keeps ticking on time; only the pilot's link holds the reports.
  const buffered: ReturnType<typeof f.capture>[] = [];
  for (let frame = 0; frame < 72; frame++) {
    f.advance(1);
    f.engine.stepClock();
    buffered.push(f.capture());
  }
  const outcomes = buffered.map((pose) => f.submit(pose));
  const firstRejected = outcomes.findIndex((outcome) => !outcome.ok);
  expect(firstRejected).toBeGreaterThan(60);
  expect(outcomes[firstRejected]).toMatchObject({
    ok: false,
    envelope: { check: 'displacement', mode: 'free', elapsedMs: 0, blockedMs: 0 },
  });
  expect(f.actor.playerMotion?.mode).toBe('handoff');
  expect(f.actor.position).toEqual(buffered[firstRejected - 1]?.position);
});

test('honest 60 Hz poses queued while the server loop was blocked for 1.6 s all land after the join', () => {
  const f = flight();
  clearAmbientField(f);
  expect(f.engine.stepClock()).toBe(0);
  f.advance(2);
  expect(f.report().ok).toBe(true);
  f.reconcile();
  const lastAccepted = { ...f.actor.position };
  const epoch = f.actor.playerMotion?.epoch;
  // The pilot keeps cruising and reporting every frame, but the server's own
  // event loop is blocked and reads none of it until the block ends.
  const buffered: ReturnType<typeof f.capture>[] = [];
  for (let frame = 0; frame < 96; frame++) {
    f.advance(1);
    buffered.push(f.capture());
  }
  // The loop resumes: the clock tick catches up, then the queued poses drain
  // together inside the same server millisecond, exactly as production logged.
  expect(f.engine.stepClock()).toBe(MAX_CATCH_UP_TICKS);
  const outcomes = buffered.map((pose) => f.submit(pose));
  expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
  // Only the first drained pose spans the block; the rest follow it directly.
  expect(outcomes[0]).toEqual({ ok: true, blockedMs: 1600 });
  expect(outcomes[1]).toEqual({ ok: true, blockedMs: 0 });
  expect(f.actor.playerMotion).toMatchObject({ mode: 'free', epoch });
  expect(f.actor.position).toEqual(f.ship.position);
  const speed = f.engine.playerMotion.legalSpeed(f.actor, f.clock.now());
  expect(f.actor.position.x - lastAccepted.x).toBeGreaterThan(buffered.length * speed * 0.95);
  // Flight simply continues from where the pilot really is.
  f.reconcile();
  expect(f.ship.serverOwnsMotion).toBe(false);
  f.advance(12);
  expect(f.report().ok).toBe(true);
});

test('honest 60 Hz poses queued behind a slow 1.6 s catch-up tick all land as well', () => {
  const f = flight();
  clearAmbientField(f);
  expect(f.engine.stepClock()).toBe(0);
  f.advance(2);
  expect(f.report().ok).toBe(true);
  f.reconcile();
  const epoch = f.actor.playerMotion?.epoch;
  const buffered: ReturnType<typeof f.capture>[] = [];
  // The loop first falls 1.6 s behind while the pilot keeps reporting...
  for (let frame = 0; frame < 96; frame++) {
    f.advance(1);
    buffered.push(f.capture());
  }
  // ...then the catch-up tick itself is slow: each replayed server frame
  // costs real time in which the pilot flies on and reports again, so the
  // block lasts 1.6 s more than the pre-tick gap alone shows.
  const original = f.engine.advanceOneFrame.bind(f.engine);
  let replayed = 0;
  const slowCatchUp = vi.spyOn(f.engine, 'advanceOneFrame').mockImplementation((nowMs) => {
    original(nowMs);
    const clientFrames = replayed++ < 36 ? 2 : 1;
    for (let frame = 0; frame < clientFrames; frame++) {
      f.advance(1);
      buffered.push(f.capture());
    }
  });
  expect(f.engine.stepClock()).toBe(MAX_CATCH_UP_TICKS);
  slowCatchUp.mockRestore();
  expect(buffered).toHaveLength(192);
  const outcomes = buffered.map((pose) => f.submit(pose));
  expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
  expect(f.actor.playerMotion).toMatchObject({ mode: 'free', epoch });
  expect(f.actor.position).toEqual(f.ship.position);
});

test('a pilot who hovers through a blocked server second cannot bank more than that block into one jump', () => {
  const hoveringPilot = () => {
    const f = flight();
    clearAmbientField(f);
    expect(f.engine.stepClock()).toBe(0);
    f.advance(1);
    expect(f.report().ok).toBe(true);
    const parked = { ...f.actor.position };
    f.ship.velocity = { x: 0, y: 0 };
    // Honest hover reports pile up behind the block and all land.
    const buffered: ReturnType<typeof f.capture>[] = [];
    for (let frame = 0; frame < 96; frame++) {
      f.wait(1);
      buffered.push(f.capture());
    }
    expect(f.engine.stepClock()).toBe(MAX_CATCH_UP_TICKS);
    expect(buffered.map((pose) => f.submit(pose)).filter((outcome) => !outcome.ok)).toEqual([]);
    expect(f.actor.position).toEqual(parked);
    return { f, parked, speed: f.engine.playerMotion.legalSpeed(f.actor, f.clock.now()) };
  };
  const bankFrames = PLAYER_MOTION.poseLeadFrames + 96;

  const within = hoveringPilot();
  within.f.ship.position.x = within.parked.x + within.speed * (bankFrames - 2);
  expect(within.f.report().ok).toBe(true);

  const beyond = hoveringPilot();
  beyond.f.ship.position.x = beyond.parked.x + beyond.speed * (bankFrames + 3);
  expect(beyond.f.report()).toMatchObject({ ok: false, envelope: { check: 'displacement' } });
  expect(beyond.f.actor.position).toEqual(beyond.parked);

  // The unspent block expires with the jitter window like any other reserve.
  const late = hoveringPilot();
  late.f.wait(10);
  late.f.ship.position.x = late.parked.x + late.speed * (2 * PLAYER_MOTION.poseLeadFrames + 3);
  expect(late.f.report()).toMatchObject({ ok: false, envelope: { check: 'displacement' } });
  expect(late.f.actor.position).toEqual(late.parked);
});

test('a pilot silent through a blocked server second still cannot claim more than that block plus one second', () => {
  // 1.6 s blocked on the server, then two responsive seconds with no poses.
  const silentPilot = () => {
    const f = flight();
    clearAmbientField(f);
    expect(f.engine.stepClock()).toBe(0);
    f.advance(2);
    expect(f.report().ok).toBe(true);
    const held = { ...f.actor.position };
    f.wait(96);
    expect(f.engine.stepClock()).toBe(MAX_CATCH_UP_TICKS);
    const caughtUp = f.engine.getDiagnostics().gameTime;
    for (let frame = 0; frame < 120; frame++) {
      f.wait(1);
      f.engine.stepClock();
    }
    expect(f.engine.getDiagnostics().gameTime - caughtUp).toBeGreaterThanOrEqual(119);
    return { f, held, speed: f.engine.playerMotion.legalSpeed(f.actor, f.clock.now()) };
  };
  // Blocked time is credited in full; silence while the server was listening
  // still stops at one second.
  const creditFrames = PLAYER_MOTION.poseLeadFrames + 96 + MAX_CATCH_UP_TICKS;

  const within = silentPilot();
  within.f.ship.position.x = within.held.x + within.speed * (creditFrames - 2);
  expect(within.f.report().ok).toBe(true);
  expect(within.f.actor.position.x).toBeCloseTo(within.f.ship.position.x, 6);

  const beyond = silentPilot();
  beyond.f.ship.position.x = beyond.held.x + beyond.speed * (creditFrames + 2);
  // The diagnostics separate the server's 1.6 s block from the pilot's own silence.
  expect(beyond.f.report()).toMatchObject({
    ok: false,
    envelope: { check: 'displacement', elapsedMs: 3600, blockedMs: 1600 },
  });
  expect(beyond.f.actor.position).toEqual(beyond.held);
});

test('a server whose every tick runs late still holds a silent pilot to one second of travel', () => {
  // Twenty seconds of ticks each firing five frames late. Every late arrival is
  // a short blocked span, but the loop read poses between them, so those spans
  // must not add up: the pilot gets one second plus a single span, not twenty.
  const lateTickServer = () => {
    const f = flight();
    clearAmbientField(f);
    expect(f.engine.stepClock()).toBe(0);
    f.advance(2);
    expect(f.report().ok).toBe(true);
    const held = { ...f.actor.position };
    for (let tick = 0; tick < 200; tick++) {
      f.wait(6);
      f.engine.stepClock();
    }
    return { f, held, speed: f.engine.playerMotion.legalSpeed(f.actor, f.clock.now()) };
  };
  const limitFrames = PLAYER_MOTION.poseLeadFrames + MAX_CATCH_UP_TICKS;

  const within = lateTickServer();
  within.f.ship.position.x = within.held.x + within.speed * (limitFrames + 3);
  expect(within.f.report().ok).toBe(true);

  const beyond = lateTickServer();
  beyond.f.ship.position.x = beyond.held.x + beyond.speed * (limitFrames + 8);
  expect(beyond.f.report()).toMatchObject({ ok: false, envelope: { check: 'displacement' } });
  expect(beyond.f.actor.position).toEqual(beyond.held);
});

test('a pilot silent for two seconds replays at most one second of travel plus the lead in one pose', () => {
  const limitFrames = PLAYER_MOTION.poseLeadFrames + MAX_CATCH_UP_TICKS;
  const within = flight();
  const speed = within.engine.playerMotion.legalSpeed(within.actor, within.clock.now());
  within.advance(2);
  expect(within.report().ok).toBe(true);
  const accepted = { ...within.actor.position };
  within.advance(120);
  within.ship.position.x = accepted.x + speed * (limitFrames - 2);
  expect(within.report().ok).toBe(true);
  expect(within.actor.position.x).toBeCloseTo(accepted.x + speed * (limitFrames - 2), 6);

  // Elapsed credit stops at one second, so the extra second of silence is
  // discarded rather than replayed as a jump.
  const beyond = flight();
  beyond.advance(2);
  expect(beyond.report().ok).toBe(true);
  const held = { ...beyond.actor.position };
  beyond.advance(120);
  beyond.ship.position.x = held.x + speed * (limitFrames + 2);
  expect(beyond.report()).toMatchObject({ ok: false, envelope: { check: 'displacement' } });
  expect(beyond.actor.position).toEqual(held);
});

test('a pilot who hovers for two seconds cannot bank that time into one jump', () => {
  const f = flight();
  const speed = f.engine.playerMotion.legalSpeed(f.actor, f.clock.now());
  f.advance(1);
  expect(f.report().ok).toBe(true);
  const parked = { ...f.actor.position };
  f.ship.velocity = { x: 0, y: 0 };
  // Every hover pose is honest and accepted, yet the unspent travel it earns
  // must not accumulate beyond one jitter window.
  for (let frame = 0; frame < 120; frame++) {
    f.wait(1);
    expect(f.report().ok).toBe(true);
  }
  expect(f.actor.position).toEqual(parked);
  f.ship.position.x = parked.x + speed * (2 * PLAYER_MOTION.poseLeadFrames + 3);
  expect(f.report()).toMatchObject({ ok: false, envelope: { check: 'displacement' } });
  expect(f.actor.position).toEqual(parked);
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
