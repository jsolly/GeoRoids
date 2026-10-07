import type { ServerGameSnapshot } from '../shared-types';
import { validateSnapshotDto } from './snapshotDto';
import {
  encodeRelativeMotion,
  type RelativeMotionPrediction,
  type RelativeMotionTuple,
  readRelativeMotion,
} from './snapshotMotion';
import { quantizeSnapshotKinematics, SNAPSHOT_KINEMATIC_FACTOR } from './snapshotPrecision';

export const SNAPSHOT_VERSION = 2;
// A late join includes the entire explored atlas plus nearby asteroid geometry.
// Keep that keyframe admissible while bounding each socket's projected queue.
export const SNAPSHOT_BACKPRESSURE_BYTES = 1024 * 1024;

type Json = null | boolean | number | string | Json[] | { [propertyKey: string]: Json };
type Row = { [propertyKey: string]: Json };
type ImmutableJson =
  | null
  | boolean
  | number
  | string
  | readonly ImmutableJson[]
  | { readonly [propertyKey: string]: ImmutableJson };
type Immutable<Value> = Json extends Value
  ? ImmutableJson
  : Value extends object
    ? { readonly [Key in keyof Value]: Immutable<Value[Key]> }
    : Value;
type SnapshotState = Immutable<ServerGameSnapshot>;
// Captured trees belong to an immutable encoder. A lower bound remains valid
// after kinematic rounding and avoids serializing large losing alternatives.
const jsonByteLowerBounds = new WeakMap<object, number>();
/** All ordinal references address the immediately previous immutable collection. */
type RowUpdate = [number, Row, string[]?] | [number, number, ...number[]];
interface CollectionPatch {
  add?: Row[];
  update?: RowUpdate[];
  /** Pure relative motion addresses baseline ordinals; all other updates remain JSON. */
  motion?: string;
  remove?: number[];
  /** Added rows use baseline.length + their index in add. */
  order?: number[];
}
interface ObjectPatch {
  set?: Row;
  clear?: string[];
  collections?: Record<string, CollectionPatch>;
}
/** Field absence means unchanged; clear deletes a field. Other nested values replace atomically. */
interface SnapshotPatch extends ObjectPatch {
  objects?: { spiderField: ObjectPatch };
}
export type SnapshotFrame =
  | { version: 2; sequence: number; kind: 'keyframe'; state: SnapshotState }
  | {
      version: 2;
      sequence: number;
      kind: 'delta';
      baseline: number;
      patch: Immutable<SnapshotPatch>;
    };
export interface SnapshotBaseline {
  sequence: number;
  state: SnapshotState;
}

interface SerializedSnapshotMessage {
  readonly frame: SnapshotFrame;
  readonly text: string;
}

