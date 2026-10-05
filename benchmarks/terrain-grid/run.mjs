import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { parseAst } from 'vite';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const baselineRevision = '5cdaeedad8db22f5925dd4cdc176caa606bfc5be';
const baselineNames = ['contours.ts', 'heightfield.ts', 'passages.ts', 'terrainConfig.ts'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
/** Vite invokes the hook with its plugin context as `this`. */
class TerrainSourceManifestPlugin {
  name = 'terrain-job-source-manifest';

  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'module-inputs.json',
      source: JSON.stringify(
        [...this.getModuleIds()]
          .filter((id) => !id.startsWith('\0'))
          .sort((left, right) => left.localeCompare(right))
      ),
    });
  }
}

if (process.argv[2] === '--build') {
  const output = process.argv[3],
    generated = process.argv[4];
  assert(
    output && isAbsolute(output) && generated && isAbsolute(generated),
    'Absolute build and generated-source directories required'
  );
  assert(
    !relative(join(root, '.performance', 'terrain-grid'), generated).startsWith('..'),
    'Generated source must belong to this benchmark'
  );
  const { build } = await import('vite');
  await build({
    root: generated,
    publicDir: false,
    configFile: false,
    envFile: false,
    logLevel: 'error',
    base: './',
    plugins: [new TerrainSourceManifestPlugin()],
    build: {
      outDir: output,
      emptyOutDir: true,
      target: 'esnext',
      rollupOptions: { input: join(generated, 'index.html') },
    },
  });
  process.exit(0);
}
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'cpu-throttle': { type: 'string', default: '4' },
    pairs: { type: 'string', default: '3' },
    warmups: { type: 'string', default: '10' },
    calls: { type: 'string', default: '12' },
  },
});
const rate = Number(values['cpu-throttle']);
assert(Number.isFinite(rate) && rate >= 1 && rate <= 20, 'CPU throttle must be 1..20');
const timingOptions = Object.fromEntries(
  ['pairs', 'warmups', 'calls'].map((key) => {
    const count = Number(values[key]);
    assert(Number.isInteger(count) && count >= 1 && count <= 100, `Invalid ${key}`);
    return [key, count];
  })
);
assert(
  timingOptions.calls >= 10 && timingOptions.warmups >= 5,
  'Require at least 10 calls and 5 warmups per arm'
);
await mkdir(join(root, '.performance', 'terrain-grid'), { recursive: true });
const runDirectory = await mkdtemp(join(root, '.performance', 'terrain-grid', 'run-'));
const generated = join(runDirectory, 'source');
const output = values.output ? resolve(root, values.output) : join(runDirectory, 'report.json');
let generatedIdentity = null;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, '{}\n', { flag: 'wx' });
const environment = () => ({
  at: new Date().toISOString(),
  node: process.version,
  execPath: process.execPath,
  platform: platform(),
  release: release(),
  arch: arch(),
  cpus: cpus().map(({ model, speed }) => ({ model, speedMHz: speed })),
  loadavg: loadavg(),
  freeBytes: freemem(),
  totalBytes: totalmem(),
});
function failure(error) {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error instanceof AggregateError ? { errors: [...error.errors].map(failure) } : {}),
        ...(error.cause === undefined ? {} : { cause: failure(error.cause) }),
      }
    : { message: String(error) };
}
async function deadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function localFile(base) {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, 'index.ts'),
  ]) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw error;
      }
    }
  }
  throw new Error(`Cannot resolve local source ${base}`);
}
async function collectSources() {
  const files = new Set();
  async function visit(file) {
    if (files.has(file)) {
      return;
    }
    assert(!relative(root, file).startsWith('..'), `Source outside checkout: ${file}`);
    files.add(file);
    if (!/\.(?:ts|tsx|mjs|js)$/u.test(file)) {
      return;
    }
    const text = await readFile(file, 'utf8');
    // Parse real imports, not import-looking strings in the generated bootstrap recipe.
    // The actual Vite module list must then be covered by this pre-build graph.
    const imports = [];
    function collect(node) {
      if (node === null || typeof node !== 'object') {
        return;
      }
      if (
        [
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
          'ImportExpression',
        ].includes(node.type) &&
        node.source?.type === 'Literal' &&
        typeof node.source.value === 'string'
      ) {
        imports.push(node.source.value);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'parent') {
          continue;
        }
        if (Array.isArray(value)) {
          for (const child of value) {
            collect(child);
          }
        } else if (value !== null && typeof value === 'object') {
          collect(value);
        }
      }
    }
    const language = file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : 'js';
    collect(parseAst(text, { lang: language }));
    for (const specifier of imports) {
      if (specifier.startsWith('.')) {
        await visit(await localFile(resolve(dirname(file), specifier)));
      }
    }
  }
  await visit(join(generated, 'bootstrap.ts'));
  await visit(join(directory, 'run.mjs'));
  for (const file of ['index.html', 'README.md']) {
    files.add(join(directory, file));
  }
  files.add(join(generated, 'index.html'));
  files.add(join(generated, 'generation.json'));
  async function configs(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await configs(full);
      } else if (/\.jsonc?$/u.test(entry.name)) {
        files.add(full);
      }
    }
  }
  await configs(join(root, 'tsconfig'));
  for (const name of await readdir(root)) {
    if (/^tsconfig.*\.json$/u.test(name)) {
      files.add(join(root, name));
    }
  }
  files.add(join(root, 'package.json'));
  files.add(join(root, 'package-lock.json'));
  for (const packageName of ['playwright', 'playwright-core', 'vite', 'typescript', 'tsx']) {
    files.add(join(root, 'node_modules', packageName, 'package.json'));
  }
  return [...files].sort();
}
async function identity() {
  assert(generatedIdentity, 'Baseline has not been materialized');
  for (const [path, expected] of Object.entries(generatedIdentity.files)) {
    assert.equal(
      hash(await readFile(join(root, path))),
      expected,
      `Generated source changed: ${path}`
    );
  }
  assert.deepStrictEqual(
    JSON.parse(await readFile(join(generated, 'generation.json'), 'utf8')),
    generatedIdentity,
    'Generated manifest changed'
  );
  const files = Object.fromEntries(
    await Promise.all(
      (await collectSources()).map(async (path) => [
        relative(root, path),
        hash(await readFile(path)),
      ])
    )
  );
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    files,
    sha256: hash(JSON.stringify(files)),
  };
}
async function compile(outputDirectory) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--build', outputDirectory, generated],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let log = '';
  const captureLog = (chunk) => {
    log = (log + chunk).slice(-16_000);
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', captureLog);
  }
  const closed = new Promise((resolveClosed, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) =>
      code === 0 ? resolveClosed() : reject(new Error(`Build failed (${code ?? signal}): ${log}`))
    );
  });
  try {
    await deadline(closed, 90_000, 'Terrain build');
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await deadline(
        closed.catch(() => undefined),
        10_000,
        'Compiler cleanup'
      );
    }
    throw error;
  }
  return { log, cleanup: 'complete' };
}
const report = {
  schemaVersion: 1,
  kind: 'production-terrain-grid-browser-cpu-job',
  status: 'running',
  cwd: root,
  invocation: process.argv,
  baselineRevision,
  evidenceDirectory: runDirectory,
  generatedSourceDirectory: generated,
  options: { cpuThrottlingRate: rate, ...timingOptions },
  environmentBefore: environment(),
  sourceBefore: null,
  sourceAfter: null,
  observation: [],
  timing: [],
  cleanup: { browser: 'not-started', server: 'not-started', artifacts: 'not-started' },
  method: {
    timedOperation:
      'Fresh complete contour extraction including grid/setup, then fresh warmContourSpatialIndex',
    heightfield: 'Created once per scenario outside timing, matching product patch construction',
    controls:
      'Three A/A pairs before, three alternating A/B pairs, three A/A pairs after by default',
    warmup: 'Both arms warm before controls; each arm warms again before its measured calls',
    betweenArms: 'Two native requestAnimationFrame callbacks, no forced GC',
    correctness:
      'Separate fresh context; full Float64 height/min/max/ordered contour/query comparisons outside timing',
    result:
      'Exit zero means complete collection, exactness and cleanup; no performance win declared',
  },
  limits: [
    'Main-thread terrain extraction plus index CPU job only; no game frame/FPS/rendering claim',
    'CDP slowdown is relative to this host, not physical-phone performance evidence',
    '4096-radius cases are scan-radius kernels; no explicit mapping from a viewport to this radius is established',
    'Height and axis buffer sizes are derived; total object/Map/transient/GC memory is unmeasured',
    'Candidate is the actual current checkout product; a dirty source run is development evidence, not pinned release proof',
  ],
};
const save = () => writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
const failures = [];
const trafficFailures = [];
let ownedDirectory, server, browserServer;
try {
  await mkdir(join(generated, 'baseline'), { recursive: true });
  const files = {};
  for (const name of baselineNames) {
    const bytes = execFileSync('git', ['show', `${baselineRevision}:src/physics/terrain/${name}`], {
      cwd: root,
    });
    const path = join(generated, 'baseline', name);
    await writeFile(path, bytes, { flag: 'wx' });
    files[relative(root, path)] = hash(bytes);
  }
  const installer = relative(generated, join(directory, 'entry.ts')).replaceAll('\\', '/');
  const bootstrap = [
    `import ${JSON.stringify(installer)};`,
    "import { createHeightfield, sampleHeight } from './baseline/heightfield';",
    "import { extractIsoContours } from './baseline/contours';",
    "import { TERRAIN } from './baseline/terrainConfig';",
    'window.installTerrainGridBenchmark({ createHeightfield, sampleHeight, extractIsoContours, contourInterval: TERRAIN.CONTOUR_INTERVAL });',
    '',
  ].join('\n');
  const generatedFiles = {
    'bootstrap.ts': bootstrap,
    'index.html': await readFile(join(directory, 'index.html')),
  };
  for (const [name, bytes] of Object.entries(generatedFiles)) {
    const path = join(generated, name);
    await writeFile(path, bytes, { flag: 'wx' });
    files[relative(root, path)] = hash(bytes);
  }
  generatedIdentity = { baselineRevision, files };
  await writeFile(
    join(generated, 'generation.json'),
    `${JSON.stringify(generatedIdentity, null, 2)}\n`,
    { flag: 'wx' }
  );
  report.generatedSources = generatedIdentity;
  report.sourceBefore = await identity();
  await save();
  ownedDirectory = await mkdtemp(join(tmpdir(), 'georoids-terrain-grid-build-'));
  report.cleanup.artifacts = 'owned';
  const dist = join(ownedDirectory, 'dist');
  report.compile = await compile(dist);
  const moduleIds = JSON.parse(await readFile(join(dist, 'module-inputs.json'), 'utf8'));
  report.compiledModules = moduleIds;
  for (const moduleId of moduleIds) {
    const file = moduleId.split('?')[0];
    if (isAbsolute(file)) {
      assert(
        Object.hasOwn(report.sourceBefore.files, relative(root, file)),
        `Unhashed compiled input ${file}`
      );
    }
  }
  const buildFiles = {};
  const pendingBuildDirectories = [dist];
  while (pendingBuildDirectories.length > 0) {
    const path = pendingBuildDirectories.pop();
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        pendingBuildDirectories.push(full);
      } else {
        const bytes = await readFile(full);
        buildFiles[relative(dist, full)] = { sha256: hash(bytes), bytes: bytes.byteLength };
      }
    }
  }
  report.compiledFiles = buildFiles;
  assert.deepStrictEqual(
    await identity(),
    report.sourceBefore,
    'Inputs changed during compilation'
  );
  server = createServer((request, response) => {
    const serve = async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const path = resolve(dist, `.${pathname}`);
      assert(!relative(dist, path).startsWith('..'), `Invalid fixture path ${pathname}`);
      const bytes = await readFile(path);
      response.writeHead(200, {
        'content-type':
          { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[
            extname(path)
          ] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(bytes);
    };
    void serve().catch((error) => {
      trafficFailures.push(String(error));
      response.writeHead(404);
      response.end();
    });
  });
  server.on('upgrade', (_request, socket) => {
    trafficFailures.push('Unexpected WebSocket upgrade');
    socket.destroy();
  });
  await deadline(
    new Promise((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListening);
    }),
    10_000,
    'Loopback server start'
  );
  report.cleanup.server = 'owned';
  const address = server.address();
  assert(address && typeof address !== 'string', 'No loopback server address');
  const origin = `http://127.0.0.1:${address.port}`;
  report.server = {
    address: '127.0.0.1',
    port: address.port,
    ownership: 'created by this process',
  };
  browserServer = await chromium.launchServer({
    headless: true,
    channel: 'chromium',
    args: ['--enable-gpu'],
    timeout: 30_000,
  });
  report.cleanup.browser = 'owned';
  const browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 30_000 });
  const browserSession = await deadline(
    browser.newBrowserCDPSession(),
    10_000,
    'Browser CDP setup'
  );
  const systemInfo = await deadline(
    browserSession.send('SystemInfo.getInfo'),
    10_000,
    'GPU identity'
  );
  await deadline(browserSession.detach(), 10_000, 'Browser CDP detach');
  report.browser = {
    version: browser.version(),
    gpu: systemInfo.gpu,
    modelName: systemInfo.modelName,
    modelVersion: systemInfo.modelVersion,
    processPid: browserServer.process().pid,
    launch: { headless: true, channel: 'chromium', args: ['--enable-gpu'] },
  };
  const renderer = systemInfo.gpu.auxAttributes?.glRenderer;
  assert(
    typeof renderer === 'string' &&
      renderer.length > 0 &&
      !/swiftshader|llvmpipe|software/iu.test(renderer),
    'Native GPU renderer identity required'
  );
  for (const feature of ['2d_canvas', 'gpu_compositing', 'rasterization']) {
    assert(
      ['enabled', 'enabled_on'].includes(systemInfo.gpu.featureStatus?.[feature]),
      `Native GPU lacks accelerated ${feature}`
    );
  }
  async function runContext(kind) {
    const context = await deadline(
      browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        hasTouch: true,
        serviceWorkers: 'block',
      }),
      30_000,
      `${kind} context setup`
    );
    const errors = [];
    const receipt = {
      kind,
      cleanup: 'owned',
      cpuThrottlingRate: rate,
      applied: 'before-navigation',
    };
    report[`${kind}Context`] = receipt;
    try {
      await deadline(
        context.route('**/*', (route) => {
          const request = route.request();
          if (
            new URL(request.url()).origin !== origin ||
            !['document', 'script'].includes(request.resourceType())
          ) {
            trafficFailures.push(`Unexpected ${request.resourceType()} ${request.url()}`);
            return route.abort();
          }
          return route.continue();
        }),
        10_000,
        `${kind} HTTP routing`
      );
      await deadline(
        context.routeWebSocket('**/*', (socket) => {
          trafficFailures.push(`Unexpected WebSocket ${socket.url()}`);
          socket.close();
        }),
        10_000,
        `${kind} WebSocket routing`
      );
      const page = await deadline(context.newPage(), 30_000, `${kind} page setup`);
      page.on('pageerror', (error) => errors.push(error));
      page.on('console', (message) => {
        if (['error', 'warning'].includes(message.type())) {
          errors.push(new Error(`${message.type()}: ${message.text()}`));
        }
      });
      page.on('requestfailed', (request) =>
        errors.push(new Error(`Request failed ${request.url()}`))
      );
      page.on('response', (response) => {
        if (!response.ok()) {
          errors.push(new Error(`HTTP ${response.status()} ${response.url()}`));
        }
      });
      const cpuSession = await deadline(
        context.newCDPSession(page),
        10_000,
        `${kind} CPU CDP setup`
      );
      await deadline(
        cpuSession.send('Emulation.setCPUThrottlingRate', { rate }),
        10_000,
        'CPU emulation'
      );
      await page.goto(`${origin}/index.html`, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForFunction('typeof window.timeTerrainScenario === "function"', undefined, {
        timeout: 30_000,
      });
      receipt.runtimeBefore = await deadline(
        page.evaluate('window.terrainRuntimeStatus()'),
        10_000,
        'Runtime observation'
      );
      const scenarios = await deadline(
        page.evaluate('window.terrainScenarios'),
        10_000,
        `${kind} scenarios`
      );
      assert.equal(scenarios.length, 21, 'Expected all 21 terrain scenarios');
      if (report.scenarios) {
        assert.deepStrictEqual(scenarios, report.scenarios, 'Context scenario lists differ');
      } else {
        report.scenarios = scenarios;
      }
      for (let index = 0; index < scenarios.length; index++) {
        const before = environment();
        const expression =
          kind === 'observation'
            ? `window.observeTerrainScenario(${index})`
            : `window.timeTerrainScenario(${index},${JSON.stringify(timingOptions)})`;
        const result = await deadline(
          page.evaluate(expression),
          120_000,
          `${kind} ${scenarios[index].id}`
        );
        assert.deepStrictEqual(
          result.scenario,
          scenarios[index],
          'Scenario outcome identity mismatch'
        );
        if (kind === 'observation') {
          assert(
            result.exactHeightFloat64Bits &&
              result.exactMinMaxFloat64Bits &&
              result.exactOrderedContourFloat64Bits &&
              result.bothSpatialIndexesBuilt,
            'Missing exactness evidence'
          );
          assert.equal(result.queries.length, 4, 'Missing spatial query witnesses');
        } else {
          assert.equal(result.arms.length, timingOptions.pairs * 6, 'Missing timed arms');
          assert.equal(
            result.operationCount,
            timingOptions.warmups * 2 +
              timingOptions.pairs * 6 * (timingOptions.warmups + timingOptions.calls),
            'Incomplete operation count'
          );
          for (const arm of result.arms) {
            assert.equal(arm.samplesMs.length, timingOptions.calls, 'Missing raw samples');
            assert(
              arm.samplesMs.every((value) => Number.isFinite(value) && value > 0),
              'Invalid raw samples'
            );
          }
        }
        assert.equal(result.frame.visibilityState, 'visible', 'Hidden browser context');
        report[kind].push({ environmentBefore: before, environmentAfter: environment(), result });
        await save();
        process.stdout.write(`${kind}: ${scenarios[index].id}\n`);
        if (errors.length) {
          throw new AggregateError(errors.splice(0), `${kind} browser errors`);
        }
      }
      receipt.runtimeAfter = await deadline(
        page.evaluate('window.terrainRuntimeStatus()'),
        10_000,
        'Final runtime observation'
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await deadline(context.close(), 10_000, `${kind} context cleanup`);
      receipt.cleanup = 'complete';
    } catch (error) {
      receipt.cleanup = 'failed';
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(errors, `${kind} context failed`);
    }
  }
  // Correctness work runs in its own context and cannot warm timing's code or caches.
  await runContext('observation');
  await runContext('timing');
  assert.equal(report.observation.length, 21);
  assert.equal(report.timing.length, 21);
} catch (error) {
  failures.push(error);
} finally {
  if (browserServer) {
    try {
      await deadline(browserServer.close(), 10_000, 'Browser cleanup');
      report.cleanup.browser = 'complete';
    } catch (error) {
      failures.push(error);
      report.cleanup.browser = 'failed';
      const child = browserServer.process();
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((resolveClosed) => child.once('close', resolveClosed));
        child.kill('SIGKILL');
        try {
          await deadline(closed, 10_000, 'Forced browser cleanup');
          report.cleanup.browser = 'forced-complete';
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
    }
  }
  if (server?.listening) {
    server.closeAllConnections();
    try {
      await deadline(
        new Promise((resolveClosed, reject) =>
          server.close((error) => (error ? reject(error) : resolveClosed()))
        ),
        10_000,
        'Loopback server cleanup'
      );
      report.cleanup.server = 'complete';
    } catch (error) {
      report.cleanup.server = 'failed';
      failures.push(error);
    }
  }
  if (ownedDirectory) {
    try {
      await deadline(
        rm(ownedDirectory, { recursive: true, force: true }),
        10_000,
        'Artifact cleanup'
      );
      report.cleanup.artifacts = 'complete';
    } catch (error) {
      report.cleanup.artifacts = 'failed';
      failures.push(error);
    }
  }
  if (trafficFailures.length) {
    failures.push(new Error(trafficFailures.join('\n')));
  }
  try {
    report.sourceAfter = await identity();
    assert.deepStrictEqual(
      report.sourceAfter,
      report.sourceBefore,
      'Source inputs changed during collection'
    );
    report.sourceStable = true;
  } catch (error) {
    report.sourceStable = false;
    failures.push(error);
  }
  report.generatedSourceRetention = {
    directory: generated,
    status: 'preserved for receipt replay; no live processes',
  };
  report.environmentAfter = environment();
  report.status = failures.length ? 'failed' : 'complete';
  if (failures.length) {
    report.failures = failures.map(failure);
    process.exitCode = 1;
  }
  await save();
  process.stdout.write(`Receipt: ${output}\n`);
}
