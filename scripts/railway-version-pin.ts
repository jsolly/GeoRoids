import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** Only fixed local policy messages may cross the workflow logging boundary. */
export class VersionPinError extends Error {}

export const railwayTarget = Object.freeze({
  project: '08a7b6ee-af66-4c58-a21e-700d5468ee14',
  environment: '94d3de2f-4bb0-4051-8975-a30190c2fffa',
  service: '4e2cb2a2-c1e2-41a8-a970-3f60659c2524',
  name: 'Georoids',
});
export const railwayCli = Object.freeze({
  version: '5.50.2',
  archiveSha256: '16a3ead7ce37fcdd2349f27a26d56b4914e47d6c6b83bd416e218d6afa680960',
  binarySha256: 'b0919b175c72cd829f9124caa9cf6d1a116741d847ef7be72abed14c70d3f43a',
});

type RecordValue = Record<string, unknown>;
type Build = { builder: 'RAILPACK'; buildEnvironment: 'V3'; railpackVersion: string | undefined };
type Snapshot = { etag: string; build: Build; deployment: { id: string; status: string } | null };
type Review = { kind: 'noop' } | { kind: 'pin'; previous: string | undefined; version: string };
type Receipt = { change: Review['kind']; version: string } & (
  | { outcome: 'plan-only'; deploymentId: null }
  | { outcome: 'verified'; deploymentId: string }
);

/** Parse CLI/workflow mode once; environment text is never forwarded into a shell. */
export function selectMode({
  args,
  workflowMode,
}: {
  args: readonly string[];
  workflowMode: unknown;
}): 'plan-only' | 'apply' {
  const [mode] = args;
  if (args.length !== 1) {
    throw new VersionPinError('Choose --plan-only, --apply or --workflow-mode');
  }
  switch (mode) {
    case '--plan-only':
      return 'plan-only';
    case '--apply':
      return 'apply';
    case '--workflow-mode':
      if (workflowMode === 'plan-only' || workflowMode === 'apply') {
        return workflowMode;
      }
      throw new VersionPinError('Workflow mode must be plan-only or apply');
    default:
      throw new VersionPinError('Choose --plan-only, --apply or --workflow-mode');
  }
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown): RecordValue {
  if (!isRecord(value)) {
    throw new VersionPinError('Railway response must be an object');
  }
  return value;
}
function keys(value: RecordValue, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new VersionPinError('Railway response has an unreviewed field');
  }
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VersionPinError('Railway response is missing required text');
  }
  return value;
}
function version(value: unknown): string {
  const result = text(value);
  if (!/^\d+\.\d+\.\d+$/u.test(result)) {
    throw new VersionPinError('Railpack pin must be a release version');
  }
  return result;
}
function build(value: unknown): Build {
  const result = record(value);
  keys(result, ['builder', 'buildEnvironment', 'railpackVersion']);
  if (result['builder'] !== 'RAILPACK' || result['buildEnvironment'] !== 'V3') {
    throw new VersionPinError('Only the reviewed RAILPACK/V3 build is allowed');
  }
  return {
    builder: result['builder'],
    buildEnvironment: result['buildEnvironment'],
    railpackVersion:
      result['railpackVersion'] === undefined ? undefined : version(result['railpackVersion']),
  };
}
function jsonData(value: unknown): RecordValue {
  const envelope = record(value);
  keys(envelope, ['data', 'errors']);
  if (
    envelope['errors'] !== undefined &&
    (!Array.isArray(envelope['errors']) || envelope['errors'].length !== 0)
  ) {
    throw new VersionPinError('Railway query failed');
  }
  return record(envelope['data']);
}

