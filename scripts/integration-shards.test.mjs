import assert from 'node:assert/strict';
import { spawn as nativeSpawn, spawnSync as nativeSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { planShards, selectShard } from './integration-shard-plan.mjs';
import {
  aggregateReports,
  captureChild,
  cleanGroup,
  compileCacheEnvironment,
  integrationFiles,
  retainGroup,
  validateDiscovery,
  validateTimingReport,
} from './integration-shards.mjs';

import { createTimingRecorder } from './integration-timing-reporter.mjs';

function fixtureEnv(inherited = process.env) {
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}
// Every real fixture subprocess receives the same boundary, including generated wrappers.
function spawn(command, args, options = {}) {
  return nativeSpawn(command, args, { ...options, env: fixtureEnv(options.env ?? process.env) });
}
function spawnSync(command, args, options = {}) {
  return nativeSpawnSync(command, args, {
    ...options,
    env: fixtureEnv(options.env ?? process.env),
  });
}
function fixtureCommonDir(directory, inherited = process.env) {
  const result = spawnSync(
    'git',
    ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', env: inherited }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync(result.stdout.trim()), join(realpathSync(directory), '.git'));
  return result.stdout.trim();
}

const root = resolve(import.meta.dirname, '..');
const helper = join(root, 'scripts/integration-shards.mjs');
function cacheInventory(directory, prefix = '') {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name),
        relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        return cacheInventory(path, relative);
      }
      const bytes = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
      return [[relative, createHash('sha256').update(bytes).digest('hex')]];
    });
}
function sharedVitestCache() {
  return cacheInventory(join(root, 'node_modules/.vite'));
}
function retainFixture(directory, label, output) {
  const home = process.env.GEOROIDS_CONTRACT_EVIDENCE_DIR;
  if (!home) {
    return;
  }
  const destination = join(home, `${label}-${directory.split('/').at(-1)}`);
  mkdirSync(destination, { recursive: true });
  if (existsSync(join(directory, '.performance'))) {
    cpSync(join(directory, '.performance'), join(destination, 'evidence'), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  if (output) {
    writeFileSync(join(destination, 'process-output.json'), JSON.stringify(output, null, 2));
  }
}
const fixtureFile = (index) => `/fixture/tests/integration/file-${index}.test.ts`;
function fixtureReports() {
  const discovery = Array.from({ length: 6 }, (_, index) => ({
    file: fixtureFile(index),
    name: `suite case-${index}`,
    location: { line: 10, column: 2 },
  }));
  const reports = discovery.map((entry) => ({
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: 1,
    testResults: [
      {
        name: entry.file,
        status: 'passed',
        assertionResults: [
          { fullName: entry.name, location: entry.location, status: 'passed', failureMessages: [] },
        ],
      },
    ],
  }));
  return { discovery, files: discovery.map((entry) => entry.file), reports };
}
test('every discovered file and source-located case must appear once despite success metadata', () => {
  const fixture = fixtureReports();
  assert.equal(aggregateReports(fixture.discovery, fixture.files, fixture.reports).cases, 6);
  for (const mutate of [
    (reports) => {
      reports[0].testResults[0].assertionResults[0].status = 'skipped';
    },
    (reports) => {
      reports[1] = reports[0];
    },
    (reports) => {
      reports[0].testResults[0].assertionResults.push(
        reports[0].testResults[0].assertionResults[0]
      );
      reports[0].numTotalTests = 2;
      reports[0].numPassedTests = 2;
    },
    (reports) => {
      reports[0].testResults[0].assertionResults[0].location.line++;
    },
    (reports) => {
      reports[0].testResults[0].assertionResults = [];
    },
    (reports) => {
      reports[0].numPassedTests = 0;
    },
    (reports) => {
      reports[0].testResults[0].assertionResults[0].failureMessages = ['reset failed'];
    },
  ]) {
    const reports = structuredClone(fixture.reports);
    mutate(reports);
    assert.throws(() => aggregateReports(fixture.discovery, fixture.files, reports));
  }
  assert.throws(
    () => aggregateReports(fixture.discovery, fixture.files, fixture.reports.slice(1)),
    /Missing shard/u
  );
});
test('duplicate titles retain source locations and exact expected occurrence counts', () => {
  const fixture = fixtureReports();
  const first = fixture.discovery[0];
  fixture.discovery.push({ ...first }, { ...first, location: { line: 20, column: 2 } });
  fixture.reports[0].testResults[0].assertionResults.push(
    { ...fixture.reports[0].testResults[0].assertionResults[0] },
    { ...fixture.reports[0].testResults[0].assertionResults[0], location: { line: 20, column: 2 } }
  );
  fixture.reports[0].numTotalTests = 3;
  fixture.reports[0].numPassedTests = 3;
  assert.equal(aggregateReports(fixture.discovery, fixture.files, fixture.reports).cases, 8);
  fixture.reports[0].testResults[0].assertionResults[2].location = first.location;
  assert.throws(
    () => aggregateReports(fixture.discovery, fixture.files, fixture.reports),
    /Duplicated, missing/u
  );
});
test('discovery requires all integration files and excludes nested unit copies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'geo-shard-discovery-'));
  try {
    mkdirSync(join(directory, 'tests/integration/nested'), { recursive: true });
    mkdirSync(join(directory, 'tests/unit'), { recursive: true });
    writeFileSync(join(directory, 'tests/integration/nested/scenario.test.ts'), '');
    writeFileSync(join(directory, 'tests/unit/copied.test.ts'), '');
    const files = integrationFiles(directory);
    assert.deepEqual(files, [
      realpathSync(join(directory, 'tests/integration/nested/scenario.test.ts')),
    ]);
    const discovered = [{ file: files[0], name: 'suite > case', location: { line: 1, column: 2 } }];
    assert.equal(validateDiscovery(discovered, files)[0].name, 'suite case');
    assert.throws(() => validateDiscovery([], files));
    assert.throws(
      () =>
        validateDiscovery(
          [...discovered, { ...discovered[0], file: join(directory, 'tests/unit/copied.test.ts') }],
          files
        ),
      /complete integration/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The fixture coordinator is an actual child of this test process, with actual
// Bash children. Authorization runs in its ordinary helper subprocess so PID,
// parent chain, process birth times and common-lock ownership are not mocked.
async function handshake(mode) {
  const sharedCacheBefore = sharedVitestCache();
  const directory = mkdtempSync(join(tmpdir(), 'geo-shard-auth-'));
  let processOutput;
  try {
    const git = spawnSync('git', ['init', '-q', directory], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(git.status, 0, git.stderr);
    fixtureCommonDir(directory);
    const worktree = realpathSync(directory),
      lock = join(worktree, '.git/georoids-test-runner.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
    writeFileSync(join(lock, 'worktree'), `${worktree}\n`);
    const timingMode = mode.startsWith('installed-timing');
    const sequencerMode = mode.startsWith('sequencer');
    let testedHelper = helper;
    if (sequencerMode || timingMode) {
      mkdirSync(join(worktree, 'scripts'));
      writeFileSync(join(worktree, 'package.json'), '{"type":"module"}');
      symlinkSync(join(root, 'node_modules'), join(worktree, 'node_modules'), 'dir');
      for (const name of [
        'integration-shards.mjs',
        'integration-shard-plan.mjs',
        'integration-sequencer.ts',
        'integration-timing-reporter.mjs',
      ]) {
        writeFileSync(join(worktree, 'scripts', name), readFileSync(join(root, 'scripts', name)));
      }
      testedHelper = join(worktree, 'scripts/integration-shards.mjs');
      writeFileSync(
        join(worktree, 'sequence.mjs'),
        `
import {readFileSync,writeFileSync} from 'node:fs';
import {IntegrationSequencer} from './scripts/integration-sequencer.ts';
const record=JSON.parse(readFileSync(process.env.GEOROIDS_SHARD_MANIFEST,'utf8'));
const plan=JSON.parse(readFileSync(record.assignmentPath,'utf8'));
if(process.env.SEQUENCE_FAULT==='digest') { record.assignmentSha256='bad';writeFileSync(process.env.GEOROIDS_SHARD_MANIFEST,JSON.stringify(record)); }
const files=plan.inventory.map(entry=>({moduleId:entry.file}));
if(process.env.SEQUENCE_FAULT==='late')files.push({moduleId:plan.worktree+'/tests/integration/late.test.ts'});
const sequencer=new IntegrationSequencer({config:{shard:{index:record.index,count:6}}});
const result=await sequencer.shard(files);
process.stdout.write(JSON.stringify(result.map(file=>file.moduleId))+'\\n');
`
      );
    }
    if (timingMode) {
      if (mode === 'installed-timing-sink') {
        writeFileSync(
          join(worktree, 'scripts/timing-failure-reporter.mjs'),
          `import TimingReporter,{createTimingRecorder} from './integration-timing-reporter.mjs';import {authorizeSequencer,writeJson} from './integration-shards.mjs';export default class extends TimingReporter {async onTestRunStart(specifications){let writes=0;this.recorder=createTimingRecorder(authorizeSequencer(),(path,value)=>{if(++writes===2)throw new Error('installed callback sink failed');writeJson(path,value);});await this.recorder.onTestRunStart(specifications);}}`
        );
      }
      mkdirSync(join(worktree, 'tests/integration'), { recursive: true });
      for (let index = 0; index < 6; index++) {
        writeFileSync(
          join(worktree, `tests/integration/file-${index}.test.ts`),
          `import {it,expect,beforeAll} from 'vitest';beforeAll(async()=>{await new Promise(resolve=>setTimeout(resolve,15));});it('installed case ${index}',()=>expect(${index}).toBe(${index}));`
        );
      }
      writeFileSync(
        join(worktree, 'vitest.config.ts'),
        `import {defineConfig} from 'vitest/config';import {IntegrationSequencer} from './scripts/integration-sequencer.ts';export default defineConfig({cacheDir:${JSON.stringify(join(worktree, '.performance/vitest-cache'))},test:{environment:'node',pool:'forks',maxWorkers:1,isolate:true,fileParallelism:false,sequence:{sequencer:IntegrationSequencer,concurrent:false},maxConcurrency:1}});`
      );
    }
    if (sequencerMode) {
      const weights = JSON.parse(
        readFileSync(join(root, 'scripts/integration-shard-weights.json'), 'utf8')
      );
      const files = integrationFiles(root).map((file) =>
        join(worktree, file.slice(root.length + 1))
      );
      const discovery = weights.entries.flatMap((entry) =>
        Array.from({ length: entry.cases }, () => ({ file: join(worktree, entry.path) }))
      );
      writeFileSync(
        join(worktree, 'planned.json'),
        JSON.stringify(
          planShards({
            worktree,
            files,
            discovery,
            weights,
            runId: 'fixture-run',
          })
        )
      );
    }
    const fixture = join(worktree, 'coordinator.mjs');
    writeFileSync(
      fixture,
      `
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const worktree=process.argv[2], helper=process.argv[3], mode=process.argv[4], loader=process.argv[5];
const sequence=mode.startsWith('sequencer'), index=Number(mode.split('-')[1])||1;
const lock=join(worktree,'.git/georoids-test-runner.lock'), runDirectory=join(worktree,'.performance/integration-shards/run-fixture'), directory=join(runDirectory,'shard-'+index);
mkdirSync(directory,{recursive:true});
const birth=pid=>spawnSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).stdout.trim();
const runId='fixture-run', nonce='a'.repeat(64);
const common={version:1,runId,worktree,lock,ownerPid:process.ppid,ownerStart:birth(process.ppid),coordinatorPid:process.pid,coordinatorStart:birth(process.pid),total:6,maxActive:3,sourceFingerprint:{sha256:'fixture-source'}};
writeFileSync(join(runDirectory,'manifest.json'),JSON.stringify(common),{mode:0o600});
const assignmentPath=join(runDirectory,'assignments.json');writeFileSync(assignmentPath,sequence?readFileSync(join(worktree,'planned.json')):JSON.stringify({version:2,runId,worktree,total:6,maxActive:3,inventory:Array.from({length:6},(_,i)=>({file:join(worktree,'tests/integration/file-'+i+'.test.ts')})),shards:Array.from({length:6},(_,i)=>({index:i+1,allocationWeight:1,files:[join(worktree,'tests/integration/file-'+i+'.test.ts')]}))}),{mode:0o600});
const assignmentSha256=createHash('sha256').update(readFileSync(assignmentPath)).digest('hex');
const script=mode.startsWith('installed-timing')?'node "$1" authorize "$$" "$PPID" "$2" "$3" >/dev/null || exit $?; node "$2/node_modules/vitest/vitest.mjs" run "$2/tests/integration" --root="$2" --config="$2/vitest.config.ts" --shard=1/6 --reporter="$4"':mode==='sequencer-ancestry'?'node "$1" authorize "$$" "$PPID" "$2" "$3" >/dev/null || exit $?; sleep 5':sequence?'node "$1" authorize "$$" "$PPID" "$2" "$3" >/dev/null || exit $?; node --import "$4" "$2/sequence.mjs"':'node "$1" authorize "$$" "$PPID" "$2" "$3"; status=$?; exit "$status"';
const child=spawn('bash',['-c',script,'fixture',helper,worktree,lock,mode==='installed-timing-sink'?join(worktree,'scripts/timing-failure-reporter.mjs'):mode==='installed-timing'?join(worktree,'scripts/integration-timing-reporter.mjs'):loader],{env:{...process.env,GEOROIDS_SHARD_MANIFEST:join(directory,'child.json'),GEOROIDS_SHARD_NONCE:mode==='nonce'?'b'.repeat(64):nonce,GEOROIDS_SHARD_RUN_ID:mode==='run'?'other-run':runId,SEQUENCE_FAULT:mode==='sequencer-digest'?'digest':mode==='sequencer-late'?'late':''},stdio:['ignore','pipe','pipe']});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
const record={...common,index,directory,runDirectory,nonce,assignmentPath,assignmentSha256,childPid:child.pid,childStart:birth(child.pid),vitePort:41001,serverPort:41002};
if(mode==='pid')record.childPid++;
if(mode==='owner')record.ownerPid++;
if(mode==='birth')record.childStart='wrong';
if(mode==='worktree')record.worktree='/wrong';
if(mode==='lock')writeFileSync(join(lock,'pid'),'1\\n');
if(mode!=='missing-manifest')setTimeout(()=>writeFileSync(join(directory,'child.json'),JSON.stringify(record),{mode:mode==='permissions'?0o644:0o600}),100);
if(mode==='sequencer-ancestry')setTimeout(()=>{const outside=spawn(process.execPath,['--import',loader,join(worktree,'sequence.mjs')],{env:{...process.env,GEOROIDS_SHARD_MANIFEST:join(directory,'child.json'),GEOROIDS_SHARD_NONCE:nonce,GEOROIDS_SHARD_RUN_ID:runId},stdio:['ignore','pipe','pipe']});outside.stdout.pipe(process.stdout);outside.stderr.pipe(process.stderr);outside.once('close',code=>{process.exitCode=code;child.kill('SIGTERM');});},250);
child.once('exit',(code)=>{if(!process.exitCode)process.exitCode=code??1;});
`
    );
    const result = await new Promise((accept, reject) => {
      const child = spawn(
        process.execPath,
        [fixture, worktree, testedHelper, mode, join(root, 'node_modules/tsx/dist/loader.mjs')],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => accept({ code, stdout, stderr }));
    });
    processOutput = result;
    if (timingMode) {
      const receipt = JSON.parse(
        readFileSync(
          join(worktree, '.performance/integration-shards/run-fixture/shard-1/file-timings.json'),
          'utf8'
        )
      );
      if (mode === 'installed-timing-sink') {
        assert.notEqual(result.code, 0);
        assert.equal(receipt.complete, false);
        assert.ok(
          receipt.evidenceErrors.some((error) => error.includes('installed callback sink failed'))
        );
        return result;
      }
      assert.equal(result.code, 0, result.stderr);
      assert.ok(
        cacheInventory(join(worktree, '.performance/vitest-cache')).some(([name]) =>
          name.endsWith('/results.json')
        ),
        'Installed Vitest results must remain in the fixture cache'
      );
      assert.equal(receipt.complete, true);
      assert.equal(receipt.files.length, 1);
      assert.equal(receipt.files[0].file, join(worktree, 'tests/integration/file-0.test.ts'));
      assert.ok(receipt.files[0].diagnostic.duration >= 15);
      assert.ok(receipt.files[0].phaseTotalMs >= receipt.files[0].diagnostic.duration);
    }
    return result;
  } finally {
    const sharedCacheAfter = sharedVitestCache();
    retainFixture(directory, mode, processOutput);
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(
      sharedCacheAfter,
      sharedCacheBefore,
      'Installed timing fixture must not write shared dependency caches'
    );
  }
}
test('actual child handshake waits for its issued PID manifest and rejects forged identities', async () => {
  const valid = await handshake('valid');
  assert.equal(valid.code, 0, valid.stderr);
  assert.match(valid.stdout, /41001\n41002\n/u);
  for (const mode of [
    'nonce',
    'run',
    'pid',
    'owner',
    'birth',
    'worktree',
    'lock',
    'permissions',
    'missing-manifest',
  ]) {
    const result = await handshake(mode);
    assert.notEqual(result.code, 0, `${mode} was authorized`);
    assert.equal(result.stdout, '');
  }
});

async function coordinatedFixture(mode) {
  const directory = mkdtempSync(join(tmpdir(), 'geo-shard-command-'));
  let processOutput;
  try {
    const git = spawnSync('git', ['init', '-q', directory], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(git.status, 0, git.stderr);
    fixtureCommonDir(directory);
    for (const name of ['scripts', 'node_modules/vitest', 'tests/integration', 'bin']) {
      mkdirSync(join(directory, name), { recursive: true });
    }
    for (const name of [
      'test-runner.sh',
      'process-tree.sh',
      'integration-shards.mjs',
      'integration-shard-plan.mjs',
      'integration-shard-weights.json',
      'integration-timing-reporter.mjs',
    ]) {
      writeFileSync(join(directory, 'scripts', name), readFileSync(join(root, 'scripts', name)), {
        mode: 0o755,
      });
    }
    writeFileSync(
      join(directory, 'node_modules/vitest/package.json'),
      JSON.stringify({ version: '5.0.1' })
    );
    if (mode === 'late-source-change') {
      const path = join(directory, 'scripts/integration-shards.mjs');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          "writeJson(join(runDirectory, 'artifact-index.json'), artifacts);",
          "writeJson(join(runDirectory, 'artifact-index.json'), artifacts); writeFileSync(join(worktree, 'tests/integration/file-0.test.ts'), 'late source edit');"
        )
      );
    }
    if (mode === 'reused-port-allocation') {
      const path = join(directory, 'scripts/integration-shards.mjs');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          "import { createServer } from 'node:net';",
          "import { createServer } from './fixture-port-allocator.mjs';"
        )
      );
      writeFileSync(
        join(directory, 'scripts/fixture-port-allocator.mjs'),
        `const held = new Set();
export function createServer() {
  let port;
  return {
    listening: false,
    once() {},
    listen(_port, _host, accept) {
      port = 40000;
      while (held.has(port)) port++;
      held.add(port);
      this.listening = true;
      queueMicrotask(accept);
    },
    address() { return { port }; },
    close(accept) {
      held.delete(port);
      this.listening = false;
      queueMicrotask(accept);
    }
  };
}
`
      );
    }
    writeFileSync(join(directory, '.env.example'), '');
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(directory, 'tests/integration', `file-${i}.test.ts`), '');
    }
    const modules = Array.from({ length: 6 }, (_, i) => ({
      file: join(realpathSync(directory), `tests/integration/file-${i}.test.ts`),
      name: `case-${i}`,
      location: { line: 1, column: 1 },
    }));
    writeFileSync(join(directory, 'fixture.json'), JSON.stringify(modules));
    writeFileSync(
      join(directory, 'node_modules/vitest/vitest.mjs'),
      `import {readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';import {spawn} from 'node:child_process';const output=process.argv.find(a=>a.startsWith('--json=')).slice(7);writeFileSync(output,readFileSync('fixture.json'));const home=process.env.GEOROIDS_TEST_SESSION_DIR,issued=JSON.parse(readFileSync(home+'/child.json','utf8')),cases=JSON.parse(readFileSync('fixture.json','utf8'));mkdirSync(home+'/environments',{recursive:true});for(let i=0;i<cases.length;i++)writeFileSync(home+'/environments/'+i+'.json',JSON.stringify({runId:issued.runId,file:cases[i].file,environment:process.argv.includes('--environment=node')?'node':'jsdom',workerPid:process.pid,node:process.version,vitest:'5.0.1',observedAt:Date.now()}));writeFileSync(home+'/collection.json',JSON.stringify({runId:issued.runId,files:cases.map(entry=>({file:entry.file,errors:[]})),unhandledErrors:[],node:process.version,vitest:'5.0.1',vite:'fixture',architecture:process.arch,platform:process.platform,completedAt:Date.now()}));const fault=process.env.FAULT;if(fault==='experiment-env-missing')unlinkSync(home+'/environments/0.json');if(fault==='experiment-collection-error'||fault==='experiment-unhandled'){const evidence=JSON.parse(readFileSync(home+'/collection.json','utf8'));if(fault==='experiment-collection-error')evidence.files[0].errors.push({message:'import collection failure'});else evidence.unhandledErrors.push({message:'unhandled collection failure'});writeFileSync(home+'/collection.json',JSON.stringify(evidence));}if(process.env.FAULT==='discovery-exit-code'){process.stderr.write('issued discovery entry failed\\n');process.exitCode=19;}if(process.env.FAULT==='owner-discovery-crash'){spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.env.GEOROIDS_TEST_SESSION_DIR+'/test-started.json',String(process.pid));setInterval(()=>{},1000);}`
    );
    writeFileSync(
      join(directory, 'bin/lsof'),
      '#!/usr/bin/env bash\nif [ "$FAULT" = port-inspection ]; then echo "inspection failed" >&2; exit 2; fi\nexit 1\n',
      { mode: 0o755 }
    );
    writeFileSync(join(directory, 'bin/curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(directory, 'bin/npx'),
      `#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync,unlinkSync,symlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
if(process.argv.includes('concurrently')) {
 const home=process.env.GEOROIDS_TEST_SESSION_DIR;
 if(process.env.FAULT.startsWith('console-fault')&&home.endsWith('shard-1')) {
  unlinkSync(home+'/output.log'); symlinkSync('/dev/full',home+'/output.log');
  if(process.env.FAULT==='console-fault-receipt')mkdirSync(home+'/console-receipt.json');
  process.stdout.write('actual owned child output\\n');
 }
 if(process.env.FAULT==='owner-slow-cleanup') { for(let i=0;i<3;i++)spawn(process.execPath,['-e',"const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)"],{stdio:'ignore'}); }
 const timer=setInterval(()=>{},1000); process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)});
}
else {
 const shard=Number(process.argv.find(a=>a.startsWith('--shard=')).slice(8).split('/')[0]);
 const output=process.argv.find(a=>a.startsWith('--outputFile.json=')).slice(18);
 const cases=JSON.parse(readFileSync('fixture.json','utf8'));
 const entry=cases[process.env.FAULT==='duplicate'&&shard===2?0:shard-1];
 const assertion={fullName:entry.name,location:entry.location,status:process.env.FAULT==='skip'&&shard===1?'skipped':'passed',failureMessages:process.env.FAULT==='evidence'&&shard===1?['receipt write failed']:[]};
 const report={success:true,numFailedTests:0,numPendingTests:0,numTodoTests:0,numFailedTestSuites:0,numPendingTestSuites:0,numTotalTests:1,numPassedTests:1,testResults:[{name:entry.file,status:'passed',assertionResults:[assertion]}]};
 if(!(process.env.FAULT==='missing'&&shard===1))writeFileSync(output,JSON.stringify(report));
 const {default:TimingReporter}=await import('../scripts/integration-timing-reporter.mjs');
 const timing=new TimingReporter();
 await timing.onTestRunStart(cases.map(entry=>({moduleId:entry.file})));
 const module={moduleId:entry.file,state:()=> 'passed',diagnostic:()=>({environmentSetupDuration:1,prepareDuration:2,setupDuration:3,collectDuration:4,duration:5})};
 await timing.onTestModuleQueued(module);await timing.onTestModuleCollected(module);await timing.onTestModuleStart(module);await timing.onTestModuleEnd(module);
 await timing.onTestRunEnd([module],[],'passed');
 if(shard===1&&process.env.FAULT==='timing-missing')unlinkSync(process.env.GEOROIDS_TEST_SESSION_DIR+'/file-timings.json');
 if(shard===1&&process.env.FAULT==='timing-incomplete'){const path=process.env.GEOROIDS_TEST_SESSION_DIR+'/file-timings.json';const receipt=JSON.parse(readFileSync(path));receipt.complete=false;writeFileSync(path,JSON.stringify(receipt));}
 if(shard===1&&process.env.FAULT==='execution-source-change')writeFileSync(entry.file,'changed source');
 if(shard===1&&process.env.FAULT==='timing-version'){const path=process.env.GEOROIDS_TEST_SESSION_DIR+'/file-timings.json';const receipt=JSON.parse(readFileSync(path));receipt.vitest='different';writeFileSync(path,JSON.stringify(receipt));}


 if(process.env.FAULT==='test-exit'&&shard===1)process.exit(7);
 if(process.env.FAULT==='timeout'||process.env.FAULT==='queue-deadline'||process.env.FAULT.startsWith('owner-')) { writeFileSync(process.env.GEOROIDS_TEST_SESSION_DIR+'/test-started.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000); }
}
`,
      { mode: 0o755 }
    );
    // npx is ESM under this fresh fixture's package boundary.
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    if (mode === 'registration-stop') {
      const runner = join(directory, 'scripts/test-runner.sh');
      writeFileSync(
        runner,
        readFileSync(runner, 'utf8').replace(
          '    DEV_PID=$!',
          () =>
            `    printf '{"pid":%s,"servicePid":%s}\\n' "$$" "$!" > "$SHARD_DIRECTORY/registration-interrupt.json"\n    kill -TERM "$$"\n    DEV_PID=$!`
        )
      );
    }
    if (mode === 'owner-slow-cleanup') {
      const runner = join(directory, 'scripts/test-runner.sh');
      writeFileSync(
        runner,
        readFileSync(runner, 'utf8').replace(
          '    local cleanup_succeeded=true',
          '    sleep 4\n    local cleanup_succeeded=true'
        )
      );
    }
    if (mode === 'cleanup') {
      const tree = join(directory, 'scripts/process-tree.sh');
      writeFileSync(
        tree,
        `${readFileSync(tree, 'utf8')}\neval "$(declare -f terminate_process_tree | sed '1s/terminate_process_tree/terminate_fixture_tree/')"\nterminate_process_tree() { terminate_fixture_tree "$@"; return 1; }\n`
      );
    }
    if (mode === 'owner-issuance-crash') {
      const helperPath = join(directory, 'scripts/integration-shards.mjs');
      writeFileSync(
        helperPath,
        readFileSync(helperPath, 'utf8')
          .replace(
            '      await delay(25);',
            "      writeJson(join(dirname(manifest), 'authorization-waiting.json'), { pid: process.pid, childPid });\n      await delay(25);"
          )
          .replace(
            '        const completion = captureChild(child, directory, stop);',
            "        writeJson(join(directory, 'issuance-paused.json'), { childPid: child.pid });\n        await delay(10000);\n        const completion = captureChild(child, directory, stop);"
          )
      );
    }
    if (mode === 'owner-unresponsive') {
      const path = join(directory, 'scripts/integration-shards.mjs');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          "process.on('SIGTERM', stop);",
          "process.on('SIGTERM', () => {});"
        )
      );
    }
    if (mode === 'queue-deadline') {
      const path = join(directory, 'scripts/integration-shards.mjs');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          'const END_TO_END_DEADLINE_MS = 600000;',
          'const END_TO_END_DEADLINE_MS = 1000;'
        )
      );
    }
    const result = await new Promise((accept, reject) => {
      const child = spawn(
        'bash',
        [
          join(directory, 'scripts/test-runner.sh'),
          mode.startsWith('experiment-') ? '--discovery-node' : '--shards=6',
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
            FAULT: mode,
            GEOROIDS_TEST_MAX_DURATION_SECONDS: mode === 'timeout' ? '1' : '1200',
            GEOROIDS_TEST_SHARD_RECEIPT:
              mode === 'output-sink' ? join(directory, 'missing-sink', 'review.json') : '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '',
        stderr = '';
      let interrupted = false;
      const interrupt = setInterval(() => {
        if (!mode.startsWith('owner-') || interrupted) {
          return;
        }
        const home = join(directory, '.performance/integration-shards');
        if (!existsSync(home)) {
          return;
        }
        const runName = readdirSync(home).find((name) => name.startsWith('run-'));
        if (!runName) {
          return;
        }
        const run = join(home, runName);
        if (mode === 'owner-issuance-crash') {
          const paused = readdirSync(run).find(
            (name) =>
              /^shard-\d+$/u.test(name) &&
              existsSync(join(run, name, 'issuance-paused.json')) &&
              existsSync(join(run, name, 'authorization-waiting.json'))
          );
          if (paused) {
            interrupted = true;
            const manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'));
            const spawned = JSON.parse(readFileSync(join(run, paused, 'spawn.json'), 'utf8'));
            const birth = spawnSync('ps', ['-p', String(spawned.childPid), '-o', 'lstart='], {
              encoding: 'utf8',
            });
            assert.equal(birth.status, 0);
            writeFileSync(
              join(run, paused, 'harness-child-birth.json'),
              JSON.stringify({ childPid: spawned.childPid, birth: birth.stdout.trim() })
            );
            process.kill(manifest.coordinatorPid, 'SIGKILL');
          }
          return;
        }
        const started = readdirSync(run).filter(
          (name) => /^shard-\d+$/u.test(name) && existsSync(join(run, name, 'test-started.json'))
        );
        if (
          mode === 'owner-discovery-crash' &&
          existsSync(join(run, 'discovery/test-started.json'))
        ) {
          interrupted = true;
          const manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'));
          process.kill(manifest.coordinatorPid, 'SIGKILL');
          return;
        }
        if (started.length < 3) {
          return;
        }
        interrupted = true;
        const manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'));
        if (mode === 'owner-provenance-failure') {
          for (const name of started) {
            const path = join(run, name, 'group-ownership.json');
            const record = JSON.parse(readFileSync(path, 'utf8'));
            record.empty = true;
            writeFileSync(path, JSON.stringify(record));
          }
          process.kill(manifest.coordinatorPid, 'SIGKILL');
          return;
        }
        if (mode === 'owner-killed') {
          child.kill('SIGKILL');
          setTimeout(() => {
            const blocked = spawnSync(
              'bash',
              [join(directory, 'scripts/test-runner.sh'), '--shards=6'],
              {
                cwd: directory,
                env: {
                  ...process.env,
                  PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
                  FAULT: mode,
                },
                encoding: 'utf8',
              }
            );
            assert.notEqual(blocked.status, 0);
            assert.match(blocked.stderr, /Unresolved coordinated cleanup/u);
            process.kill(manifest.coordinatorPid, 'SIGTERM');
          }, 50);
          return;
        }
        if (mode === 'owner-coordinator-crash') {
          process.kill(manifest.coordinatorPid, 'SIGKILL');
          return;
        }
        child.kill(mode === 'owner-int' ? 'SIGINT' : 'SIGTERM');
        if (mode === 'owner-repeated') {
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill('SIGTERM');
              child.kill('SIGINT');
            }
            try {
              process.kill(manifest.coordinatorPid, 'SIGTERM');
              process.kill(manifest.coordinatorPid, 'SIGINT');
            } catch (error) {
              if (error.code !== 'ESRCH') {
                throw error;
              }
            }
          }, 25);
        }
      }, 20);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => {
        clearInterval(interrupt);
        accept({ code, stdout, stderr });
      });
    });
    processOutput = result;
    const runs = readdirSync(join(directory, '.performance/integration-shards')).filter((name) =>
      name.startsWith('run-')
    );
    assert.equal(runs.length, 1);
    const run = join(directory, '.performance/integration-shards', runs[0]);
    const receipt = existsSync(join(run, 'result.json'))
      ? JSON.parse(readFileSync(join(run, 'result.json'), 'utf8'))
      : null;
    if (!receipt) {
      assert.ok(
        [
          'owner-unresponsive',
          'owner-coordinator-crash',
          'owner-provenance-failure',
          'owner-discovery-crash',
          'owner-issuance-crash',
        ].includes(mode)
      );
    }
    const queue = existsSync(join(run, 'queue.json'))
      ? JSON.parse(readFileSync(join(run, 'queue.json'), 'utf8'))
      : {
          launched: readdirSync(run)
            .filter((name) => /^shard-\d+$/u.test(name))
            .map((name) => Number(name.slice(6))),
          cancelled: [],
          interrupted: true,
        };
    if (mode === 'owner-issuance-crash') {
      const unissued = join(run, 'shard-1');
      const spawnRecord = JSON.parse(readFileSync(join(unissued, 'spawn.json'), 'utf8'));
      assert.equal(existsSync(join(unissued, 'child.json')), false);
      assert.doesNotThrow(() => process.kill(spawnRecord.childPid, 0));
      const observed = JSON.parse(readFileSync(join(unissued, 'harness-child-birth.json'), 'utf8'));
      const current = spawnSync('ps', ['-p', String(spawnRecord.childPid), '-o', 'lstart='], {
        encoding: 'utf8',
      });
      assert.equal(current.status, 0);
      assert.equal(current.stdout.trim(), observed.birth);
      const blocked = spawnSync('bash', [join(directory, 'scripts/test-runner.sh'), '--shards=6'], {
        cwd: directory,
        env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, FAULT: mode },
        encoding: 'utf8',
      });
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /Unresolved coordinated cleanup/u);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const probe = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
        if (
          !probe.stdout.split('\n').some((line) => {
            const [group, state] = line.trim().split(/\s+/u);
            return Number(group) === spawnRecord.childPid && !state?.startsWith('Z');
          })
        ) {
          break;
        }
        await new Promise((accept) => setTimeout(accept, 50));
      }
      const final = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
      assert.equal(
        final.stdout.split('\n').some((line) => {
          const [group, state] = line.trim().split(/\s+/u);
          return Number(group) === spawnRecord.childPid && !state?.startsWith('Z');
        }),
        false
      );
    }
    const directories = queue.launched
      .map((index) => join(run, `shard-${index}`))
      .filter((path) => mode !== 'owner-issuance-crash' || existsSync(join(path, 'child.json')));
    const manifests = directories.map((path) =>
      JSON.parse(readFileSync(join(path, 'child.json'), 'utf8'))
    );
    assert.equal(
      new Set(manifests.flatMap((m) => [m.vitePort, m.serverPort])).size,
      directories.length * 2
    );
    assert.equal(new Set(manifests.map((m) => m.childPid)).size, directories.length);
    const events = manifests.map((m) => [m.launchedAt, 1]);
    for (const path of directories) {
      const end = existsSync(join(path, 'process-exit.json'))
        ? JSON.parse(readFileSync(join(path, 'process-exit.json'), 'utf8'))
        : { finishedAt: Date.now() };
      events.push([end.finishedAt, -1]);
    }
    let active = 0;
    for (const [, delta] of events.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      active += delta;
      assert.ok(active <= 3);
    }
    if (mode === 'valid' || mode === 'late-source-change') {
      assert.equal(queue.launched.length, 6);
      const plan = JSON.parse(readFileSync(join(run, 'assignments.json'), 'utf8'));
      const heaviest = [...plan.shards]
        .sort((a, b) => b.estimatedFileMs - a.estimatedFileMs || a.index - b.index)
        .slice(0, 3)
        .map((shard) => shard.index);
      assert.deepEqual(queue.launched.slice(0, 3), heaviest);
      assert.ok(queue.launched.every((index) => plan.shards[index - 1].allocationWeight === 1));
      for (const later of manifests.slice(3)) {
        assert.ok(
          manifests.slice(0, 3).some((earlier) => {
            const cleanup = JSON.parse(
              readFileSync(join(run, `shard-${earlier.index}`, 'runner.json'), 'utf8')
            );
            return (
              cleanup.cleanupSucceeded &&
              JSON.parse(
                readFileSync(join(run, `shard-${earlier.index}`, 'process-exit.json'), 'utf8')
              ).finishedAt <= later.launchedAt
            );
          }),
          'Queue advanced before a verified runner cleanup'
        );
      }
    }
    for (const path of directories) {
      if (existsSync(join(path, 'runner.json'))) {
        const runner = JSON.parse(readFileSync(join(path, 'runner.json'), 'utf8'));
        if (mode === 'registration-stop') {
          assert.equal(runner.exitCode, 143);
          const boundary = JSON.parse(
            readFileSync(join(path, 'registration-interrupt.json'), 'utf8')
          );
          const issued = JSON.parse(readFileSync(join(path, 'child.json'), 'utf8'));
          assert.equal(boundary.pid, issued.childPid);
          assert.ok(boundary.servicePid > 0);
        }
        if (
          mode !== 'owner-coordinator-crash' &&
          mode !== 'owner-unresponsive' &&
          mode !== 'owner-provenance-failure'
        ) {
          assert.equal(runner.cleanupSucceeded, mode !== 'cleanup');
        }
      } else {
        assert.notEqual(
          mode,
          'late-source-change',
          'Late source rejection omitted cleanup evidence'
        );
        assert.ok(
          ['owner-unresponsive', 'owner-coordinator-crash', 'owner-provenance-failure'].includes(
            mode
          ) ||
            ![
              'valid',
              'owner-term',
              'owner-int',
              'owner-repeated',
              'owner-slow-cleanup',
              'queue-deadline',
            ].includes(mode),
          'Orderly shard omitted cleanup receipt'
        );
      }
      if (!(mode.startsWith('console-fault') && path.endsWith('shard-1'))) {
        assert.ok(statSync(join(path, 'output.log')).isFile());
      }
      assert.ok(statSync(join(path, 'screenshots')).isDirectory());
      assert.ok(statSync(join(path, 'cache')).isDirectory());
    }
    if (mode === 'owner-provenance-failure') {
      assert.equal(
        existsSync(join(directory, '.git/georoids-test-runner.lock/cleanup-failed.json')),
        true
      );
      const blocked = spawnSync('bash', [join(directory, 'scripts/test-runner.sh'), '--shards=6'], {
        cwd: directory,
        env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, FAULT: mode },
        encoding: 'utf8',
      });
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /Unresolved coordinated cleanup/u);
      for (const manifest of manifests) {
        const birth = spawnSync('ps', ['-p', String(manifest.childPid), '-o', 'lstart='], {
          encoding: 'utf8',
        });
        assert.equal(birth.stdout.trim(), manifest.childStart);
        process.kill(-manifest.childPid, 'SIGKILL');
      }
      await new Promise((accept) => setTimeout(accept, 100));
    }
    const discoveryIssued = JSON.parse(readFileSync(join(run, 'discovery/child.json'), 'utf8'));
    const groups = spawnSync('ps', ['-axo', 'pgid='], { encoding: 'utf8' });
    assert.equal(groups.status, 0);
    const liveGroups = new Set(groups.stdout.trim().split(/\s+/u).map(Number));
    assert.equal(
      liveGroups.has(discoveryIssued.childPid),
      false,
      'Owned discovery group survived owner exit'
    );
    for (const manifest of manifests) {
      assert.equal(
        liveGroups.has(manifest.childPid),
        false,
        'Owned shard group survived owner exit'
      );
    }
    assert.equal(
      existsSync(join(directory, '.git/georoids-test-runner.lock')),
      [
        'owner-provenance-failure',
        'port-inspection',
        'owner-killed',
        'owner-issuance-crash',
      ].includes(mode)
    );
    assert.equal(existsSync(join(directory, 'logs')), false);
    const ownerName = readdirSync(join(directory, '.performance/integration-shards')).find((name) =>
      name.startsWith('owner-')
    );
    const ownerPath = join(
      directory,
      '.performance/integration-shards',
      ownerName,
      'owner-cancellation.json'
    );
    const ownerReceipt = existsSync(ownerPath) ? JSON.parse(readFileSync(ownerPath, 'utf8')) : null;
    const stopReceipt = existsSync(join(run, 'stop.json'))
      ? JSON.parse(readFileSync(join(run, 'stop.json'), 'utf8'))
      : null;
    return {
      ...result,
      receipt,
      queue,
      ownerReceipt,
      stopReceipt,
      discovery: existsSync(join(run, 'discovery.json'))
        ? JSON.parse(readFileSync(join(run, 'discovery.json'), 'utf8'))
        : null,
    };
  } finally {
    retainFixture(directory, mode, processOutput);
    rmSync(directory, { recursive: true, force: true });
  }
}
test('six actual authenticated runner commands retain isolation and fail closed on child or evidence faults', async () => {
  const valid = await coordinatedFixture('valid');
  assert.equal(valid.code, 0, `${valid.stdout}\n${valid.stderr}`);
  assert.equal(valid.receipt.success, true);
  assert.equal(valid.receipt.equivalencePassed, true);
  assert.equal(valid.receipt.summary.cases, 6);
  const reusedPorts = await coordinatedFixture('reused-port-allocation');
  assert.equal(reusedPorts.code, 0, `${reusedPorts.stdout}\n${reusedPorts.stderr}`);
  assert.equal(reusedPorts.receipt.success, true);
  assert.equal(reusedPorts.receipt.summary.cases, 6);
  for (const fault of [
    'missing',
    'duplicate',
    'skip',
    'evidence',
    'test-exit',
    'timing-missing',
    'timing-incomplete',
    'timing-version',
    'execution-source-change',
    'cleanup',
    'timeout',
    'port-inspection',
    'output-sink',
    'console-fault',
    'console-fault-receipt',
  ]) {
    const result = await coordinatedFixture(fault);
    assert.notEqual(result.code, 0, `${fault} was accepted`);
    assert.equal(result.receipt.success, false);
    assert.ok(result.receipt.errors.length > 0);
    if (fault.startsWith('console-fault')) {
      assert.match(result.receipt.errors.join(' '), /ENOSPC|EPERM/u);
      assert.ok(result.queue.launched.length <= 3, 'Retention failure advanced the shard queue');
      if (fault === 'console-fault-receipt') {
        assert.match(result.receipt.errors.join(' '), /console-receipt/u);
      }
    }
  }
});

