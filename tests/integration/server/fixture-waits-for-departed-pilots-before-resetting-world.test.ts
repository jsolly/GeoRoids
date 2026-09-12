import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { prepareFixture, startFixtureControl } from '../../../benchmarks/fixture-control';
import { createServerInstance } from '../../../server/createServer';
import { RecordingSocket } from '../../support/recordingSocket';

test('a departed pilot leaves the diagnostic world untouched until it rejoins', async () => {
  const directory = await mkdtemp('/tmp/georoids-fixture-');
  const server = createServerInstance({ port: 0, seed: 42 });
  let closeControl: (() => Promise<void>) | undefined;
  try {
    await server.listening;
    const socket = join(directory, 'fixture.sock');
    closeControl = await startFixtureControl(server, socket, 42);
    const before = JSON.stringify(server.gameEngine.getAllAsteroids());
    const pending = await prepareFixture(socket, {
      scenario: 'traversal',
      participants: ['departed-pilot'],
    });
    expect(pending).toEqual({ kind: 'pending', missing: ['departed-pilot'] });
    expect(JSON.stringify(server.gameEngine.getAllAsteroids())).toBe(before);
    expect(server.gameEngine.getAllPlayers()).toHaveLength(0);
  } finally {
    await closeControl?.();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a retained pilot with a closed transport leaves the diagnostic world untouched', async () => {
  const directory = await mkdtemp('/tmp/georoids-fixture-');
  const server = createServerInstance({ port: 0, seed: 42 });
  let closeControl: (() => Promise<void>) | undefined;
  try {
    await server.listening;
    server.gameEngine.stopGameLoop();
    const transport = new RecordingSocket();
    server.gameEngine.addPlayer('retained-pilot', 'Pilot', transport);
    transport.close();
    const socket = join(directory, 'fixture.sock');
    closeControl = await startFixtureControl(server, socket, 42);
    const before = JSON.stringify(server.gameEngine.getAllAsteroids());
    expect(
      await prepareFixture(socket, {
        scenario: 'traversal',
        participants: ['retained-pilot'],
      })
    ).toEqual({ kind: 'pending', missing: ['retained-pilot'] });
    expect(JSON.stringify(server.gameEngine.getAllAsteroids())).toBe(before);
  } finally {
    await closeControl?.();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a prepared fixture returns the authoritative placed motion epoch', async () => {
  const directory = await mkdtemp('/tmp/georoids-fixture-');
  const server = createServerInstance({ port: 0, seed: 42 });
  let closeControl: (() => Promise<void>) | undefined;
  try {
    await server.listening;
    server.gameEngine.stopGameLoop();
    const transport = new RecordingSocket();
    server.wsCore.handleClientMessage(
      {
        type: 'join',
        data: {
          id: 'prepared-pilot',
          name: 'Prepared pilot',
          position: { x: 100, y: 100 },
          snapshotVersion: 1,
          asteroidInteractions: 1,
        },
      },
      transport
    );
    const before = server.gameEngine.getPlayer('prepared-pilot')?.playerMotion?.epoch;
    expect(before).toBe(1);
    const socket = join(directory, 'fixture.sock');
    closeControl = await startFixtureControl(server, socket, 42);

    const fixture = await prepareFixture(socket, {
      scenario: 'traversal',
      participants: ['prepared-pilot'],
    });

    expect(fixture.kind).toBe('prepared');
    if (fixture.kind !== 'prepared') {
      throw new Error('Fixture unexpectedly pending');
    }
    expect(fixture.baselines).toEqual([{ id: 'prepared-pilot', sequence: 2, motionEpoch: 2 }]);
    expect(server.gameEngine.getPlayer('prepared-pilot')?.playerMotion?.epoch).toBe(2);
  } finally {
    await closeControl?.();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
