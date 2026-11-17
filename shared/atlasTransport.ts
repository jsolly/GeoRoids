import type { ExplorationTile } from '../shared-types';
import { type ExplorationMap, MAX_EXPLORATION_TILES, validExploration } from './exploration';

export const EXPLORATION_VERSION = 1;
export const ATLAS_SEGMENT_BYTES = 8192;
const ATLAS_CONTENT_BYTES = 1024 * 1024;
const MAX_RECORDS = 64;
const ID_FRAGMENT_CHARACTERS = 2048;
const ID_FRAGMENT_PATTERN = /^[\d,]+$/u;
const TILE_BITS_PATTERN = /^[0-9a-f]{64}$/u;

type AtlasSource = Pick<ExplorationMap, 'atlasIdentity' | 'nextAtlasTile'>;
type Scan = {
  readonly epoch: number;
  readonly afterRevision: number;
  readonly target: number;
  readonly endSlot: number;
  readonly nextSlot: number;
};
export type AtlasCursor =
  | { readonly kind: 'start' }
  | ({ readonly kind: 'scan'; readonly offset: number } & Scan)
  | { readonly kind: 'idle'; readonly epoch: number; readonly through: number };

type AtlasRecord =
  | {
      readonly kind: 'part';
      readonly slot: number;
      readonly offset: number;
      readonly total: number;
      readonly id: string;
    }
  | {
      readonly kind: 'tile';
      readonly slot: number;
      readonly offset: number;
      readonly total: number;
      readonly id: string;
      readonly bits: string;
    };

export interface AtlasSegment {
  readonly epoch: number;
  readonly transfer: number;
  readonly reset: boolean;
  readonly through: number | null;
  readonly records: readonly AtlasRecord[];
}

export interface AtlasOffer {
  readonly segment: AtlasSegment;
  readonly text: string;
  readonly next: AtlasCursor;
}

