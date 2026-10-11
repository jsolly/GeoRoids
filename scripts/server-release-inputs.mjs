import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const deploymentFiles = new Set([
  'server.ts',
  'shared-types.ts',
  'package.json',
  'package-lock.json',
  '.nvmrc',
  '.node-version',
  '.npmrc',
  'tsconfig.json',
  'tsconfig.build.json',
  'astro.config.ts',
  'astro.config.mjs',
  'vite.config.ts',
  'Procfile',
  'Dockerfile',
  'railway.json',
  'railway.toml',
]);
const deploymentDirectories = ['server/', 'shared/', 'setup/', '.railway/'];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function requireSha(value) {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error('A full lowercase commit SHA is required');
  }
  return value;
}

const serverEntryFiles = new Set(['server.ts', 'shared-types.ts']);

function trackedFiles(cwd) {
  return git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean);
}

function isDeploymentInput(path) {
  return (
    deploymentFiles.has(path) ||
    deploymentDirectories.some((directory) => path.startsWith(directory))
  );
}

/** Every module the server sources load, as the TypeScript compiler resolves them. */
function serverModuleGraph(cwd, tracked) {
  const roots = tracked.filter(
    (path) =>
      (serverEntryFiles.has(path) ||
        deploymentDirectories.some((directory) => path.startsWith(directory))) &&
      /\.[cm]?ts$/u.test(path)
  );
  const temporary = mkdtempSync(join(tmpdir(), 'georoids-server-graph-'));
  try {
    const configPath = join(temporary, 'tsconfig.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: resolve(cwd, 'tsconfig.json'),
        compilerOptions: { typeRoots: [resolve(cwd, 'node_modules/@types')] },
        files: roots.map((path) => resolve(cwd, path)),
        include: [],
        exclude: [],
      })
    );
    const compiler = join(
      dirname(fileURLToPath(import.meta.resolve('typescript/package.json'))),
      'bin/tsc'
    );
    return execFileSync(
      process.execPath,
      [compiler, '--project', configPath, '--listFilesOnly', '--pretty', 'false'],
      { cwd, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .map((file) => relative(cwd, file));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Server, shared, setup and Railway modules never load the browser client under src/. */
export function assertServerAvoidsClient(cwd = process.cwd(), tracked = trackedFiles(cwd)) {
  const clientModules = serverModuleGraph(cwd, tracked).filter((path) => path.startsWith('src/'));
  if (clientModules.length > 0) {
    throw new Error(`Server modules import client sources: ${clientModules.join(', ')}`);
  }
}

/** The server release is its deployment directories plus runtime and build manifests. */
export function serverReleaseInputs(cwd = process.cwd()) {
  const tracked = trackedFiles(cwd);
  assertServerAvoidsClient(cwd, tracked);
  const inputs = tracked.filter(isDeploymentInput);
  if (!inputs.includes('server.ts')) {
    throw new Error('Tracked server.ts is required');
  }
  return inputs.sort();
}

export function requiresServerDeployment(baseSha, targetSha, cwd = process.cwd()) {
  requireSha(baseSha);
  requireSha(targetSha);
  if (git(cwd, ['rev-parse', 'HEAD']) !== targetSha) {
    throw new Error('Classify server changes from the target commit checkout');
  }
  serverReleaseInputs(cwd);
  return git(cwd, ['diff', '--name-only', baseSha, targetSha]).split('\n').some(isDeploymentInput);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === '--changed' && first && second) {
    process.stdout.write(`${requiresServerDeployment(first, second)}\n`);
  } else if (mode === '--list') {
    process.stdout.write(`${serverReleaseInputs().join('\n')}\n`);
  } else {
    throw new Error('Usage: server-release-inputs.mjs --list | --changed BASE SHA');
  }
}
