import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  atomicReceipt,
  candidateMatches,
  digest,
  identity,
  RECEIPT_VERSION,
  readReusable,
  STAGES,
  sameIdentity,
} from './gate-receipt.mjs';
import { canonicalEnvironment, validationLaunch } from './gate-runtime.mjs';
import { literalOnlyChange } from './literal-only-change.mjs';
import { validateReviewReceipt } from './review-receipt.mjs';
import { runAdmitted, verifyChild } from './validation-admission.mjs';

function sourceTexts(root, rows) {
  return Object.fromEntries(
    rows
      .filter(
        ([name, record]) =>
          record !== null && record.mode !== '120000' && /\.(?:[cm]?js|tsx?)$/u.test(name)
      )
      .map(([name]) => [name, readFileSync(join(root, name)).toString('base64')])
  );
}
function graphEligible(old, current, texts) {
  if (
    !old ||
    !current.reusable ||
    old.identity.installation !== current.installation ||
    old.identity.runtime !== current.runtime ||
    old.identity.manifest !== current.manifest ||
    !old.graphWitness
  ) {
    return false;
  }
  if (
    JSON.stringify(old.identity.source.map(([name, record]) => [name, record?.mode])) !==
    JSON.stringify(current.source.map(([name, record]) => [name, record?.mode]))
  ) {
    return false;
  }
  const oldRows = new Map(old.identity.source);
  if (
    current.source.some(
      ([name, record]) =>
        (record?.mode === '120000' || !/\.(?:[cm]?js|tsx?)$/u.test(name)) &&
        JSON.stringify(oldRows.get(name)) !== JSON.stringify(record)
    )
  ) {
    return false;
  }
  const decode = (rows) =>
    Object.fromEntries(
      Object.entries(rows).map(([name, value]) => [name, Buffer.from(value, 'base64').toString()])
    );
  return literalOnlyChange(decode(old.sourceTexts), decode(texts));
}
function prepareTools({ root, environment }) {
  return spawnSync('bash', ['scripts/check-actions.sh'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}
async function runStage(command, args, { artifact, ...options }) {
  const output = openSync(artifact, 'w', 0o600);
  try {
    return await new Promise((accept) => {
      // Keep stages in the admission supervisor's process group for cancellation.
      const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      let error;
      child.once('error', (failure) => {
        error = failure;
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => writeSync(output, chunk));
        createInterface({ input: stream }).on('line', (line) => {
          if (
            /^(Waiting for heavy validation (?:admission,|ticket allocation:)|Heavy validation admitted,|Review artifacts:|Review exit )/u.test(
              line
            )
          ) {
            process.stderr.write(`${line}\n`);
          }
        });
      }
      child.once('close', (status, signal) => accept({ status, signal, error }));
    });
  } finally {
    closeSync(output);
  }
}
export async function runGate({
  root,
  environment = process.env,
  capture = identity,
  run = runStage,
  validateReview = validateReviewReceipt,
  prepare = prepareTools,
}) {
  const home = join(root, '.performance/gate');
  mkdirSync(home, { recursive: true });
  const receiptPath = join(home, 'receipt.json');
  // The canonical helper bootstraps pinned archives before installed identity.
  // Its ordinary manifest stage still runs and verifies those archive bytes.
  const preparationDirectory = mkdtempSync(join(home, 'prepare.'));
  const preparationArtifact = join(preparationDirectory, 'output.log');
  const preparation = prepare({ root, environment });
  writeFileSync(
    preparationArtifact,
    `${preparation.stdout ?? ''}${preparation.stderr ?? ''}\nexit_status=${preparation.status ?? 'none'} signal=${preparation.signal ?? 'none'} error=${preparation.error?.message ?? 'none'}\n`
  );
  if (preparation.status !== 0 || preparation.signal || preparation.error) {
    throw new Error(`Gate tool preparation failed; diagnostics: ${preparationArtifact}`);
  }
  const bootstrap = {
    command: ['bash', 'scripts/check-actions.sh'],
    success: true,
    artifact: preparationArtifact,
    digest: digest(readFileSync(preparationArtifact)),
  };
  const before = capture(root, environment);
  const candidate = candidateMatches(root, before.source);
  const cached = readReusable(receiptPath, before, candidate, validateReview);
  if (cached) {
    const final = capture(root, environment);
    if (!sameIdentity(before, final) || !final.reusable || !candidateMatches(root, final.source)) {
      throw new Error('Gate inputs changed during receipt validation');
    }
    process.stdout.write(
      'Complete gate receipt reused for exact source, installation, runtime and retained artifacts.\n'
    );
    return cached;
  }
  let prior = null;
  try {
    const old = JSON.parse(readFileSync(receiptPath, 'utf8'));
    // Graph witness still requires a fully validated old proof, including artifacts.
    prior = readReusable(receiptPath, old.identity, true, (path) =>
      validateReview(path, { checkCurrentSource: false })
    );
  } catch {
    /* First run, malformed proof, or missing artifact: run graphs. */
  }
  const texts = sourceTexts(root, before.source);
  // A commit changes the release stamp, not an already executed code check.
  // The one donor is a fully validated complete candidate proof, never a partial
  // or failed attempt. Every other source/install/runtime input must be exact.
  const buildOnly =
    prior?.candidateCertified === true &&
    candidate &&
    before.reusable &&
    prior.classifier?.kind === 'full' &&
    /^[a-f0-9]{40,64}$/u.test(before.buildHead ?? '') &&
    /^[a-f0-9]{40,64}$/u.test(prior.identity.buildHead ?? '') &&
    before.buildHead !== prior.identity.buildHead &&
    sameIdentity({ ...before, buildHead: prior.identity.buildHead }, prior.identity);
  const skipGraphs =
    !buildOnly &&
    before.buildHead === prior?.identity.buildHead &&
    graphEligible(prior, before, texts);
  const directory = mkdtempSync(join(home, 'run.'));
  writeFileSync(join(directory, 'identity-before.json'), `${JSON.stringify(before, null, 2)}\n`, {
    mode: 0o600,
  });
  // Per-input scope barriers survive interruption and unrelated attempts. A
  // newer code attempt invalidates older evidence before executing any stage.
  // Build-only retries retain the code proof and always execute the build.
  const scopes = join(home, 'code-attempts');
  mkdirSync(scopes, { recursive: true });
  const scope = digest(
    JSON.stringify([before.sourceDigest, before.installation, before.runtime, before.manifest])
  );
  const codeAttempt = buildOnly
    ? prior.codeAttempt
    : {
        path: join(scopes, `${scope}.json`),
        id: directory,
      };
  if (!buildOnly) {
    atomicReceipt(codeAttempt.path, { id: codeAttempt.id, identity: before, success: false });
  }
  let reviewReceipt = join(directory, 'review.json');
  let donorProof;
  let donorPath;
  if (buildOnly) {
    donorPath = join(directory, 'donor-receipt.json');
    atomicReceipt(donorPath, prior);
    donorProof = {
      receipt: donorPath,
      digest: digest(readFileSync(donorPath)),
      buildHead: prior.identity.buildHead,
    };
  }
  const stages = [];
  process.stdout.write(`Complete gate artifacts: ${directory}\n`);
  for (const [name, command] of STAGES) {
    if (buildOnly && command !== 'build') {
      const original = prior.stages.find((row) => row.command === command);
      stages.push({
        ...original,
        kind: 'head-reuse',
        provenance: original.provenance ?? donorProof,
      });
      if (command === 'test:review') {
        reviewReceipt = prior.reviewReceipt;
      }
      process.stdout.write(
        `Gate: ${name} reused for identical source/install/runtime; build HEAD changed.\n`
      );
      continue;
    }
    const artifact = join(directory, `${stages.length}-${command.replaceAll(':', '-')}.log`);
    const skipped = skipGraphs && ['check:knip', 'check:ts-prune'].includes(command);
    if (skipped) {
      writeFileSync(artifact, `Literal-only graph witness: ${prior.graphWitness}\n`);
    } else {
      process.stdout.write(`Gate: ${name}\n`);
      // Vite/Vitest honor this cache home; code integration owns its own
      // isolated artifact session.
      const sessionDirectory = join(directory, `session-${stages.length}`);
      mkdirSync(sessionDirectory);
      const result = await run('npm', ['run', command], {
        artifact,
        cwd: root,
        env: {
          ...environment,
          GEOROIDS_REVIEW_RECEIPT: reviewReceipt,
          GEOROIDS_TEST_SESSION_DIR: sessionDirectory,
          ...(command === 'check:test-runner'
            ? { GEOROIDS_CONTRACT_EVIDENCE_DIR: join(sessionDirectory, 'contracts') }
            : {}),
        },
      });
      if (result.status !== 0 || result.signal || result.error) {
        throw new Error(
          `Gate ${name} failed (${result.status ?? result.signal ?? result.error}); diagnostics: ${artifact}`
        );
      }
    }
    stages.push({
      name,
      command,
      success: true,
      kind: skipped ? 'literal-graph' : 'ran',
      artifact,
      digest: digest(readFileSync(artifact)),
    });
  }
  validateReview(reviewReceipt);
  const after = capture(root, environment);
  writeFileSync(join(directory, 'identity-after.json'), `${JSON.stringify(after, null, 2)}\n`, {
    mode: 0o600,
  });
  const changedComponents = [
    'sourceDigest',
    'installation',
    'runtime',
    'manifest',
    'buildHead',
    'reusable',
  ].filter((key) => before[key] !== after[key]);
  writeFileSync(
    join(directory, 'identity-diff.json'),
    `${JSON.stringify({ changedComponents }, null, 2)}\n`,
    { mode: 0o600 }
  );
  if (!sameIdentity(before, after)) {
    throw new Error(
      `Gate inputs changed while validating (${changedComponents.join(', ')}); diagnostics: ${directory}`
    );
  }
  if (buildOnly) {
    if (!candidateMatches(root, after.source)) {
      throw new Error('Candidate index changed during new-HEAD validation');
    }
    if (
      !readReusable(
        donorPath,
        { ...after, buildHead: prior.identity.buildHead },
        true,
        validateReview
      )
    ) {
      throw new Error('Complete donor evidence changed during new-HEAD validation');
    }
  }
  const receipt = {
    version: RECEIPT_VERSION,
    codeAttempt,
    success: true,
    cleanupSucceeded: true,
    bootstrap,
    identity: after,
    candidateCertified: candidate && candidateMatches(root, after.source),
    stages,
    reviewReceipt,
    reviewDigest: digest(readFileSync(reviewReceipt)),
    sourceTexts: texts,
    graphWitness: skipGraphs ? prior.graphWitness : after.sourceDigest,
    graphArtifacts: skipGraphs
      ? prior.graphArtifacts
      : stages
          .filter(({ command }) => ['check:knip', 'check:ts-prune'].includes(command))
          .map(({ command, artifact, digest: hash }) => ({
            command,
            artifact,
            digest: hash,
            witness: after.sourceDigest,
          })),
    classifier: {
      kind: skipGraphs ? 'literal-only' : 'full',
      witness: skipGraphs ? prior.graphWitness : null,
    },
  };
  if (!buildOnly) {
    atomicReceipt(codeAttempt.path, { id: codeAttempt.id, identity: after, success: true });
  }
  atomicReceipt(receiptPath, receipt);
  process.stdout.write(
    `Complete gate passed${receipt.candidateCertified ? '' : '; development proof only (candidate index differs)'}.\n`
  );
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    if (process.argv[2] === '--validation-child') {
      verifyChild(root, 'checkout');
      const env = canonicalEnvironment(root, process.env);
      process.env.PATH = env.PATH;
      process.env.FLEET_DOC_FAST = env.FLEET_DOC_FAST;
      for (const key of Object.keys(process.env)) {
        if (!Object.hasOwn(env, key)) {
          delete process.env[key];
        }
      }
      await runGate({ root });
    } else {
      const launch = await validationLaunch(root, process.env, fileURLToPath(import.meta.url));
      process.exitCode = await runAdmitted('checkout', launch.command, {
        root,
        environment: launch.environment,
      });
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