test('the real memory server starts with a long isolated temporary directory', {
  timeout: 15000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'geo-long-server-'));
  const temporary = join(
    directory,
    'isolated-session-directory-with-a-deliberately-long-resource-path'.repeat(3),
    'shard-1',
    'tmp'
  );
  mkdirSync(temporary, { recursive: true });
  const reservation = createServer();
  await new Promise((accept) => reservation.listen(0, '127.0.0.1', accept));
  const port = reservation.address().port;
  await new Promise((accept) => reservation.close(accept));
  const child = spawn(
    process.execPath,
    ['--env-file=.env.example', '--import', 'tsx', 'server.ts'],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        VITEST: 'false',
        PORT: String(port),
        GEOROIDS_WORLD_PATH: ':memory:',
        GEOROIDS_TEST_LOG_DIR: join(directory, 'logs'),
        TMPDIR: temporary,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const closed = new Promise((accept) =>
    child.once('close', (code, signal) => accept({ code, signal }))
  );
  try {
    let healthy = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(300),
        });
        healthy = response.status === 200;
        await response.arrayBuffer();
        if (healthy) {
          break;
        }
      } catch {
        /* Wait for the actual server listener. */
      }
      await delay(100);
    }
    assert.equal(healthy, true, output);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
    }
    const outcome = await closed;
    rmSync(directory, { recursive: true, force: true });
    assert.equal(outcome.code, 0, output);
  }
});

