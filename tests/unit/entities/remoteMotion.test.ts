import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GAME, SHIP } from '../../../shared/constants/gameplay';
import { CONTOUR_BRIDGE } from '../../../shared/contourBridge';
import { contourLockSpeed } from '../../../shared/contourLock';
import { Player } from '../../../src/entities/player/Player';
import { advanceRemotePlayerShips } from '../../../src/entities/player/remoteLasers';

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => vi.restoreAllMocks());

function remote(): Player {
  return new Player({ id: 'crew', name: 'Crew', type: 'remote' });
}

function pose(player: Player, x: number, vx = 1, angle = 0): void {
  player.updateFromServer({ position: { x, y: 10 }, velocity: { x: vx, y: 0 }, angle });
}

test('a remote hull moves on intervening frames and fresh snapshots do not double its distance', () => {
  const player = remote();
  pose(player, 100);
  expect(player.ship.position).toEqual({ x: 100, y: 10 });
  for (let snapshot = 1; snapshot <= 5; snapshot++) {
    advanceRemotePlayerShips([player]);
    expect(player.ship.position.x).toBe(100 + snapshot * 2 - 1);
    advanceRemotePlayerShips([player]);
    expect(player.ship.position.x).toBe(100 + snapshot * 2);
    pose(player, 100 + snapshot * 2);
    expect(player.ship.position.x).toBe(100 + snapshot * 2);
  }
});

test('receipt time and caught-up simulation frames measure one elapsed interval', () => {
  const player = remote();
  pose(player, 100);
  vi.mocked(performance.now).mockReturnValue(30);
  advanceRemotePlayerShips([player]);
  expect(player.ship.position.x).toBeCloseTo(101.8);
  advanceRemotePlayerShips([player]);
  expect(player.ship.position.x).toBe(102);
});

test.each([90, 110])('a stopped snapshot at %s converges monotonically without overshoot', (x) => {
  const player = remote();
  pose(player, 100);
  advanceRemotePlayerShips([player]);
  pose(player, x, 0);
  expect(player.ship.position.x).toBe(101);
  let previousError = Math.abs(101 - x);
  for (let frame = 0; frame < GAME.FPS / 10; frame++) {
    advanceRemotePlayerShips([player]);
    expect(player.ship.position.x).toBeGreaterThanOrEqual(Math.min(101, x));
    expect(player.ship.position.x).toBeLessThanOrEqual(Math.max(101, x));
    const error = Math.abs(player.ship.position.x - x);
    expect(error).toBeLessThan(previousError);
    previousError = error;
  }
  expect(player.ship.position.x).toBe(x);
  advanceRemotePlayerShips([player]);
  expect(player.ship.position.x).toBe(x);
});

test('aim corrections cross the angle seam by the short arc and stop at the supplied heading', () => {
  const player = remote();
  pose(player, 0, 0, Math.PI - 0.1);
  pose(player, 0, 0, -Math.PI + 0.1);
  advanceRemotePlayerShips([player]);
  expect(Math.abs(Math.sin(player.ship.angle))).toBeLessThan(0.1);
  for (let frame = 1; frame < GAME.FPS / 10; frame++) {
    advanceRemotePlayerShips([player]);
  }
  expect(player.ship.angle).toBe(-Math.PI + 0.1);
  advanceRemotePlayerShips([player]);
  expect(player.ship.angle).toBe(-Math.PI + 0.1);
});

test('silence and hidden-tab age bound projection even when the snapshot supplies excessive velocity', () => {
  const player = remote();
  player.updateFromServer({
    position: { x: 0, y: 0 },
    velocity: { x: 1000, y: 1000 },
    contourLock: { height: 0, direction: 1 },
    contourDraftFrames: CONTOUR_BRIDGE.draftFrames,
  });
  vi.mocked(performance.now).mockReturnValue(10_000);
  advanceRemotePlayerShips([player]);
  const horizon = GAME.FPS / 10;
  const maximum = contourLockSpeed(SHIP.MAX_VELOCITY) * CONTOUR_BRIDGE.draftMultiplier;
  expect(Math.hypot(player.ship.position.x, player.ship.position.y)).toBeCloseTo(maximum * horizon);
  const stopped = { ...player.ship.position };
  for (let frame = 0; frame < GAME.FPS; frame++) {
    advanceRemotePlayerShips([player]);
  }
  expect(player.ship.position).toEqual(stopped);
  expect(player.ship.velocity).toEqual({ x: 1000, y: 1000 });
});

test('a new motion epoch and a distant discontinuity immediately replace the display baseline', () => {
  const player = remote();
  player.ship.playerMotion = { epoch: 1, mode: 'free', ack: 0 };
  pose(player, 100);
  advanceRemotePlayerShips([player]);
  player.ship.playerMotion = { epoch: 2, mode: 'free', ack: 0 };
  pose(player, 90);
  expect(player.ship.position.x).toBe(90);
  advanceRemotePlayerShips([player]);
  expect(player.ship.position.x).toBe(91);
  pose(player, 5000);
  expect(player.ship.position.x).toBe(5000);
  advanceRemotePlayerShips([player]);
  expect(player.ship.position.x).toBe(5001);
});

test('local prediction keeps its own pose and the remote frame step never advances it', () => {
  const player = new Player({ id: 'local', name: 'Local', type: 'local' });
  player.ship.position = { x: 50, y: 70 };
  player.ship.velocity = { x: 0.4, y: 0.2 };
  player.ship.angle = 1;
  pose(player, 900, 1, 2);
  advanceRemotePlayerShips([player]);
  expect(player.ship.position).toEqual({ x: 50, y: 70 });
  expect(player.ship.velocity).toEqual({ x: 0.4, y: 0.2 });
  expect(player.ship.angle).toBe(1);
});

test.each(['death', 'explosion', 'respawn', 'downed', 'rescue', 'transit'] as const)(
  '%s discards remote projection and the next living pose starts a new baseline',
  (lifecycle) => {
    const player = remote();
    pose(player, 100);
    advanceRemotePlayerShips([player]);
    player.updateFromServer({
      position: { x: 90, y: 10 },
      velocity: { x: 1, y: 0 },
      ...(lifecycle === 'death' ? { health: 0, exploding: true } : {}),
      ...(lifecycle === 'explosion' ? { exploding: true } : {}),
      ...(lifecycle === 'respawn' ? { respawnTimer: 1 } : {}),
      ...(lifecycle === 'downed' ? { downedUntil: 30_000 } : {}),
      ...(lifecycle === 'rescue' ? { rescue: { targetId: 'friend', completesAt: 3000 } } : {}),
      ...(lifecycle === 'transit'
        ? {
            furnaceTransit: {
              sourceId: 'town-square',
              destinationId: 'frontier:1,0',
              startedAt: 0,
              durationMs: 1000,
            },
          }
        : {}),
    });
    expect(player.ship.position.x).toBe(90);
    advanceRemotePlayerShips([player]);
    expect(player.ship.position.x).toBe(90);
    player.updateFromServer({
      position: { x: 95, y: 10 },
      velocity: { x: 1, y: 0 },
      health: 100,
      exploding: false,
      downedUntil: null,
      rescue: null,
      furnaceTransit: null,
      spawnProtectionTimer: 120,
    });
    expect(player.ship.position.x).toBe(95);
    advanceRemotePlayerShips([player]);
    expect(player.ship.position.x).toBe(96);
  }
);