/** One bounded selection; the caller owns offered/applied cursor credit. */
export function offerAtlas(
  source: AtlasSource,
  cursor: AtlasCursor,
  transfer: number
): AtlasOffer | undefined {
  const identity = source.atlasIdentity();
  if (identity.encodedBytes > ATLAS_CONTENT_BYTES) {
    throw new Error('Atlas exceeds supported transport content budget');
  }
  if (
    cursor.kind === 'idle' &&
    cursor.epoch === identity.epoch &&
    cursor.through === identity.revision
  ) {
    return undefined;
  }
  const reset = cursor.kind === 'start' || cursor.epoch !== identity.epoch;
  const scan: Scan =
    cursor.kind === 'scan' && !reset
      ? cursor
      : {
          epoch: identity.epoch,
          afterRevision: !reset && cursor.kind === 'idle' ? cursor.through : 0,
          target: identity.revision,
          endSlot: identity.slots,
          nextSlot: 0,
        };
  let nextSlot = scan.nextSlot;
  let offset = cursor.kind === 'scan' && !reset ? cursor.offset : 0;
  const records: AtlasRecord[] = [];
  const encoded: string[] = [];
  let bytes = 256; // Bounded numeric metadata, array and property overhead.
  let done = false;
  while (records.length < MAX_RECORDS && bytes + 256 < ATLAS_SEGMENT_BYTES) {
    const tile = source.nextAtlasTile({
      afterSlot: nextSlot,
      endSlot: scan.endSlot,
      afterRevision: scan.afterRevision,
    });
    if (!tile) {
      done = true;
      break;
    }
    const count = Math.min(
      tile.id.length - offset,
      ID_FRAGMENT_CHARACTERS,
      ATLAS_SEGMENT_BYTES - bytes - 256
    );
    const id = tile.id.slice(offset, offset + count);
    const complete = offset + count === tile.id.length;
    const row: AtlasRecord = complete
      ? { kind: 'tile', slot: tile.slot, offset, total: tile.id.length, id, bits: tile.bits }
      : { kind: 'part', slot: tile.slot, offset, total: tile.id.length, id };
    // Each row is serialized once. Do not repeatedly serialize a growing chunk.
    const text = JSON.stringify(row);
    bytes += text.length + 1;
    records.push(row);
    encoded.push(text);
    nextSlot = complete ? tile.slot + 1 : tile.slot;
    offset = complete ? 0 : offset + count;
  }
  // A full record budget may also finish the pass without another payload row.
  if (
    !done &&
    offset === 0 &&
    !source.nextAtlasTile({
      afterSlot: nextSlot,
      endSlot: scan.endSlot,
      afterRevision: scan.afterRevision,
    })
  ) {
    done = true;
  }
  const segment: AtlasSegment = {
    epoch: scan.epoch,
    transfer,
    reset,
    through: done ? scan.target : null,
    records,
  };
  const shell = JSON.stringify({ ...segment, records: null });
  const text = shell.replace('"records":null', `"records":[${encoded.join(',')}]`);
  if (text.length > ATLAS_SEGMENT_BYTES) {
    throw new Error('Atlas segment exceeded byte budget');
  }
  return {
    segment,
    text,
    next: done
      ? { kind: 'idle', epoch: scan.epoch, through: scan.target }
      : { ...scan, kind: 'scan', nextSlot, offset },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('Unknown atlas field');
  }
}
function readSegment(input: unknown): AtlasSegment {
  if (!record(input)) {
    throw new Error('Invalid atlas segment');
  }
  exact(input, ['epoch', 'transfer', 'reset', 'through', 'records']);
  if (
    !counter(input['epoch']) ||
    !counter(input['transfer']) ||
    typeof input['reset'] !== 'boolean' ||
    !(input['through'] === null || counter(input['through'])) ||
    !Array.isArray(input['records']) ||
    input['records'].length > MAX_RECORDS
  ) {
    throw new Error('Invalid atlas metadata');
  }
  // The incoming field is already bounded by its wire envelope; ASCII records
  // also make this independent exact field accounting safe across runtimes.
  if (JSON.stringify(input).length > ATLAS_SEGMENT_BYTES) {
    throw new Error('Oversized atlas segment');
  }
  const records: AtlasRecord[] = [];
  for (const item of input['records']) {
    if (
      !record(item) ||
      !counter(item['slot']) ||
      item['slot'] >= MAX_EXPLORATION_TILES ||
      !counter(item['offset']) ||
      !counter(item['total']) ||
      item['total'] > ATLAS_CONTENT_BYTES ||
      typeof item['id'] !== 'string' ||
      item['id'].length === 0 ||
      !ID_FRAGMENT_PATTERN.test(item['id']) ||
      item['offset'] + item['id'].length > item['total']
    ) {
      throw new Error('Invalid atlas fragment');
    }
    const common = {
      slot: item['slot'],
      offset: item['offset'],
      total: item['total'],
      id: item['id'],
    };
    if (
      item['kind'] === 'tile' &&
      typeof item['bits'] === 'string' &&
      TILE_BITS_PATTERN.test(item['bits']) &&
      item['offset'] + item['id'].length === item['total']
    ) {
      exact(item, ['kind', 'slot', 'offset', 'total', 'id', 'bits']);
      records.push({ ...common, kind: 'tile', bits: item['bits'] });
    } else if (item['kind'] === 'part' && item['offset'] + item['id'].length < item['total']) {
      exact(item, ['kind', 'slot', 'offset', 'total', 'id']);
      records.push({ ...common, kind: 'part' });
    } else {
      throw new Error('Invalid atlas record');
    }
  }
  return {
    epoch: input['epoch'],
    transfer: input['transfer'],
    reset: input['reset'],
    through: input['through'],
    records,
  };
}

type PartialTile = { readonly slot: number; readonly id: string; readonly total: number };
type ReceiverIdentity = { readonly epoch: number; readonly transfer: number };

/** Parser-owned authority. Committed content plus one partial ID is <= 1 MiB.
 * Atomic preparation can retain the old partial and its replacement, bounded
 * by two content budgets plus one incoming segment. It never clones the map. */
export class AtlasReceiver {
  private identity: ReceiverIdentity | undefined;
  private readonly tiles = new Map<number, ExplorationTile>();
  private readonly ids = new Map<string, number>();
  private partial: PartialTile | undefined;
  private bytes = 2;
  private encoded: ExplorationTile[] = [];
  private stale = false;
  private syncing = true;

