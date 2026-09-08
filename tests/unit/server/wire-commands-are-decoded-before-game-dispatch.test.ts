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
      data: {
        id: 'nested-pilot',
        laserStart: { x: 100, y: 200 },
        laserDirection: { x: 30, y: 40 },
      },
    })
  ).toEqual({
    ok: true,
    command: {
      type: 'shoot',
      id: 'top-level-pilot',
      laserStart: { x: 10, y: 20 },
      laserDirection: { x: 3, y: 4 },
    },
  });
});

test('nested legacy joins keep numeric-string positions and enhanced offers', () => {
  expect(
    decodeClientCommand({
      type: 'join',
      data: {
        id: 'pilot',
        name: 'Pilot',
        position: { x: '12.5px', y: '-4' },
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
      enhancedOffer: true,
      snapshotVersion: 1,
      resumeRequested: false,
    },
  });
});

test('malformed commands retain their action-specific error policy', () => {
  expect(decodeClientCommand({ type: 'asteroidInput', data: { epoch: 1, sequence: 2 } })).toEqual({
    ok: false,
    messageType: 'asteroidInput',
  });
  expect(decodeClientCommand({ type: 'shoot', id: 'pilot', data: { laserStart: null } })).toEqual({
    ok: false,
    messageType: 'shoot',
    error: 'Missing finite laser coordinates for shoot',
  });
  expect(decodeClientCommand({ type: 'laserDamage', data: {} })).toEqual({
    ok: false,
    messageType: 'laserDamage',
    error: 'Missing required fields for laserDamage',
    suppressWhenAuthoritativeProjectiles: true,
  });
});

test('client telemetry reaches ingress validation even when its payload is malformed', () => {
  expect(decodeClientCommand({ type: 'clientLog', data: 'malformed' })).toEqual({
    ok: true,
    command: { type: 'clientLog', payload: {} },
  });
});
