/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';
import { EntityManager } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { ServerClock } from '../../../server/core/ServerClock';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { AI_SHIPS, inBotSanctuary } from '../../../shared/aiShips';
import { DAMAGE, GAME, LASER, SHIP } from '../../../shared/constants/gameplay';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { BotRole } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) {
    close();
  }
});

function world(store?: WorldStore) {
  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => 10_000, monotonicNow: () => elapsed });
  const engine = new GameEngine(82, clock, store ? new InlineWorldPersistence(store) : undefined);
  cleanup.push(() => engine.stopGameLoop());
  const socket = new RecordingSocket();
  const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, 'scout');
  pilot.position = { x: 0, y: 0 };
  pilot.overlayHold = true;
  assert(engine.registerPilot(pilot, socket).ok);
  engine.createAsteroids(0);
  for (const asteroid of engine.getAllAsteroids()) {
    engine.removeAsteroid(asteroid.id);
  }
  engine.clearSpiderField();
  function frame(count = 1) {
    for (let index = 0; index < count; index++) {
      elapsed += 1000 / GAME.FPS;
      pilot.lastUpdate = clock.now();
      engine.advanceOneFrame(clock.now());
    }
  }
  function bot(role: BotRole) {
    const row = engine.getSnapshotState().entities.find((entry) => entry.botRole === role);
    assert(row, `Missing ${role}`);
    const actor = engine.getPlayer(row.id);
    assert(actor);
    return actor;
  }
  frame(AI_SHIPS.spawnDelayFrames);
  function elapse(ms: number): void {
    elapsed += ms;
  }
  function restart(epoch = clock.now()): GameEngine {
    assert(store, 'Restart requires the fixture store');
    const restartedClock = new ServerClock({ wallNow: () => epoch, monotonicNow: () => 0 });
    const restored = new GameEngine(82, restartedClock, new InlineWorldPersistence(store));
    cleanup.push(() => restored.stopGameLoop());
    return restored;
  }
  return { engine, pilot, socket, frame, bot, clock, elapse, restart };
}

test('one bot of each role moves without becoming a human, stale socket or saved pilot', () => {
  const { engine, frame, bot } = world();
  const worker = bot('worker');
  const start = { ...worker.position };
  expect(inBotSanctuary(start)).toBe(false);
  expect(inBotSanctuary(bot('raider').position)).toBe(false);
  expect(worker.ws).toBeUndefined();
  expect(worker.playerMotion).toBeUndefined();
  expect(engine.registerPilot(worker, new RecordingSocket()).ok).toBe(false);
  worker.lastUpdate = -100_000;
  frame(120);
  expect(engine.getPlayer(worker.id)).toBe(worker);
  expect(worker.position).not.toEqual(start);
  expect(engine.getPlayerCount()).toBe(1);
  expect(engine.getAllPlayers().map((entry) => entry.id)).toEqual(['pilot']);
  expect(engine.getSnapshotState().entities.filter((entry) => entry.botRole)).toHaveLength(2);
  expect(engine.hasSavedPilot(worker.id)).toBe(false);
});

test.each([0, 25])(
  'an idle worker gives pilots room and catches up without crowding, carrying %i points',
  (cargo) => {
    const { pilot, frame, bot } = world();
    pilot.position = { x: 5000, y: 4000 };
    const worker = bot('worker');
    worker.position = { x: 5100, y: 4000 };
    worker.velocity = { x: 0, y: 0 };
    worker.angle = 0;
    worker.cargo = cargo;
    // Isolate loitering from raider attacks and cargo spills.
    bot('raider').position = { x: 5000, y: 4500 };
    bot('raider').respawnTimer = 10_000;
    const separation = () =>
      Math.hypot(worker.position.x - pilot.position.x, worker.position.y - pilot.position.y);
    frame(240);
    expect(separation()).toBeGreaterThanOrEqual(350);
    expect(separation()).toBeLessThanOrEqual(550);
    expect(worker.thrusting).toBe(false);
    const resting = { ...worker.position };
    frame(120);
    expect(worker.position).toEqual(resting);
    pilot.position.x -= 900;
    frame(600);
    expect(separation()).toBeGreaterThanOrEqual(350);
    expect(separation()).toBeLessThanOrEqual(550);
    expect(worker.thrusting).toBe(false);
    expect(worker.cargo).toBe(cargo);
  }
);

