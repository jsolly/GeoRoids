import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  railwayCli,
  railwayTarget,
  readSnapshot,
  reviewPlanChanges,
  stableJson,
  VersionPinError,
} from './railway-version-pin.ts';

const volume = { id: 'a32aab03-3044-46a5-ba40-578f8c6d2129', name: 'world-data' };
const declared = ['volume.world-data', 'service.Georoids'];
const intendedOwner = '*';
type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function object(value: unknown): ObjectValue {
  if (!isObject(value)) {
    throw new VersionPinError('Ownership response must be an object; inventory unverified');
  }
  return value;
}
function onlyKeys(value: ObjectValue, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new VersionPinError('Ownership response has unsupported fields; inventory unverified');
  }
}
function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new VersionPinError('Ownership response is not JSON; inventory unverified', {
      cause: error,
    });
  }
}
function digest(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function connection(value: unknown, expected: { id: string; name: string }) {
  const result = object(value);
  onlyKeys(result, ['edges', 'pageInfo']);
  const page = object(result['pageInfo']);
  onlyKeys(page, ['hasNextPage']);
  if (page['hasNextPage'] !== false || !Array.isArray(result['edges'])) {
    throw new VersionPinError('Ownership resource mapping is incomplete');
  }
  const nodes = result['edges'].map((edge: unknown) => {
    const entry = object(edge);
    onlyKeys(entry, ['node']);
    const node = object(entry['node']);
    onlyKeys(node, ['id', 'name']);
    return node;
  });
  const matches = nodes.filter(
    (node) => node['id'] === expected.id || node['name'] === expected.name
  );
  if (
    matches.length !== 1 ||
    matches[0]?.['id'] !== expected.id ||
    matches[0]?.['name'] !== expected.name
  ) {
    throw new VersionPinError('Ownership resource identity differs from the reviewed target');
  }
  return { edges: result['edges'] };
}

/** v5.50.2 engine.rs::parse_owners accepts null as no owners. Missing is never authoritative. */
export function readOwnershipSnapshot(value: unknown) {
  const response = object(value);
  onlyKeys(response, ['data', 'errors']);
  if (
    response['errors'] !== undefined &&
    (!Array.isArray(response['errors']) || response['errors'].length !== 0)
  ) {
    throw new VersionPinError('Ownership query failed; owner map unavailable');
  }
  const data = object(response['data']);
  onlyKeys(data, ['environment', 'project', 'environmentStagedChanges', 'serviceInstance']);
  const environment = object(data['environment']);
  onlyKeys(environment, ['id', 'projectId', 'config', 'configEtag', 'iacPartials']);
  if (!Object.hasOwn(environment, 'iacPartials')) {
    throw new VersionPinError('Ownership map is missing; no empty-map fallback is allowed');
  }
  const owners = environment['iacPartials'] === null ? {} : object(environment['iacPartials']);
  if (
    Object.entries(owners).some(
      ([address, owner]) =>
        !declared.includes(address) ||
        typeof owner !== 'string' ||
        (owner !== intendedOwner && !/^[a-zA-Z0-9._-]{1,64}$/u.test(owner))
    )
  ) {
    throw new VersionPinError('Ownership map is malformed or exceeds the reviewed resource scope');
  }
  const project = object(data['project']);
  onlyKeys(project, ['id', 'services', 'volumes']);
  const services = connection(project['services'], {
    id: railwayTarget.service,
    name: railwayTarget.name,
  });
  connection(project['volumes'], volume);
  const config = object(environment['config']);
  const live = object(object(config['services'])[railwayTarget.service]);
  const mounts = object(live['volumeMounts']);
  const mount = object(mounts[volume.id]);
  const liveVolume = object(object(config['volumes'])[volume.id]);
  if (
    Object.keys(mounts).length !== 1 ||
    mount['mountPath'] !== '/data' ||
    liveVolume['isDeleted'] === true ||
    liveVolume['region'] !== 'iad' ||
    liveVolume['sizeMB'] !== 1024
  ) {
    throw new VersionPinError('Production volume or mount differs from the reviewed target');
  }
  const pin = readSnapshot({
    data: {
      environment: {
        id: environment['id'],
        projectId: environment['projectId'],
        config: environment['config'],
        configEtag: environment['configEtag'],
      },
      project: { id: project['id'], services },
      environmentStagedChanges: data['environmentStagedChanges'],
      serviceInstance: data['serviceInstance'],
    },
  });
  const ownership = declared.map((address) => {
    const owner = owners[address] ?? null;
    return {
      address,
      resourceId: address === 'service.Georoids' ? railwayTarget.service : volume.id,
      currentOwner: owner,
      intendedOwner,
      claimNeeded: owner !== intendedOwner,
    };
  });
  return {
    pin,
    ownership,
    // Retain only a digest of the complete masked config and owner map, never variable values.
    stateDigest: digest(stableJson({ config, owners, project })),
  };
}

type OwnershipSnapshot = ReturnType<typeof readOwnershipSnapshot>;
const planKeys = [
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
];
const operationKeys = [
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
];
function label(value: unknown, allowed: readonly string[]) {
  return typeof value === 'string' && allowed.includes(value) ? value : 'unrecognized';
}

/** Inventory first, classify second. A report has no application capability or admission authority. */
export function inspectOwnershipPlan(
  value: unknown,
  expected: { sourceTree: string; version: string; snapshot: OwnershipSnapshot }
) {
  const plan = object(value);
  onlyKeys(plan, planKeys);
  if (
    plan['kind'] !== 'railway.config.plan' ||
    plan['version'] !== 1 ||
    plan['cliVersion'] !== railwayCli.version ||
    plan['sourceTree'] !== expected.sourceTree ||
    plan['environmentId'] !== railwayTarget.environment ||
    plan['configEtag'] !== expected.snapshot.pin.etag ||
    typeof plan['destructive'] !== 'boolean' ||
    (plan['claim'] !== undefined && typeof plan['claim'] !== 'boolean') ||
    (plan['diff'] !== undefined && typeof plan['diff'] !== 'string')
  ) {
    throw new VersionPinError('Ownership plan identity is unsupported; inventory unverified');
  }
  const set = object(plan['changeSet']);
  onlyKeys(set, ['version', 'changes', 'diagnostics', 'declared', 'telemetry']);
  if (
    set['version'] !== 1 ||
    plan['changeSetHash'] !== digest(stableJson(set)) ||
    !isDeepStrictEqual(set['declared'], declared) ||
    !isDeepStrictEqual(set['telemetry'], { language: 'typescript' }) ||
    !Array.isArray(set['changes']) ||
    !Array.isArray(set['diagnostics']) ||
    set['changes'].length > 256
  ) {
    throw new VersionPinError('Ownership change set is unsupported; inventory unverified');
  }
  const operations = set['changes'].map((raw: unknown, index: number) => {
    const change = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    return {
      index,
      kind: label('kind' in change ? change.kind : undefined, [
        'resource.update',
        'resource.create',
        'resource.delete',
      ]),
      address: label('address' in change ? change.address : undefined, declared),
      field: label('field' in change ? change.field : undefined, [
        'build',
        'deploy',
        'source',
        'variables',
        'networking',
        'config',
        'volumeAttachments',
        'groupId',
      ]),
      unknownFieldCount: Object.keys(change).filter((key) => !operationKeys.includes(key)).length,
      values: 'withheld',
    };
  });
  let settings:
    | { status: 'pin-only'; change: ReturnType<typeof reviewPlanChanges> }
    | { status: 'outside-pin-policy' };
  try {
    settings = {
      status: 'pin-only',
      change: reviewPlanChanges(plan, {
        version: expected.version,
        snapshot: expected.snapshot.pin,
      }),
    };
  } catch (error) {
    if (!(error instanceof VersionPinError)) {
      throw error;
    }
    settings = { status: 'outside-pin-policy' };
  }
  const claim = plan['claim'] === true;
  const claimConsistent = claim === expected.snapshot.ownership.some((row) => row.claimNeeded);
  const foreignOwner = expected.snapshot.ownership.some(
    (row) => row.currentOwner !== null && row.currentOwner !== intendedOwner
  );
  return {
    outcome: 'ownership-plan-only',
    applicationEnabled: false,
    deploymentId: null,
    sourceTree: expected.sourceTree,
    configEtagDigest: digest(expected.snapshot.pin.etag),
    changeSetHash: digest(stableJson(set)),
    intendedOwner,
    ownership: expected.snapshot.ownership,
    claim,
    claimConsistent,
    foreignOwner,
    destructive: plan['destructive'],
    diagnosticCount: set['diagnostics'].length,
    operationCount: operations.length,
    operations,
    settings,
    liveApprovalReady: false,
    pinPolicyAccepted:
      !claim &&
      claimConsistent &&
      !foreignOwner &&
      plan['destructive'] === false &&
      set['diagnostics'].length === 0 &&
      settings.status === 'pin-only',
  };
}

const query = `query OwnershipPlanSnapshot($projectId: String!, $environmentId: String!, $serviceId: String!) {
  environment(id: $environmentId) { id projectId config(decryptVariables: false) configEtag iacPartials }
  project(id: $projectId) {
    id
    services(first: 1000) { edges { node { id name } } pageInfo { hasNextPage } }
    volumes(first: 1000) { edges { node { id name } } pageInfo { hasNextPage } }
  }
  environmentStagedChanges(environmentId: $environmentId) { id status patch(decryptVariables: false) }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { latestDeployment { id status } }
}`;

/** Fixed query and plan only. There is intentionally no apply flag, callback or command. */
export async function runOwnershipPlan({
  railway,
  planPath,
  readPlan,
  sourceTree,
  desiredVersion,
  assertSource,
  reportOwners,
}: {
  railway: (args: string[]) => Promise<string>;
  planPath: string;
  readPlan: () => Promise<string>;
  sourceTree: string;
  desiredVersion: string;
  assertSource: () => Promise<void>;
  reportOwners: (ownership: OwnershipSnapshot['ownership']) => void;
}) {
  const snapshot = async () =>
    readOwnershipSnapshot(
      parse(
        await railway([
          'api',
          query,
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
  reportOwners(before.ownership);
  await railway(['config', 'plan', '--json', '--out', planPath]);
  const saved = await readPlan();
  const receipt = inspectOwnershipPlan(parse(saved), {
    sourceTree,
    version: desiredVersion,
    snapshot: before,
  });
  const after = await snapshot();
  await assertSource();
  if (!isDeepStrictEqual(before, after) || (await readPlan()) !== saved) {
    throw new VersionPinError('Source, provider or saved plan changed; inventory unverified');
  }
  return { ...receipt, artifactDigest: digest(saved), stabilityVerified: true };
}
