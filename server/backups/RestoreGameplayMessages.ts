import type { WebSocket } from 'ws';
import { SnapshotDecoder } from '../../shared/snapshotProtocol';

type SnapshotRead = ReturnType<SnapshotDecoder['readMessage']>;

interface RestoreConnection {
  send(message: string): void;
  on(event: 'message', listener: (raw: WebSocket.RawData) => void): unknown;
  on(event: 'error' | 'close', listener: () => void): unknown;
  off(event: 'message', listener: (raw: WebSocket.RawData) => void): unknown;
  off(event: 'error' | 'close', listener: () => void): unknown;
}

/** One decoder stays attached across the drill's sequential observations. */
export class RestoreGameplayMessages {
  private readonly decoder = new SnapshotDecoder('live');
  private joinedAccepted = false;
  private failure: Error | undefined;
  private waiter:
    | { read: (value: SnapshotRead) => boolean; finish: (error?: Error) => void }
    | undefined;

  constructor(private readonly connection: RestoreConnection) {
    connection.on('message', this.received);
    connection.on('error', this.failed);
    connection.on('close', this.failed);
  }

  acceptJoin(): void {
    this.decoder.reset();
    this.joinedAccepted = true;
  }

  waitFor(read: (value: SnapshotRead) => boolean, trigger: () => void): Promise<void> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => this.fail(new Error('Restore gameplay contract timed out')),
        5000
      );
      const finish = (error?: Error): void => {
        clearTimeout(deadline);
        this.waiter = undefined;
        error ? reject(error) : resolve();
      };
      this.waiter = { read, finish };
      try {
        trigger();
      } catch {
        this.failed();
      }
    });
  }

  finish(): void {
    const failure = this.failure;
    this.dispose();
    if (failure) {
      throw failure;
    }
  }

  dispose(): void {
    this.failed();
    this.connection.off('message', this.received);
    this.connection.off('error', this.failed);
    this.connection.off('close', this.failed);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.waiter?.finish(this.failure);
  }

  private readonly failed = (): void => {
    this.fail(new Error('Restore gameplay transport failed'));
  };

  private readonly received = (raw: WebSocket.RawData): void => {
    if (this.failure) {
      return;
    }
    try {
      const value = this.decoder.readMessage(String(raw), {
        acceptSnapshots: this.joinedAccepted,
      });
      if (value.kind === 'snapshot-rejected') {
        throw value.error;
      }
      if (value.kind === 'snapshot') {
        this.connection.send(
          JSON.stringify({ type: 'snapshotAck', data: { sequence: value.metadata.sequence } })
        );
      }
      const waiter = this.waiter;
      if (waiter?.read(value) === true) {
        waiter.finish();
      }
    } catch {
      this.fail(new Error('Restore gameplay message failed validation'));
    }
  };
}