test('a worker banks recovered points in the shared settlement and leaves equipment for humans', () => {
  const store = new WorldStore(':memory:');
  cleanup.push(() => store.close());
  const { engine, pilot, frame, bot, restart } = world(store);
  const worker = bot('worker');
  // A real hazard spill produces recoverable points; the worker must find and offload them.
  pilot.position = { x: worker.position.x + 100, y: worker.position.y };
  pilot.cargo = 30;
  pilot.overlayHold = false;
  delete pilot.spawnProtectionTimer;
  expect(engine.handleShipDamage(pilot.id, 'asteroid', 30).applied).toBe(true);
  pilot.position = { x: 0, y: 0 };
  pilot.overlayHold = true;
  const gear = engine.dropEquipmentAt(worker.position, 'resource_tap');
  const before = engine.getSnapshotState().settlement.points;
  let collected = false;
  for (let index = 0; index < 1000; index++) {
    frame();
    collected ||= worker.cargo > 0;
    if (engine.getSnapshotState().settlement.points > before) {
      break;
    }
  }
  expect(collected).toBe(true);
  expect(engine.getSnapshotState().settlement.points).toBeGreaterThan(before);
  expect(pilot.score).toBe(0);
  expect(worker.score).toBe(0);
  expect(worker.equipment ?? []).toEqual([]);
  expect(engine.getLoot().some((drop) => drop.id === gear.id)).toBe(true);
  engine.checkpointWorld();
  expect(store.loadPilots().map((entry) => entry.id)).toEqual(['pilot']);
  const restored = restart();
  expect(restored.getSnapshotState().settlement.points).toBe(
    engine.getSnapshotState().settlement.points
  );
  expect(restored.getSnapshotState().entities).toEqual([]);
});

test('opposing direct shots damage hulls while crew shots pass through friendlies and sanctuary', () => {
  const { engine, pilot, bot } = world();
  const raider = bot('raider');
  const worker = bot('worker');
  for (const actor of [pilot, raider, worker]) {
    actor.position = { x: 5000, y: 4000 };
    actor.velocity = { x: 0, y: 0 };
    actor.healthRegenTimer = 10_000;
    delete actor.spawnProtectionTimer;
  }
  pilot.overlayHold = false;
  worker.position = { x: 5200, y: 4000 };
  raider.position = { x: 5100, y: 4000 };
  const bolt = engine.spawnLaser(
    pilot.id,
    { x: 5080, y: 4000 },
    { x: LASER.SPEED / GAME.FPS, y: 0 }
  );
  assert(bolt);
  engine.advanceLasersAndResolveHits();
  expect(raider.health).toBe(raider.maxHealth - DAMAGE.LASER_HIT);
  const health = pilot.health;
  engine.spawnLaser(raider.id, { x: 5020, y: 4000 }, { x: -LASER.SPEED / GAME.FPS, y: 0 });
  engine.advanceLasersAndResolveHits();
  expect(pilot.health).toBe(health - DAMAGE.LASER_HIT);
  // A friendly bolt crosses a worker without consuming itself or removing hull health.
  const workerHealth = worker.health;
  engine.spawnLaser(pilot.id, { x: 5180, y: 4000 }, { x: LASER.SPEED / GAME.FPS, y: 0 });
  engine.advanceLasersAndResolveHits();
  expect(worker.health).toBe(workerHealth);
  pilot.position = { x: 0, y: 0 };
  const protectedHealth = pilot.health;
  engine.spawnLaser(raider.id, { x: -20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 });
  engine.advanceLasersAndResolveHits();
  expect(pilot.health).toBe(protectedHealth);
});

test('a raider aims and fires through the real authoritative shot path', () => {
  const { pilot, frame, bot } = world();
  const raider = bot('raider');
  pilot.position = { x: 5000, y: 4000 };
  pilot.overlayHold = false;
  delete pilot.spawnProtectionTimer;
  raider.position = { x: 5300, y: 4000 };
  raider.angle = Math.PI;
  delete raider.spawnProtectionTimer;
  // Keep this scenario focused on firing, away from the worker.
  bot('worker').position = { x: 4000, y: 4000 };
  frame(AI_SHIPS.shotIntervalFrames + Math.ceil(300 / (LASER.SPEED / GAME.FPS)) + 20);
  expect(pilot.health).toBeLessThan(pilot.maxHealth);
});