function object(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function key(name: string): void {
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new Error('Unsafe snapshot key');
  }
}
function jsonByteLowerBound(value: Json): number {
  if (value === null) {
    return 4;
  }
  if (typeof value === 'boolean') {
    return value ? 4 : 5;
  }
  if (typeof value === 'number') {
    return 1;
  }
  if (typeof value === 'string') {
    // JSON escaping and UTF-8 encoding can only increase this UTF-16 length.
    return value.length + 2;
  }
  const cached = jsonByteLowerBounds.get(value);
  if (cached !== undefined) {
    return cached;
  }
  let bytes = 2;
  if (Array.isArray(value)) {
    bytes += Math.max(0, value.length - 1);
    for (let index = 0; index < value.length; index++) {
      // The ownership copy preserves holes; JSON.stringify writes them as null.
      bytes += Object.hasOwn(value, index) ? jsonByteLowerBound(value[index] as Json) : 4;
    }
  } else {
    const names = Object.keys(value);
    bytes += Math.max(0, names.length - 1);
    for (const name of names) {
      bytes += name.length + 3 + jsonByteLowerBound(value[name] as Json);
    }
  }
  jsonByteLowerBounds.set(value, bytes);
  return bytes;
}
type RootFieldCopy = (name: string, value: unknown, bounds: { bytes: number }) => Json;
/** Detached ownership copy; unknown subtrees deliberately preserve independent aliases. */
function copyJson(
  value: unknown,
  depth = 0,
  bounds?: { bytes: number },
  rootFieldCopy?: RootFieldCopy
): Json {
  if (depth > 24) {
    throw new Error('Snapshot nesting limit');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (bounds) {
      bounds.bytes +=
        value === null ? 4 : typeof value === 'string' ? value.length + 2 : value ? 4 : 5;
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (bounds) {
      bounds.bytes++;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const start = bounds?.bytes ?? 0;
    let present = 0;
    const result = value.map((item) => {
      if (bounds) {
        present++;
      }
      return copyJson(item, depth + 1, bounds);
    });
    if (bounds) {
      bounds.bytes += 2 + Math.max(0, result.length - 1) + (result.length - present) * 4;
      jsonByteLowerBounds.set(result, bounds.bytes - start);
    }
    return result;
  }
  if (object(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const start = bounds?.bytes ?? 0;
    const result: Row = {};
    let retained = 0;
    for (const name of Object.keys(value)) {
      key(name);
      const item = value[name];
      if (item !== undefined) {
        if (bounds) {
          bounds.bytes += name.length + 3 + (retained++ ? 1 : 0);
        }
        result[name] =
          depth === 0 && bounds && rootFieldCopy
            ? rootFieldCopy(name, item, bounds)
            : copyJson(item, depth + 1, bounds);
      }
    }
    if (bounds) {
      bounds.bytes += 2;
      jsonByteLowerBounds.set(result, bounds.bytes - start);
    }
    return result;
  }
  throw new Error('Non-JSON value in snapshot');
}
const BROADCAST_ROW_COLLECTIONS = new Set([
  'entities',
  'asteroids',
  'loot',
  'satellitePickups',
  'playerProjectiles',
  'collabTags',
  'mapAssets',
]);
const BROADCAST_COMMON_BRANCHES = new Set([
  'settlement',
  'exploration',
  'civicModules',
  'spiderField',
  'beltRecovery',
]);

function freezeJsonTree(value: Json): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    freezeJsonTree(child);
  }
  Object.freeze(value);
}

/** A synchronous broadcast owns this cache; never retain it between engine frames. */
export class SnapshotBroadcastCapture {
  private readonly parts = new Map<string, WeakMap<object, Json>>();

  capture(state: SnapshotState): SnapshotState {
    const pending: Array<{ cache: WeakMap<object, Json>; source: object; detached: Json }> = [];
    const staged = new Map<string, WeakMap<object, Json>>();
    const newlyDetached = new WeakSet<object>();
    const bounds = { bytes: 0 };
    const part = (kind: string, value: unknown, depth: number): Json => {
      if (value === null || typeof value !== 'object') {
        return copyJson(value, depth, bounds);
      }
      let cache = this.parts.get(kind);
      if (!cache) {
        cache = new WeakMap();
        this.parts.set(kind, cache);
      }
      const previous = cache.get(value) ?? staged.get(kind)?.get(value);
      if (previous !== undefined) {
        bounds.bytes += jsonByteLowerBound(previous);
        return previous;
      }
      const detached = copyJson(value, depth, bounds);
      let waiting = staged.get(kind);
      if (!waiting) {
        waiting = new WeakMap();
        staged.set(kind, waiting);
      }
      waiting.set(value, detached);
      pending.push({ cache, source: value, detached });
      if (detached !== null && typeof detached === 'object') {
        newlyDetached.add(detached);
      }
      return detached;
    };
    const detached = copyJson(state, 0, bounds, (name, value, fieldBounds) => {
      if (BROADCAST_ROW_COLLECTIONS.has(name) && Array.isArray(value)) {
        const start = fieldBounds.bytes;
        let present = 0;
        // map preserves holes exactly as the ordinary ownership copy does.
        const selected = value.map((row) => {
          present++;
          return part(`${name}:2`, row, 2);
        });
        fieldBounds.bytes += 2 + Math.max(0, selected.length - 1) + (selected.length - present) * 4;
        jsonByteLowerBounds.set(selected, fieldBounds.bytes - start);
        return selected;
      }
      return BROADCAST_COMMON_BRANCHES.has(name)
        ? part(`${name}:1`, value, 1)
        : copyJson(value, 1, fieldBounds);
    });
    // Every recipient still receives exhaustive DTO and local-reference validation.
    // A bad recipient must not publish even otherwise valid staged pieces.
    validateSnapshot(detached);
    const freshRows = <T extends object>(items: T[]): T[] => {
      const selected: T[] = [];
      const visited = new Set<T>();
      for (const row of items) {
        if (row === undefined) {
          // Required sparse kinematic arrays must keep their existing rejection.
          selected.length++;
        } else if (newlyDetached.has(row) && !visited.has(row)) {
          selected.push(row);
          visited.add(row);
        }
      }
      return selected;
    };
    const validated: ServerGameSnapshot = detached;
    const { spiderField, ...root } = validated;
    // Capture-owned identity, rather than freezing, proves which pieces still
    // need their first rounding pass. Unknown aliases are not part of this view.
    quantizeSnapshotKinematics({
      ...root,
      asteroids: freshRows(detached.asteroids),
      loot: freshRows(detached.loot),
      satellitePickups: freshRows(detached.satellitePickups),
      playerProjectiles: freshRows(detached.playerProjectiles),
      ...(spiderField && newlyDetached.has(spiderField) ? { spiderField } : {}),
    });
    for (const entry of pending) {
      freezeJsonTree(entry.detached);
    }
    for (const entry of pending) {
      entry.cache.set(entry.source, entry.detached);
    }
    return detached;
  }
}

export function captureSnapshot(state: SnapshotState): ServerGameSnapshot {
  const copy = copyJson(state);
  validateSnapshot(copy);
  return copy;
}
function equal(left: Json | undefined, right: Json | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => equal(item, right[i]));
  }
  if (object(left) && object(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((k) => equal(left[k], right[k]));
  }
  return false;
}
function rows(value: unknown): value is Row[] {
  return (
    Array.isArray(value) && value.every((item) => object(item) && typeof item['id'] === 'string')
  );
}
function indexed(items: Row[]): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const item of items) {
    if (typeof item['id'] !== 'string' || result.has(item['id'])) {
      throw new Error('Invalid or duplicate snapshot entity ID');
    }
    result.set(item['id'], item);
  }
  return result;
}
function fields(before: Row, after: Row): [Row, string[]] {
  const set: Row = {};
  const clear: string[] = [];
  for (const name of Object.keys(before)) {
    if (!Object.hasOwn(after, name)) {
      clear.push(name);
    }
  }
  for (const name of Object.keys(after)) {
    if (!equal(before[name], after[name])) {
      set[name] = after[name] as Json;
    }
  }
  return [set, clear];
}
const NON_ASCII = /[\u0080-\u{10ffff}]/gu;
/** Native scanning skips ASCII; only non-ASCII UTF-8 excess needs JS work. */
function utf8Bytes(text: string) {
  let size = text.length;
  NON_ASCII.lastIndex = 0;
  for (let match = NON_ASCII.exec(text); match; match = NON_ASCII.exec(text)) {
    const code = text.charCodeAt(match.index);
    if (code < 0x800) {
      size++;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      text.charCodeAt(match.index + 1) >= 0xdc00 &&
      text.charCodeAt(match.index + 1) <= 0xdfff
    ) {
      // Two UTF-16 units already contribute two bytes; a pair needs four.
      size += 2;
    } else {
      // BMP characters and replacement bytes for lone surrogates need three.
      size += 2;
    }
  }
  return size;
}
function serializedBytes(value: unknown) {
  return utf8Bytes(stringifyJson(value));
}
function exactPoint(value: Json | undefined): value is Row & { x: number; y: number } {
  return (
    object(value) &&
    Object.keys(value).length === 2 &&
    typeof value['x'] === 'number' &&
    Number.isFinite(value['x']) &&
    typeof value['y'] === 'number' &&
    Number.isFinite(value['y'])
  );
}
function motionAngle(name: string, nested: boolean): 'rotation' | 'angle' | undefined {
  return !nested && name === 'asteroids'
    ? 'rotation'
    : nested && name === 'spiders'
      ? 'angle'
      : undefined;
}
function scaledInteger(value: Json | undefined): number | undefined {
  if (typeof value !== 'number') {
    return undefined;
  }
  const scaled = Math.round(value * SNAPSHOT_KINEMATIC_FACTOR);
  return Number.isSafeInteger(scaled) && scaled / SNAPSHOT_KINEMATIC_FACTOR === value
    ? scaled
    : undefined;
}
function motionValues(previous: Row, mask: number, angle: string): number[] | undefined {
  const values: number[] = [];
  if (mask & 1) {
    const point = previous['position'];
    if (!exactPoint(point)) {
      return undefined;
    }
    values.push(point['x'], point['y']);
  }
  if (mask & 2) {
    if (typeof previous[angle] !== 'number') {
      return undefined;
    }
    values.push(previous[angle]);
  }
  if (mask & 4) {
    const velocity = previous['velocity'];
    if (!exactPoint(velocity)) {
      return undefined;
    }
    values.push(velocity['x'], velocity['y']);
  }
  return values;
}
function elapsedSnapshotTicks(
  before: Json | undefined,
  after: Json | undefined
): number | undefined {
  if (typeof before !== 'number' || typeof after !== 'number') {
    return undefined;
  }
  const ticks = after - before;
  return Number.isFinite(before) &&
    Number.isFinite(after) &&
    Number.isSafeInteger(ticks) &&
    ticks > 0
    ? ticks
    : undefined;
}
/** A compression reference only. Residuals preserve every actual motion outcome. */
function asteroidMotionPrediction(
  baseline: Row[],
  elapsedTicks: number | undefined
): RelativeMotionPrediction | undefined {
  if (elapsedTicks === undefined) {
    return undefined;
  }
  const predict = (old: Json | undefined, velocity: Json | undefined): number | undefined => {
    const scaled = scaledInteger(old);
    if (
      scaled === undefined ||
      typeof old !== 'number' ||
      typeof velocity !== 'number' ||
      !Number.isFinite(velocity)
    ) {
      return undefined;
    }
    const displacement = velocity * elapsedTicks;
    const projected = old + displacement;
    const scaledProjection = projected * SNAPSHOT_KINEMATIC_FACTOR;
    const next = Math.round(scaledProjection);
    const delta = next - scaled;
    return Number.isFinite(displacement) &&
      Number.isFinite(projected) &&
      Number.isFinite(scaledProjection) &&
      Number.isSafeInteger(next) &&
      Number.isSafeInteger(delta)
      ? delta
      : undefined;
  };
  return (rowIndex, mask) => {
    const before = baseline[rowIndex];
    if (!before) {
      return undefined;
    }
    const values: number[] = [];
    if (mask & 1) {
      const position = before['position'];
      const velocity = before['velocity'];
      if (!exactPoint(position) || !exactPoint(velocity)) {
        return undefined;
      }
      const x = predict(position['x'], velocity['x']);
      const y = predict(position['y'], velocity['y']);
      if (x === undefined || y === undefined) {
        return undefined;
      }
      values.push(x, y);
    }
    if (mask & 2) {
      const angle = predict(before['rotation'], before['angularVelocity']);
      if (angle === undefined) {
        return undefined;
      }
      values.push(angle);
    }
    if (mask & 4) {
      values.push(0, 0);
    }
    return values;
  };
}
function smallerMotionTuple(
  index: number,
  mask: number,
  values: number[],
  previous: Row,
  angle: string
): RowUpdate {
  const absolute: RowUpdate = [index, mask, ...values];
  const before = motionValues(previous, mask, angle);
  if (!before) {
    return absolute;
  }
  const deltas: number[] = [];
  // Ordinal, brackets and commas are identical. Finite JSON numbers serialize
  // exactly as String(number), including canonical -0 and exponent notation.
  let absoluteBytes = String(mask).length;
  let relativeBytes = String(mask | 8).length;
  for (let i = 0; i < values.length; i++) {
    const old = scaledInteger(before[i]);
    const current = scaledInteger(values[i]);
    if (old === undefined || current === undefined) {
      return absolute;
    }
    const delta = current - old;
    if (!Number.isSafeInteger(delta)) {
      return absolute;
    }
    deltas.push(delta);
    absoluteBytes += String(values[i]).length;
    relativeBytes += String(delta).length;
  }
  return relativeBytes < absoluteBytes ? [index, mask | 8, ...deltas] : absolute;
}
/** A pure-motion tuple never drops extra fields or mixes in generic updates. */
function rowUpdate(
  index: number,
  previous: Row,
  set: Row,
  clear: string[],
  name: string,
  nested: boolean
): RowUpdate {
  const angle = motionAngle(name, nested);
  if (angle && clear.length === 0) {
    let mask = 0;
    const values: number[] = [];
    if (exactPoint(set['position'])) {
      mask |= 1;
      values.push(set['position']['x'], set['position']['y']);
    }
    if (typeof set[angle] === 'number' && Number.isFinite(set[angle])) {
      mask |= 2;
    }
    if (!nested && exactPoint(set['velocity'])) {
      mask |= 4;
    }
    const keys = Object.keys(set);
    if (
      mask &&
      keys.every(
        (field) =>
          (field === 'position' && (mask & 1) !== 0) ||
          (field === angle && (mask & 2) !== 0) ||
          (field === 'velocity' && (mask & 4) !== 0)
      )
    ) {
      if (mask & 2) {
        values.push(set[angle] as number);
      }
      if (mask & 4) {
        const velocity = set['velocity'];
        if (!exactPoint(velocity)) {
          throw new Error('Invalid motion velocity');
        }
        values.push(velocity['x'], velocity['y']);
      }
      return smallerMotionTuple(index, mask, values, previous, angle);
    }
  }
  return clear.length ? [index, set, clear] : [index, set];
}
function createCollectionPatch(
  previous: Row[],
  current: Row[],
  name: string,
  nested: boolean,
  elapsedTicks: number | undefined
): CollectionPatch {
  const old = new Map(previous.map((row, index) => [row['id'] as string, index]));
  const incoming = new Set(current.map((row) => row['id'] as string));
  const add: Row[] = [],
    update: RowUpdate[] = [],
    remove: number[] = [],
    order: number[] = [];
  for (let index = 0; index < previous.length; index++) {
    const row = previous[index];
    if (row && !incoming.has(row['id'] as string)) {
      remove.push(index);
    }
  }
  for (const row of current) {
    const index = old.get(row['id'] as string);
    if (index === undefined) {
      order.push(previous.length + add.length);
      add.push(row);
    } else {
      order.push(index);
      const before = previous[index];
      if (!before) {
        throw new Error('Missing collection baseline row');
      }
      const [set, clear] = fields(before, row);
      if (Object.keys(set).length || clear.length) {
        update.push(rowUpdate(index, before, set, clear, name, nested));
      }
    }
  }
  // Without order, decoding retains surviving baseline rows then appends additions.
  const removed = new Set(remove);
  const natural: number[] = [];
  for (let index = 0; index < previous.length; index++) {
    if (!removed.has(index)) {
      natural.push(index);
    }
  }
  for (let index = 0; index < add.length; index++) {
    natural.push(previous.length + index);
  }
  const change: CollectionPatch = {
    ...(add.length ? { add } : {}),
    ...(update.length ? { update } : {}),
    ...(remove.length ? { remove } : {}),
    ...(!equal(order, natural) ? { order } : {}),
  };
  const motion: RelativeMotionTuple[] = [];
  const generic: RowUpdate[] = [];
  for (const tuple of update) {
    if (typeof tuple[1] === 'number' && tuple[1] & 8) {
      motion.push(tuple as RelativeMotionTuple);
    } else {
      generic.push(tuple);
    }
  }
  if (!motion.length) {
    return change;
  }
  const prediction =
    !nested && name === 'asteroids' ? asteroidMotionPrediction(previous, elapsedTicks) : undefined;
  const compact: CollectionPatch = { ...change, motion: encodeRelativeMotion(motion, prediction) };
  if (generic.length) {
    compact.update = generic;
  } else {
    delete compact.update;
  }
  // The unchanged add/remove/order members cancel exactly. Compare the complete
  // replacement members, including keys, commas and base64 expansion.
  return serializedBytes({
    ...(generic.length ? { update: generic } : {}),
    motion: compact.motion,
  }) < serializedBytes({ update })
    ? compact
    : change;
}
function createObjectPatch(before: Row, after: Row, nested: boolean): ObjectPatch {
  const set: Row = {};
  const clear = Object.keys(before).filter((name) => !Object.hasOwn(after, name));
  const collections: Record<string, CollectionPatch> = {};
  for (const name of Object.keys(after)) {
    const previous = before[name],
      current = after[name] as Json;
    if ((nested && name !== 'spiders' && name !== 'nests') || !rows(previous) || !rows(current)) {
      if (!equal(previous, current)) {
        set[name] = current;
      }
      continue;
    }
    const change = createCollectionPatch(
      previous,
      current,
      name,
      nested,
      nested ? undefined : elapsedSnapshotTicks(before['gameTime'], after['gameTime'])
    );
    if (!Object.keys(change).length) {
      continue;
    }
    // Compare complete operation envelopes, including the collection metadata.
    const collectionBytes = serializedBytes({ collections: { [name]: change } });
    const replacement = { set: { [name]: current } };
    if (
      collectionBytes < jsonByteLowerBound(replacement) ||
      collectionBytes < serializedBytes(replacement)
    ) {
      collections[name] = change;
    } else {
      set[name] = current;
    }
  }
  return {
    ...(Object.keys(set).length ? { set } : {}),
    ...(clear.length ? { clear } : {}),
    ...(Object.keys(collections).length ? { collections } : {}),
  };
}
function createSnapshotPatch(state: SnapshotState, baseline: SnapshotState): SerializedPatch {
  const before = baseline as unknown as Row,
    after = state as unknown as Row;
  const patch: SnapshotPatch = createObjectPatch(before, after, false);
  if (
    patch.set &&
    Object.hasOwn(patch.set, 'spiderField') &&
    object(before['spiderField']) &&
    object(after['spiderField'])
  ) {
    const nested = createObjectPatch(before['spiderField'], after['spiderField'], true);
    const set = { ...patch.set };
    delete set['spiderField'];
    const candidate: SnapshotPatch = { ...patch, objects: { spiderField: nested } };
    if (Object.keys(set).length) {
      candidate.set = set;
    } else {
      delete candidate.set;
    }
    const alternative = serializePatch(candidate);
    if (alternative.bytes < jsonByteLowerBound(patch as unknown as Json)) {
      return alternative;
    }
    const original = serializePatch(patch);
    return alternative.bytes < original.bytes ? alternative : original;
  }
  return serializePatch(patch);
}