/** Parse the pinned CLI's environment/project/staged/latest-deployment query. Never retain variables. */
export function readSnapshot(value: unknown): Snapshot {
  const data = jsonData(value);
  keys(data, ['environment', 'project', 'environmentStagedChanges', 'serviceInstance']);
  if (data['environmentStagedChanges'] !== null) {
    throw new VersionPinError('Existing staged Railway work blocks automation');
  }
  const environment = record(data['environment']);
  keys(environment, ['id', 'projectId', 'config', 'configEtag']);
  if (
    environment['id'] !== railwayTarget.environment ||
    environment['projectId'] !== railwayTarget.project
  ) {
    throw new VersionPinError('Railway target does not match production');
  }
  const project = record(data['project']);
  keys(project, ['id', 'services']);
  if (project['id'] !== railwayTarget.project) {
    throw new VersionPinError('Railway project does not match production');
  }
  const services = record(project['services']);
  keys(services, ['edges']);
  if (!Array.isArray(services['edges'])) {
    throw new VersionPinError('Railway services are missing');
  }
  const matches = services['edges']
    .map((edge: unknown) => record(record(edge)['node']))
    .filter((node) => node['id'] === railwayTarget.service);
  const [service] = matches;
  if (matches.length !== 1 || !service || service['name'] !== railwayTarget.name) {
    throw new VersionPinError('Production service identity differs from the reviewed IaC address');
  }
  const config = record(environment['config']);
  const live = record(record(config['services'])[railwayTarget.service]);
  if (live['isDeleted'] === true) {
    throw new VersionPinError('Production service is deleted');
  }
  const instance = record(data['serviceInstance']);
  keys(instance, ['latestDeployment']);
  let deployment: Snapshot['deployment'] = null;
  if (instance['latestDeployment'] !== null) {
    const latest = record(instance['latestDeployment']);
    keys(latest, ['id', 'status']);
    deployment = { id: text(latest['id']), status: text(latest['status']) };
  }
  return { etag: text(environment['configEtag']), build: build(live['build']), deployment };
}