test('bot death respawns outside town, and final human removal spills holds before checkpoint', () => {
  const store = new WorldStore(':memory:');
  cleanup.push(() => store.close());
  const { engine, pilot, bot, frame, restart } = world(store);
  const raider = bot('raider');
  delete raider.spawnProtectionTimer;
  expect(engine.handleShipDamage(raider.id, 'crew-fire', 1000).isDestroyed).toBe(true);
  frame(SHIP.RESPAWN_DELAY_FRAMES);
  expect(raider.health).toBe(raider.maxHealth);
  expect(raider.respawnTimer).toBeUndefined();
  expect(inBotSanctuary(raider.position)).toBe(false);
  const worker = bot('worker');
  worker.cargo = 42;
  engine.checkpointWorld();
  const crashRecovery = restart();
  expect(crashRecovery.getLoot().filter((drop) => drop.points === 42)).toHaveLength(1);
  expect(crashRecovery.getSnapshotState().entities).toEqual([]);
  engine.removePlayer(pilot.id);
  expect(engine.isGamePaused()).toBe(true);
  expect(engine.getSnapshotState().entities).toEqual([]);
  expect(engine.getLoot().some((drop) => drop.points === 42)).toBe(true);
  expect(store.loadPilots().some((entry) => entry.id === worker.id)).toBe(false);
  const restored = restart();
  expect(restored.getLoot().some((drop) => drop.points === 42)).toBe(true);
});

test('worker hold checkpoints refresh only recovery deadlines on the engine clock and retain them through restart', () => {
  const wall = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  cleanup.push(() => wall.mockRestore());
  const store = new WorldStore(':memory:');
  cleanup.push(() => store.close());
  const { engine, pilot, bot, clock, elapse, restart } = world(store);
  const worker = bot('worker');
  worker.cargo = 42;
  const checkpointNow = clock.now();
  engine.checkpointWorld();
  const first = store
    .load()
    .economy?.pointLoot.find((drop) => drop.id === `bot-cargo-${worker.id}`);
  assert(first);
  expect(first).toMatchObject({ points: 42, expiresAt: checkpointNow + 120_000 });

  // Live held cargo has no TTL; a later checkpoint starts a fresh recovery window.
  elapse(120_001);
  wall.mockReturnValue(50_000_000);
  pilot.lastUpdate = clock.now();
  engine.advanceOneFrame(clock.now());
  expect(worker.cargo).toBe(42);
  engine.checkpointWorld();
  const refreshed = store.load().economy?.pointLoot.find((drop) => drop.id === first.id);
  assert(refreshed);
  expect(refreshed.expiresAt).toBe(first.expiresAt + 120_001);
  expect(refreshed.points).toBe(42);
  wall.mockReturnValue(1);
  elapse(1);
  engine.checkpointWorld();
  const final = store.load().economy?.pointLoot.find((drop) => drop.id === first.id);
  assert(final);
  expect(final.expiresAt).toBe(refreshed.expiresAt + 1);

  const beforeExpiry = restart(final.expiresAt - 1);
  expect(beforeExpiry.getLoot().find((drop) => drop.id === final.id)).toMatchObject({ points: 42 });
  expect(beforeExpiry.getSnapshotState().entities).toEqual([]);
  const atExpiry = restart(final.expiresAt);
  expect(atExpiry.getLoot().some((drop) => drop.id === final.id)).toBe(false);
  // Loading does not rebase or rewrite the persisted absolute deadline.
  expect(store.load().economy?.pointLoot.find((drop) => drop.id === final.id)?.expiresAt).toBe(
    final.expiresAt
  );
});

