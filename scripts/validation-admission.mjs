import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CHECKOUT = 'GEOROIDS_VALIDATION_CHECKOUT';
const ADMISSION = 'GEOROIDS_VALIDATION_ADMISSION';
const CHILD = 'GEOROIDS_VALIDATION_CHILD';
const tokenKeys = [CHECKOUT, ADMISSION, CHILD];
const require = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function write(path, value) {
  const temporary = `${path}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
function git(root, argument) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', argument], {
    encoding: 'utf8',
    // Ownership belongs to this checkout, including when called by a hook with
    // an index override. Keep the original environment for the actual command.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  });
  require(result.status === 0 &&
    !result.stderr.trim(), `Cannot locate Git ownership: ${result.stderr}`);
  return realpathSync(resolve(root, result.stdout.trim()));
}
function homes(root) {
  return {
    checkout: join(git(root, '--absolute-git-dir'), 'georoids-validation-checkout.lock'),
    common: git(root, '--git-common-dir'),
  };
}
function inspectionDetails(result) {
  return JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error?.message.slice(0, 500) ?? null,
    stderr: result.stderr?.trim().slice(0, 500) ?? '',
  });
}
class InspectionTimeout extends Error {
  constructor(pid, result) {
    super(`Cannot inspect validation PID ${pid}: ${inspectionDetails(result)}`, {
      cause: result.error,
    });
    this.name = 'InspectionTimeout';
  }
}
// A normal absent process is distinct from a failed inspection. Never infer death
// from an unavailable ps command, diagnostics, or malformed output.
function inspect(pid) {
  require(Number.isSafeInteger(pid) && pid > 0, 'Invalid validation owner PID');
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,stat=,lstart='], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new InspectionTimeout(pid, result);
  }
  require(!result.error &&
    !result.signal &&
    !result.stderr.trim(), `Cannot inspect validation PID ${pid}: ${inspectionDetails(result)}`);
  if (result.status === 1 && !result.stdout.trim()) {
    return null;
  }
  require(result.status ===
    0, `Cannot inspect validation PID ${pid}: ${inspectionDetails(result)}`);
  const match = result.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/u);
  require(match, `Invalid process inspection for validation PID ${pid}`);
  if (match[2].includes('Z')) {
    return null;
  }
  return { pid, parent: Number(match[1]), start: match[3] };
}
function live(owner) {
  const current = inspect(owner.pid);
  return current?.start === owner.start;
}
function ancestor(owner) {
  let pid = process.pid;
  require(live(owner), 'Validation owner is dead or its PID was reused');
  const visited = new Set();
  while (pid > 1 && !visited.has(pid)) {
    if (pid === owner.pid) {
      return;
    }
    visited.add(pid);
    const current = inspect(pid);
    require(current, 'Validation ancestry disappeared');
    pid = current.parent;
  }
  throw new Error('Validation owner is not a live ancestor');
}
function decode(value) {
  const token = JSON.parse(value);
  require(typeof token.nonce === 'string' &&
    /^[a-f0-9-]{36}$/u.test(token.nonce), 'Invalid validation nonce');
  return token;
}
function checkoutOwner(home, env) {
  const token = decode(env[CHECKOUT]);
  const owner = json(join(home.checkout, 'owner.json'));
  require(owner.nonce === token.nonce, 'Checkout validation nonce differs');
  ancestor(owner);
  return owner;
}
function admissionOwner(home, env) {
  const token = decode(env[ADMISSION]);
  require(/^\d{12}$/u.test(token.ticket), 'Invalid validation queue ticket');
  const directory = join(home.common, 'georoids-validation-queue', token.ticket);
  const owner = json(join(directory, 'owner.json'));
  require(owner.nonce === token.nonce &&
    existsSync(join(directory, 'active')), 'Heavy validation token is not admitted');
  ancestor(owner);
  return { ...owner, directory };
}
function childOwner(home, env) {
  checkoutOwner(home, env);
  const token = decode(env[CHILD]);
  const record = json(join(home.checkout, 'children', `${token.nonce}.json`));
  require(record.nonce === token.nonce &&
    !record.finished, 'Validation child token is no longer active');
  ancestor(record);
  return record;
}
// Only authenticated runtime ownership is removed from source-bound receipts.
// Unknown GEOROIDS_* variables remain visible to the ordinary identity policy.
export function receiptEnvironment(root, environment) {
  const env = { ...environment };
  if (!tokenKeys.some((key) => env[key] !== undefined)) {
    return env;
  }
  const home = homes(root);
  if (env[CHECKOUT] !== undefined) {
    checkoutOwner(home, env);
  }
  if (env[ADMISSION] !== undefined) {
    admissionOwner(home, env);
  }
  if (env[CHILD] !== undefined) {
    childOwner(home, env);
  }
  for (const key of tokenKeys) {
    delete env[key];
  }
  return env;
}
export function inheritAdmission(root, original, resolved) {
  // Only the caller's still-authenticated authority may cross setup. The
  // completed setup command's temporary child token must never be transferred.
  receiptEnvironment(root, original);
  const env = { ...resolved };
  for (const key of tokenKeys) {
    delete env[key];
    if (original[key] !== undefined) {
      env[key] = original[key];
    }
  }
  return env;
}

export function verifyChild(root, kind, pid = process.pid) {
  const home = homes(root);
  let owner = childOwner(home, process.env);
  // The supervisor records the issued child's birth immediately after spawn.
  // A fast shell can reach authorization before that atomic update completes.
  const deadline = Date.now() + 5000;
  while (!owner.command && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    owner = childOwner(home, process.env);
  }
  require(owner.kind === kind, 'Validation child kind differs');
  const current = inspect(pid);
  require((process.pid === pid || process.ppid === pid) &&
    current?.parent === owner.pid &&
    owner.command?.pid === pid &&
    owner.command.start === current?.start, 'Validation command is not the issued direct child');
}

function groupMembers(group) {
  // Darwin can query one process group directly, avoiding a census of unrelated
  // host processes while proving the same owned descendants have disappeared.
  const scoped = process.platform === 'darwin';
  const args = scoped
    ? ['-g', String(group), '-o', 'pid=,pgid=,stat=']
    : ['-axo', 'pid=,pgid=,stat='];
  const result = spawnSync('ps', args, { encoding: 'utf8', timeout: 5000 });
  const absent = scoped && result.status === 1 && result.stdout === '' && result.stderr === '';
  require((result.status === 0 || absent) &&
    !result.error &&
    !result.signal &&
    !result.stderr.trim(), `Cannot inspect validation process group: ${inspectionDetails(result)}`);
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/u);
      require(match, 'Malformed validation process group inspection');
      require(!scoped ||
        Number(match[2]) === group, 'Unexpected validation process group inspection');
      return { pid: Number(match[1]), group: Number(match[2]), state: match[3] };
    })
    .filter((entry) => entry.group === group && !entry.state.includes('Z'));
}
function signalCommand(command, signal, kind) {
  if (!command || command.retired) {
    return;
  }
  const group = command.pid;
  if (groupMembers(group).length === 0) {
    command.retired = true;
    return;
  }
  require(command.start &&
    inspect(group)?.start ===
      command.start, 'Cannot authenticate validation command group for cancellation');
  try {
    // The runner owns graceful INT/TERM cleanup. Its coordinator may already be
    // stopping, so even our first group signal could kill its inspection helpers.
    // HUP has no runner cleanup trap; preserve its existing group cancellation.
    const gracefulRunner = kind === 'runner' && (signal === 'SIGINT' || signal === 'SIGTERM');
    process.kill(gracefulRunner ? command.pid : -group, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}
async function awaitGroup(command, cancellationFailure) {
  const group = command.pid;
  const deadline = Date.now() + 45000;
  for (;;) {
    const failure = cancellationFailure();
    if (failure) {
      throw failure;
    }
    if (groupMembers(group).length === 0) {
      break;
    }
    require(Date.now() < deadline, `Validation process group ${group} did not finish cleanup`);
    await delay(100);
  }
  command.retired = true;
}
function legacyBusy(home) {
  const directory = join(home.common, 'georoids-test-runner.lock');
  if (!existsSync(directory)) {
    return false;
  }
  const pid = Number(readFileSync(join(directory, 'pid'), 'utf8').trim());
  if (inspect(pid) !== null) {
    return true;
  }
  require(!existsSync(join(directory, 'ownership-pending.json')) &&
    !existsSync(
      join(directory, 'cleanup-failed.json')
    ), `Unresolved runner cleanup blocks validation: ${directory}`);
  return false;
}
async function allocateTicket(home, owner, cancelled) {
  const queue = join(home.common, 'georoids-validation-queue');
  const allocation = join(home.common, 'georoids-validation-allocation.lock');
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  let reported = 0;
  for (;;) {
    require(!cancelled(), 'Validation queue allocation cancelled');
    try {
      mkdirSync(allocation, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
    let prior;
    try {
      prior = json(join(allocation, 'owner.json'));
    } catch (error) {
      const metadata = statSync(allocation, { throwIfNoEntry: false });
      if (!metadata) {
        continue;
      }
      require(error.code === 'ENOENT' &&
        Date.now() - metadata.mtimeMs <
          5000, `Untrustworthy validation allocation blocks admission: ${allocation}`);
    }
    if (prior) {
      require(live(prior), `Dead validation allocator requires inspection: ${allocation}`);
    }
    if (Date.now() - reported > 10000) {
      process.stderr.write(`Waiting for heavy validation ticket allocation: ${allocation}\n`);
      reported = Date.now();
    }
    await delay(100);
  }
  let directory;
  let created = false;
  try {
    write(join(allocation, 'owner.json'), owner);
    // Selection and complete publication share one lock. A delayed allocator
    // must never publish a reused lower ticket after a later ticket is admitted.
    const names = readdirSync(queue).filter((name) => /^\d{12}$/u.test(name));
    const number = Math.max(0, ...names.map(Number)) + 1;
    require(number < 1e12, 'Validation queue ticket space exhausted');
    const ticket = String(number).padStart(12, '0');
    directory = join(queue, ticket);
    mkdirSync(directory, { mode: 0o700 });
    created = true;
    write(join(directory, 'owner.json'), owner);
    return { queue, ticket, directory };
  } catch (error) {
    if (created) {
      rmSync(directory, { recursive: true });
    }
    throw error;
  } finally {
    // Only its creator removes this lock. Dead or incomplete ownership is
    // preserved for inspection, never reclaimed with a racy check then unlink.
    rmSync(allocation, { recursive: true });
  }
}
async function acquireHeavy(home, owner, cancelled) {
  const { queue, ticket, directory } = await allocateTicket(home, owner, cancelled);
  let admitted = false;
  try {
    let reported = 0;
    for (;;) {
      require(!cancelled(), 'Validation queue wait cancelled');
      let blocked = false;
      const stale = [];
      let inspectionTimeout;
      try {
        const earlier = readdirSync(queue)
          .filter((name) => /^\d{12}$/u.test(name) && name < ticket)
          .sort();
        for (const name of earlier) {
          const preceding = join(queue, name);
          let prior;
          try {
            prior = json(join(preceding, 'owner.json'));
          } catch (error) {
            if (error.code === 'ENOENT') {
              const metadata = statSync(preceding, { throwIfNoEntry: false });
              if (!metadata) {
                continue;
              }
              if (Date.now() - metadata.mtimeMs < 5000) {
                blocked = true;
                continue;
              }
            }
            throw new Error(`Untrustworthy validation ticket blocks admission: ${preceding}`, {
              cause: error,
            });
          }
          if (!live(prior)) {
            require(!existsSync(
              join(preceding, 'active')
            ), `Dead validation owner requires cleanup verification: ${preceding}`);
            stale.push(preceding);
          } else {
            blocked = true;
          }
        }
        if (!blocked) {
          blocked = legacyBusy(home);
        }
      } catch (error) {
        if (!(error instanceof InspectionTimeout)) {
          throw error;
        }
        inspectionTimeout = error;
        blocked = true;
        process.stderr.write(
          `Waiting for heavy validation admission, ticket ${ticket}; process inspection timed out, ownership unchanged: ${error.message}\n`
        );
      }
      // A partial scan cannot reclaim ownership. Retry from the beginning after
      // the cancellable wait; only conclusive inspections may remove tickets or admit.
      if (!inspectionTimeout) {
        for (const preceding of stale) {
          rmSync(preceding, { recursive: true, force: true });
        }
      }
      if (!blocked) {
        break;
      }
      if (Date.now() - reported > 10000) {
        process.stderr.write(
          `Waiting for heavy validation admission, ticket ${ticket}: ${queue}\n`
        );
        reported = Date.now();
      }
      await delay(100);
    }
    writeFileSync(join(directory, 'active'), '', { flag: 'wx', mode: 0o600 });
    admitted = true;
    process.stderr.write(`Heavy validation admitted, ticket ${ticket}.\n`);
    return { directory, token: JSON.stringify({ ticket, nonce: owner.nonce }) };
  } finally {
    if (!admitted) {
      rmSync(directory, { recursive: true });
    }
  }
}
function pendingChildren(checkout, ownNonce) {
  const records = readdirSync(join(checkout, 'children')).map((name) =>
    json(join(checkout, 'children', name))
  );
  const descendants = new Set([ownNonce]);
  for (let previous = -1; previous !== descendants.size; ) {
    previous = descendants.size;
    for (const record of records) {
      if (descendants.has(record.parentNonce)) {
        descendants.add(record.nonce);
      }
    }
  }
  for (const record of records) {
    if (record.nonce !== ownNonce && descendants.has(record.nonce)) {
      require(record.finished &&
        record.cleanupSucceeded, `Nested validation cleanup is unproven: ${record.nonce}`);
    }
  }
}
export async function runAdmitted(
  kind,
  command,
  { root = process.cwd(), environment = process.env, timeoutMs, captureOutput = false } = {}
) {
  require(['checkout', 'review', 'runner', 'frame', 'contracts', 'unit', 'integration'].includes(
    kind
  ) && command.length > 0, 'Expected a validation kind followed by -- command');
  require(timeoutMs === undefined ||
    (Number.isSafeInteger(timeoutMs) && timeoutMs > 0), 'Invalid validation deadline');
  require(typeof captureOutput === 'boolean', 'Invalid validation output mode');
  const captured = { stdout: [], stderr: [], bytes: 0, exceeded: false };
  const home = homes(root);
  const env = { ...environment };
  if (tokenKeys.some((key) => env[key] !== undefined)) {
    require(env[CHECKOUT] !== undefined &&
      env[CHILD] !== undefined, 'Incomplete validation ownership tokens');
    receiptEnvironment(root, env);
  }
  const owner = { ...inspect(process.pid), nonce: randomUUID(), root: realpathSync(root), kind };
  let ownCheckout = false;
  let heavy;
  let admissionDirectory;
  let child;
  let commandIssued = false;
  let recordPath;
  let commandIdentity;
  let result;
  let interrupted;
  let signalFailure;
  let rejectCommand;
  let deadlineTimer;
  let cancellationTimer;
  let timedOut = false;
  const cancel = (signal) => {
    // The first signal starts owned cleanup. Repeated group signals could kill
    // the short-lived receipt and inspection helpers running during cleanup.
    if (interrupted) {
      return;
    }
    interrupted = signal;
    cancellationTimer = setTimeout(() => {
      rejectCommand?.(
        new Error('Validation command did not close within its cancellation grace period')
      );
    }, 45000);
    try {
      signalCommand(commandIdentity, signal, kind);
    } catch (error) {
      signalFailure ??= new Error(`Cannot forward ${signal}: ${error.message}`, { cause: error });
      // The command may never exit when authentication prevents cancellation.
      // Reject its wait without signaling unverified processes or freeing locks.
      rejectCommand?.(signalFailure);
    }
  };
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => cancel(signal)]);
  for (const [signal, handler] of handlers) {
    process.on(signal, handler);
  }
  try {
    if (env[CHECKOUT] !== undefined) {
      checkoutOwner(home, env);
      owner.parentNonce = childOwner(home, env).nonce;
    } else {
      try {
        mkdirSync(home.checkout, { mode: 0o700 });
      } catch (error) {
        throw new Error(`Checkout validation already owned; inspect ${home.checkout}`, {
          cause: error,
        });
      }
      ownCheckout = true;
      write(join(home.checkout, 'owner.json'), owner);
      mkdirSync(join(home.checkout, 'children'));
      env[CHECKOUT] = JSON.stringify({ nonce: owner.nonce });
    }
    if (env[ADMISSION] !== undefined) {
      admissionDirectory = admissionOwner(home, env).directory;
    } else if (kind === 'runner' || kind === 'frame') {
      heavy = await acquireHeavy(home, owner, () => interrupted);
      env[ADMISSION] = heavy.token;
      admissionDirectory = heavy.directory;
    }
    require(!interrupted, 'Validation cancelled before command startup');
    recordPath = join(home.checkout, 'children', `${owner.nonce}.json`);
    write(recordPath, owner);
    env[CHILD] = JSON.stringify({ nonce: owner.nonce });
    let receipt;
    if (kind === 'runner') {
      receipt =
        env.GEOROIDS_TEST_RUNNER_RECEIPT || join(home.checkout, `${owner.nonce}-runner.json`);
      require(!existsSync(receipt), `Runner cleanup receipt already exists: ${receipt}`);
      env.GEOROIDS_TEST_RUNNER_RECEIPT = receipt;
    }
    result = await new Promise((accept, reject) => {
      rejectCommand = reject;
      child = spawn(command[0], command.slice(1), {
        cwd: root,
        env,
        stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        detached: true,
      });
      // Record issuance before inspection/publication can fail. A native spawn
      // failure has no PID; an issued but unverified process must retain ownership.
      commandIssued = child.pid !== undefined;
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
      commandIdentity = {
        pid: child.pid,
        group: child.pid,
        start: child.pid ? inspect(child.pid)?.start : null,
        retired: false,
      };
      write(recordPath, { ...owner, command: commandIdentity });
      if (timeoutMs !== undefined) {
        deadlineTimer = setTimeout(() => {
          timedOut = true;
          cancel('SIGTERM');
        }, timeoutMs);
      }
      if (captureOutput) {
        for (const name of ['stdout', 'stderr']) {
          child[name].on('data', (chunk) => {
            captured.bytes += chunk.length;
            if (captured.bytes > 4 * 1024 * 1024) {
              captured.exceeded = true;
              cancel('SIGTERM');
            } else {
              captured[name].push(chunk);
            }
          });
        }
      }
    });
    rejectCommand = undefined;
    await awaitGroup(commandIdentity, () => signalFailure);
    require(!result.signal ||
      interrupted, `Validation command died unexpectedly: ${result.signal}`);
    if (receipt) {
      const proof = json(receipt);
      require(proof.ownerPid === child.pid &&
        proof.kind === 'georoids-runner-final' &&
        proof.worktree === owner.root &&
        proof.cleanupSucceeded === true &&
        proof.lockReleased === true &&
        proof.sessionRemoved === true, `Runner cleanup is unproven: ${receipt}`);
    }
    // Nested wrappers finish their own groups before completing their records.
    // Their direct parent can disappear during cancellation without freeing us.
    pendingChildren(home.checkout, owner.nonce);
    write(recordPath, {
      ...owner,
      command: commandIdentity,
      finished: true,
      cleanupSucceeded: true,
    });
    if (heavy) {
      rmSync(heavy.directory, { recursive: true });
    }
    if (ownCheckout) {
      rmSync(home.checkout, { recursive: true });
    }
    const exitStatus = timedOut
      ? 124
      : captured.exceeded
        ? 1
        : interrupted
          ? interrupted === 'SIGINT'
            ? 130
            : 143
          : (result.code ?? 1);
    return captureOutput
      ? {
          code: exitStatus,
          stdout: Buffer.concat(captured.stdout).toString('utf8'),
          stderr: Buffer.concat(captured.stderr).toString('utf8'),
          outputExceeded: captured.exceeded,
        }
      : exitStatus;
  } catch (error) {
    // An intent record is not an issued process. Setup failures remain failures,
    // but cannot require process-cleanup proof for a command that never started.
    if (!commandIssued) {
      try {
        if (recordPath) {
          write(recordPath, {
            ...owner,
            finished: true,
            cleanupSucceeded: true,
            failure: { kind: 'command-not-started', message: error.message },
          });
        }
        if (heavy) {
          rmSync(heavy.directory, { recursive: true });
        }
        if (ownCheckout) {
          rmSync(home.checkout, { recursive: true });
        }
        error.message += '\nValidation command never started; owned admission released.';
      } catch (cleanupError) {
        error.message += `\nCannot release setup ownership: ${cleanupError.message}\nInspect checkout ownership: ${home.checkout}`;
      }
    }
    if (commandIssued) {
      // Close captured pipes so a surviving child cannot strand this supervisor.
      // Keep durable ownership evidence when cleanup remains unproven.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      error.message += `\nValidation cleanup is unproven; the owned command may still be running.\nPreserved checkout ownership: ${home.checkout}`;
      if (admissionDirectory) {
        error.message += `\nPreserved heavy queue ownership: ${admissionDirectory}`;
      }
    }
    error.exitCode = result?.code || 1;
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(cancellationTimer);
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [kind, separator, ...command] = process.argv.slice(2);
    if (kind === 'verify') {
      verifyChild(process.cwd(), separator, Number(command[0]));
    } else {
      require(separator === '--', 'Validation command requires -- separator');
      process.exitCode = await runAdmitted(kind, command);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  }
}
