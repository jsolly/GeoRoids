import { expect, test } from 'vitest';
import { EntityManager } from '../../../server/core/EntityManager';
import { RNGService } from '../../../server/core/RNGService';
import { PALETTE } from '../../../src/constants';

test('rejoin and same-name takeover apply the requested Hauler kit', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer(
    'pilot-1',
    'Pilot',
    { sent: 1 } as never,
    { x: 8, y: 9 },
    '#abc',
    'dart'
  );
  expect(first.kitId).toBe('dart');

  const rejoined = manager.addHumanPlayer(
    'pilot-1',
    'Pilot',
    { sent: 2 } as never,
    { x: 0, y: 0 },
    '#def',
    'hauler'
  );
  expect(rejoined).toBe(first);
  expect(rejoined.kitId).toBe('hauler');

  const taken = manager.addHumanPlayer(
    'pilot-new',
    'Pilot',
    { sent: 3 } as never,
    { x: 0, y: 0 },
    '#fff',
    'hauler'
  );
  expect(taken).toBe(first);
  expect(taken.kitId).toBe('hauler');
});

test('rejoining the same human id keeps lives, side, and swaps the socket', () => {
  const manager = new EntityManager(new RNGService(1));
  const firstSocket = { sent: 1 } as never;
  const secondSocket = { sent: 2 } as never;
  const first = manager.addHumanPlayer('pilot-1', 'Pilot', firstSocket, { x: 8, y: 9 }, '#abc');
  first.lives = 1;
  first.health = 40;

  const rejoined = manager.addHumanPlayer('pilot-1', 'Pilot', secondSocket, { x: 0, y: 0 }, '#def');

  expect(rejoined).toBe(first);
  expect(manager.getHumanPlayerCount()).toBe(1);
  expect(rejoined.lives).toBe(1);
  expect(rejoined.health).toBe(40);
  expect(rejoined.position).toEqual({ x: 8, y: 9 });
  expect(rejoined.ws).toBe(secondSocket);
  expect(rejoined.factionId).toBe('ion');
  expect(rejoined.color).toBe(PALETTE.REMOTE);
});

test('a new client id with the same name takes over the live ship instead of cloning it', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer('pilot-old', 'PilotB', { sent: 1 } as never, { x: 8, y: 9 });
  first.lives = 2;
  first.score = 450;

  const taken = manager.addHumanPlayer('pilot-new', 'PilotB', { sent: 2 } as never, {
    x: 3000,
    y: 0,
  });

  expect(taken).toBe(first);
  expect(taken.id).toBe('pilot-new');
  expect(taken.lives).toBe(2);
  expect(taken.score).toBe(450);
  expect(manager.getHumanPlayerCount()).toBe(1);
  expect(manager.getEntity('pilot-old')).toBeUndefined();
});

test('drop then rejoin under a new id restores lives and score by name', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer('pilot-old', 'PilotB', { sent: 1 } as never, { x: 8, y: 9 });
  first.lives = 2;
  first.score = 450;
  manager.removeEntity('pilot-old');

  const rejoined = manager.addHumanPlayer('pilot-new', 'PilotB', { sent: 2 } as never, {
    x: 3000,
    y: 0,
  });

  expect(rejoined.lives).toBe(2);
  expect(rejoined.score).toBe(450);
  expect(manager.getHumanPlayerCount()).toBe(1);
});

test('game-over rejoin starts a new ship instead of restoring 0 lives', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 1 } as never, { x: 8, y: 9 });
  first.lives = 0;
  first.score = 210;

  manager.removeEntity('pilot-1');
  const rejoined = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 2 } as never, {
    x: 3000,
    y: 0,
  });

  expect(rejoined.lives).toBe(3);
  expect(rejoined.score).toBe(0);
});

