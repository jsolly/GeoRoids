import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { RecordingSocket } from '../../support/recordingSocket';

test('a shot tells other pilots its muzzle position once and does not echo to its shooter', () => {
  const engine = new GameEngine(525);
  const shooter = new RecordingSocket();
  const listener = new RecordingSocket();
  try {
    engine.addPlayer('shooter', 'Shooter', shooter, { x: 0, y: 0 });
    engine.addPlayer('listener', 'Listener', listener, { x: 100, y: 0 });
    const shot = engine.spawnLaser('shooter', { x: 12, y: 0 }, { x: 5, y: 0 });
    assert.ok(shot);
    shot.position.x = 100;
    const broadcaster = new GameStateBroadcaster(engine);
    broadcaster.broadcastGameState();
    broadcaster.broadcastGameState();
    expect(shooter.inbox.filter((message) => message.type === 'playerShotFired')).toEqual([]);
    expect(listener.inbox.filter((message) => message.type === 'playerShotFired')).toEqual([
      expect.objectContaining({
        data: { id: shot.id, ownerId: 'shooter', position: { x: 12, y: 0 } },
      }),
    ]);
  } finally {
    engine.stopGameLoop();
  }
});

test('resetting a world clears queued shot sounds', () => {
  const engine = new GameEngine(525);
  try {
    engine.spawnLaser('pilot', { x: 0, y: 0 }, { x: 5, y: 0 });
    engine.resetForTesting();
    expect(engine.drainShotSounds()).toEqual([]);
  } finally {
    engine.stopGameLoop();
  }
});