test('proposed whole-file weights balance every current integration file without excluding new or changed cases', () => {
  const weights = JSON.parse(
    readFileSync(join(root, 'scripts/integration-shard-weights.json'), 'utf8')
  );
  const files = integrationFiles(root);
  const discovery = weights.entries.flatMap((entry) =>
    Array.from({ length: entry.cases }, () => ({ file: join(root, entry.path) }))
  );
  const input = { worktree: root, files, discovery, weights, runId: 'plan-contract' };
  const plan = planShards(input);
  assert.equal(plan.inventory.length, 91);
  assert.equal(
    plan.shards.reduce((sum, shard) => sum + shard.cases, 0),
    210
  );
  assert.deepEqual(
    plan.shards.map((shard) => shard.allocationWeight),
    [1, 1, 1, 1, 1, 1]
  );
  assert.equal(plan.maxActive, 3);
  assert.ok(
    Math.abs(
      plan.shards.reduce((sum, shard) => sum + shard.estimatedFileMs, 0) -
        plan.inventory.reduce((sum, entry) => sum + entry.estimatedFileMs, 0)
    ) < 1e-6
  );
  assert.equal(weights.acceptedBaseline, false);
  assert.equal(
    weights.entries.filter((entry) => entry.provenance === 'validated-complete-child').length,
    60
  );
  assert.equal(
    weights.entries.filter((entry) => entry.provenance === 'partial-child-ended-row').length,
    28
  );
  assert.equal(
    weights.entries.reduce((sum, entry) => sum + entry.cases, 0),
    weights.caseCount
  );
  assert.ok(
    Math.abs(
      weights.entries.reduce((sum, entry) => sum + entry.wholeFileMs, 0) - weights.wholeFileMs
    ) < 1e-6
  );
  assert.equal(weights.status, 'PROPOSED_CENSORED_NOT_ACCEPTED_BASELINE');
  assert.equal(
    weights.entries.filter((entry) => entry.provenance === 'conservative-historical-fallback')
      .length,
    3
  );
  assert.throws(() => selectShard({ ...plan, maxActive: 4 }, files, 1, 6), /index\/count/u);
  assert.throws(
    () =>
      selectShard(
        { ...plan, shards: plan.shards.map((shard) => ({ ...shard, allocationWeight: 2 })) },
        files,
        1,
        6
      ),
    /allocation/u
  );

  const normalized = plan.shards.map((shard) => shard.estimatedFileMs / shard.allocationWeight);
  assert.ok(Math.max(...normalized) - Math.min(...normalized) < 2000);
  assert.ok(plan.shards.every((shard) => shard.files.length > 0));
  assert.deepEqual(
    planShards({ ...input, files: [...files].reverse(), discovery: [...discovery].reverse() }),
    plan
  );
  const selected = Array.from({ length: 6 }, (_, i) => selectShard(plan, files, i + 1, 6)).flat();
  assert.equal(new Set(selected).size, files.length);
  assert.deepEqual([...selected].sort(), files);
  const added = join(root, 'tests/integration/new-contract.test.ts');
  const extended = planShards({
    ...input,
    files: [...files, added],
    discovery: [...discovery, { file: added }, { file: files[0] }],
  });
  assert.equal(extended.inventory.find((entry) => entry.file === added).fallback, 'new-file');
  assert.equal(
    extended.inventory.find((entry) => entry.file === files[0]).fallback,
    'case-count-changed'
  );
  assert.ok(extended.inventory.every((entry) => entry.estimatedFileMs > 0));
  assert.throws(() => planShards({ ...input, files: [...files, files[0]] }), /Duplicate/u);
  assert.throws(
    () =>
      planShards({
        ...input,
        weights: { ...weights, entries: [...weights.entries, weights.entries[0]] },
      }),
    /Duplicate/u
  );
  assert.throws(
    () =>
      planShards({
        ...input,
        weights: { ...weights, entries: [{ ...weights.entries[0], wholeFileMs: 0 }] },
      }),
    /positive/u
  );
  assert.throws(() => selectShard(plan, [...files, added], 1, 6), /inventory/u);
  assert.throws(() => selectShard(plan, [...files, files[0]], 1, 6), /inventory/u);
  assert.throws(() => selectShard(plan, files, 1, 5), /index\/count/u);
  assert.throws(
    () =>
      selectShard(
        {
          ...plan,
          shards: plan.shards.map((shard) => ({
            ...shard,
            files: shard.index === 1 ? [...shard.files, files[0]] : shard.files,
          })),
        },
        files,
        1,
        6
      ),
    /inventory/u
  );
});

