// @vitest-environment node
import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { Pilot } from '../../../benchmarks/pilot';
import { SNAPSHOT_VERSION, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import { snapshotFixture } from '../network/snapshotFixture';

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class ControlledSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = ControlledSocket.OPEN;
    bufferedAmount = 0;
    extensions = '';
    readonly sent: string[] = [];

    constructor() {
      super();
      this.on('close', () => {
        this.readyState = ControlledSocket.CLOSED;
      });
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = ControlledSocket.CLOSING;
    }

    terminate(): void {
      this.readyState = ControlledSocket.CLOSED;
      queueMicrotask(() => this.emit('close', 1006));
    }
  }
  return { WebSocket: ControlledSocket };
});

function joinedPilot() {
  const failures: unknown[] = [];
  const pilot = new Pilot(0, {
    url: new URL('ws://127.0.0.1:1/ws'),
    measuring: () => false,
    fail: (error) => failures.push(error),
  });
  pilot.socket.emit('open');
  pilot.socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'joined',
        data: {
          id: pilot.id,
          snapshotVersion: SNAPSHOT_VERSION,
          asteroidInteractions: 1,
          resumeToken: 'a'.repeat(64),
        },
      })
    )
  );
  const world = snapshotFixture();
  const own = world.entities[0];
  assert(own, 'Fixture has a pilot');
  own.id = pilot.id;
  const first = new SnapshotEncoder(world).encodeSerialized(1, undefined, 0);
  pilot.socket.emit('message', Buffer.from(first.text));
  assert.equal(pilot.states, 1, 'Pilot applied its active-session world');
  return { pilot, failures, world };
}

test('a departing pilot leaves without applying or acknowledging a buffered world', async () => {
  const { pilot, failures, world } = joinedPilot();
  const send = vi.spyOn(pilot.socket, 'send');
  const before = structuredClone(pilot.state);
  const closing = pilot.close();
  try {
    const queued = structuredClone(world);
    const own = queued.entities[0];
    assert(own);
    own.position.x += 50;
    pilot.socket.emit(
      'message',
      Buffer.from(new SnapshotEncoder(queued).encodeSerialized(2, undefined, 0).text)
    );
    expect(pilot.state).toEqual(before);
    expect(pilot.states).toBe(1);
    expect(pilot.lastSnapshot?.sequence).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toEqual({ type: 'leave', data: {} });
    expect(failures).toEqual([]);
  } finally {
    pilot.socket.emit('close', 1000);
    await closing;
    send.mockRestore();
  }
});

test('intentional departure preserves an application failure recorded while the pilot was active', async () => {
  const { pilot, failures } = joinedPilot();
  pilot.socket.emit('message', Buffer.from('{"type":"snapshot","data":{"version":999}}'));
  expect(failures).toHaveLength(1);
  const original = failures[0];
  const closing = pilot.close();
  try {
    pilot.socket.emit('message', Buffer.from('{"type":"snapshot","data":{"version":999}}'));
    expect(failures).toEqual([original]);
    expect(pilot.states).toBe(1);
  } finally {
    pilot.socket.emit('close', 1000);
    await closing;
  }
});

test('a socket that closes before intentional departure remains a pilot failure', async () => {
  const { pilot, failures } = joinedPilot();
  pilot.socket.emit('close', 1006);
  expect(failures).toEqual(['Pilot 0 closed unexpectedly (1006)']);
  await pilot.close();
  expect(failures).toEqual(['Pilot 0 closed unexpectedly (1006)']);
});

test('a server rejection delivered during intentional departure remains a pilot failure', async () => {
  const { pilot, failures } = joinedPilot();
  const closing = pilot.close();
  try {
    pilot.socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'error', data: { message: 'Earlier shot was rejected' } }))
    );
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain('Earlier shot was rejected');
    expect(pilot.states).toBe(1);
    expect(pilot.lastSnapshot?.sequence).toBe(1);
  } finally {
    pilot.socket.emit('close', 1000);
    await closing;
  }
});

test('a native socket error during intentional departure fails the pilot and its cleanup', async () => {
  const { pilot, failures } = joinedPilot();
  const nativeError = new Error('Socket failed during graceful departure');
  const closing = pilot.close();
  const rejected = expect(closing).rejects.toThrow(nativeError);
  pilot.socket.emit('error', nativeError);
  await rejected;
  expect(failures).toEqual([nativeError]);
  expect(pilot.states).toBe(1);
});