/** One detached world per broadcast; each socket keeps its own sequence and baseline. */
interface SerializedPatch {
  readonly patch: SnapshotPatch;
  readonly text: string;
  readonly bytes: number;
}

function serializePatch(patch: SnapshotPatch): SerializedPatch {
  const text = stringifyJson(patch);
  return { patch, text, bytes: utf8Bytes(text) };
}

interface PreparedSnapshot {
  readonly frame: SnapshotFrame;
  readonly shell: string;
  readonly payload: string;
}

function stringifyJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Snapshot JSON serialization omitted a value');
  }
  return serialized;
}

/** Replace only the placeholder emitted by the small metadata shell. */
function replaceNullField(shell: string, name: string, payload: string): string {
  const marker = `"${name}":null`;
  const index = shell.indexOf(marker);
  if (index < 0 || index !== shell.lastIndexOf(marker)) {
    throw new Error(`Snapshot JSON shell is missing its ${name} placeholder`);
  }
  return `${shell.slice(0, index)}"${name}":${payload}${shell.slice(index + marker.length)}`;
}

export class SnapshotEncoder {
  readonly state: SnapshotState;
  private fullStateText?: string;
  private fullStateBytes?: number;
  private readonly patches = new Map<SnapshotState, SerializedPatch>();

  constructor(state: SnapshotState, broadcast?: SnapshotBroadcastCapture) {
    if (broadcast) {
      this.state = broadcast.capture(state);
      return;
    }
    const detached = copyJson(state, 0, { bytes: 0 });
    validateSnapshot(detached);
    quantizeSnapshotKinematics(detached);
    this.state = detached;
  }

