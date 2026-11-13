// @vitest-environment node
import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { RestoreGameplayMessages } from '../../../server/backups/RestoreGameplayMessages';
import { LiveSnapshotFixture } from '../../support/liveSnapshotFixture';
import { emptySnapshotFixture } from '../network/snapshotFixture';

class ControlledConnection extends EventEmitter {
  readonly sent: string[] = [];

  send(message: string): void {
    this.sent.push(message);
  }
}

function join(connection: ControlledConnection, messages: RestoreGameplayMessages): Promise<void> {
  return messages.waitFor(
    (value) => {
      if (value.kind !== 'message') {
        return false;
      }
      messages.acceptJoin();
      return true;
    },
    () => connection.emit('message', Buffer.from('{"type":"joined"}'))
  );
}

test('a baseline delivered after join completes and before movement is observed still admits its next delta', async () => {
  const connection = new ControlledConnection();
  const messages = new RestoreGameplayMessages(connection);
  try {
    const joined = join(connection, messages);
    const before = new LiveSnapshotFixture(emptySnapshotFixture());
    const keyframe = before.encodeSerialized(1, undefined, 0);
    // A WebSocket receiver may deliver another frame before the await continuation.
    connection.emit('message', Buffer.from(keyframe.text));
    await joined;
    const after = new LiveSnapshotFixture({ ...emptySnapshotFixture(), serverTime: 42 });
    const delta = after.encodeSerialized(2, { sequence: 1, state: before.state }, 1);
    expect(delta.frame.kind).toBe('delta');
    await messages.waitFor(
      (value) => value.kind === 'snapshot' && value.state.serverTime === 42,
      () => connection.emit('message', Buffer.from(delta.text))
    );
    expect(connection.sent).toEqual([
      '{"type":"snapshotAck","data":{"sequence":1}}',
      '{"type":"snapshotAck","data":{"sequence":2}}',
    ]);
    messages.finish();
    expect(connection.listenerCount('message')).toBe(0);
  } finally {
    messages.dispose();
  }
});

test('an invalid frame between observations fails the next phase without exposing its payload', async () => {
  const connection = new ControlledConnection();
  const messages = new RestoreGameplayMessages(connection);
  try {
    await join(connection, messages);
    connection.emit('message', Buffer.from('fixture-private-invalid-json'));
    const trigger = vi.fn();
    await expect(messages.waitFor(() => true, trigger)).rejects.toThrow(
      /^Restore gameplay message failed validation$/u
    );
    expect(trigger).not.toHaveBeenCalled();
    expect(() => messages.finish()).toThrow(/^Restore gameplay message failed validation$/u);
    expect(connection.listenerCount('message')).toBe(0);
  } finally {
    messages.dispose();
  }
});

test('transport failure rejects the active observation and disposal removes owned listeners', async () => {
  const connection = new ControlledConnection();
  const messages = new RestoreGameplayMessages(connection);
  try {
    await expect(
      messages.waitFor(
        () => false,
        () => connection.emit('error', new Error('fixture-private-transport-detail'))
      )
    ).rejects.toThrow(/^Restore gameplay transport failed$/u);
  } finally {
    messages.dispose();
  }
  for (const event of ['message', 'error', 'close']) {
    expect(connection.listenerCount(event)).toBe(0);
  }
});