test('the installed Vitest sequencer selects each issued bucket and rejects changed evidence or late candidates', async () => {
  const weights = JSON.parse(
    readFileSync(join(root, 'scripts/integration-shard-weights.json'), 'utf8')
  );
  const inventory = integrationFiles(root);
  const discovery = weights.entries.flatMap((entry) =>
    Array.from({ length: entry.cases }, () => ({ file: join(root, entry.path) }))
  );
  const expected = planShards({
    worktree: root,
    files: inventory,
    discovery,
    weights,
    runId: 'fixture-run',
  });
  const relative = (file) => file.slice(file.indexOf('/tests/integration/') + 1);
  const selected = [];
  assert.equal(inventory.length, 91);
  for (let index = 1; index <= 6; index++) {
    const result = await handshake(`sequencer-${index}`);
    assert.equal(result.code, 0, result.stderr);
    const files = JSON.parse(result.stdout.trim()).map(relative);
    assert.deepEqual([...files].sort(), expected.shards[index - 1].files.map(relative).sort());
    selected.push(...files);
  }
  assert.equal(new Set(selected).size, 91);
  assert.deepEqual([...selected].sort(), inventory.map(relative).sort());
  for (const mode of ['sequencer-digest', 'sequencer-late', 'sequencer-ancestry']) {
    const result = await handshake(mode);
    assert.notEqual(result.code, 0, `${mode}: ${result.stderr}`);
  }
});

