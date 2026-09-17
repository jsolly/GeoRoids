import { afterEach, expect, test } from 'vitest';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import {
  bindPlayerNetworkPort,
  requirePlayerNetworkPort,
  resetPlayerNetworkPort,
} from '../../../src/entities/player/playerNetworkPort';

afterEach(() => {
  resetPlayerNetworkPort();
});

test('crew name sync fails closed until the network port is bound', () => {
  expect(() => requirePlayerNetworkPort()).toThrow('Player network port is not bound');
});

test('a bound port lists remote crew for radar and forwards local identity', () => {
  const manager = PlayerManager.getInstance();
  const local = manager.createLocalPlayer();
  const remote = entityFactory.createRemotePlayer('remote-1', 'Radar Crew', { x: 200, y: 0 });
  const names: string[] = [];
  bindPlayerNetworkPort({
    getAllPlayers: () => [local, remote],
    setLocalPlayerName: (name) => {
      names.push(name);
    },
    updatePlayerState: () => undefined,
  });

  expect(manager.getNonLocalPlayers().map((player) => player.id)).toEqual([remote.id]);
  manager.setPlayerName('Comet');
  expect(names).toEqual(['Comet']);
  expect(local.name).toBe('Comet');
});