/** Match Rust stable_stringify's recursively sorted JSON object keys. */
export function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'number'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const object = record(value);
  return `{${Object.keys(object)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

/** Validate the actual v5.50.2 saved artifact, including whole-field before/after payloads. */
export function reviewPlan(
  value: unknown,
  expected: { sourceTree: string; version: string; snapshot: Snapshot }
): Review {
  const plan = record(value);
  keys(plan, [
    'kind',
    'version',
    'cliVersion',
    'sourceTree',
    'environmentId',
    'configEtag',
    'changeSetHash',
    'changeSet',
    'diff',
    'destructive',
    'claim',
  ]);
  if (
    plan['kind'] !== 'railway.config.plan' ||
    plan['version'] !== 1 ||
    plan['cliVersion'] !== railwayCli.version ||
    plan['sourceTree'] !== expected.sourceTree ||
    plan['environmentId'] !== railwayTarget.environment ||
    plan['configEtag'] !== expected.snapshot.etag ||
    plan['destructive'] !== false ||
    (plan['claim'] !== undefined && plan['claim'] !== false)
  ) {
    throw new VersionPinError(
      'Saved Railway plan identity, source or etag differs from the reviewed target'
    );
  }
  if (plan['diff'] !== undefined && typeof plan['diff'] !== 'string') {
    throw new VersionPinError('Saved Railway plan diff has an unsupported shape');
  }
  const set = record(plan['changeSet']);
  keys(set, ['version', 'changes', 'diagnostics', 'declared', 'telemetry']);
  const hash = `sha256:${createHash('sha256').update(stableJson(set)).digest('hex')}`;
  if (plan['changeSetHash'] !== hash) {
    throw new VersionPinError('Saved Railway plan hash does not match');
  }
  if (
    set['version'] !== 1 ||
    !Array.isArray(set['changes']) ||
    !Array.isArray(set['diagnostics']) ||
    set['diagnostics'].length !== 0
  ) {
    throw new VersionPinError('Railway change set is unsupported or has diagnostics');
  }
  if (
    !isDeepStrictEqual(set['declared'], ['volume.world-data', 'service.Georoids']) ||
    !isDeepStrictEqual(set['telemetry'], { language: 'typescript' })
  ) {
    throw new VersionPinError('Railway ownership or authoring contract changed');
  }
  const desired = version(expected.version);
  if (set['changes'].length === 0) {
    if (expected.snapshot.build.railpackVersion !== desired) {
      throw new VersionPinError('Empty plan does not establish the reviewed pin');
    }
    return { kind: 'noop' };
  }
  if (set['changes'].length !== 1) {
    throw new VersionPinError('Only one Railpack pin change is allowed');
  }
  const change = record(set['changes'][0]);
  keys(change, [
    'kind',
    'address',
    'field',
    'before',
    'after',
    'path',
    'summary',
    'severity',
    'deployEffect',
    'details',
  ]);
  if (
    change['kind'] !== 'resource.update' ||
    change['address'] !== `service.${railwayTarget.name}` ||
    change['field'] !== 'build' ||
    change['path'] !== `resources.service.${railwayTarget.name}.build` ||
    change['severity'] !== 'safe' ||
    change['deployEffect'] !== 'deploy'
  ) {
    throw new VersionPinError('Railway plan contains a change outside the version-pin policy');
  }
  text(change['summary']);
  const before = build(change['before']);
  const after = build(change['after']);
  if (
    !isDeepStrictEqual(change['details'], [
      `build.railpackVersion (${JSON.stringify(before.railpackVersion ?? null)} → ${JSON.stringify(desired)})`,
    ])
  ) {
    throw new VersionPinError('Railway plan details differ from the reviewed leaf change');
  }
  if (
    !isDeepStrictEqual(before, expected.snapshot.build) ||
    before.railpackVersion === desired ||
    !isDeepStrictEqual({ ...expected.snapshot.build, railpackVersion: desired }, after)
  ) {
    throw new VersionPinError('Railway plan changes more than the reviewed Railpack version');
  }
  return { kind: 'pin', previous: before.railpackVersion, version: desired };
}

const snapshotQuery = `query VersionPinSnapshot($projectId: String!, $environmentId: String!, $serviceId: String!) {
  environment(id: $environmentId) { id projectId config(decryptVariables: false) configEtag }
  project(id: $projectId) { id services(first: 1000) { edges { node { id name } } } }
  environmentStagedChanges(environmentId: $environmentId) { id status }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { latestDeployment { id status } }
}`;
const deploymentQuery =
  'query VersionPinDeployment($id: String!) { deployment(id: $id) { status } }';
type Transport = (args: string[]) => Promise<string>;
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new VersionPinError('Railway returned malformed JSON', { cause: error });
  }
}
function appliedDeployment(value: unknown): string {
  const result = record(value);
  keys(result, ['id', 'status', 'deploymentId', 'stagedPatchId', 'diagnostics', 'changes']);
  if (
    result['status'] !== 'applied' ||
    result['stagedPatchId'] !== null ||
    !Array.isArray(result['diagnostics']) ||
    result['diagnostics'].length !== 0 ||
    !Array.isArray(result['changes']) ||
    result['changes'].length !== 1
  ) {
    throw new VersionPinError('Railway did not prove a completed unstaged apply');
  }
  text(result['id']);
  const [entry] = result['changes'];
  const change = record(entry);
  keys(change, ['kind', 'path', 'summary', 'status', 'outputs']);
  if (
    change['kind'] !== 'resource.update' ||
    change['status'] !== 'applied' ||
    change['path'] !== `resources.service.${railwayTarget.name}.build`
  ) {
    throw new VersionPinError('Railway apply operation did not complete');
  }
  return text(result['deploymentId']);
}

/** The sole owner of plan -> guarded exact apply -> actual readback/build/smoke sequencing. */
export async function runVersionPin({
  railway,
  planPath,
  readPlan,
  sourceTree,
  desiredVersion,
  apply,
  assertSource,
  sleep,
  smoke,
}: {
  railway: Transport;
  planPath: string;
  readPlan: () => Promise<string>;
  sourceTree: string;
  desiredVersion: string;
  apply: boolean;
  assertSource: () => Promise<void>;
  sleep: () => Promise<unknown>;
  smoke: () => Promise<void>;
}): Promise<Receipt> {
  const snapshot = async () =>
    readSnapshot(
      parseJson(
        await railway([
          'api',
          snapshotQuery,
          '--variables',
          JSON.stringify({
            projectId: railwayTarget.project,
            environmentId: railwayTarget.environment,
            serviceId: railwayTarget.service,
          }),
          '--compact',
        ])
      )
    );
  await assertSource();
  const before = await snapshot();
  await railway(['config', 'plan', '--json', '--out', planPath]);
  const saved = await readPlan();
  const review = reviewPlan(parseJson(saved), {
    sourceTree,
    version: desiredVersion,
    snapshot: before,
  });
  const unchanged = await snapshot();
  if (unchanged.etag !== before.etag || !isDeepStrictEqual(unchanged.build, before.build)) {
    throw new VersionPinError('Railway changed while the saved plan was reviewed');
  }
  if (!apply) {
    return {
      outcome: 'plan-only',
      change: review.kind,
      version: desiredVersion,
      deploymentId: null,
    };
  }
  await assertSource();
  if ((await readPlan()) !== saved) {
    throw new VersionPinError('Saved Railway plan bytes changed before apply');
  }
  const deploymentId =
    review.kind === 'pin'
      ? appliedDeployment(
          parseJson(await railway(['config', 'apply', '--plan', planPath, '--yes', '--json']))
        )
      : before.deployment?.id;
  if (deploymentId === undefined) {
    throw new VersionPinError('Railway supplied no deployment to verify');
  }
  let succeeded = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = jsonData(
      parseJson(
        await railway([
          'api',
          deploymentQuery,
          '--variables',
          JSON.stringify({ id: deploymentId }),
          '--compact',
        ])
      )
    );
    keys(result, ['deployment']);
    const deployment = record(result['deployment']);
    keys(deployment, ['status']);
    const status = deployment['status'];
    if (status === 'SUCCESS') {
      succeeded = true;
      break;
    }
    if (!['INITIALIZING', 'BUILDING', 'DEPLOYING', 'QUEUED', 'WAITING'].includes(text(status))) {
      throw new VersionPinError('Railway deployment did not succeed');
    }
    await sleep();
  }
  if (!succeeded) {
    throw new VersionPinError('Railway deployment verification timed out');
  }
  const after = await snapshot();
  if (
    after.build.railpackVersion !== desiredVersion ||
    after.deployment?.id !== deploymentId ||
    after.deployment.status !== 'SUCCESS'
  ) {
    throw new VersionPinError('Production readback does not prove the pin and deployment');
  }
  const logs = await railway([
    'logs',
    deploymentId,
    '--build',
    '--json',
    '--lines',
    '1000',
    '--project',
    railwayTarget.project,
    '--environment',
    railwayTarget.environment,
    '--service',
    railwayTarget.service,
  ]);
  const drivers = logs
    .trim()
    .split('\n')
    .map((line) => record(parseJson(line))['message'])
    .filter((message): message is string => typeof message === 'string')
    .flatMap((message) =>
      [...message.matchAll(/using build driver railpack-v(\d+\.\d+\.\d+)/gu)].map(
        (match) => match[1]
      )
    );
  if (drivers.length === 0 || drivers.some((driver) => driver !== desiredVersion)) {
    throw new VersionPinError(
      'Deployment build driver does not prove the reviewed Railpack version'
    );
  }
  await smoke();
  const final = await snapshot();
  if (
    final.build.railpackVersion !== desiredVersion ||
    final.deployment?.id !== deploymentId ||
    final.deployment.status !== 'SUCCESS'
  ) {
    throw new VersionPinError('Production changed during the smoke verification');
  }
  return { outcome: 'verified', change: review.kind, version: desiredVersion, deploymentId };
}