  encode(sequence: number, baseline?: SnapshotBaseline): SnapshotFrame {
    return this.prepare(sequence, baseline, false);
  }

  encodeSerialized(
    sequence: number,
    baseline: SnapshotBaseline | undefined,
    timestamp: number
  ): SerializedSnapshotMessage {
    const prepared = this.prepare(sequence, baseline, true);
    const frameText =
      prepared.frame.kind === 'keyframe'
        ? replaceNullField(prepared.shell, 'state', prepared.payload)
        : replaceNullField(prepared.shell, 'patch', prepared.payload);
    return {
      frame: prepared.frame,
      text: `{"type":"snapshot","data":${frameText},"timestamp":${stringifyJson(timestamp)}}`,
    };
  }

  private prepare(
    sequence: number,
    baseline: SnapshotBaseline | undefined,
    serialized: true
  ): PreparedSnapshot;
  private prepare(
    sequence: number,
    baseline: SnapshotBaseline | undefined,
    serialized: false
  ): SnapshotFrame;
  private prepare(
    sequence: number,
    baseline: SnapshotBaseline | undefined,
    serialized: boolean
  ): PreparedSnapshot | SnapshotFrame {
    const full = {
      version: SNAPSHOT_VERSION,
      sequence,
      kind: 'keyframe',
      state: this.state,
    } satisfies SnapshotFrame;
    if (!baseline) {
      if (!serialized) {
        return full;
      }
      return {
        frame: full,
        shell: stringifyJson({ ...full, state: null }),
        payload: this.serializedState(),
      };
    }

    let change = this.patches.get(baseline.state);
    if (!change) {
      change = createSnapshotPatch(this.state, baseline.state);
      this.patches.set(baseline.state, change);
    }
    const delta = {
      version: SNAPSHOT_VERSION,
      sequence,
      kind: 'delta',
      baseline: baseline.sequence,
      patch: change.patch,
    } satisfies SnapshotFrame;
    // Null stands in for the shared payload while JSON.stringify counts each
    // recipient's metadata, including sequence-number digit changes.
    const deltaShell = stringifyJson({ ...delta, patch: null });
    const fullShell = stringifyJson({ ...full, state: null });
    const deltaLength = utf8Bytes(deltaShell) - 4 + change.bytes;
    const fullShellLength = utf8Bytes(fullShell) - 4;
    if (deltaLength < fullShellLength + jsonByteLowerBound(this.state as unknown as Json)) {
      return serialized ? { frame: delta, shell: deltaShell, payload: change.text } : delta;
    }
    const fullState = this.serializedState();
    const fullLength = fullShellLength + (this.fullStateBytes ?? utf8Bytes(fullState));
    if (deltaLength < fullLength) {
      return serialized ? { frame: delta, shell: deltaShell, payload: change.text } : delta;
    }
    return serialized ? { frame: full, shell: fullShell, payload: fullState } : full;
  }

