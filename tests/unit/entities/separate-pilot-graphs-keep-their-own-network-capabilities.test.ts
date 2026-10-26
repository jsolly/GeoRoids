import { expect, test, vi } from 'vitest';
import type { Laser } from '../../../src/entities/laser/Laser';
import { createPlayer } from '../../../src/entities/player/createPlayer';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import type { ShipCombatNetwork } from '../../../src/entities/ship/shipCombatNetwork';

function pilotGraph(id: string, delivered = true) {
  const remote = createPlayer({
    id: `${id}-crew`,
    name: `${id} crew`,
    type: 'remote',
    position: { x: 200, y: 0 },
  });
  const port = {
    getAllPlayers: () => [remote],
    setLocalPlayerName: vi.fn(),
    updatePlayerState: vi.fn(() => delivered),
  };
  const combat = {
    isConnected: true,
    sendShoot: vi.fn<(laser: Laser) => void>(),
    sendCharge: () => true,
    sendAbility: vi.fn<ShipCombatNetwork['sendAbility']>(() => true),
  };
  const manager = new PlayerManager(port, combat);
  const local = manager.createLocalPlayer('hauler');
  return { manager, local, remote, port, combat };
}

test('creating a second pilot graph preserves the first pilot’s crew, input, shots and ability sender', () => {
  const a = pilotGraph('A');
  const b = pilotGraph('B');
  a.local.ship.position = { x: 100, y: 200 };
  b.local.ship.position = { x: 300, y: 400 };

  for (const graph of [a, b]) {
    expect(graph.manager.getNonLocalPlayers()).toEqual([graph.remote]);
    graph.manager.setPlayerName(graph.remote.id);
    graph.manager.updateNetworkState();
    graph.local.ship.fireLaser();
    expect(graph.local.ship.activateAbility()).toBe(true);
  }

  for (const graph of [a, b]) {
    expect(graph.port.setLocalPlayerName).toHaveBeenCalledExactlyOnceWith(graph.remote.id);
    expect(graph.local.name).toBe(graph.remote.id);
    expect(graph.port.updatePlayerState).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ position: graph.local.ship.position })
    );
    expect(graph.combat.sendShoot).toHaveBeenCalledExactlyOnceWith(graph.local.ship.lasers[0]);
    expect(graph.combat.sendAbility).toHaveBeenCalledExactlyOnceWith();
  }
  expect(a.combat.sendShoot.mock.calls[0]?.[0]).not.toBe(b.local.ship.lasers[0]);
  a.local.cargo = 7;
  const replacement = pilotGraph('A-recreated');
  expect(replacement.local).not.toBe(a.local);
  expect(replacement.local.ship).not.toBe(a.local.ship);
  expect(replacement.local.cargo).toBe(0);
  replacement.manager.setPlayerName('New A');
  replacement.manager.updateNetworkState();
  replacement.local.ship.fireLaser();
  expect(replacement.local.ship.activateAbility()).toBe(true);
  b.manager.setPlayerName('Still B');
  b.manager.updateNetworkState();
  expect(b.port.setLocalPlayerName).toHaveBeenLastCalledWith('Still B');
  expect(b.port.updatePlayerState).toHaveBeenCalledTimes(2);
  expect(replacement.port.setLocalPlayerName).toHaveBeenCalledExactlyOnceWith('New A');
  expect(replacement.combat.sendShoot).toHaveBeenCalledExactlyOnceWith(
    replacement.local.ship.lasers[0]
  );
  expect(replacement.combat.sendAbility).toHaveBeenCalledExactlyOnceWith();
  expect(a.port.setLocalPlayerName).toHaveBeenCalledTimes(1);
  expect(a.port.updatePlayerState).toHaveBeenCalledTimes(1);
  expect(a.combat.sendShoot).toHaveBeenCalledTimes(1);
  expect(a.combat.sendAbility).toHaveBeenCalledTimes(1);
});

test('an isolated pilot graph reports whether its port actually delivered the pose', () => {
  // `GameController.reportBoundaryContact` latches on this boolean, so a graph
  // composed with explicit capabilities has to pass the port's answer back
  // rather than reporting its own call. A fake returning nothing used to
  // satisfy the signature and leave that contract unpinned here.
  const sent = pilotGraph('delivering');
  expect(sent.manager.updateNetworkState()).toBe(true);

  const refused = pilotGraph('refusing', false);
  expect(refused.manager.updateNetworkState()).toBe(false);
  expect(refused.port.updatePlayerState).toHaveBeenCalledTimes(1);
});

test('production player composition requires one complete pair and refuses another graph’s capabilities', () => {
  expect(() => PlayerManager.getInstance()).toThrow('must be composed with network capabilities');
  const a = pilotGraph('production-A');
  const b = pilotGraph('production-B');
  const capabilities = { networkPort: a.port, combatNetwork: a.combat };
  const production = PlayerManager.getInstance(capabilities);
  expect(PlayerManager.getInstance()).toBe(production);
  expect(PlayerManager.getInstance(capabilities)).toBe(production);
  expect(() => PlayerManager.getInstance({ networkPort: b.port, combatNetwork: a.combat })).toThrow(
    'already composed'
  );
  expect(() => PlayerManager.getInstance({ networkPort: a.port, combatNetwork: b.combat })).toThrow(
    'already composed'
  );
  production.createLocalPlayer('hauler');
  production.setPlayerName('Retained production pilot');
  expect(production.getNonLocalPlayers()).toEqual([a.remote]);
  expect(production.getLocalShip()?.activateAbility()).toBe(true);
  expect(a.port.setLocalPlayerName).toHaveBeenCalledExactlyOnceWith('Retained production pilot');
  expect(a.combat.sendAbility).toHaveBeenCalledExactlyOnceWith();
  expect(b.port.setLocalPlayerName).not.toHaveBeenCalled();
  expect(b.combat.sendAbility).not.toHaveBeenCalled();
});
