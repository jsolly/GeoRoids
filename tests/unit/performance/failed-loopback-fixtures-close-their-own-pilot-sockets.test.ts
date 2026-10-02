// @vitest-environment node
import { expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createOwnedLoopback } from '../../../benchmarks/owned-loopback';

test('a failed pilot connection still closes its owned listener and every accepted socket', async () => {
  const owner = await createOwnedLoopback(() => {
    throw new Error('Pilot arrangement failed');
  });
  let listenerCloses = 0;
  owner.listener.on('close', () => {
    listenerCloses++;
  });
  try {
    await expect(owner.connect()).rejects.toThrow('Owned loopback failed');
  } finally {
    await expect(owner.close()).rejects.toThrow('cleanup failed');
  }
  expect(listenerCloses).toBe(1);
  expect(owner.listener.clients.size).toBe(0);
  expect(owner.clients.length).toBe(1);
  expect(owner.peers.length).toBe(1);
  expect(owner.clients.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
  expect(owner.peers.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true);
  expect(owner.transports.every((socket) => socket.destroyed)).toBe(true);
  // close() shares the same completed rejection; it cannot reopen resources.
  await expect(owner.close()).rejects.toThrow('cleanup failed');
});
