/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { validateSnapshotDto } from '../../../shared/snapshotDto';
import { SnapshotDecoder, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import { decodeSnapshotMessage, snapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';
import { snapshotFixture } from '../network/snapshotFixture';

test('a published snapshot omits a death cause the server still stores on the pilot', () => {
  const engine = new GameEngine(26);
  try {
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    pilot.deathCause = 'asteroid';
    const published = engine.getGameState().entities.find((entity) => entity.id === pilot.id);
    assert.ok(published);
    expect(published).not.toHaveProperty('deathCause');
    expect(pilot.deathCause).toBe('asteroid');
    expect(
      JSON.stringify(
        new SnapshotEncoder({
          ...engine.getGameState(),
          playerProjectiles: engine.getPlayerProjectiles(),
        }).encode(1)
      )
    ).not.toContain('deathCause');
  } finally {
    engine.stopGameLoop();
  }
});

test('an older snapshot that still carries a death cause decodes the pilot', () => {
  const world = snapshotFixture();
  const pilot = world.entities[0];
  assert.ok(pilot);
  Object.assign(pilot, { deathCause: 'asteroid' });
  expect(() => validateSnapshotDto(world)).not.toThrow();
  const decoded = decodeSnapshotMessage(
    new SnapshotDecoder(),
    snapshotMessage(new SnapshotEncoder(world).encode(1))
  );
  const row = decoded.entities.find((entity) => entity.id === pilot.id);
  assert.ok(row);
  expect(row).toMatchObject({ id: pilot.id, name: pilot.name, health: pilot.health });
  expect(row).toHaveProperty('deathCause', 'asteroid');
});
