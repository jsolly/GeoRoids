import { expect, test } from 'vitest';
import { GAME, LASER } from '../../../src/constants';
import { AuthoritativeProjectileField } from '../../../src/entities/laser/AuthoritativeProjectileField';
import { Ship } from '../../../src/entities/ship/Ship';
import {
  createSkirmisherRingShots,
  SKIRMISHER_RING_COUNT,
} from '../../../src/entities/ship/skirmisherRing';

test('Skirmisher E predicts a complete evenly spaced ring with inherited velocity', () => {
  const position = { x: 120, y: -80 };
  const angle = Math.PI / 6;
  const carry = { x: 1.25, y: -0.75 };
  const shots = createSkirmisherRingShots(position, angle, 14, carry);

  expect(shots).toHaveLength(SKIRMISHER_RING_COUNT);
  for (const [index, shot] of shots.entries()) {
    const next = shots[(index + 1) % shots.length];
    expect(next).toBeDefined();
    expect(shot.velocity.x).toBeCloseTo(
      carry.x + (Math.cos(shot.angle) * LASER.SPEED) / GAME.FPS,
      10
    );
    expect(shot.velocity.y).toBeCloseTo(
      carry.y - (Math.sin(shot.angle) * LASER.SPEED) / GAME.FPS,
      10
    );
    expect(Math.hypot(shot.velocity.x - carry.x, shot.velocity.y - carry.y)).toBeCloseTo(
      LASER.SPEED / GAME.FPS,
      10
    );
    if (next) {
      const spacing = (next.angle - shot.angle + Math.PI * 2) % (Math.PI * 2);
      expect(spacing).toBeCloseTo((Math.PI * 2) / SKIRMISHER_RING_COUNT, 10);
    }
  }
});

test('Skirmisher E creates twelve local predictions without regular shot packets', () => {
  const ship = new Ship({ kitId: 'skirmisher' });
  ship.position = { x: 40, y: 20 };
  ship.angle = 0;
  ship.velocity = { x: 2, y: 0 };

  expect(ship.activateAbility()).toBe(true);
  expect(ship.lasers).toHaveLength(SKIRMISHER_RING_COUNT);
  expect(ship.lasers.map((laser) => laser.velocity.x)).toContain(2 + LASER.SPEED / GAME.FPS);
  expect(ship.lasers.map((laser) => laser.velocity.x)).toContain(2 - LASER.SPEED / GAME.FPS);
});

test('authoritative ring snapshots replace local predictions without duplicating bolts', () => {
  const field = AuthoritativeProjectileField.getInstance();
  field.clear();
  const ship = new Ship({ kitId: 'skirmisher' });
  ship.position = { x: -30, y: 18 };
  ship.angle = Math.PI / 4;
  ship.velocity = { x: 0.5, y: -1 };
  ship.fireRing();
  expect(ship.lasers).toHaveLength(SKIRMISHER_RING_COUNT);
  expect(ship.lasers.every((laser) => laser.serverId === undefined)).toBe(true);
  expect(ship.canShootAgain()).toBe(true);

  const rows = createSkirmisherRingShots(ship.position, ship.angle, ship.r, ship.velocity).map(
    (shot, index) => ({
      id: `ring-${index}`,
      abilityShot: true,
      ownerId: ship.id,
      position: shot.position,
      prevPosition: shot.position,
      velocity: shot.velocity,
      energy: 1,
      bounces: 0,
      age: 0,
    })
  );
  field.sync(rows);
  field.reconcileShip(ship, ship.id);

  expect(ship.lasers).toHaveLength(SKIRMISHER_RING_COUNT);
  expect(ship.lasers.map((laser) => laser.serverId)).toEqual(rows.map((row) => row.id));
  expect(ship.canShootAgain()).toBe(true);
  for (let index = 0; index < 5; index++) {
    ship.fireLaser();
  }
  expect(ship.canShootAgain()).toBe(false);
  field.clear();
});
