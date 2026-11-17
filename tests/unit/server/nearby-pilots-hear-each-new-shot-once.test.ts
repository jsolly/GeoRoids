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
    const shot = engine.laserCombat.spawn('shooter', { x: 12, y: 0 }, { x: 5, y: 0 });
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
    engine.laserCombat.spawn('pilot', { x: 0, y: 0 }, { x: 5, y: 0 });
    engine.resetForTesting();
    expect(engine.laserCombat.drainShotSounds()).toEqual([]);
  } finally {
    engine.stopGameLoop();
  }
});

test('queued shot sounds keep the newest 256 launches and read the final charged flag', () => {
  const engine = new GameEngine(525);
  try {
    const shots = Array.from({ length: 257 }, (_, index) => {
      const origin = { x: index, y: 0 };
      const shot = engine.laserCombat.spawn('shooter', origin, { x: 5, y: 0 });
      assert.ok(shot);
      origin.x = -1000;
      return shot;
    });
    const latest = shots.at(-1);
    assert.ok(latest);
    latest.charged = true;
    latest.position.x = 1000;
    const snapshot = engine.laserCombat.projectiles().at(-1);
    assert.ok(snapshot);
    expect(snapshot.position).not.toBe(latest.position);
    expect(snapshot.prevPosition).not.toBe(latest.prevPosition);
    expect(snapshot.velocity).not.toBe(latest.velocity);
    snapshot.position.x = -2000;
    snapshot.prevPosition.x = -3000;
    snapshot.velocity.x = -4000;
    expect(latest.position).toEqual({ x: 1000, y: 0 });
    expect(latest.prevPosition).toEqual({ x: 256, y: 0 });
    expect(latest.velocity).toEqual({ x: 5, y: 0 });

    const sounds = engine.laserCombat.drainShotSounds();
    expect(sounds).toHaveLength(256);
    expect(sounds.map((sound) => sound.id)).toEqual(shots.slice(1).map((shot) => shot.id));
    expect(sounds.map((sound) => sound.position)).toEqual(
      Array.from({ length: 256 }, (_, index) => ({ x: index + 1, y: 0 }))
    );
    expect(sounds.filter((sound) => sound.charged)).toEqual([
      { id: latest.id, ownerId: 'shooter', position: { x: 256, y: 0 }, charged: true },
    ]);
    expect(engine.laserCombat.drainShotSounds()).toEqual([]);
  } finally {
    engine.stopGameLoop();
  }
});