test('leftover 0-life same-name ship is deleted so Start gets a fresh 3/0', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer('pilot-old', 'Pilot', { sent: 1 } as never, { x: 8, y: 9 });
  first.lives = 0;
  first.score = 210;

  const started = manager.addHumanPlayer('pilot-new', 'Pilot', { sent: 2 } as never, {
    x: 3000,
    y: 0,
  });

  expect(started).not.toBe(first);
  expect(started.id).toBe('pilot-new');
  expect(started.lives).toBe(3);
  expect(started.score).toBe(0);
  expect(manager.getHumanPlayerCount()).toBe(1);
  expect(manager.getEntity('pilot-old')).toBeUndefined();
});

test('leftover 0-life same-id ship is replaced instead of taken over', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 1 } as never, { x: 8, y: 9 });
  first.lives = 0;
  first.score = 210;

  const started = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 2 } as never, {
    x: 3000,
    y: 0,
  });

  expect(started).not.toBe(first);
  expect(started.lives).toBe(3);
  expect(started.score).toBe(0);
  expect(manager.getHumanPlayerCount()).toBe(1);
});

test('same-id reconnect mid-explosion finishes respawn instead of inheriting a corpse', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 1 } as never, { x: 8, y: 9 });
  first.lives = 2;
  first.score = 210;
  first.health = 0;
  first.exploding = true;
  first.explodeTime = 8;
  first.respawnTimer = 8;
  first.velocity = { x: 0, y: 0 };
  delete first.spawnProtectionTimer;

  const rejoined = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 2 } as never, { x: 0, y: 0 });

  expect(rejoined).toBe(first);
  expect(rejoined.health).toBe(rejoined.maxHealth);
  expect(rejoined.exploding).toBe(false);
  expect(rejoined.respawnTimer).toBeUndefined();
  expect(rejoined.spawnProtectionTimer).toBeGreaterThan(0);
  expect(rejoined.lives).toBe(2);
  expect(rejoined.score).toBe(210);
  expect(rejoined.velocity).toEqual({ x: 0, y: 0 });
});

test('same-name takeover mid-death respawns and reports the old id', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer('pilot-old', 'PilotB', { sent: 1 } as never, { x: 8, y: 9 });
  first.lives = 2;
  first.health = 0;
  first.exploding = true;
  first.respawnTimer = 8;

  const taken = manager.addHumanPlayer('pilot-new', 'PilotB', { sent: 2 } as never, {
    x: 3000,
    y: 0,
  });

  expect(taken.health).toBe(taken.maxHealth);
  expect(taken.exploding).toBe(false);
  expect(taken.respawnTimer).toBeUndefined();
  expect(taken.id).toBe('pilot-new');
  expect(manager.getEntity('pilot-old')).toBeUndefined();
  expect(manager.consumeReplacedHumanId()).toBe('pilot-old');
});

test('live same-id reuse keeps velocity and does not report a replaced id', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 1 } as never, { x: 8, y: 9 });
  first.velocity = { x: 4, y: -2 };
  first.health = 40;

  const rejoined = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 2 } as never, { x: 0, y: 0 });

  expect(rejoined.velocity).toEqual({ x: 4, y: -2 });
  expect(rejoined.health).toBe(40);
  expect(manager.consumeReplacedHumanId()).toBeUndefined();
});

test('rejoining after the socket was removed restores lives and score, not a fresh 3/0', () => {
  const manager = new EntityManager(new RNGService(1));
  const first = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 1 } as never, { x: 8, y: 9 });
  first.lives = 2;
  first.score = 210;

  manager.removeEntity('pilot-1');
  expect(manager.getHumanPlayerCount()).toBe(0);

  const rejoined = manager.addHumanPlayer('pilot-1', 'Pilot', { sent: 2 } as never, {
    x: 3000,
    y: 0,
  });

  expect(rejoined.lives).toBe(2);
  expect(rejoined.score).toBe(210);
  expect(rejoined.health).toBe(100);
  expect(rejoined.spawnProtectionTimer).toBeGreaterThan(0);
});