test('actual owner TERM and INT preserve queued cancellation receipts despite repeated signals', async () => {
  for (const mode of [
    'owner-term',
    'owner-int',
    'owner-repeated',
    'owner-slow-cleanup',
    'queue-deadline',
  ]) {
    const result = await coordinatedFixture(mode);
    assert.notEqual(result.code, 0);
    assert.equal(result.receipt.success, false);
    assert.equal(result.queue.launched.length, 3);
    assert.equal(result.queue.cancelled.length, 3);
    assert.equal(result.queue.interrupted, true);
    assert.equal(new Set(result.stopReceipt.termSentPids).size, 3);
    assert.equal(result.stopReceipt.termSentPids.length, 3);
    if (mode.startsWith('owner-')) {
      assert.equal(result.ownerReceipt.receiptValidated, true, result.stderr);
      assert.equal(result.ownerReceipt.fallbackUsed, false, result.stderr);
      assert.equal(result.ownerReceipt.success, false);
    }
  }
});

test('an unresponsive coordinator ends the real owner grace period in retained failure-marked fallback', async () => {
  const started = Date.now();
  const result = await coordinatedFixture('owner-unresponsive');
  assert.notEqual(result.code, 0);
  assert.equal(result.ownerReceipt.receiptValidated, false);
  assert.equal(result.ownerReceipt.fallbackUsed, true);
  assert.equal(result.ownerReceipt.success, false);
  assert.ok(Date.now() - started >= 29000);
  assert.ok(Date.now() - started < 45000);
  if (result.receipt) {
    assert.equal(result.receipt.success, false);
  }
});

