import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { clientAssetGraph } from './client-asset-graph.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const receiptPath = (root) => join(root, '.performance/benchmark-client-build.json');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function selectedPorts(ports) {
  assert(
    ports.length === 3 &&
      ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535) &&
      new Set(ports).size === 3,
    'Expected three valid, distinct benchmark ports'
  );
  return ports;
}

function successfulReceipt(root) {
  assert(existsSync(receiptPath(root)), 'Missing successful benchmark-client build receipt');
  const receipt = readJson(receiptPath(root));
  assert.equal(receipt.schemaVersion, 2, 'Unsupported benchmark build receipt');
  assert.equal(receipt.kind, 'benchmark-client-production-build');
  assert.equal(receipt.inputs.worktree, root, 'Reusable build belongs to another worktree');
  const ports = selectedPorts(receipt.inputs.ports);
  assert.equal(receipt.inputs.websocketUrl, `ws://localhost:${ports[2]}/ws`);
  return receipt;
}

function git(root, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  );
  return execFileSync('git', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fileRows(root, paths) {
  return [...new Set(paths)].sort().map((file) => {
    const path = join(root, file);
    if (!existsSync(path)) {
      return { file, deleted: true };
    }
    const info = lstatSync(path);
    assert(info.isFile(), `Build receipt refuses non-file input: ${file}`);
    return { file, mode: info.mode & 0o777, sha256: digest(readFileSync(path)) };
  });
}

function inputs(root, websocketUrl) {
  assert(/^ws:\/\/localhost:[0-9]+\/ws$/u.test(websocketUrl), 'Expected owned benchmark WS URL');
  // URL parsing also rejects a malformed/out-of-range TCP port.
  assert.equal(new URL(websocketUrl).protocol, 'ws:');
  assert.equal(realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()), root);
  assert(existsSync(join(root, 'package-lock.json')), 'Missing build lockfile');
  const sourcePaths = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter((file) => file && !/^(?:\.performance|logs|dist|node_modules|coverage)\//u.test(file));
  // Vite reads ignored environment files as well as Git-visible source/assets.
  const environmentFiles = readdirSync(root).filter((name) => /^\.env(?:\..*)?$/u.test(name));
  const rows = fileRows(root, [...sourcePaths, ...environmentFiles]);
  const environment = Object.fromEntries(
    Object.entries(process.env)
      .filter(([name]) =>
        /^(?:VITE_|VERCEL_|RAILWAY_|NODE_OPTIONS$|NODE_ENV$|GEOROIDS_TEST_(?:VITE_PORT|SERVER_PORT|SESSION_DIR)$)/u.test(
          name
        )
      )
      .sort(([a], [b]) => a.localeCompare(b))
  );
  // The runner supplies this value to npm build, overriding the ambient value.
  environment.VITE_WEBSOCKET_URL = websocketUrl;
  return {
    worktree: root,
    commit: git(root, ['rev-parse', 'HEAD']).trim(),
    nodeVersion: process.version,
    websocketUrl,
    ports: selectedPorts([
      Number(process.env.GEOROIDS_TEST_VITE_PORT),
      Number(process.env.GEOROIDS_TEST_SERVER_PORT),
      Number(process.env.GEOROIDS_TEST_PROXY_PORT),
    ]),
    sourceSha256: digest(JSON.stringify(rows)),
    environmentSha256: digest(
      JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)))
    ),
    lockfileSha256: digest(readFileSync(join(root, 'package-lock.json'))),
  };
}

function build(root) {
  assert(existsSync(join(root, 'dist/index.html')), 'Missing production dist/index.html');
  assert(existsSync(join(root, 'dist/release.json')), 'Missing production dist/release.json');
  const release = readJson(join(root, 'dist/release.json'));
  assert.equal(
    release.releaseSha,
    git(root, ['rev-parse', 'HEAD']).trim(),
    'Benchmark build release is stale'
  );
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  const entries = [...html.matchAll(/<script\b[^>]*>/giu)]
    .map(([tag]) =>
      /\btype=["']module["']/iu.test(tag) ? /\bsrc=["']\/([^"']+)["']/iu.exec(tag)?.[1] : undefined
    )
    .filter(Boolean);
  const modules = clientAssetGraph(
    readJson(join(root, 'dist/client-assets.json')),
    release.releaseSha,
    entries
  );
  for (const path of modules) {
    assert(existsSync(join(root, 'dist', path)), 'Attributed gameplay asset is missing');
    assert(readFileSync(join(root, 'dist', path)).length > 0, 'Attributed gameplay asset is empty');
  }
  const paths = [];
  function visit(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      assert(!entry.isSymbolicLink(), `Build receipt refuses symlink: ${path}`);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        assert(entry.isFile(), `Build receipt refuses non-file asset: ${path}`);
        paths.push(path);
      }
    }
  }
  visit('dist');
  const files = fileRows(root, paths);
  return { sha256: digest(JSON.stringify(files)), files };
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function benchmarkBuildReceipt(action, directory, websocketUrl, preparedPath) {
  const root = realpathSync(directory);
  if (action === 'ports') {
    // These are candidates, never permission to attach to or stop a listener.
    // The runner still checks availability, ownership and the full build proof.
    return successfulReceipt(root).inputs.ports;
  } else if (action === 'prepare') {
    assert(preparedPath, 'Missing prepared input receipt path');
    // A failed new build must never leave an older successful receipt reusable.
    rmSync(receiptPath(root), { force: true });
    atomicJson(preparedPath, inputs(root, websocketUrl));
  } else if (action === 'record') {
    assert(preparedPath, 'Missing prepared input receipt path');
    const prepared = readJson(preparedPath);
    assert.deepEqual(inputs(root, websocketUrl), prepared, 'Build inputs changed during build');
    const assets = build(root);
    atomicJson(receiptPath(root), {
      schemaVersion: 2,
      kind: 'benchmark-client-production-build',
      completedAt: new Date().toISOString(),
      inputs: prepared,
      assets,
    });
  } else if (action === 'verify') {
    const receipt = successfulReceipt(root);
    assert.deepEqual(inputs(root, websocketUrl), receipt.inputs, 'Reusable build inputs differ');
    assert.deepEqual(build(root), receipt.assets, 'Reusable production assets differ');
  } else {
    throw new Error('Expected ports, prepare, record or verify');
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [action, root, websocketUrl, preparedPath] = process.argv.slice(2);
    assert(
      root && (action === 'ports' || websocketUrl),
      'Expected action, worktree and owned WS URL'
    );
    const result = benchmarkBuildReceipt(action, root, websocketUrl, preparedPath);
    if (action === 'ports') {
      process.stdout.write(`${result.join('\n')}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
