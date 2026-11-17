import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = 'shared/snapshotProtocol.ts';

interface Decoder {
  reset(): void;
  readMessage(text: string, admission: { readonly acceptSnapshots: boolean }): unknown;
}
export interface CandidateProtocol {
  readonly identity: {
    readonly source: 'candidate';
    readonly requestedSha: string;
    readonly observedSha: string;
    readonly modulePath: typeof modulePath;
    readonly moduleSha256: string;
    readonly constructionMode: 'live';
  };
  createDecoder(): Decoder;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Candidate code is the codec under test, never the source of smoke assertions. */
export function candidateDecoderFactory(namespace: unknown): () => Decoder {
  assert(
    record(namespace) && typeof namespace['SnapshotDecoder'] === 'function',
    'Candidate SnapshotDecoder export is invalid'
  );
  const Constructor = namespace['SnapshotDecoder'];
  return () => {
    try {
      const instance: unknown = Reflect.construct(Constructor, ['live']);
      if (instance instanceof Promise) {
        void instance.catch(() => undefined);
        throw new Error('Candidate decoder constructor must be synchronous');
      }
      assert(record(instance));
      const reset = instance['reset'];
      const read = instance['readMessage'];
      assert(typeof reset === 'function' && typeof read === 'function');
      return {
        reset() {
          try {
            const result: unknown = Reflect.apply(reset, instance, []);
            if (result instanceof Promise) {
              void result.catch(() => undefined);
            }
            assert(result === undefined);
          } catch {
            // biome-ignore lint/style/useErrorCause: candidate exceptions may contain joined credentials or raw payloads.
            throw new Error('Candidate decoder reset failed');
          }
        },
        readMessage(text, admission) {
          try {
            const result: unknown = Reflect.apply(read, instance, [text, admission]);
            if (result instanceof Promise) {
              void result.catch(() => undefined);
              throw new Error('Candidate decoder must be synchronous');
            }
            return result;
          } catch {
            // biome-ignore lint/style/useErrorCause: candidate exceptions may contain joined credentials or raw payloads.
            throw new Error('Candidate decoder read failed');
          }
        },
      };
    } catch {
      // biome-ignore lint/style/useErrorCause: candidate exceptions may contain joined credentials or raw payloads.
      throw new Error('Candidate decoder construction failed');
    }
  };
}

export async function loadCandidateProtocol(settings: {
  readonly workspaceRoot: string | undefined;
  readonly candidateRoot: string | undefined;
  readonly requestedSha: string;
}): Promise<CandidateProtocol> {
  try {
    const { workspaceRoot, candidateRoot, requestedSha } = settings;
    assert(workspaceRoot !== undefined && isAbsolute(workspaceRoot));
    assert(candidateRoot !== undefined && isAbsolute(candidateRoot));
    assert(/^[0-9a-f]{40}$/u.test(requestedSha));
    const workspace = await realpath(workspaceRoot);
    const candidate = await realpath(candidateRoot);
    assert(candidate === join(workspace, 'candidate'));
    assert(candidate !== (await realpath(join(workspace, 'verification'))));
    const path = join(candidate, modulePath);
    assert((await lstat(path)).isFile());
    assert((await realpath(path)) === path);
    const observedSha = execFileSync(
      'git',
      ['--no-optional-locks', '-C', candidate, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', maxBuffer: 4096 }
    ).trim();
    assert(observedSha === requestedSha);
    const bytes = await readFile(path);
    const committed = execFileSync(
      'git',
      ['--no-optional-locks', '-C', candidate, 'show', `${requestedSha}:${modulePath}`],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    assert(bytes.equals(committed));
    const url = pathToFileURL(path);
    url.searchParams.set('candidate', requestedSha);
    const namespace: unknown = await import(url.href);
    assert((await readFile(path)).equals(bytes));
    const createDecoder = candidateDecoderFactory(namespace);
    createDecoder().reset();
    return {
      identity: {
        source: 'candidate',
        requestedSha,
        observedSha,
        modulePath,
        moduleSha256: createHash('sha256').update(bytes).digest('hex'),
        constructionMode: 'live',
      },
      createDecoder,
    };
  } catch {
    // biome-ignore lint/style/useErrorCause: candidate module exceptions and Git errors are not public smoke evidence.
    throw new Error('Candidate protocol identity or module validation failed');
  }
}

interface Pose {
  readonly id: string;
  readonly sequence: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}
type Observation =
  | { readonly kind: 'joined'; readonly id: string }
  | {
      readonly kind: 'snapshot';
      readonly sequence: number;
      readonly own: Pose | null;
      readonly target: Pose | null;
    }
  | { readonly kind: 'other' };
type ObserverState =
  | { readonly kind: 'waiting'; readonly id: null; readonly ownPose: null; readonly pose: null }
  | {
      readonly kind: 'joined';
      readonly id: string;
      readonly ownPose: Pose | null;
      readonly pose: Pose | null;
    };

function observation(value: unknown, ownId: string | null, targetId: string | null): Observation {
  assert(record(value), 'Invalid candidate decoder result');
  if (value['kind'] === 'message') {
    const message = value['message'];
    assert(record(message), 'Invalid candidate control envelope');
    if (message['type'] !== 'joined') {
      return { kind: 'other' };
    }
    const data = message['data'];
    assert(
      record(data) &&
        typeof data['id'] === 'string' &&
        data['id'].length > 0 &&
        data['snapshotVersion'] === 3 &&
        data['asteroidInteractions'] === 1,
      'Invalid candidate joined identity'
    );
    return { kind: 'joined', id: data['id'] };
  }
  assert(value['kind'] === 'snapshot' && ownId !== null, 'Candidate snapshot was not accepted');
  const state = value['state'];
  const metadata = value['metadata'];
  assert(
    record(state) && Array.isArray(state['entities']) && record(metadata),
    'Invalid candidate snapshot observation'
  );
  const sequence = metadata['sequence'];
  assert(
    typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0,
    'Invalid candidate snapshot sequence'
  );
  let own: Pose | null = null;
  let target: Pose | null = null;
  for (const row of state['entities']) {
    if (!record(row) || (row['id'] !== ownId && row['id'] !== targetId)) {
      continue;
    }
    const position = row['position'];
    const angle = row['angle'];
    assert(
      record(position) &&
        typeof position['x'] === 'number' &&
        Number.isFinite(position['x']) &&
        typeof position['y'] === 'number' &&
        Number.isFinite(position['y']) &&
        typeof angle === 'number' &&
        Number.isFinite(angle) &&
        typeof row['id'] === 'string',
      'Invalid candidate identified pose'
    );
    const pose = { id: row['id'], sequence, x: position['x'], y: position['y'], angle };
    if (row['id'] === ownId) {
      assert(own === null, 'Duplicate candidate own identity');
      own = pose;
    }
    if (row['id'] === targetId) {
      assert(target === null, 'Duplicate candidate target identity');
      target = pose;
    }
  }
  return { kind: 'snapshot', sequence, own, target };
}

/** Bounded passive state; a retired socket cannot change the current two poses. */
export class CandidatePoseObserver {
  private generation = 0;
  private current: ObserverState = { kind: 'waiting', id: null, ownPose: null, pose: null };
  private readonly errors: string[] = [];

  constructor(
    private readonly settings: {
      readonly createDecoder: () => Decoder;
      readonly target: () => string | null;
    }
  ) {}

  get state(): ObserverState {
    return this.current;
  }
  get failures(): readonly string[] {
    return this.errors;
  }

  openSocket(): { receive(payload: unknown): void; close(): void } {
    const generation = ++this.generation;
    this.current = { kind: 'waiting', id: null, ownPose: null, pose: null };
    let decoder: Decoder;
    try {
      decoder = this.settings.createDecoder();
      decoder.reset();
    } catch {
      this.fail();
      return { receive() {}, close() {} };
    }
    return {
      receive: (payload) => {
        if (generation !== this.generation) {
          return;
        }
        try {
          assert(typeof payload === 'string');
          const result = observation(
            decoder.readMessage(payload, { acceptSnapshots: this.current.kind === 'joined' }),
            this.current.id,
            this.settings.target()
          );
          if (result.kind === 'joined') {
            decoder.reset();
            this.current = { kind: 'joined', id: result.id, ownPose: null, pose: null };
          } else if (result.kind === 'snapshot') {
            assert(this.current.kind === 'joined');
            this.current = {
              kind: 'joined',
              id: this.current.id,
              ownPose: result.own,
              pose: result.target,
            };
          }
        } catch {
          this.fail();
        }
      },
      close: () => {
        if (generation !== this.generation) {
          return;
        }
        this.generation++;
        this.current = { kind: 'waiting', id: null, ownPose: null, pose: null };
      },
    };
  }

  private fail(): void {
    if (this.errors.length < 50) {
      this.errors.push('Candidate protocol observation failed');
    }
  }
}
