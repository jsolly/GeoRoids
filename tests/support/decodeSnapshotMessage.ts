import type { SnapshotDecoder, SnapshotFrame } from '../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../shared-types';

export function snapshotMessage(frame: SnapshotFrame): string {
  return JSON.stringify({ type: 'snapshot', data: frame });
}

export function decodeSnapshotMessage(decoder: SnapshotDecoder, text: string): ServerGameSnapshot {
  const result = decoder.readMessage(text, { acceptSnapshots: true });
  switch (result.kind) {
    case 'snapshot':
      return result.state;
    case 'snapshot-rejected':
      throw result.error;
    case 'message':
      throw new Error('Expected a snapshot message');
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
