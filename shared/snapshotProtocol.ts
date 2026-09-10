import type { ServerGameSnapshot } from '../shared-types';
import { validateSnapshotDto } from './snapshotDto';

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_KEYFRAME_INTERVAL = 90;
export const SNAPSHOT_BACKPRESSURE_BYTES = 256 * 1024;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = { [key: string]: Json };
type ImmutableJson =
  | null
  | boolean
  | number
  | string
  | readonly ImmutableJson[]
  | { readonly [key: string]: ImmutableJson };
type Immutable<Value> = Json extends Value
  ? ImmutableJson
  : Value extends object
    ? { readonly [Key in keyof Value]: Immutable<Value[Key]> }
    : Value;
type SnapshotState = Immutable<ServerGameSnapshot>;
/** Field absence means unchanged; clear deletes a field. Nested values replace atomically. */
interface SnapshotPatch {
  set: Row;
  clear: string[];
  collections: Record<
    string,
    {
      add: Row[];
      update: Array<[string, Row, string[]]>;
      remove: string[];
      order?: string[];
    }
  >;
}
export type SnapshotFrame =
  | { version: 1; sequence: number; kind: 'keyframe'; state: SnapshotState }
  | {
      version: 1;
      sequence: number;
      kind: 'delta';
      baseline: number;
      patch: Immutable<SnapshotPatch>;
    };
export interface SnapshotBaseline {
  sequence: number;
  state: SnapshotState;
}