test('a killed coordinator cannot release its owner lock while detached shard groups survive', async () => {
  const result = await coordinatedFixture('owner-coordinator-crash');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /owned fallback required/u);
});

test('cleanup refuses a reused leader or permanently empty group without signaling its new occupants', async () => {
  for (const empty of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'geo-group-provenance-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const closed = new Promise((accept) => child.once('close', accept));
    try {
      const birth = spawnSync('ps', ['-p', String(child.pid), '-o', 'lstart='], {
        encoding: 'utf8',
      }).stdout.trim();
      const issued = {
        pid: child.pid,
        childStart: empty ? birth : 'earlier occupant',
        directory,
        index: 1,
      };
      if (empty) {
        writeFileSync(
          join(directory, 'group-ownership.json'),
          JSON.stringify({ group: child.pid, childStart: birth, empty: true, members: [] })
        );
      }
      await assert.rejects(
        cleanGroup(issued),
        empty ? /was reused/u : /No proven ownership anchor/u
      );
      assert.doesNotThrow(() => process.kill(child.pid, 0));
    } finally {
      process.kill(-child.pid, 'SIGKILL');
      await Promise.resolve(closed);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('cleanup keeps a retained descendant anchor after its issued runner exits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'geo-group-anchor-'));
  const marker = join(directory, 'descendant.json');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[1],String(c.pid));c.unref();setTimeout(()=>process.exit(0),500);`,
      marker,
    ],
    { detached: true, stdio: 'ignore' }
  );
  const closed = new Promise((accept) => child.once('close', accept));
  try {
    const birth = spawnSync('ps', ['-p', String(child.pid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).stdout.trim();
    const issued = { pid: child.pid, childStart: birth, directory, index: 1 };
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await delay(10);
    }
    assert.equal(existsSync(marker), true);
    assert.ok(retainGroup(issued).length >= 2);
    await Promise.resolve(closed);
    await cleanGroup(issued);
    assert.deepEqual(retainGroup(issued), []);
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
    }
    await Promise.resolve(closed);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unresolved group ownership retains its lock and blocks a second runner after the owner exits', async () => {
  const result = await coordinatedFixture('owner-provenance-failure');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Retaining test-runner lock/u);
});

test('a killed coordinator during expanded discovery closes its issued worker group before releasing the owner lock', async () => {
  const result = await coordinatedFixture('owner-discovery-crash');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /owned fallback required/u);
});

test('a killed lock owner leaves durable ownership proof that blocks a second runner', async () => {
  await coordinatedFixture('owner-killed');
});

test('TERM between service spawn and PID registration is honored after registration and leaves no descendants', async () => {
  const result = await coordinatedFixture('registration-stop');
  assert.notEqual(result.code, 0);
});

test('inherited output pipes cannot hold an exited runner open or turn lost cleanup into success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'geo-output-close-'));
  const marker = join(directory, 'descendant.json');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});writeFileSync(process.argv[1],String(c.pid));c.unref();setTimeout(()=>process.exit(0),500);`,
      marker,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const completion = captureChild(child, directory);
  const birth = spawnSync('ps', ['-p', String(child.pid), '-o', 'lstart='], {
    encoding: 'utf8',
  }).stdout.trim();
  const issued = { pid: child.pid, childStart: birth, directory, index: 1 };
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await delay(10);
    }
    assert.equal(existsSync(marker), true);
    assert.ok(retainGroup(issued).length >= 2);
    const outcome = await completion;
    assert.equal(outcome.code, 0);
    assert.ok(outcome.outputErrors.some((error) => error.sink === 'output-close'));
    await cleanGroup(issued);
    assert.deepEqual(retainGroup(issued), []);
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
    }
    await completion;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an authenticated discovery entry cannot mask its nonzero exit with a complete case inventory', async () => {
  const result = await coordinatedFixture('discovery-exit-code');
  assert.notEqual(result.code, 0);
  assert.equal(result.receipt.success, false);
  assert.match(result.receipt.errors.join(' '), /"code":19/u);
  assert.equal(result.queue.launched.length, 0);
});

test('coordinator loss between child spawn and manifest issuance retains unresolved ownership and blocks a second runner', async () => {
  const result = await coordinatedFixture('owner-issuance-crash');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Retaining test-runner lock/u);
});

test('the explicit Node discovery experiment fails closed on collected errors or incomplete resolved environments', async () => {
  const result = await coordinatedFixture('experiment-node');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.receipt.discoveryOnly, true);
  assert.equal(result.receipt.success, false);
  assert.equal(result.queue.launched.length, 0);
  assert.equal(result.discovery.discoveryEnvironment, 'node');
  assert.ok(
    result.discovery.evidence.environments.every((record) => record.environment === 'node')
  );
  for (const fault of [
    'experiment-env-missing',
    'experiment-collection-error',
    'experiment-unhandled',
  ]) {
    const failed = await coordinatedFixture(fault);
    assert.notEqual(failed.code, 0);
    assert.equal(failed.receipt.success, false);
    assert.equal(failed.queue.launched.length, 0);
  }
});