  private serializedState(): string {
    const cached = this.fullStateText;
    if (cached !== undefined) {
      return cached;
    }
    const text = stringifyJson(this.state);
    this.fullStateText = text;
    this.fullStateBytes = utf8Bytes(text);
    return text;
  }
}
function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length
  );
}
function structural(
  value: unknown,
  allowed: readonly string[],
  label: string
): asserts value is Row {
  if (!object(value)) {
    throw new Error(`Invalid snapshot ${label}`);
  }
  for (const name of Object.keys(value)) {
    key(name);
    if (!allowed.includes(name)) {
      throw new Error(`Unknown snapshot ${label} member`);
    }
  }
}
function applyFields(base: Row, set: unknown, clear: unknown): Row {
  if ((set !== undefined && !object(set)) || (clear !== undefined && !stringList(clear))) {
    throw new Error('Invalid snapshot field patch');
  }
  const updates = set ?? {};
  const removed = clear ?? [];
  const result = { ...base };
  for (const name of removed) {
    key(name);
    if (!Object.hasOwn(base, name) || Object.hasOwn(updates, name)) {
      throw new Error('Conflicting snapshot clear');
    }
    delete result[name];
  }
  for (const [name, value] of Object.entries(updates)) {
    key(name);
    result[name] = value;
  }
  return result;
}
function ordinal(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < maximum;
}
function applyRowUpdate(previous: Row, update: unknown[], name: string, nested: boolean): Row {
  const value = update[1];
  let result: Row;
  if (typeof value === 'number') {
    return applyMotion(previous, value, update.slice(2), name, nested);
  } else {
    if (update.length !== 2 && update.length !== 3) {
      throw new Error('Invalid snapshot entity patch');
    }
    if (!object(value)) {
      throw new Error('Invalid snapshot entity fields');
    }
    result = applyFields(previous, value, update[2]);
  }
  if (result['id'] !== previous['id']) {
    throw new Error('Snapshot changes entity identity');
  }
  return result;
}
function applyMotion(
  previous: Row,
  mask: number,
  input: unknown[],
  name: string,
  nested: boolean
): Row {
  const angle = motionAngle(name, nested),
    allowedMask = (nested ? 3 : 7) | 8;
  if (
    !angle ||
    !Number.isSafeInteger(mask) ||
    mask <= 0 ||
    mask > allowedMask ||
    (mask & ~allowedMask) !== 0 ||
    (mask & 7) === 0
  ) {
    throw new Error('Invalid snapshot motion mask');
  }
  const arity = (mask & 1 ? 2 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 2 : 0);
  if (
    input.length !== arity ||
    !input.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new Error('Invalid snapshot motion tuple');
  }
  const result = { ...previous };
  let values = input as number[];
  if (mask & 8) {
    const before = motionValues(previous, mask, angle);
    if (!before || !values.every(Number.isSafeInteger)) {
      throw new Error('Invalid snapshot relative motion baseline or deltas');
    }
    values = values.map((delta, i) => {
      const old = scaledInteger(before[i]);
      if (old === undefined || !Number.isSafeInteger(old + delta)) {
        throw new Error('Invalid snapshot relative motion sum');
      }
      return (old + delta) / SNAPSHOT_KINEMATIC_FACTOR;
    });
  }
  let index = 0;
  if (mask & 1) {
    result['position'] = { x: values[index++] as number, y: values[index++] as number };
  }
  if (mask & 2) {
    result[angle] = values[index++] as number;
  }
  if (mask & 4) {
    result['velocity'] = { x: values[index++] as number, y: values[index++] as number };
  }
  return result;
}
function applyCollection(
  previous: Row[],
  change: unknown,
  name: string,
  nested: boolean,
  elapsedTicks: number | undefined
): Row[] {
  structural(change, ['add', 'update', 'motion', 'remove', 'order'], 'collection patch');
  const add = change['add'] === undefined ? [] : change['add'],
    update = change['update'] === undefined ? [] : change['update'],
    remove = change['remove'] === undefined ? [] : change['remove'];
  if (
    !rows(add) ||
    !Array.isArray(update) ||
    !Array.isArray(remove) ||
    update.length > previous.length ||
    remove.length > previous.length
  ) {
    throw new Error('Invalid snapshot collection patch');
  }
  const entries: Array<Row | undefined> = [...previous];
  const touched = new Set<number>();
  for (const index of remove) {
    if (!ordinal(index, previous.length) || touched.has(index)) {
      throw new Error('Invalid snapshot removal ordinal');
    }
    touched.add(index);
    entries[index] = undefined;
  }
  const ids = new Set(previous.map((row) => row['id'] as string));
  for (const row of add) {
    const id = row['id'] as string;
    if (ids.has(id)) {
      throw new Error('Snapshot adds duplicate entity');
    }
    ids.add(id);
    entries.push(row);
  }
  for (const tuple of update) {
    if (!Array.isArray(tuple) || !ordinal(tuple[0], previous.length) || touched.has(tuple[0])) {
      throw new Error('Invalid snapshot update ordinal');
    }
    const index = tuple[0],
      before = previous[index];
    if (!before) {
      throw new Error('Snapshot updates missing entity');
    }
    touched.add(index);
    entries[index] = applyRowUpdate(before, tuple, name, nested);
  }
  if (change['motion'] !== undefined) {
    if (!motionAngle(name, nested)) {
      throw new Error('Invalid snapshot packed motion target');
    }
    const prediction =
      !nested && name === 'asteroids'
        ? asteroidMotionPrediction(previous, elapsedTicks)
        : undefined;
    readRelativeMotion(
      change['motion'],
      previous.length,
      !nested,
      (index, mask, values) => {
        const before = previous[index];
        if (!before || touched.has(index)) {
          throw new Error('Conflicting snapshot packed motion ordinal');
        }
        touched.add(index);
        entries[index] = applyMotion(before, mask, values, name, nested);
      },
      prediction
    );
  }
  const count = previous.length - remove.length + add.length;
  if (change['order'] !== undefined) {
    const order = change['order'];
    if (!Array.isArray(order) || order.length !== count) {
      throw new Error('Invalid snapshot entity order');
    }
    const seen = new Set<number>();
    return order.map((index) => {
      if (!ordinal(index, entries.length) || seen.has(index) || !entries[index]) {
        throw new Error('Invalid snapshot entity order');
      }
      seen.add(index);
      return entries[index] as Row;
    });
  }
  return entries.filter((row): row is Row => row !== undefined);
}
function applyObjectPatch(base: Row, patch: unknown, nested: boolean): Row {
  structural(
    patch,
    nested ? ['set', 'clear', 'collections'] : ['set', 'clear', 'collections', 'objects'],
    'object patch'
  );
  const state = applyFields(base, patch['set'], patch['clear']);
  const collections = patch['collections'];
  if (collections !== undefined && !object(collections)) {
    throw new Error('Invalid snapshot collections');
  }
  for (const [name, change] of Object.entries(collections ?? {})) {
    key(name);
    // Reserved v2 target: deployed older servers still send consumption history.
    if (
      (nested && name !== 'spiders' && name !== 'nests' && name !== 'consumed') ||
      !rows(base[name])
    ) {
      throw new Error('Invalid snapshot collection target');
    }
    if (
      (object(patch['set']) && Object.hasOwn(patch['set'], name)) ||
      (Array.isArray(patch['clear']) && patch['clear'].includes(name))
    ) {
      throw new Error('Conflicting snapshot collection patch');
    }
    state[name] = applyCollection(
      base[name],
      change,
      name,
      nested,
      nested ? undefined : elapsedSnapshotTicks(base['gameTime'], state['gameTime'])
    );
  }
  if (!nested && patch['objects'] !== undefined) {
    structural(patch['objects'], ['spiderField'], 'nested objects');
    for (const [name, change] of Object.entries(patch['objects'])) {
      if (
        !object(base[name]) ||
        (object(patch['set']) && Object.hasOwn(patch['set'], name)) ||
        (Array.isArray(patch['clear']) && patch['clear'].includes(name)) ||
        (object(collections) && Object.hasOwn(collections, name))
      ) {
        throw new Error('Conflicting snapshot nested patch');
      }
      state[name] = applyObjectPatch(base[name], change, true);
    }
  }
  return state;
}
function applyPatch(base: SnapshotState, patch: unknown): ServerGameSnapshot {
  const state = applyObjectPatch(base as unknown as Row, patch, false);
  validateSnapshot(state);
  return state;
}

