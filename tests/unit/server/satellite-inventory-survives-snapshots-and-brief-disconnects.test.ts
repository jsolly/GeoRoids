/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { PLAYER_MOTION } from '../../../shared/playerMotion';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { decodeSnapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';

test('inventory follows its owner across snapshot interest and reconnect grace, then drops on leave or grace expiry', () => {
  let now = 0;
  const clock = new ServerClock({ wallNow: () => Date.now(), monotonicNow: () => now });
  const engine = new GameEngine(82, clock);
  const core = new WebSocketCore(engine);
  const broadcaster = core.getBroadcaster();
  const socket = new RecordingSocket();
  const observerSocket = new RecordingSocket();
  const owner = engine.addPlayer('owner', 'Owner', socket, { x: 0, y: 0 }, 'hauler');
  const observer = engine.addPlayer(
    'observer',
    'Observer',
    observerSocket,
    { x: 10000, y: 0 },
    'scout'
  );
  owner.asteroidInteractions = 1;
  const registration = engine.registerPilot(owner, socket);
  assert.ok(registration.ok);
  const pickup = engine.getAllSatellitePickups()[0];
  assert.ok(pickup);
  engine.updatePlayer(owner.id, { position: { x: pickup.position.x + 110, y: pickup.position.y } });
  engine.tickSatellitePickups();
  // The observer can see this world location, but must not see stored inventory.
  engine.updatePlayer(observer.id, { position: { ...pickup.position } });
  broadcaster.negotiateSnapshot(socket);
  broadcaster.negotiateSnapshot(observerSocket);
  const decoder = new SnapshotDecoder();
  const observerDecoder = new SnapshotDecoder();
  const read = () => {
    socket.sent.length = 0;
    observerSocket.sent.length = 0;
    broadcaster.broadcastGameState();
    const raw = socket.sent.find((message) => JSON.parse(message).type === 'snapshot');
    assert.ok(raw);
    const observerRaw = observerSocket.sent.find(
      (message) => JSON.parse(message).type === 'snapshot'
    );
    assert.ok(observerRaw);
    return {
      owner: decodeSnapshotMessage(decoder, raw),
      observer: decodeSnapshotMessage(observerDecoder, observerRaw),
    };
  };
  try {
    const collected = read();
    expect(collected.owner.satellitePickups.find((row) => row.id === pickup.id)?.state).toBe(
      'stored'
    );
    expect(collected.observer.satellitePickups.some((row) => row.id === pickup.id)).toBe(false);
    // Broadcast before a pickup tick: its cached world position is outside the owner's interest.
    engine.updatePlayer(owner.id, { position: { x: 10000, y: 0 } });
    const moved = read();
    expect(moved.owner.satellitePickups.find((row) => row.id === pickup.id)).toMatchObject({
      state: 'stored',
    });
    expect(moved.observer.satellitePickups.some((row) => row.id === pickup.id)).toBe(false);
    engine.updatePlayer(observer.id, { position: { ...owner.position } });
    expect(engine.equipSatellite(owner.id, pickup.id)).toBe(true);
    engine.handleSatellitePickupDamage(pickup.id, 25);
    engine.tickSatellitePickups();
    const equipped = engine.getSatellitePickup(pickup.id);
    assert.ok(equipped);
    expect(read().owner.satellitePickups.find((row) => row.id === pickup.id)).toMatchObject({
      state: 'orbiting',
      health: equipped.health,
    });

    expect(engine.transportClosed(socket)).toBe(true);
    now += PLAYER_MOTION.reconnectGraceMs - 1;
    const resumedSocket = new RecordingSocket();
    const resumed = engine.resumePilot(registration.resumeToken, resumedSocket);
    assert.ok(resumed.ok);
    expect(engine.getSatellitePickup(pickup.id)).toMatchObject({
      ownerId: owner.id,
      health: equipped.health,
    });
    core.handleClientMessage({ type: 'leave' }, resumedSocket);
    expect(engine.getSatellitePickup(pickup.id)).toMatchObject({
      state: 'loose',
      ownerId: null,
      health: equipped.health,
    });

    const again = engine.resumePilot(registration.resumeToken, resumedSocket);
    assert.ok(again.ok);
    const dropped = engine.getSatellitePickup(pickup.id);
    assert.ok(dropped);
    engine.updatePlayer(owner.id, { position: { ...dropped.position } });
    engine.tickSatellitePickups();
    expect(engine.getSatellitePickup(pickup.id)?.state).toBe('stored');
    expect(engine.transportClosed(resumedSocket)).toBe(true);
    now += PLAYER_MOTION.reconnectGraceMs + 1;
    engine.advanceOneFrame();
    expect(engine.getPlayer(owner.id)).toBeUndefined();
    expect(engine.getSatellitePickup(pickup.id)).toMatchObject({
      state: 'stored',
      ownerId: 'observer',
      health: equipped.health,
    });
  } finally {
    engine.stopGameLoop();
  }
});
