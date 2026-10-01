import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
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
import { literalOnlyChange } from './literal-only-change.mjs';
import { validateReviewReceipt } from './review-receipt.mjs';

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
export function runGate({
  root,
  environment = process.env,
  capture = identity,
  run = spawnSync,
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
  const skipGraphs = graphEligible(prior, before, texts);
  const directory = mkdtempSync(join(home, 'run.'));
  writeFileSync(join(directory, 'identity-before.json'), `${JSON.stringify(before, null, 2)}\n`, {
    mode: 0o600,
  });
  const reviewReceipt = join(directory, 'review.json');
  const stages = [];
  process.stdout.write(`Complete gate artifacts: ${directory}\n`);
  for (const [name, command] of STAGES) {
    const artifact = join(directory, `${stages.length}-${command.replaceAll(':', '-')}.log`);
    const skipped = skipGraphs && ['check:knip', 'check:ts-prune'].includes(command);
    if (skipped) {
      writeFileSync(artifact, `Literal-only graph witness: ${prior.graphWitness}\n`);
    } else {
      process.stdout.write(`Gate: ${name}\n`);
      // Vite/Vitest honor this cache home; shard children replace it with their
      // own authenticated session, while serial benchmark children inherit it.
      const sessionDirectory = join(directory, `session-${stages.length}`);
      mkdirSync(sessionDirectory);
      const result = run('npm', ['run', command], {
        cwd: root,
        env: {
          ...environment,
          GEOROIDS_REVIEW_RECEIPT: reviewReceipt,
          GEOROIDS_TEST_SESSION_DIR: sessionDirectory,
        },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      writeFileSync(artifact, `${result.stdout ?? ''}${result.stderr ?? ''}`);
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
  const receipt = {
    version: RECEIPT_VERSION,
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
  atomicReceipt(receiptPath, receipt);
  process.stdout.write(
    `Complete gate passed${receipt.candidateCertified ? '' : '; development proof only (candidate index differs)'}.\n`
  );
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runGate({ root: fileURLToPath(new URL('../', import.meta.url)) });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