export type SnapshotMetadata = Pick<SnapshotFrame, 'kind' | 'sequence'> & {
  readonly baseline?: number;
};

interface SnapshotReadTimings {
  readonly parseMs: number;
  readonly decodeMs?: number;
}

type SnapshotReadTiming = { readonly timings?: SnapshotReadTimings };

type SnapshotRead =
  | ({
      readonly kind: 'snapshot';
      readonly state: ServerGameSnapshot;
      readonly metadata: SnapshotMetadata;
    } & SnapshotReadTiming)
  | ({
      readonly kind: 'snapshot-rejected';
      readonly error: Error;
      readonly metadata?: SnapshotMetadata;
    } & SnapshotReadTiming)
  | ({ readonly kind: 'message'; readonly message: unknown } & SnapshotReadTiming);

interface SnapshotAdmission {
  readonly acceptSnapshots: boolean;
}

function readSnapshotMetadata(value: unknown): SnapshotMetadata | undefined {
  if (!object(value)) {
    return undefined;
  }
  const sequence = value['sequence'];
  if (!Number.isSafeInteger(sequence) || (sequence as number) <= 0) {
    return undefined;
  }
  const kind = value['kind'];
  if (kind !== 'keyframe' && kind !== 'delta') {
    return undefined;
  }
  return {
    kind,
    sequence: sequence as number,
    ...(kind === 'delta' && Number.isSafeInteger(value['baseline'])
      ? { baseline: value['baseline'] as number }
      : {}),
  };
}

