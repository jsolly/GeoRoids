/* @vitest-environment node */
import { expect, test } from 'vitest';
import { decodeClientCommand } from '../../../server/communication/clientCommandDecoder';

test('legacy top-level fields override nested command fields once', () => {
  expect(
    decodeClientCommand({
      type: 'shoot',
      id: 'top-level-pilot',
      laserStart: { x: 10, y: 20 },
      laserDirection: { x: 3, y: 4 },
      requestId: 'top-level-shot',
      data: {
        id: 'nested-pilot',
        laserStart: { x: 100, y: 200 },
        laserDirection: { x: 30, y: 40 },
        requestId: 'nested-shot',
      },
    })
  ).toEqual({
    ok: true,
    command: {
      type: 'shoot',
      id: 'top-level-pilot',
      laserStart: { x: 10, y: 20 },
      laserDirection: { x: 3, y: 4 },
      requestId: 'top-level-shot',
    },
  });
});

test('shoot request IDs remain optional while malformed correlation values stop at the wire boundary', () => {
  expect(
    decodeClientCommand({
      type: 'shoot',
      id: 'pilot',
      data: {
        laserStart: { x: 10, y: 20 },
        laserDirection: { x: 3, y: 4 },
        requestId: 'shot_01-abc',
      },
    })
  ).toEqual({
    ok: true,
    command: {
      type: 'shoot',
      id: 'pilot',
      laserStart: { x: 10, y: 20 },
      laserDirection: { x: 3, y: 4 },
      requestId: 'shot_01-abc',
    },
  });

  expect(
    decodeClientCommand({
      type: 'shoot',
      id: 'pilot',
      data: { laserStart: { x: 10, y: 20 }, laserDirection: { x: 3, y: 4 } },
    })
  ).toEqual({
    ok: true,
    command: {
      type: 'shoot',
      id: 'pilot',
      laserStart: { x: 10, y: 20 },
      laserDirection: { x: 3, y: 4 },
    },
  });

  for (const requestId of ['', 'a'.repeat(65), 'shot.id', 'shot id', 7, null]) {
    expect(
      decodeClientCommand({
        type: 'shoot',
        id: 'pilot',
        data: {
          laserStart: { x: 10, y: 20 },
          laserDirection: { x: 3, y: 4 },
          requestId,
        },
      })
    ).toEqual({
      ok: false,
      messageType: 'shoot',
      error: 'Invalid shoot request ID',
    });
  }
});

test('nested joins keep finite positions and capability offers', () => {
  expect(
    decodeClientCommand({
      type: 'join',
      data: {
        id: 'pilot',
        name: 'Pilot',
        position: { x: 12.5, y: -4 },
        kitId: 'hauler',
        asteroidInteractions: 1,
        snapshotVersion: 1,
      },
    })
  ).toEqual({
    ok: true,
    command: {
      type: 'join',
      id: 'pilot',
      name: 'Pilot',
      position: { x: 12.5, y: -4 },
      kitId: 'hauler',
      snapshotVersion: 1,
      asteroidInteractions: 1,
      resumeRequested: false,
    },
  });
});

test('join coordinates must be finite numbers', () => {
  expect(
    decodeClientCommand({
      type: 'join',
      data: {
        id: 'pilot',
        name: 'Pilot',
        position: { x: '12.5px', y: '-4' },
        snapshotVersion: 1,
        asteroidInteractions: 1,
      },
    })
  ).toEqual({
    ok: false,
    messageType: 'join',
    error: 'Join position is outside the world or invalid',
  });
});

test('Hauler utility slot commands accept only the two equipped tools', () => {
  expect(
    decodeClientCommand({
      type: 'setHaulerUtility',
      id: 'pilot',
      data: { utilityId: 'resource_tap' },
    })
  ).toEqual({
    ok: true,
    command: { type: 'setHaulerUtility', id: 'pilot', utilityId: 'resource_tap' },
  });
  expect(
    decodeClientCommand({
      type: 'setHaulerUtility',
      id: 'pilot',
      data: { utilityId: 'inventory' },
    })
  ).toEqual({
    ok: false,
    messageType: 'setHaulerUtility',
    error: 'Invalid Hauler utility',
  });
});

test('retired asteroid tool and pickup claim commands are rejected at the wire boundary', () => {
  for (const type of ['asteroidTool', 'asteroidInput', 'satellitePickupCollected']) {
    expect(decodeClientCommand({ type, data: {} })).toEqual({
      ok: false,
      messageType: type,
      error: `Unknown message type: ${type}`,
      logUnknown: true,
    });
  }
});

test('malformed current commands retain their action-specific error policy', () => {
  expect(decodeClientCommand({ type: 'shoot', id: 'pilot', data: { laserStart: null } })).toEqual({
    ok: false,
    messageType: 'shoot',
    error: 'Missing finite laser coordinates for shoot',
  });
});

test('client telemetry reaches ingress validation even when its payload is malformed', () => {
  expect(decodeClientCommand({ type: 'clientLog', data: 'malformed' })).toEqual({
    ok: true,
    command: { type: 'clientLog', payload: {} },
  });
});

test('heartbeat probe identities are echoed only after integer validation while bare pings work', () => {
  expect(decodeClientCommand({ type: 'ping' })).toEqual({ ok: true, command: { type: 'ping' } });
  expect(decodeClientCommand({ type: 'ping', probeId: 12 })).toEqual({
    ok: true,
    command: { type: 'ping', probeId: 12 },
  });
  for (const probeId of [0, -1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 1]) {
    expect(decodeClientCommand({ type: 'ping', probeId }).ok).toBe(false);
  }
});

test('satellite equipment commands require a player and a bounded pickup identity', () => {
  expect(
    decodeClientCommand({ type: 'equipSatellite', id: 'pilot', data: { pickupId: 'landsat' } })
  ).toEqual({
    ok: true,
    command: { type: 'equipSatellite', id: 'pilot', pickupId: 'landsat' },
  });
  for (const pickupId of [null, '', 17, 'a'.repeat(129)]) {
    expect(
      decodeClientCommand({ type: 'equipSatellite', id: 'pilot', data: { pickupId } }).ok
    ).toBe(false);
  }
  expect(decodeClientCommand({ type: 'equipSatellite', data: { pickupId: 'landsat' } }).ok).toBe(
    false
  );
});

test('pose updates may latch overlay hold without extra pose keys', () => {
  expect(
    decodeClientCommand({
      type: 'update',
      id: 'pilot',
      data: {
        position: { x: 1, y: 2 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        thrusting: false,
        overlayHold: true,
        motionEpoch: 0,
        motionSequence: 1,
      },
    })
  ).toEqual({
    ok: true,
    command: {
      type: 'update',
      id: 'pilot',
      update: {
        position: { x: 1, y: 2 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        thrusting: false,
        overlayHold: true,
      },
      motionEpoch: 0,
      motionSequence: 1,
    },
  });
});