function object(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function key(name: string): void {
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new Error('Unsafe snapshot key');
  }
}
/** Copy JSON once per broadcast: engine positions are mutable, baselines must not be. */
function copyJson(value: unknown, depth = 0): Json {
  if (depth > 24) {
    throw new Error('Snapshot nesting limit');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => copyJson(item, depth + 1));
  }
  if (object(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Row = {};
    for (const [name, item] of Object.entries(value)) {
      key(name);
      if (item !== undefined) {
        result[name] = copyJson(item, depth + 1);
      }
    }
    return result;
  }
  throw new Error('Non-JSON value in snapshot');
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
function rows(value: Json | undefined): value is Row[] {
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
function createSnapshotPatch(state: SnapshotState, baseline: SnapshotState): SnapshotPatch {
  const before = baseline as unknown as Row;
  const after = state as unknown as Row;
  const [set, clear] = fields(before, after);
  const collections: SnapshotPatch['collections'] = {};
  for (const name of Object.keys(set)) {
    const previous = before[name];
    const current = after[name];
    // All keyed collections, including future server fields, participate. Other arrays replace.
    if (!rows(previous) || !rows(current)) {
      continue;
    }
    const oldRows = indexed(previous);
    const newRows = indexed(current);
    const add: Row[] = [];
    const update: Array<[string, Row, string[]]> = [];
    const remove = [...oldRows.keys()].filter((id) => !newRows.has(id));
    for (const [id, row] of newRows) {
      const old = oldRows.get(id);
      if (!old) {
        add.push(row);
      } else {
        const [changed, removed] = fields(old, row);
        if (Object.keys(changed).length || removed.length) {
          update.push([id, changed, removed]);
        }
      }
    }
    const oldOrder = previous.map((row) => row['id'] as string);
    const order = current.map((row) => row['id'] as string);
    const change = { add, update, remove, ...(!equal(oldOrder, order) ? { order } : {}) };
    // Tiny arrays can cost more to patch than replace. Both forms carry complete information.
    if (JSON.stringify(change).length < JSON.stringify(current).length) {
      collections[name] = change;
      delete set[name];
    }
  }
  return { set, clear, collections };
}

/** One detached world per broadcast; each socket keeps its own sequence and baseline. */
export class SnapshotEncoder {
  readonly state: SnapshotState;
  private fullStateLength?: number;
  private readonly patches = new Map<SnapshotState, { patch: SnapshotPatch; length: number }>();

  constructor(state: SnapshotState) {
    this.state = captureSnapshot(state);
  }

  encode(sequence: number, baseline?: SnapshotBaseline): SnapshotFrame {
    const full: SnapshotFrame = {
      version: SNAPSHOT_VERSION,
      sequence,
      kind: 'keyframe',
      state: this.state,
    };
    if (!baseline) {
      return full;
    }

    let change = this.patches.get(baseline.state);
    if (!change) {
      const patch = createSnapshotPatch(this.state, baseline.state);
      change = { patch, length: JSON.stringify(patch).length };
      this.patches.set(baseline.state, change);
    }
    const delta: SnapshotFrame = {
      version: SNAPSHOT_VERSION,
      sequence,
      kind: 'delta',
      baseline: baseline.sequence,
      patch: change.patch,
    };
    this.fullStateLength ??= JSON.stringify(this.state).length;
    // Null stands in for the shared payload while JSON.stringify counts each
    // recipient's metadata, including sequence-number digit changes.
    const deltaLength = JSON.stringify({ ...delta, patch: null }).length - 4 + change.length;
    const fullLength = JSON.stringify({ ...full, state: null }).length - 4 + this.fullStateLength;
    return deltaLength < fullLength ? delta : full;
  }
}
function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length
  );
}
function applyFields(base: Row, set: unknown, clear: unknown): Row {
  if (!object(set) || !stringList(clear)) {
    throw new Error('Invalid snapshot field patch');
  }
  const result = { ...base };
  for (const name of clear) {
    key(name);
    if (!Object.hasOwn(base, name) || Object.hasOwn(set, name)) {
      throw new Error('Conflicting snapshot clear');
    }
    delete result[name];
  }
  for (const [name, value] of Object.entries(set)) {
    key(name);
    result[name] = value;
  }
  return result;
}
function applyPatch(base: SnapshotState, patch: unknown): ServerGameSnapshot {
  if (!object(patch) || !object(patch['collections'])) {
    throw new Error('Invalid snapshot patch');
  }
  const state = applyFields(base as unknown as Row, patch['set'], patch['clear']);
  for (const [name, change] of Object.entries(patch['collections'])) {
    key(name);
    if (
      !object(change) ||
      !rows(state[name]) ||
      !rows(change['add']) ||
      !Array.isArray(change['update']) ||
      !stringList(change['remove'])
    ) {
      throw new Error('Invalid snapshot collection patch');
    }
    if (Object.hasOwn(patch['set'] as Row, name) || (patch['clear'] as string[]).includes(name)) {
      throw new Error('Conflicting snapshot collection patch');
    }
    const items = indexed(state[name]);
    const touched = new Set<string>();
    for (const id of change['remove']) {
      if (!items.delete(id)) {
        throw new Error('Snapshot removes missing entity');
      }
      touched.add(id);
    }
    for (const row of change['add']) {
      const id = row['id'] as string;
      if (items.has(id) || touched.has(id)) {
        throw new Error('Snapshot adds duplicate entity');
      }
      items.set(id, row);
      touched.add(id);
    }
    for (const update of change['update']) {
      if (!Array.isArray(update) || update.length !== 3 || typeof update[0] !== 'string') {
        throw new Error('Invalid snapshot entity patch');
      }
      const [id, set, clear] = update;
      const previous = items.get(id);
      if (!previous || touched.has(id)) {
        throw new Error('Snapshot updates missing or duplicate entity');
      }
      const next = applyFields(previous, set, clear);
      if (next['id'] !== id) {
        throw new Error('Snapshot changes entity identity');
      }
      items.set(id, next);
      touched.add(id);
    }
    if (change['order'] !== undefined) {
      if (
        !stringList(change['order']) ||
        change['order'].length !== items.size ||
        change['order'].some((id) => !items.has(id))
      ) {
        throw new Error('Invalid snapshot entity order');
      }
      state[name] = change['order'].map((id) => items.get(id) as Row);
    } else {
      state[name] = [...items.values()];
    }
  }
  validateSnapshot(state);
  return state;
}
/** Atomic decoder: neither a rejected packet nor consumers can mutate its baseline. */
export class SnapshotDecoder {
  private baseline?: SnapshotBaseline;
  reset(): void {
    delete this.baseline;
  }
  decode(input: unknown): ServerGameSnapshot {
    const frame = input;
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
      validateSnapshot(frame['state']);
      state = frame['state'];
    } else if (
      frame['kind'] === 'delta' &&
      this.baseline &&
      frame['baseline'] === this.baseline.sequence &&
      sequence === this.baseline.sequence + 1
    ) {
      state = applyPatch(this.baseline.state, frame['patch']);
    } else {
      throw new Error('Snapshot baseline missing; keyframe required');
    }
    // Detach only the retained baseline. The application owns the parsed/reconstructed
    // state, saving a second full clone while still isolating input and consumer writes.
    const retained = captureSnapshot(state);
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