function copyOwnedSnapshot(state: ServerGameSnapshot): ServerGameSnapshot {
  // #decodeOwned has already validated this parser-owned graph. copyJson keeps
  // the wire-safety, depth and detachment checks without repeating DTO/index validation.
  return copyJson(state) as unknown as ServerGameSnapshot;
}

/** Atomic decoder: neither a rejected packet nor consumers can mutate its baseline. */
export class SnapshotDecoder {
  private baseline?: SnapshotBaseline;

  reset(): void {
    delete this.baseline;
  }

  readMessage(text: string, admission: SnapshotAdmission, collectTimings = false): SnapshotRead {
    const parseStarted = collectTimings ? performance.now() : 0;
    const envelope: unknown = JSON.parse(text);
    const parseMs = collectTimings ? performance.now() - parseStarted : 0;
    const parseTimings = collectTimings ? { timings: { parseMs } } : {};
    if (!object(envelope) || envelope['type'] !== 'snapshot') {
      return { kind: 'message', message: envelope, ...parseTimings };
    }

    const frame = envelope['data'];
    const metadata = readSnapshotMetadata(frame);
    if (!admission.acceptSnapshots) {
      return {
        kind: 'snapshot-rejected',
        error: new Error('Snapshot arrived before the current protocol join ack'),
        ...(metadata ? { metadata } : {}),
        ...parseTimings,
      };
    }

    const decodeStarted = collectTimings ? performance.now() : 0;
    try {
      const state = this.#decodeOwned(frame);
      if (!metadata) {
        throw new Error('Decoded snapshot is missing diagnostic metadata');
      }
      return {
        kind: 'snapshot',
        state,
        metadata,
        ...(collectTimings
          ? { timings: { parseMs, decodeMs: performance.now() - decodeStarted } }
          : {}),
      };
    } catch (error) {
      return {
        kind: 'snapshot-rejected',
        error:
          error instanceof Error
            ? error
            : new Error(typeof error === 'string' ? error : JSON.stringify(error), {
                cause: error,
              }),
        ...(metadata ? { metadata } : {}),
        ...(collectTimings
          ? { timings: { parseMs, decodeMs: performance.now() - decodeStarted } }
          : {}),
      };
    }
  }

