import assert from 'node:assert/strict';

// The dedicated strict tooling-contract project admits these real JavaScript
// imports. Values still cross the checked unknown boundary below; legacy module
// bodies are not claimed to have TypeScript validation.
import { runGate as legacyRunGate } from '../gate.mjs';
import {
  candidateMatches as legacyCandidateMatches,
  digest as legacyDigest,
  fileRecord as legacyFileRecord,
  GRAPH_COMMANDS as legacyGraphCommands,
  identity as legacyIdentity,
  sourceRows as legacySourceRows,
  STAGES as legacyStages,
} from '../gate-receipt.mjs';
import {
  canonicalEnvironment as legacyCanonicalEnvironment,
  lifecycleCommand as legacyLifecycleCommand,
} from '../gate-runtime.mjs';
import { literalOnlyChange as legacyLiteralOnlyChange } from '../literal-only-change.mjs';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invoke(callable: unknown, name: string, args: unknown[]): unknown {
  assert.ok(typeof callable === 'function', `Missing JavaScript helper ${name}`);
  const result: unknown = Reflect.apply(callable, undefined, args);
  return result;
}

interface FileRecord {
  mode: string;
  digest: string;
}

function isFileRecord(value: unknown): value is FileRecord {
  return (
    isRecord(value) && typeof value['mode'] === 'string' && typeof value['digest'] === 'string'
  );
}

type SourceRows = [string, FileRecord][];

function isSourceRows(value: unknown): value is SourceRows {
  return (
    Array.isArray(value) &&
    value.every(
      (row: unknown) =>
        Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && isFileRecord(row[1])
    )
  );
}

export interface GateIdentity {
  source: SourceRows;
  sourceDigest: string;
  installation: string;
  runtime: string;
  buildHead: string | null;
  reusable: boolean;
  manifest: string;
  unknown?: string[];
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function isIdentity(value: unknown): value is GateIdentity {
  return (
    isRecord(value) &&
    isSourceRows(value['source']) &&
    ['sourceDigest', 'installation', 'runtime', 'manifest'].every(
      (key) => typeof value[key] === 'string'
    ) &&
    (value['buildHead'] === null || typeof value['buildHead'] === 'string') &&
    typeof value['reusable'] === 'boolean' &&
    (value['unknown'] === undefined || isStrings(value['unknown']))
  );
}

interface StageReceipt {
  command: string;
  kind: string;
  artifact: string;
  digest: string;
  provenance?: { receipt: string; digest: string; buildHead: string | null };
}

function isStage(value: unknown): value is StageReceipt {
  if (
    !isRecord(value) ||
    !['command', 'kind', 'artifact', 'digest'].every((key) => typeof value[key] === 'string')
  ) {
    return false;
  }
  const provenance = value['provenance'];
  return (
    provenance === undefined ||
    (isRecord(provenance) &&
      typeof provenance['receipt'] === 'string' &&
      typeof provenance['digest'] === 'string' &&
      (provenance['buildHead'] === null || typeof provenance['buildHead'] === 'string'))
  );
}

export interface GateReceipt {
  identity: GateIdentity;
  stages: StageReceipt[];
  reviewReceipt: string;
  candidateCertified: boolean;
  bootstrap: { artifact: string };
  graphArtifacts: { command: string; witness: string }[];
  classifier?: unknown;
  graphWitness?: string;
}

function isReceipt(value: unknown): value is GateReceipt {
  if (!isRecord(value)) {
    return false;
  }
  const stages: unknown = value['stages'];
  const bootstrap = value['bootstrap'];
  const graphArtifacts: unknown = value['graphArtifacts'];
  return (
    isIdentity(value['identity']) &&
    Array.isArray(stages) &&
    stages.every(isStage) &&
    typeof value['reviewReceipt'] === 'string' &&
    typeof value['candidateCertified'] === 'boolean' &&
    isRecord(bootstrap) &&
    typeof bootstrap['artifact'] === 'string' &&
    Array.isArray(graphArtifacts) &&
    graphArtifacts.every(
      (row: unknown) =>
        isRecord(row) && typeof row['command'] === 'string' && typeof row['witness'] === 'string'
    ) &&
    (value['graphWitness'] === undefined || typeof value['graphWitness'] === 'string')
  );
}

export function receipt(value: unknown): GateReceipt {
  assert.ok(isReceipt(value));
  return value;
}

interface StageResult {
  status: number | null;
  signal?: string | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
}

export type StageRunner = (
  command: string,
  args: [string, string],
  options: {
    artifact: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
) => StageResult | Promise<StageResult>;

interface GateOptions {
  root: string;
  capture: () => GateIdentity;
  run: StageRunner;
  validateReview: (path: string) => void;
  prepare?: () => StageResult;
  environment: NodeJS.ProcessEnv;
}

export async function runGate(options: GateOptions): Promise<GateReceipt> {
  return receipt(await invoke(legacyRunGate, 'runGate', [options]));
}

function stageList(value: unknown): [string, string][] {
  assert.ok(Array.isArray(value));
  assert.ok(
    value.every(
      (row: unknown): row is [string, string] =>
        Array.isArray(row) &&
        row.length === 2 &&
        row.every((item: unknown) => typeof item === 'string')
    )
  );
  return value;
}
// Keep the actual exported array: the mandatory-stage mutation must reach runGate.
export const STAGES = stageList(legacyStages);
const graphCommands: unknown = legacyGraphCommands;
assert.ok(isStrings(graphCommands));
export const GRAPH_COMMANDS = graphCommands;

export function digest(value: string | Buffer): string {
  const result = invoke(legacyDigest, 'digest', [value]);
  assert.ok(typeof result === 'string');
  return result;
}

export function fileRecord(path: string): FileRecord {
  const result = invoke(legacyFileRecord, 'fileRecord', [path]);
  assert.ok(isFileRecord(result));
  return result;
}

export function sourceRows(root: string): SourceRows {
  const result = invoke(legacySourceRows, 'sourceRows', [root]);
  assert.ok(isSourceRows(result));
  return result;
}

export function candidateMatches(root: string, rows: SourceRows): boolean {
  const result = invoke(legacyCandidateMatches, 'candidateMatches', [root, rows]);
  assert.ok(typeof result === 'boolean');
  return result;
}

export function identity(
  root: string,
  environment: NodeJS.ProcessEnv
): GateIdentity & { unknown: string[] } {
  const result = invoke(legacyIdentity, 'identity', [root, environment]);
  assert.ok(isIdentity(result) && isStrings(result.unknown));
  return { ...result, unknown: result.unknown };
}

export function canonicalEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const result = invoke(legacyCanonicalEnvironment, 'canonicalEnvironment', [root, environment]);
  assert.ok(isRecord(result));
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => {
      assert.ok(value === undefined || typeof value === 'string');
      return [key, value];
    })
  );
}

export function lifecycleCommand(
  root: string,
  environment: NodeJS.ProcessEnv,
  entry: string
): [string, ...string[]] {
  const result = invoke(legacyLifecycleCommand, 'lifecycleCommand', [root, environment, entry]);
  assert.ok(isStrings(result) && result.length > 0);
  const [command, ...args] = result;
  assert.ok(command !== undefined);
  return [command, ...args];
}

export function literalOnlyChange(
  before: Record<string, string>,
  after: Record<string, string>
): boolean {
  const result = invoke(legacyLiteralOnlyChange, 'literalOnlyChange', [before, after]);
  assert.ok(typeof result === 'boolean');
  return result;
}