  reset(): void {
    this.identity = undefined;
    this.tiles.clear();
    this.ids.clear();
    this.partial = undefined;
    this.bytes = 2;
    this.encoded = [];
    this.stale = false;
    this.syncing = true;
  }

  prepare(input: unknown): () => void {
    const segment = readSegment(input);
    if (this.identity && segment.epoch < this.identity.epoch) {
      throw new Error('Stale atlas epoch');
    }
    if (
      this.identity &&
      segment.epoch === this.identity.epoch &&
      segment.transfer < this.identity.transfer
    ) {
      throw new Error('Stale atlas transfer');
    }
    const reset = !this.identity || segment.epoch !== this.identity.epoch || segment.reset;
    const staged = new Map<number, ExplorationTile>();
    const stagedIds = new Map<string, number>();
    let partial = reset ? undefined : this.partial;
    let bytes = reset ? 2 : this.bytes;
    for (const item of segment.records) {
      const existing = staged.get(item.slot) ?? (reset ? undefined : this.tiles.get(item.slot));
      if (existing) {
        if (
          existing.id.length !== item.total ||
          existing.id.slice(item.offset, item.offset + item.id.length) !== item.id
        ) {
          throw new Error('Conflicting atlas identity');
        }
        if (item.kind === 'tile') {
          let bits = '';
          for (let byte = 0; byte < 64; byte += 2) {
            bits += (
              Number.parseInt(existing.bits.slice(byte, byte + 2), 16) |
              Number.parseInt(item.bits.slice(byte, byte + 2), 16)
            )
              .toString(16)
              .padStart(2, '0');
          }
          staged.set(item.slot, { id: existing.id, bits });
        }
        continue;
      }
      if (!partial) {
        if (item.offset !== 0) {
          throw new Error('Atlas fragment lacks start');
        }
        partial = { slot: item.slot, id: '', total: item.total };
      }
      if (
        partial.slot !== item.slot ||
        partial.total !== item.total ||
        item.offset > partial.id.length ||
        partial.id.slice(item.offset, Math.min(partial.id.length, item.offset + item.id.length)) !==
          item.id.slice(0, Math.max(0, partial.id.length - item.offset))
      ) {
        throw new Error('Atlas fragment gap or conflict');
      }
      const suffix = item.id.slice(Math.max(0, partial.id.length - item.offset));
      if (bytes + partial.id.length + suffix.length > ATLAS_CONTENT_BYTES) {
        throw new Error('Atlas assembly exceeds content budget');
      }
      partial = { ...partial, id: partial.id + suffix };
      if (item.kind === 'tile') {
        const tile = { id: partial.id, bits: item.bits };
        if (!validExploration([tile])) {
          throw new Error('Invalid assembled atlas tile');
        }
        const previousSlot = stagedIds.get(tile.id) ?? (reset ? undefined : this.ids.get(tile.id));
        if (previousSlot !== undefined && previousSlot !== item.slot) {
          throw new Error('Duplicate atlas tile identity');
        }
        const count = (reset ? 0 : this.tiles.size) + staged.size;
        bytes += tile.id.length + tile.bits.length + 19 + (count > 0 ? 1 : 0);
        if (bytes > ATLAS_CONTENT_BYTES) {
          throw new Error('Atlas exceeds content budget');
        }
        staged.set(item.slot, tile);
        stagedIds.set(tile.id, item.slot);
        partial = undefined;
      }
    }
    if (segment.through !== null && partial) {
      throw new Error('Incomplete atlas marked complete');
    }
    return () => {
      if (reset) {
        this.reset();
      }
      this.identity = { epoch: segment.epoch, transfer: segment.transfer };
      this.partial = partial;
      this.bytes = bytes;
      for (const [slot, tile] of staged) {
        this.tiles.set(slot, tile);
        this.ids.set(tile.id, slot);
      }
      this.stale ||= reset || staged.size > 0;
      this.syncing = segment.through === null;
    };
  }

  snapshot(): ExplorationTile[] {
    if (this.stale) {
      this.encoded = [...this.tiles.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, tile]) => ({ ...tile }));
      this.stale = false;
    }
    // Presentation consumers cannot mutate the parser-owned projection.
    return this.encoded.map((tile) => ({ ...tile }));
  }

  isSyncing(): boolean {
    return this.syncing;
  }
}