  #decodeOwned(frame: unknown): ServerGameSnapshot {
    if (
      !object(frame) ||
      frame['version'] !== SNAPSHOT_VERSION ||
      !Number.isSafeInteger(frame['sequence']) ||
      (frame['sequence'] as number) <= 0
    ) {
      throw new Error('Unsupported or malformed snapshot');
    }
    const sequence = frame['sequence'] as number;
    if (this.baseline && sequence <= this.baseline.sequence) {
      throw new Error('Stale snapshot sequence');
    }
    let state: ServerGameSnapshot;
    if (frame['kind'] === 'keyframe') {
      structural(frame, ['version', 'sequence', 'kind', 'state'], 'keyframe');
      validateSnapshot(frame['state']);
      state = frame['state'];
    } else if (
      frame['kind'] === 'delta' &&
      this.baseline &&
      frame['baseline'] === this.baseline.sequence &&
      sequence === this.baseline.sequence + 1
    ) {
      structural(frame, ['version', 'sequence', 'kind', 'baseline', 'patch'], 'delta');
      state = applyPatch(this.baseline.state, frame['patch']);
    } else {
      throw new Error('Snapshot baseline missing; keyframe required');
    }
    const retained = copyOwnedSnapshot(state);
    this.baseline = { sequence, state: retained };
    return state;
  }
}

function validateSnapshot(value: unknown): asserts value is ServerGameSnapshot {
  validateSnapshotDto(value);
  for (const collection of Object.values(value as unknown as Row)) {
    if (rows(collection)) {
      indexed(collection);
    }
  }
}
