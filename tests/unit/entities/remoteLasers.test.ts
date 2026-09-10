import { expect, test, vi } from 'vitest';
import { SHIP } from '../../../src/constants';
import { Laser } from '../../../src/entities/laser/Laser';
import { Player } from '../../../src/entities/player/Player';
import { advanceRemotePlayerShips } from '../../../src/entities/player/remoteLasers';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { canvasManager } from '../../../src/rendering/canvas';

function makePlayer(type: 'local' | 'remote' | 'bot'): Player {
  return new Player({ id: type, name: type, type, input: new MockPlayerInput() });
}

test('ticks lifecycle and lasers only for remote players', () => {
  const remote = makePlayer('remote');
  const local = makePlayer('local');
  const bot = makePlayer('bot');

  const remoteLife = vi.spyOn(remote.ship, 'updateLifecycle');
  const remoteLasers = vi.spyOn(remote.ship, 'moveLasers');
  const localLife = vi.spyOn(local.ship, 'updateLifecycle');
  const botLife = vi.spyOn(bot.ship, 'updateLifecycle');

  advanceRemotePlayerShips([remote, local, bot]);

  expect(remoteLife).toHaveBeenCalledOnce();
  expect(remoteLasers).toHaveBeenCalledTimes(1);
  expect(localLife).not.toHaveBeenCalled();
  expect(botLife).not.toHaveBeenCalled();
});

test("a remote player's laser travels instead of freezing at the muzzle", () => {
  // Play canvas is #gameCanvas (title starfield is a second canvas).
  const canvas =
    (document.getElementById('gameCanvas') as HTMLCanvasElement | null) ??
    Object.assign(document.createElement('canvas'), { id: 'gameCanvas' });
  if (!canvas.isConnected) {
    document.body.appendChild(canvas);
  }
  canvas.width = 800;
  canvasManager.initialize();

  const remote = makePlayer('remote');
  remote.ship.lasers.push(new Laser({ x: 0, y: 0 }, { x: 5, y: 0 }, 0, 0, false));

  advanceRemotePlayerShips([remote]);

  expect(remote.ship.lasers.length).toBe(1);
  expect(remote.ship.lasers[0]?.position.x).toBeCloseTo(5, 5);
});

test('a hitch drains a remote explode window so the corpse does not freeze', () => {
  const remote = makePlayer('remote');
  remote.ship.takeDamage(100);
  expect(remote.ship.explodeTime).toBe(SHIP.EXPLODE_DURATION_FRAMES);

  for (let frame = 0; frame < SHIP.EXPLODE_DURATION_FRAMES; frame++) {
    advanceRemotePlayerShips([remote]);
  }

  expect(remote.ship.explodeTime).toBe(0);
  expect(remote.ship.exploding).toBe(true);
});
