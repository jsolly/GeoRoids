import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative as relativePath, resolve, sep } from 'node:path';
import process from 'node:process';
import { receiptEnvironment } from './validation-admission.mjs';

export const RECEIPT_VERSION = 2;
export const STAGES = [
  ['lint policy', 'check:lint-policy'],
  ['lint', 'check:lint'],
  ['knip', 'check:knip'],
  ['ts-prune', 'check:ts-prune'],
  ['markdown lint', 'check:md'],
  ['yaml lint', 'check:yaml'],
  ['actionlint', 'check:actions'],
  ['test runner contract', 'check:test-runner'],
  ['dev server contract', 'check:dev-server'],
  ['tsc', 'check:ts'],
  ['benchmark tsc', 'check:benchmarks'],
  ['vitest', 'test'],
  ['build', 'build'],
  ['review', 'test:review'],
];
export const digest = (value) => createHash('sha256').update(value).digest('hex');
const jsonDigest = (value) => digest(JSON.stringify(value));
function git(root, args) {
  // Git reads indexed assets as well as metadata. Their size is already bounded
  // by Node's Buffer limit, not spawnSync's unrelated default 1 MiB pipe cap.
  const result = spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: Infinity });
  if (result.status !== 0 || result.error || result.signal) {
    const diagnostic = result.stderr?.toString().trim().slice(0, 2048) || 'no stderr';
    throw new Error(
      `git ${args[0]} failed (exit=${result.status ?? 'none'}, signal=${result.signal ?? 'none'}, error=${result.error?.code ?? 'none'}): ${diagnostic}`
    );
  }
  return result.stdout;
}
function buildHead(root) {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status === 0 && /^[a-f0-9]{40,64}\n?$/u.test(head.stdout)) {
    return head.stdout.trim();
  }
  // An unborn symbolic branch is expected in private fixtures. Corrupt/detached
  // HEADs and repository errors are not an unborn repository.
  const branch = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (branch.status !== 0 || !branch.stdout.startsWith('refs/heads/')) {
    throw new Error('Cannot identify build HEAD');
  }
  const reference = spawnSync('git', ['show-ref', '--verify', '--quiet', branch.stdout.trim()], {
    cwd: root,
    encoding: 'utf8',
  });
  if (reference.status !== 1 || reference.signal || reference.error) {
    throw new Error('Cannot identify build HEAD');
  }
  return null;
}
export function fileRecord(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return { mode: '120000', digest: digest(readlinkSync(path)) };
  }
  if (!stat.isFile()) {
    throw new Error(`Unsupported input: ${path}`);
  }
  return { mode: stat.mode & 0o111 ? '100755' : '100644', digest: digest(readFileSync(path)) };
}
function walk(path, prefix = '', inventoryBoundary = null) {
  if (!existsSync(path)) {
    return [];
  }
  if (inventoryBoundary === null) {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error('Unsupported installed inventory root link');
    }
  }
  const boundary = inventoryBoundary ?? realpathSync(path);
  const rows = [];
  for (const name of readdirSync(path).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    // Only actionlint's per-run extraction directory is generated scratch.
    if (/^\.cache\/check-actions\/run\.[^/]+(?:\/|$)/u.test(relative)) {
      continue;
    }
    const absolute = join(path, name);
    if (lstatSync(absolute).isDirectory()) {
      rows.push(...walk(absolute, relative, boundary));
    } else {
      if (lstatSync(absolute).isSymbolicLink()) {
        const target = realpathSync(absolute);
        if (lstatSync(target).isDirectory()) {
          const targetRelative = relativePath(boundary, target);
          if (
            (target !== boundary && !target.startsWith(`${boundary}${sep}`)) ||
            /^\.cache\/check-actions\/run\.[^/]+(?:\/|$)/u.test(targetRelative)
          ) {
            throw new Error(`Unsupported installed directory link: ${relative}`);
          }
          // Internal aliases (including links back to an ancestor) are recorded
          // without traversal. Their canonical target is inventoried once by
          // the ordinary directory walk, so aliases cannot introduce cycles.
          rows.push([
            relative,
            { link: fileRecord(absolute), resolved: target, kind: 'internal-directory-alias' },
          ]);
          continue;
        }
        if (!lstatSync(target).isFile()) {
          throw new Error(`Unsupported installed link: ${relative}`);
        }
        rows.push([
          relative,
          { link: fileRecord(absolute), resolved: target, payload: fileRecord(target) },
        ]);
        continue;
      }
      rows.push([relative, fileRecord(absolute)]);
    }
  }
  return rows;
}
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
export function sourceRows(root) {
  const names = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString()
    .split('\0')
    .filter(Boolean);
  return [...new Set(names)]
    .sort()
    .filter((name) => present(join(root, name)))
    .map((name) => [name, fileRecord(join(root, name))]);
}
export function candidateMatches(root, rows) {
  const indexed = git(root, ['ls-files', '-s', '-z']).toString().split('\0').filter(Boolean);
  const map = new Map();
  for (const row of indexed) {
    const [meta, name] = row.split('\t');
    const [mode, hash, stage] = meta.split(' ');
    if (stage !== '0') {
      return false;
    }
    map.set(name, { mode, digest: digest(git(root, ['cat-file', 'blob', hash])) });
  }
  return (
    rows.every(
      ([name, record]) => JSON.stringify(record) === JSON.stringify(map.get(name) ?? null)
    ) && [...map.keys()].every((name) => rows.some(([path]) => path === name))
  );
}
function executable(name, env) {
  if (name === 'node') {
    return realpathSync(process.execPath);
  }
  for (const directory of (env.PATH ?? '').split(':')) {
    const path = join(directory, name);
    if (existsSync(path)) {
      return realpathSync(path);
    }
  }
  throw new Error(`Missing runtime ${name}`);
}
function consumedFile(path) {
  if (!present(path)) {
    return null;
  }
  const resolved = realpathSync(path);
  return { link: fileRecord(path), payload: fileRecord(resolved), resolved };
}
export function identity(root, inputEnvironment = process.env) {
  const env = receiptEnvironment(root, inputEnvironment);
  const source = sourceRows(root);
  const runtimes = ['node', 'npm', 'bash', 'git', 'uvx'].map((name) => {
    const path = executable(name, env);
    return [name, path, fileRecord(path)];
  });
  const allowed = new Set([
    'NODE_ENV',
    'NODE_OPTIONS',
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'CI',
    'GEOROIDS_SERVER_ENV_FILE',
    'DOTAGENTS_GATE_LIB',
    'FLEET_DOC_FAST',
    'VERCEL_GIT_COMMIT_SHA',
    'RAILWAY_GIT_COMMIT_SHA',
    // npm supplies these for every npm-run child; values still enter the digest.
    'npm_config_user_agent',
    'npm_config_local_prefix',
    'npm_config_userconfig',
    'npm_config_globalconfig',
    'npm_config_prefix',
    'npm_config_cache',
    'npm_config_node_gyp',
    'npm_config_npm_version',
    'npm_config_global_prefix',
    'npm_config_init_module',
    'npm_config_allow_scripts',
    'npm_config_noproxy',
    'npm_config_yes',
    'npm_config_loglevel',
  ]);
  const relevant = Object.keys(env)
    .filter(
      (key) =>
        allowed.has(key) ||
        /^(?:BIOME_|VITE_|GEOROIDS_|NODE_|NPM_CONFIG_|npm_config_|TSX_|VITEST_|BASH_ENV$|ENV$)/u.test(
          key
        )
    )
    .sort();
  const unknown = relevant.filter((key) => !allowed.has(key));
  const environment = relevant.map((key) => [key, digest(env[key] ?? '')]);
  const ignoredInputs = readdirSync(root)
    .filter((name) => /^\.env(?:\.|$)/u.test(name))
    .sort()
    .map((name) => [name, consumedFile(join(root, name))]);
  if (env.GEOROIDS_SERVER_ENV_FILE) {
    ignoredInputs.push([
      'selected-server-env',
      consumedFile(resolve(root, env.GEOROIDS_SERVER_ENV_FILE)),
    ]);
  }
  // Ask the actual npm CLI for selected/default configuration homes, rather
  // than guessing a prefix from a separately installed Node executable.
  const npmConfig = spawnSync(
    process.execPath,
    [executable('npm', env), 'config', 'get', 'userconfig', 'globalconfig'],
    { cwd: root, env, encoding: 'utf8' }
  );
  if (npmConfig.status !== 0 || npmConfig.error || npmConfig.signal) {
    throw new Error('Cannot identify actual npm configuration');
  }
  const selections = npmConfig.stdout.trim().split('\n');
  if (
    selections.length !== 2 ||
    !selections[0].startsWith('userconfig=') ||
    !selections[1].startsWith('globalconfig=')
  ) {
    throw new Error('Unsupported npm configuration identity');
  }
  const npmConfigs = [
    ...selections.map((line) => line.slice(line.indexOf('=') + 1)),
    join(root, '.npmrc'),
  ].map((path) => [resolve(root, path), consumedFile(resolve(root, path))]);
  const installation = jsonDigest(walk(join(root, 'node_modules')));
  const runtime = jsonDigest({
    runtimes,
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    environment,
    ignoredInputs,
    sourceLinkInputs: source
      .filter(([, record]) => record.mode === '120000')
      .map(([name]) => [name, consumedFile(join(root, name))]),
    npmConfigs,
  });
  return {
    source,
    sourceDigest: jsonDigest(source),
    buildHead: buildHead(root),
    installation,
    runtime,
    reusable: unknown.length === 0,
    unknown,
    manifest: jsonDigest(STAGES),
  };
}
export function sameIdentity(a, b) {
  return ['sourceDigest', 'installation', 'runtime', 'manifest', 'buildHead'].every(
    (key) => a[key] === b[key]
  );
}
export function readReusable(path, current, candidate, validateReview, ancestors = new Set()) {
  try {
    const location = resolve(path);
    if (ancestors.has(location)) {
      return null;
    }
    const lineage = new Set([...ancestors, location]);
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (
      receipt.version !== RECEIPT_VERSION ||
      receipt.success !== true ||
      receipt.cleanupSucceeded !== true ||
      !(
        receipt.identity?.buildHead === null ||
        /^[a-f0-9]{40,64}$/u.test(receipt.identity?.buildHead ?? '')
      ) ||
      !current.reusable ||
      !sameIdentity(receipt.identity, current) ||
      !candidate
    ) {
      return null;
    }
    const attempt = JSON.parse(readFileSync(receipt.codeAttempt.path, 'utf8'));
    if (
      typeof receipt.codeAttempt.id !== 'string' ||
      attempt.id !== receipt.codeAttempt.id ||
      attempt.success !== true ||
      !sameIdentity({ ...attempt.identity, buildHead: current.buildHead }, current)
    ) {
      return null;
    }
    if (
      receipt.bootstrap?.success !== true ||
      JSON.stringify(receipt.bootstrap.command) !==
        JSON.stringify(['bash', 'scripts/check-actions.sh']) ||
      digest(readFileSync(receipt.bootstrap.artifact)) !== receipt.bootstrap.digest
    ) {
      return null;
    }
    if (
      JSON.stringify(receipt.stages.map(({ name, command }) => [name, command])) !==
      JSON.stringify(STAGES)
    ) {
      return null;
    }
    if (
      receipt.stages.some(
        (stage) =>
          stage.success !== true ||
          !['ran', 'literal-graph', 'head-reuse'].includes(stage.kind) ||
          !stage.artifact ||
          digest(readFileSync(stage.artifact)) !== stage.digest
      )
    ) {
      return null;
    }
    const donors = new Map();
    for (const stage of receipt.stages) {
      if (stage.kind !== 'head-reuse') {
        if (stage.provenance !== undefined) {
          return null;
        }
        continue;
      }
      const proof = stage.provenance;
      if (
        stage.command === 'build' ||
        !proof ||
        !/^[a-f0-9]{40,64}$/u.test(proof.buildHead) ||
        typeof proof.receipt !== 'string' ||
        digest(readFileSync(proof.receipt)) !== proof.digest
      ) {
        return null;
      }
      let donor = donors.get(proof.receipt);
      if (!donor) {
        donor = readReusable(
          proof.receipt,
          { ...current, buildHead: proof.buildHead },
          true,
          validateReview,
          lineage
        );
        if (donor?.candidateCertified !== true || donor.classifier?.kind !== 'full') {
          return null;
        }
        donors.set(proof.receipt, donor);
      }
      const original = donor.stages.find((row) => row.command === stage.command);
      if (
        !original ||
        original.name !== stage.name ||
        original.kind !== 'ran' ||
        original.artifact !== stage.artifact ||
        original.digest !== stage.digest
      ) {
        return null;
      }
    }
    const graphCommands = ['check:knip', 'check:ts-prune'];
    const skipped = receipt.stages.filter((stage) => stage.kind === 'literal-graph');
    if (
      typeof receipt.candidateCertified !== 'boolean' ||
      !/^[a-f0-9]{64}$/u.test(receipt.graphWitness)
    ) {
      return null;
    }
    if (skipped.length === 0) {
      if (
        receipt.classifier?.kind !== 'full' ||
        receipt.classifier.witness !== null ||
        receipt.graphWitness !== receipt.identity.sourceDigest
      ) {
        return null;
      }
    } else {
      if (
        JSON.stringify(skipped.map((stage) => stage.command)) !== JSON.stringify(graphCommands) ||
        receipt.classifier?.kind !== 'literal-only' ||
        receipt.classifier.witness !== receipt.graphWitness
      ) {
        return null;
      }
    }
    if (
      !Array.isArray(receipt.graphArtifacts) ||
      receipt.graphArtifacts.length !== 2 ||
      JSON.stringify(receipt.graphArtifacts.map((row) => row.command)) !==
        JSON.stringify(graphCommands) ||
      receipt.graphArtifacts.some((row) => row.witness !== receipt.graphWitness) ||
      receipt.graphArtifacts.some((row) => digest(readFileSync(row.artifact)) !== row.digest)
    ) {
      return null;
    }
    if (
      skipped.length === 0 &&
      receipt.graphArtifacts.some((row) => {
        const stage = receipt.stages.find((entry) => entry.command === row.command);
        return stage.artifact !== row.artifact || stage.digest !== row.digest;
      })
    ) {
      return null;
    }
    const codeRows = receipt.identity.source.filter(
      ([name, record]) => record && record.mode !== '120000' && /\.(?:[cm]?js|tsx?)$/u.test(name)
    );
    if (
      !receipt.sourceTexts ||
      Object.keys(receipt.sourceTexts).length !== codeRows.length ||
      codeRows.some(
        ([name, record]) =>
          typeof receipt.sourceTexts[name] !== 'string' ||
          digest(Buffer.from(receipt.sourceTexts[name], 'base64')) !== record.digest
      )
    ) {
      return null;
    }
    validateReview(receipt.reviewReceipt);
    if (digest(readFileSync(receipt.reviewReceipt)) !== receipt.reviewDigest) {
      return null;
    }
    return receipt;
  } catch {
    return null;
  }
}
export function atomicReceipt(path, receipt) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
