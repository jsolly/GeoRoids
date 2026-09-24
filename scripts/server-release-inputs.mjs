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

/** The live server also imports gameplay modules outside server/. */
export function serverReleaseInputs(cwd = process.cwd()) {
  const temporary = mkdtempSync(join(tmpdir(), 'georoids-server-graph-'));
  let sourceFiles;
  try {
    const configPath = join(temporary, 'tsconfig.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: resolve(cwd, 'tsconfig.json'),
        compilerOptions: { typeRoots: [resolve(cwd, 'node_modules/@types')] },
        files: [resolve(cwd, 'server.ts')],
        include: [],
        exclude: [],
      })
    );
    const compiler = join(
      dirname(fileURLToPath(import.meta.resolve('typescript/package.json'))),
      'bin/tsc'
    );
    sourceFiles = execFileSync(
      process.execPath,
      [compiler, '--project', configPath, '--listFilesOnly', '--pretty', 'false'],
      {
        cwd,
        encoding: 'utf8',
      }
    )
      .trim()
      .split('\n');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const dependencies = new Set(sourceFiles.map((file) => relative(cwd, file)));
  const tracked = git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean);
  const inputs = tracked.filter(
    (path) =>
      dependencies.has(path) ||
      deploymentFiles.has(path) ||
      deploymentDirectories.some((directory) => path.startsWith(directory))
  );
  if (!inputs.includes('server.ts')) {
    throw new Error('Tracked server.ts is required');
  }
  return inputs.sort();
}

export function minimumServerRelease(targetSha, cwd = process.cwd()) {
  requireSha(targetSha);
  if (git(cwd, ['rev-parse', 'HEAD']) !== targetSha) {
    throw new Error('Compute server release inputs from the target commit checkout');
  }
  const sha = git(cwd, ['log', '-1', '--format=%H', targetSha, '--', ...serverReleaseInputs(cwd)]);
  return requireSha(sha);
}

export function requiresServerDeployment(baseSha, targetSha, cwd = process.cwd()) {
  requireSha(baseSha);
  requireSha(targetSha);
  if (git(cwd, ['rev-parse', 'HEAD']) !== targetSha) {
    throw new Error('Classify server changes from the target commit checkout');
  }
  const inputs = new Set(serverReleaseInputs(cwd));
  return git(cwd, ['diff', '--name-only', baseSha, targetSha])
    .split('\n')
    .some(
      (path) =>
        inputs.has(path) ||
        deploymentFiles.has(path) ||
        deploymentDirectories.some((directory) => path.startsWith(directory))
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === '--minimum' && first) {
    process.stdout.write(`${minimumServerRelease(first)}\n`);
  } else if (mode === '--changed' && first && second) {
    process.stdout.write(`${requiresServerDeployment(first, second)}\n`);
  } else if (mode === '--list') {
    process.stdout.write(`${serverReleaseInputs().join('\n')}\n`);
  } else {
    throw new Error('Usage: server-release-inputs.mjs --list | --minimum SHA | --changed BASE SHA');
  }
}