test('decoded snapshots retain distant humans while bot geometry enters and leaves local interest', () => {
  const { engine, socket, bot } = world();
  const worker = bot('worker');
  const farSocket = new RecordingSocket();
  engine.addPlayer('far-human', 'Far human', farSocket, { x: 12_000, y: 0 });
  const broadcaster = new GameStateBroadcaster(engine);
  broadcaster.negotiateSnapshot(socket);
  broadcaster.negotiateSnapshot(farSocket);
  const decoder = new SnapshotDecoder();
  function state() {
    broadcaster.broadcastGameState();
    const raw = socket.sent.at(-1);
    assert(raw);
    const result = decoder.readMessage(raw, { acceptSnapshots: true });
    assert(result.kind === 'snapshot', JSON.stringify(result));
    assert(broadcaster.acknowledgeSnapshot(socket, result.metadata.sequence));
    return result.state;
  }
  broadcaster.broadcastPlayerDamaged(worker.id, 'asteroid', 25, 100, false);
  expect(socket.received('playerDamaged')).toEqual([]);
  expect(state().entities.find((entry) => entry.id === worker.id)?.botRole).toBe('worker');
  broadcaster.broadcastPlayerDamaged(worker.id, 'asteroid', 25, 100, false);
  expect(socket.received('playerDamaged')).toHaveLength(1);
  expect(farSocket.received('playerDamaged')).toEqual([]);
  worker.position = { x: 12_000, y: 0 };
  const far = state();
  expect(far.entities.some((entry) => entry.id === worker.id)).toBe(false);
  expect(far.entities.some((entry) => entry.id === 'far-human')).toBe(true);
  broadcaster.broadcastPlayerDamaged(worker.id, 'asteroid', 25, 75, false);
  expect(socket.received('playerDamaged')).toHaveLength(1);
  expect(farSocket.received('playerDamaged')).toHaveLength(1);
  worker.position = { x: 100, y: 100 };
  expect(state().entities.find((entry) => entry.id === worker.id)?.botRole).toBe('worker');
});

test('a dropped human transport stops both bots during reconnect grace and recovers the worker hold', () => {
  const { engine, socket, bot, frame } = world();
  bot('worker').cargo = 25;
  expect(engine.transportClosed(socket)).toBe(true);
  frame();
  expect(engine.getSnapshotState().entities.filter((entry) => entry.botRole)).toEqual([]);
  expect(engine.getLoot().some((drop) => drop.points === 25)).toBe(true);
  frame(AI_SHIPS.spawnDelayFrames);
  expect(engine.getSnapshotState().entities.filter((entry) => entry.botRole)).toEqual([]);
});

test('workers leave silk and equipment untouched and raiders collect no cargo', () => {
  const rng = new RNGService(82);
  const entities = new EntityManager(rng);
  const loot = new LootManager(rng, () => Date.now());
  const worker = entities.addBot('worker', 'worker', { x: 800, y: 0 });
  const raider = entities.addBot('raider', 'raider', { x: 800, y: 0 });
  const silk = loot.spawnSilk(worker.position, 0, { x: 0, y: 0 });
  const gear = loot.spawnEquipment(worker.position, 0, 'resource_tap');
  loot.spawnPoints(worker.position, 50);
  expect(loot.collectOverlaps([raider])).toEqual([]);
  expect(raider.cargo).toBe(0);
  const collected = loot.collectOverlaps([worker]);
  expect(collected.map((entry) => entry.loot.kind)).toEqual(['points']);
  expect(worker.cargo).toBe(50);
  expect(loot.get(silk.id)).toBeDefined();
  expect(loot.get(gear.id)).toBeDefined();
});

test('a queued bot-removal snapshot cannot be followed by damage for its old baseline hull', () => {
  const { engine, socket, bot } = world();
  const worker = bot('worker');
  const broadcaster = new GameStateBroadcaster(engine);
  broadcaster.negotiateSnapshot(socket);
  broadcaster.broadcastGameState();
  const decoder = new SnapshotDecoder();
  const initial = socket.sent.at(-1);
  assert(initial);
  const applied = decoder.readMessage(initial, { acceptSnapshots: true });
  assert(applied.kind === 'snapshot');
  assert(broadcaster.acknowledgeSnapshot(socket, applied.metadata.sequence));
  const original = socket.send.bind(socket);
  const pending: Array<(error?: Error) => void> = [];
  const delayed = vi.spyOn(socket, 'send').mockImplementation((data, options, callback) => {
    if (typeof options === 'object') {
      throw new Error('No send options expected');
    }
    original(data);
    const done = options ?? callback;
    if (done) {
      pending.push(done);
    }
  });
  try {
    worker.position = { x: 12_000, y: 0 };
    broadcaster.broadcastGameState();
    expect(pending).toHaveLength(1);
    const raw = socket.sent.at(-1);
    assert(raw);
    const removed = decoder.readMessage(raw, { acceptSnapshots: true });
    assert(removed.kind === 'snapshot');
    expect(removed.state.entities.some((row) => row.id === worker.id)).toBe(false);
    broadcaster.broadcastPlayerDamaged(worker.id, 'asteroid', 25, 100, false);
    expect(socket.received('playerDamaged')).toEqual([]);
    for (const done of pending) {
      done();
    }
  } finally {
    delayed.mockRestore();
  }
});
