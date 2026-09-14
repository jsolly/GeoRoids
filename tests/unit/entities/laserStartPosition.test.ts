import { describe, expect, test } from 'vitest';
import { createLaser } from '../../../src/entities/laser/laserUtils';
import { Ship } from '../../../src/entities/ship/Ship';
import { calculateLaserStartPosition } from '../../../src/entities/ship/shipUtils';

describe('shared laser spawn helper', () => {
  test('noses the shot 4/3 radius along the ship heading', () => {
    const shipPos = { x: 10, y: -4 };
    const angle = Math.PI / 6;
    const radius = 15;
    const start = calculateLaserStartPosition(shipPos, angle, radius);
    expect(start.x).toBeCloseTo(shipPos.x + (4 / 3) * radius * Math.cos(angle));
    expect(start.y).toBeCloseTo(shipPos.y - (4 / 3) * radius * Math.sin(angle));
  });

  test('createLaser uses the shared start helper for every ship', () => {
    const player = new Ship({ position: { x: 40, y: 8 } });
    const remote = new Ship({ position: { x: 40, y: 8 } });
    player.angle = 0.4;
    remote.angle = 0.4;
    player.r = 15;
    remote.r = 15;

    const playerLaser = createLaser(player);
    const remoteLaser = createLaser(remote);
    const expected = calculateLaserStartPosition(player.position, player.angle, player.r);

    expect(playerLaser.position).toEqual(expected);
    expect(remoteLaser.position).toEqual(expected);
  });
});