async function installedDiscoveryFixture(
  option,
  fault = '',
  treatment = '',
  inherited = process.env
) {
  const sharedCacheBefore = sharedVitestCache();
  const directory = mkdtempSync(join(tmpdir(), 'geo-installed-discovery-'));
  let output;
  try {
    const git = spawnSync('git', ['init', '-q', directory], { encoding: 'utf8', env: inherited });
    assert.equal(git.status, 0, git.stderr);
    fixtureCommonDir(directory);
    mkdirSync(join(directory, 'scripts'));
    mkdirSync(join(directory, 'tests/integration'), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    writeFileSync(join(directory, '.gitignore'), 'node_modules\n.performance\n.env.local\n');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    for (const name of [
      'test-runner.sh',
      'process-tree.sh',
      'integration-shards.mjs',
      'integration-shard-plan.mjs',
      'integration-discovery-probe.mjs',
      'integration-discovery-evidence.mjs',
    ]) {
      writeFileSync(join(directory, 'scripts', name), readFileSync(join(root, 'scripts', name)));
    }
    writeFileSync(
      join(directory, 'vitest.discovery.config.mjs'),
      readFileSync(join(root, 'vitest.discovery.config.mjs'))
    );
    writeFileSync(
      join(directory, 'vitest.browser.config.ts'),
      `import {defineConfig} from 'vitest/config';export default defineConfig({cacheDir:${JSON.stringify(join(directory, '.performance/vitest-cache'))},test:{environment:'jsdom',includeTaskLocation:true,setupFiles:['./setup.mjs']${fault === 'global' ? ",globalSetup:['./global-setup.mjs']" : ''}}});`
    );
    writeFileSync(
      join(directory, 'setup.mjs'),
      fault === 'cache-cancel'
        ? "import {writeFileSync} from 'node:fs';writeFileSync('collector-started','started');await new Promise(resolve=>setTimeout(resolve,60000));"
        : fault === 'cache-symlink'
          ? "import {mkdirSync,rmSync,symlinkSync} from 'node:fs';import {dirname,join} from 'node:path';const cache=process.env.NODE_COMPILE_CACHE;const sibling=join(dirname(cache),'owned-cache-sibling');mkdirSync(sibling);rmSync(cache,{recursive:true,force:true});symlinkSync(sibling,cache,'dir');"
          : fault === 'cache-missing'
            ? "import {rmSync} from 'node:fs';rmSync(process.env.NODE_COMPILE_CACHE,{recursive:true,force:true});"
            : fault === 'cache-mismatch'
              ? "process.env.NODE_COMPILE_CACHE='/invalid-cache';"
              : fault === 'source-change'
                ? "import {writeFileSync} from 'node:fs';writeFileSync('changed-source.ts','changed');"
                : fault === 'sink'
                  ? "import {mkdirSync} from 'node:fs';mkdirSync(process.env.GEOROIDS_TEST_SESSION_DIR+'/collection.json');"
                  : ''
    );
    writeFileSync(
      join(directory, 'global-setup.mjs'),
      "throw new Error('collection global setup rejected');"
    );
    writeFileSync(
      join(directory, 'tests/integration/dynamic.test.ts'),
      `import {describe,it,beforeAll,afterAll,beforeEach,afterEach} from 'vitest';
import {writeFileSync} from 'node:fs';
const unexpected=()=>{writeFileSync('hook-or-test-ran','unexpected');throw new Error('collection executed a body');};
beforeAll(unexpected);afterAll(unexpected);beforeEach(unexpected);afterEach(unexpected);
describe.each([1,2])('expanded suite %s',()=>{it.each([3,4])('expanded test %s',unexpected);});
${fault === 'file' ? "throw new Error('collection file rejected after registration');" : ''}
${fault === 'document' ? "if(typeof document!=='undefined')it('document-dependent registration',unexpected);" : ''}`
    );
    writeFileSync(
      join(directory, 'tests/integration/dom-pragma.test.ts'),
      `// @vitest-environment jsdom
import {it} from 'vitest';it('pragma retains its actual DOM environment',()=>{throw new Error('body ran');});`
    );
    const args = [join(directory, 'scripts/test-runner.sh'), option];
    if (treatment) {
      args.push(`--native-compile-cache=${treatment}`);
    }
    if (fault === 'flags') {
      args.push('--environment=jsdom');
    }
    output = await new Promise((accept, reject) => {
      const child = spawn('bash', args, {
        cwd: directory,
        env: {
          ...inherited,
          ...(fault === 'coverage' ? { NODE_V8_COVERAGE: join(directory, 'coverage') } : {}),
          ...(fault === 'cache-flags' ? { NODE_OPTIONS: '--no-compilation-cache' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const cancellation =
        fault === 'cache-cancel'
          ? setInterval(() => {
              if (existsSync(join(directory, 'collector-started'))) {
                clearInterval(cancellation);
                child.kill('SIGTERM');
              }
            }, 20)
          : undefined;
      child.once('error', reject);
      child.once('close', (code) => {
        clearInterval(cancellation);
        accept({ code, stdout, stderr });
      });
    });
    assert.equal(existsSync(join(directory, 'hook-or-test-ran')), false);
    assert.equal(existsSync(join(directory, '.git/georoids-test-runner.lock')), false);
    if (fault === 'flags') {
      assert.notEqual(output.code, 0);
      assert.match(
        output.stderr,
        treatment
          ? /Native compile-cache options require --discovery-node/u
          : /unsupported argument/u
      );
      return output;
    }
    if (['coverage', 'cache-flags'].includes(fault)) {
      assert.notEqual(output.code, 0);
      assert.match(output.stderr, /refuses coverage or conflicting Node options/u);
      return { ...output, receipt: { success: false } };
    }
    const home = join(directory, '.performance/integration-shards');
    const runName = readdirSync(home).find((name) => name.startsWith('run-'));
    const run = join(home, runName);
    const receipt = JSON.parse(readFileSync(join(run, 'result.json'), 'utf8'));
    assert.equal(receipt.discoveryOnly, true);
    assert.equal(receipt.equivalencePassed, false);
    assert.equal(receipt.success, false);
    assert.deepEqual(JSON.parse(readFileSync(join(run, 'queue.json'), 'utf8')).launched, []);
    if (!existsSync(join(run, 'discovery/child.json'))) {
      return { ...output, receipt };
    }
    const issued = JSON.parse(readFileSync(join(run, 'discovery/child.json'), 'utf8'));
    const groups = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
    assert.equal(groups.status, 0);
    assert.equal(
      groups.stdout.split('\n').some((line) => {
        const [group, state] = line.trim().split(/\s+/u);
        return Number(group) === issued.childPid && !state?.startsWith('Z');
      }),
      false
    );
    const discovery = existsSync(join(run, 'discovery.json'))
      ? JSON.parse(readFileSync(join(run, 'discovery.json'), 'utf8'))
      : null;
    return {
      ...output,
      fixtureCommonDirectory: fixtureCommonDir(directory, inherited),
      fixtureDirectory: realpathSync(directory),
      discovery,
      receipt,
      collectionPresent: existsSync(join(run, 'discovery/collection.json')),
      cacheSnapshot: existsSync(join(run, 'discovery/native-cache-collection.json'))
        ? JSON.parse(readFileSync(join(run, 'discovery/native-cache-collection.json'), 'utf8'))
        : null,
    };
  } finally {
    const sharedCacheAfter = sharedVitestCache();
    retainFixture(directory, `installed-discovery-${option}-${fault}`, output);
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(
      sharedCacheAfter,
      sharedCacheBefore,
      'Installed discovery fixture must not write shared dependency caches'
    );
  }
}

test('installed Vitest collection emits fresh errors and actual environments without running hooks, tests, or services', async () => {
  const node = await installedDiscoveryFixture('--discovery-node');
  assert.equal(node.code, 0, `${node.stdout}\n${node.stderr}`);
  assert.equal(node.collectionPresent, true);
  assert.equal(node.discovery.cases.length, 5);
  assert.deepEqual(
    node.discovery.evidence.environments.map((record) => record.environment).sort(),
    ['jsdom', 'node']
  );
  const dom = await installedDiscoveryFixture('--discover-integration');
  assert.equal(dom.code, 0, `${dom.stdout}\n${dom.stderr}`);
  assert.deepEqual(
    dom.discovery.evidence.environments.map((record) => record.environment),
    ['jsdom', 'jsdom']
  );
  const file = await installedDiscoveryFixture('--discovery-node', 'file');
  assert.notEqual(file.code, 0);
  assert.match(file.stdout + file.stderr, /Discovery failed/u);
  const global = await installedDiscoveryFixture('--discovery-node', 'global');
  assert.notEqual(global.code, 0);
  assert.equal(global.collectionPresent, false);
  assert.equal(global.discovery, null);
  const sink = await installedDiscoveryFixture('--discovery-node', 'sink');
  assert.notEqual(sink.code, 0);
  await installedDiscoveryFixture('--discovery-node', 'flags');
});

test('document-dependent registration cannot hide extra or missing cases behind successful shard metadata', async () => {
  const node = await installedDiscoveryFixture('--discovery-node', 'document');
  const dom = await installedDiscoveryFixture('--discover-integration', 'document');
  assert.equal(node.code, 0, node.stdout + node.stderr);
  assert.equal(dom.code, 0, dom.stdout + dom.stderr);
  const normalize = (entries) =>
    entries.map((entry) => ({
      ...entry,
      file: `/fixture/tests/integration/${basename(entry.file)}`,
    }));
  const nodeCases = normalize(node.discovery.cases);
  const domCases = normalize(dom.discovery.cases);
  assert.equal(nodeCases.length, 5);
  assert.equal(domCases.length, 6);
  const filler = fixtureReports();
  const build = (cases) => {
    const files = [...new Set(cases.map((entry) => entry.file))].sort();
    const reports = files.map((file) => {
      const entries = cases.filter((entry) => entry.file === file);
      const report = structuredClone(filler.reports[0]);
      report.numTotalTests = entries.length;
      report.numPassedTests = entries.length;
      report.testResults = [
        {
          name: file,
          status: 'passed',
          assertionResults: entries.map((entry) => ({
            fullName: entry.name,
            location: entry.location,
            status: 'passed',
            failureMessages: [],
          })),
        },
      ];
      return report;
    });
    return {
      files: [...files, ...filler.files.slice(2)].sort(),
      reports: [...reports, ...filler.reports.slice(2)],
      cases: [...cases, ...filler.discovery.slice(2)],
    };
  };
  const expectedNode = build(nodeCases),
    expectedDom = build(domCases);
  assert.equal(
    aggregateReports(expectedNode.cases, expectedNode.files, expectedNode.reports).cases,
    9
  );
  assert.equal(
    aggregateReports(expectedDom.cases, expectedDom.files, expectedDom.reports).cases,
    10
  );
  assert.throws(
    () => aggregateReports(expectedNode.cases, expectedNode.files, expectedDom.reports),
    /missing or changed integration cases/u
  );
  assert.throws(
    () => aggregateReports(expectedDom.cases, expectedDom.files, expectedNode.reports),
    /missing or changed integration cases/u
  );
  const zero = structuredClone(expectedNode.reports);
  zero[0].testResults[0].assertionResults = [];
  zero[0].numTotalTests = 0;
  zero[0].numPassedTests = 0;
  assert.throws(
    () => aggregateReports(expectedNode.cases, expectedNode.files, zero),
    /Incomplete file/u
  );
});

test('installed Vitest reports the full pre-shard inventory and only selected execution phases', async () => {
  const result = await handshake('installed-timing');
  assert.equal(result.code, 0, result.stderr);
});

async function timingFixture(run) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'geo-timing-contract-')));
  try {
    const files = [0, 1].map((index) => join(directory, `file-${index}.test.ts`));
    for (const file of files) {
      writeFileSync(file, '');
    }
    const issued = {
      runId: 'timing-run',
      index: 1,
      worktree: directory,
      directory,
      sourceFingerprint: { sha256: 'source' },
      plan: {
        inventory: files.map((file) => ({ file })),
        shards: [{ index: 1, files: [files[0]] }],
      },
    };
    const module = {
      moduleId: files[0],
      state: () => 'passed',
      diagnostic: () => ({
        environmentSetupDuration: 1,
        prepareDuration: 2,
        setupDuration: 3,
        collectDuration: 4,
        duration: 5,
        importDurations: { duplicate: 1000 },
      }),
    };
    await run({ issued, module, files });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
async function timingLifecycle(recorder, module) {
  await recorder.onTestModuleQueued(module);
  await recorder.onTestModuleCollected(module);
  await recorder.onTestModuleStart(module);
  await recorder.onTestModuleEnd(module);
}
test('timing evidence sums each phase once and rejects changed identities or omitted files', async () => {
  await timingFixture(async ({ issued, module, files }) => {
    let receipt;
    let tick = 0;
    const recorder = createTimingRecorder(
      issued,
      (_path, value) => {
        receipt = value;
      },
      () => tick++
    );
    await recorder.onTestRunStart(files.map((moduleId) => ({ moduleId })));
    await timingLifecycle(recorder, module);
    await recorder.onTestRunEnd([module], [], 'passed');
    assert.equal(receipt.files[0].phaseTotalMs, 15);
    assert.equal(receipt.files[0].reporterObservedStartedToEndMs, 2);
    validateTimingReport(receipt, issued, [files[0]]);
    for (const change of [
      (r) => (r.runId = 'other'),
      (r) => (r.node = undefined),
      (r) => (r.node = 'different'),
      (r) => (r.vitest = undefined),
      (r) => (r.vitest = 'different'),
      (r) => (r.complete = false),
      (r) => (r.files = []),
      (r) => (r.files[0].phaseTotalMs = 1015),
      (r) => (r.files[0].diagnostic.duration = -1),
      (r) => (r.files[0].state = 'failed'),
    ]) {
      const invalid = structuredClone(receipt);
      change(invalid);
      assert.throws(() => validateTimingReport(invalid, issued, [files[0]]));
    }
  });
});
test('timing interruption retains completed rows without certifying a successful measurement', async () => {
  await timingFixture(async ({ issued, module, files }) => {
    for (const reason of ['interrupted', 'failed']) {
      let receipt;
      const recorder = createTimingRecorder(issued, (_path, value) => {
        receipt = value;
      });
      await recorder.onTestRunStart(files.map((moduleId) => ({ moduleId })));
      await timingLifecycle(recorder, module);
      await recorder.onTestRunEnd([module], [], reason);
      assert.equal(receipt.complete, false);
      assert.equal(receipt.files[0].ended, true);
      assert.throws(() => validateTimingReport(receipt, issued, [files[0]]));
    }
  });
});
test('timing writes serialize and an initial failed write remains fatal after successful writes', async () => {
  await timingFixture(async ({ issued, module, files }) => {
    let receipt,
      writes = 0,
      active = 0,
      maxActive = 0;
    const recorder = createTimingRecorder(issued, async (_path, value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(2);
      active--;
      if (++writes === 1) {
        throw new Error('timing sink failed');
      }
      receipt = value;
    });
    await assert.rejects(
      recorder.onTestRunStart(files.map((moduleId) => ({ moduleId }))),
      /timing sink failed/u
    );
    const results = await Promise.allSettled([
      recorder.onTestModuleQueued(module),
      recorder.onTestModuleCollected(module),
      recorder.onTestModuleStart(module),
      recorder.onTestModuleEnd(module),
    ]);
    assert.ok(results.every((result) => result.status === 'rejected'));
    await assert.rejects(recorder.onTestRunEnd([module], [], 'passed'), /timing sink failed/u);
    assert.equal(maxActive, 1);
    assert.equal(receipt.complete, false);
    assert.ok(receipt.evidenceErrors.length > 0);
  });
});
test('timing unknown modules, duplicate events, incomplete lifecycle and invalid phases fail closed', async () => {
  await timingFixture(async ({ issued, module, files }) => {
    for (const fault of ['unknown', 'duplicate', 'missing', 'numeric', 'unhandled', 'inventory']) {
      let receipt;
      const recorder = createTimingRecorder(issued, (_path, value) => {
        receipt = value;
      });
      if (fault === 'inventory') {
        await assert.rejects(recorder.onTestRunStart([{ moduleId: files[0] }]), /inventory/u);
        continue;
      }
      await recorder.onTestRunStart(files.map((moduleId) => ({ moduleId })));
      if (fault === 'unknown') {
        await assert.rejects(
          recorder.onTestModuleQueued({ ...module, moduleId: files[1] }),
          /assignment/u
        );
        continue;
      }
      if (fault === 'duplicate') {
        await recorder.onTestModuleQueued(module);
        await assert.rejects(recorder.onTestModuleQueued(module), /duplicate/u);
        continue;
      }
      if (fault === 'numeric') {
        await recorder.onTestModuleQueued(module);
        await recorder.onTestModuleCollected(module);
        await recorder.onTestModuleStart(module);
        await assert.rejects(
          recorder.onTestModuleEnd({
            ...module,
            diagnostic: () => ({ ...module.diagnostic(), duration: NaN }),
          }),
          /phase/u
        );
        continue;
      }
      if (fault !== 'missing') {
        await timingLifecycle(recorder, module);
      }
      if (fault === 'missing') {
        await assert.rejects(recorder.onTestRunEnd([module], [], 'passed'));
      } else {
        await recorder.onTestRunEnd([module], [new Error('unhandled')], 'passed');
      }
      assert.equal(receipt.complete, false);
    }
  });
});

test('installed Vitest callback persistence failure exits nonzero and retains sticky incomplete evidence', async () => {
  const result = await handshake('installed-timing-sink');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /installed callback sink failed/u);
});
test('a source edit after cleanup and artifact retention cannot certify measurement', async () => {
  const result = await coordinatedFixture('late-source-change');
  assert.notEqual(result.code, 0);
  assert.equal(result.receipt.success, false);
  assert.match(result.receipt.errors.join(' '), /before final measurement acceptance/u);
});

test('native compile-cache environment normalizes controls and refuses existing paths, symlinks, coverage and conflicting flags', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'geo-native-cache-contract-')));
  try {
    const inherited = {
      NODE_COMPILE_CACHE: '/outside',
      NODE_DISABLE_COMPILE_CACHE: '1',
      NODE_COMPILE_CACHE_PORTABLE: '1',
      NODE_COMPILE_CACHE_READONLY: '1',
      NODE_COMPILE_CACHE_READ_ONLY: '1',
      KEEP: 'unchanged',
    };
    const disabled = compileCacheEnvironment('disabled', directory, inherited);
    assert.equal(disabled.NODE_DISABLE_COMPILE_CACHE, '1');
    for (const key of [
      'NODE_COMPILE_CACHE',
      'NODE_COMPILE_CACHE_PORTABLE',
      'NODE_COMPILE_CACHE_READONLY',
      'NODE_COMPILE_CACHE_READ_ONLY',
    ]) {
      assert.equal(disabled[key], undefined);
    }
    const cold = compileCacheEnvironment('cold', directory, inherited);
    assert.equal(cold.NODE_COMPILE_CACHE, join(directory, 'native-compile-cache'));
    assert.equal(cold.KEEP, 'unchanged');
    assert.equal(cold.NODE_DISABLE_COMPILE_CACHE, undefined);
    assert.throws(() => compileCacheEnvironment('cold', directory, {}), /exist/u);
    rmSync(cold.NODE_COMPILE_CACHE, { recursive: true });
    symlinkSync(tmpdir(), cold.NODE_COMPILE_CACHE, 'dir');
    assert.throws(() => compileCacheEnvironment('cold', directory, {}), /exist/u);
    assert.throws(
      () => compileCacheEnvironment('cold', directory, { NODE_V8_COVERAGE: '/coverage' }),
      /coverage/u
    );
    assert.throws(
      () => compileCacheEnvironment('cold', directory, { NODE_OPTIONS: '--no-compilation-cache' }),
      /options/u
    );
    assert.throws(() => compileCacheEnvironment('unknown', directory, {}), /Unknown/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('installed isolated Vitest workers observe issued disabled/cold cache treatments without executing bodies', async () => {
  for (const treatment of ['disabled', 'cold']) {
    const result = await installedDiscoveryFixture('--discovery-node', '', treatment);
    assert.equal(result.code, 0, result.stderr);
    const workers = result.discovery.evidence.environments;
    assert.equal(workers.length, 2);
    assert.equal(new Set(workers.map((record) => record.workerPid)).size, 2);
    assert.ok(workers.every((record) => record.nativeCompileCache.treatment === treatment));
    assert.equal(result.receipt.nativeCompileCacheDiagnostic.treatment, treatment);
    assert.equal(result.cacheSnapshot.complete, true);
    assert.equal(result.cacheSnapshot.files.length, 2);
    assert.ok(
      result.cacheSnapshot.files.every(
        (row) => row.diagnostic.duration === 0 && row.diagnostic.collectDuration > 0
      )
    );
    assert.ok(
      result.cacheSnapshot.snapshotFinishedBeforeWrite.monotonicMs >=
        result.cacheSnapshot.snapshotStartedAt.monotonicMs
    );
    assert.equal(result.receipt.success, false);
  }
  for (const fault of [
    'cache-missing',
    'cache-cancel',
    'cache-symlink',
    'cache-mismatch',
    'source-change',
    'coverage',
    'cache-flags',
    'sink',
  ]) {
    const result = await installedDiscoveryFixture('--discovery-node', fault, 'cold');
    assert.notEqual(result.code, 0, fault);
    assert.equal(result.receipt.success, false);
    if (fault === 'sink') {
      assert.equal(result.cacheSnapshot.complete, false);
      assert.ok(result.cacheSnapshot.evidenceErrors.length > 0);
    }
  }
  const unsupported = await installedDiscoveryFixture('--discover-integration', 'flags', 'cold');
  assert.notEqual(unsupported.code, 0);
});

test('hook Git variables cannot redirect generated fixture initialization or nested runner Git operations', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'geo-private-hook-parent-')));
  let output;
  try {
    const git = (args) => {
      const result = spawnSync('git', ['-C', parent, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '-q']);
    const common = fixtureCommonDir(parent);
    git(['config', '--local', 'fixture.guard', 'parent-unchanged']);
    writeFileSync(join(parent, 'parent.txt'), 'private parent file');
    git(['add', 'parent.txt']);
    git(['commit', '-qm', 'private fixture parent']);
    const snapshot = () => ({
      head: git(['rev-parse', 'HEAD']),
      config: readFileSync(join(common, 'config'), 'utf8'),
      index: createHash('sha256')
        .update(readFileSync(join(common, 'index')))
        .digest('hex'),
    });
    const before = snapshot();
    const hostile = {
      ...process.env,
      GIT_DIR: common,
      GIT_COMMON_DIR: common,
      GIT_WORK_TREE: parent,
      GIT_INDEX_FILE: join(common, 'index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'fixture.guard',
      GIT_CONFIG_VALUE_0: 'poisoned',
      GIT_UNKNOWN_HOOK_VARIABLE: 'removed',
    };
    assert.equal(fixtureEnv(hostile).GIT_UNKNOWN_HOOK_VARIABLE, undefined);
    output = await installedDiscoveryFixture('--discovery-node', '', '', hostile);
    assert.equal(output.code, 0, output.stderr);
    assert.equal(output.fixtureCommonDirectory, join(output.fixtureDirectory, '.git'));
    assert.notEqual(output.fixtureCommonDirectory, common);
    assert.deepEqual(snapshot(), before);
    assert.equal(git(['config', '--local', 'fixture.guard']), 'parent-unchanged');
  } finally {
    retainFixture(parent, 'private-hook-parent', output);
    rmSync(parent, { recursive: true, force: true });
  }
});
