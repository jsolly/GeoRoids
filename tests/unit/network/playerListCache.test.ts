import { expect, test } from 'vitest';

import { PlayerListCache } from '../../../src/network/services/playerListCache';

test('allPlayers returns the same array until the map membership changes', () => {
  const cache = new PlayerListCache<{ type: string; name: string }>();
  const players = new Map<string, { type: string; name: string }>([
    ['a', { type: 'local', name: 'Nova' }],
    ['b', { type: 'remote', name: 'Castle' }],
  ]);

  const first = cache.allPlayers(players);
  expect(cache.allPlayers(players)).toBe(first);
  expect(first).toHaveLength(2);

  const remote = players.get('b');
  if (remote) {
    remote.name = 'Retro Castle';
  }
  expect(cache.allPlayers(players)).toBe(first);
  expect(first[1]?.name).toBe('Retro Castle');

  players.set('c', { type: 'remote', name: 'Peer' });
  cache.invalidate();
  const afterAdd = cache.allPlayers(players);
  expect(afterAdd).not.toBe(first);
  expect(afterAdd).toHaveLength(3);
});

test('remotePlayers skips local entries and is cached', () => {
  const cache = new PlayerListCache<{ type: string }>();
  const players = new Map<string, { type: string }>([
    ['local', { type: 'local' }],
    ['remote', { type: 'remote' }],
    ['other', { type: 'local' }],
  ]);

  const remotes = cache.remotePlayers(players);
  expect(remotes).toEqual([{ type: 'remote' }]);
  expect(cache.remotePlayers(players)).toBe(remotes);
});
