import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import type { Page } from 'playwright';
import { civicLot } from '../../../shared/furnaces';
import { getFixtureState } from './test-server-control';

const GIT_TIMEOUT_MS = 30_000;
const GIT_STDERR_LIMIT = 16 * 1024;
const GIT_PATH_LIMIT = 64 * 1024;

/** Consume stdout as bytes; never retain the whole binary diff or accept a partial hash. */
async function streamGit(
  root: string,
  args: string[],
  consume: (chunk: Buffer) => void
): Promise<void> {
  const env = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_COMMON_DIR',
  ]) {
    delete env[name];
  }
  await new Promise<void>((resolve, reject) => {
    const ownsProcessGroup = process.platform !== 'win32';
    const child = spawn('git', args, {
      cwd: root,
      env,
      detached: ownsProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let failure: { error: unknown } | undefined;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let stderrOmitted = false;
    const stop = (error: unknown) => {
      failure ??= { error };
      const cleanupFailures: unknown[] = [];
      try {
        if (ownsProcessGroup && child.pid !== undefined) {
          // Only the process group created by this exact spawn is ours. Git's
          // external diff/textconv children can outlive it and retain its pipes.
          process.kill(-child.pid, 'SIGKILL');
        } else if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null) {
          throw new Error('Fixture provenance Git termination was not delivered');
        }
      } catch (cleanupError) {
        if (
          !(
            cleanupError instanceof Error &&
            'code' in cleanupError &&
            cleanupError.code === 'ESRCH'
          )
        ) {
          cleanupFailures.push(cleanupError);
        }
      }
      // Never await pipes held by descendants, even if Git has already exited.
      for (const pipe of [child.stdout, child.stderr]) {
        try {
          pipe.destroy();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0) {
        failure = {
          error: new AggregateError(
            [failure.error, ...cleanupFailures],
            'Fixture provenance failed with process cleanup failures'
          ),
        };
        clearTimeout(timeout);
        reject(failure.error);
      }
    };
    const timeout = setTimeout(
      () => stop(new Error(`Fixture provenance git ${args.join(' ')} timed out`)),
      GIT_TIMEOUT_MS
    );
    child.once('error', (error) => {
      failure ??= { error };
    });
    child.stdout.once('error', stop);
    child.stderr.once('error', stop);
    child.stdout.on('data', (chunk: Buffer) => {
      if (!failure) {
        try {
          consume(chunk);
        } catch (error) {
          stop(error);
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = GIT_STDERR_LIMIT - stderrBytes;
      if (remaining > 0) {
        const retained = Buffer.from(chunk.subarray(0, remaining));
        stderr.push(retained);
        stderrBytes += retained.length;
      }
      stderrOmitted ||= chunk.length > remaining;
    });
    // close follows stream closure: no success before the last stdout bytes.
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (failure) {
        reject(failure.error);
      } else if (code !== 0 || signal !== null) {
        const detail = Buffer.concat(stderr).toString('utf8');
        reject(
          new Error(
            `Fixture provenance git ${args.join(' ')} failed (exit ${code}, signal ${signal}): ${detail}${stderrOmitted ? ' [stderr truncated]' : ''}`
          )
        );
      } else {
        resolve();
      }
    });
  });
}

export async function fixtureEvidenceMetadata(root = process.cwd()) {
  let dirtyTree = false;
  await streamGit(root, ['status', '--porcelain'], (chunk) => {
    dirtyTree ||= chunk.length > 0;
  });
  const digest = createHash('sha256');
  await streamGit(root, ['diff', 'HEAD', '--binary'], (chunk) => {
    digest.update(chunk);
  });
  const decoder = new StringDecoder('utf8');
  const untracked: string[] = [];
  let pending = '';
  await streamGit(root, ['ls-files', '--others', '--exclude-standard'], (chunk) => {
    pending += decoder.write(chunk);
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      if (newline > GIT_PATH_LIMIT) {
        throw new Error('Fixture provenance untracked path exceeds evidence limit');
      }
      untracked.push(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
    if (pending.length > GIT_PATH_LIMIT) {
      throw new Error('Fixture provenance untracked path exceeds evidence limit');
    }
  });
  pending += decoder.end();
  if (pending) {
    untracked.push(pending);
  }
  // Preserve the old ls-files output.trim().split('\n') byte ordering.
  const first = untracked[0];
  const last = untracked[untracked.length - 1];
  if (first !== undefined) {
    untracked[0] = first.trimStart();
  }
  if (last !== undefined) {
    untracked[untracked.length - 1] = untracked[untracked.length - 1]?.trimEnd() ?? '';
  }
  for (const file of untracked.filter(Boolean)) {
    digest.update(file);
    for await (const chunk of createReadStream(join(root, file))) {
      digest.update(chunk);
    }
  }
  const packageInfo: unknown = JSON.parse(
    readFileSync(join(root, 'node_modules/playwright/package.json'), 'utf8')
  );
  if (
    !packageInfo ||
    typeof packageInfo !== 'object' ||
    !('version' in packageInfo) ||
    typeof packageInfo.version !== 'string'
  ) {
    throw new Error('Playwright version unavailable');
  }
  let revision = '';
  await streamGit(root, ['rev-parse', 'HEAD'], (chunk) => {
    revision += chunk.toString('utf8');
    if (revision.length > 4096) {
      throw new Error('Fixture provenance revision exceeds evidence limit');
    }
  });
  return {
    revision: revision.trim(),
    dirtyTree,
    diffDigest: digest.digest('hex'),
    nodeVersion: process.version,
    playwrightVersion: packageInfo.version,
    platform: process.platform,
    architecture: process.arch,
  };
}

type FailureEvidence =
  | string
  | {
      name: string;
      message: string;
      stack?: string;
      cause?: FailureEvidence;
      errors?: FailureEvidence[];
    };

/** Error graphs can contain cycles; retain concrete causes within fixed evidence bounds. */
function failureEvidence(value: unknown): FailureEvidence {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const text = (message: string) =>
    message
      .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
      .replace(
        /(\b(?:resumeToken|sessionToken|credential|authorization)\b["']?\s*[:=]\s*["']?)([^\s,"'&}]+)/giu,
        '$1[redacted]'
      )
      .slice(0, 2000);
  const visit = (entry: unknown, depth: number): FailureEvidence => {
    if (++nodes > 64 || depth > 6) {
      return '[error evidence limit]';
    }
    if (!(entry instanceof Error)) {
      return typeof entry === 'object' && entry !== null
        ? '[non-error object]'
        : text(String(entry));
    }
    if (seen.has(entry)) {
      return '[circular error]';
    }
    seen.add(entry);
    const result: Exclude<FailureEvidence, string> = {
      name: entry.name,
      message: text(entry.message),
    };
    if (entry.stack !== undefined) {
      result.stack = text(entry.stack);
    }
    if (entry.cause !== undefined) {
      result.cause = visit(entry.cause, depth + 1);
    }
    if (entry instanceof AggregateError) {
      const errors: unknown[] = Array.isArray(entry.errors) ? entry.errors : [];
      result.errors = errors.slice(0, 8).map((nested) => visit(nested, depth + 1));
      if (errors.length > 8) {
        result.errors.push(`[${errors.length - 8} additional errors omitted]`);
      }
    }
    return result;
  };
  return visit(value, 0);
}

/** Keep only gameplay observations: never serialize storage, tokens or socket URLs. */
export async function withFixtureEvidence(
  page: Page,
  scenario: string,
  run: (stage: (name: string) => Promise<void>) => Promise<void>,
  observations: {
    asteroidIds?: () => readonly string[];
    evidence?: () => unknown;
    retainedEvidence?: () => unknown;
  } = {}
): Promise<void> {
  const directory =
    process.env['GEOROIDS_TEST_SCREENSHOTS_DIR'] ??
    join(process.cwd(), 'tests/integration/browser/screenshots');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${scenario}-${Date.now()}`);
  const receipt = {
    ...(await fixtureEvidenceMetadata()),
    browser: page.context().browser()?.version(),
    scenario,
    stages: [] as {
      name: string;
      elapsedMs: number;
      durationMs: number;
      server: unknown;
      client: unknown;
      evidence: unknown;
      retainedEvidence: unknown;
      captureFailures: {
        source: 'server' | 'client' | 'scenario' | 'retained';
        error: FailureEvidence;
      }[];
    }[],
  };
  const started = performance.now();
  let previous = started;
  const stage = async (name: string) => {
    const now = performance.now();
    const [server, client, scenarioEvidence, retainedEvidence] = await Promise.allSettled([
      Promise.resolve().then(() => getFixtureState(observations.asteroidIds?.() ?? [])),
      Promise.resolve().then(() =>
        page.isClosed()
          ? null
          : page.evaluate((lot) => {
              const controller = window.gameController;
              const player = controller?.getCurrPlayer();
              const ship = player?.ship;
              const prompt = document.querySelector('#furnace-travel-prompt');
              const button = prompt?.querySelector('button');
              const menu = document.querySelector('#town-store-dialog');
              return {
                furnacePrompt: {
                  visible: prompt?.classList.contains('is-visible') ?? false,
                  focused:
                    button !== null && button !== undefined && document.activeElement === button,
                  menuVisible: menu instanceof HTMLDialogElement && menu.open,
                  viewport: { width: window.innerWidth, height: window.innerHeight },
                  streetFootprintEligible:
                    lot !== undefined &&
                    ship !== undefined &&
                    ship.health > 0 &&
                    !ship.exploding &&
                    !ship.furnaceTransit &&
                    Math.hypot(
                      ship.position.x - lot.position.x,
                      ship.position.y - lot.position.y
                    ) <= lot.radius,
                },
                connected: controller?.getNetworkManager().isConnected,
                playerId: controller?.getNetworkManager().getLocalPlayerId(),
                cargo: player?.cargo,
                score: controller?.getCurrScore(),
                health: ship?.health,
                exploding: ship?.exploding,
                position: ship?.position,
                velocity: ship?.velocity,
                thrust: ship?.thrust,
                motionEpoch: ship?.playerMotion?.epoch,
                furnaceTransit: ship?.furnaceTransit,
              };
            }, civicLot('street-1-0'))
      ),
      Promise.resolve().then(async () =>
        structuredClone((await observations.evidence?.()) ?? null)
      ),
      Promise.resolve().then(() => structuredClone(observations.retainedEvidence?.() ?? null)),
    ]);
    const failures: unknown[] = [];
    const captureFailures: {
      source: 'server' | 'client' | 'scenario' | 'retained';
      error: FailureEvidence;
    }[] = [];
    for (const [source, result] of [
      ['server', server],
      ['client', client],
      ['scenario', scenarioEvidence],
      ['retained', retainedEvidence],
    ] as const) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
        captureFailures.push({ source, error: failureEvidence(result.reason) });
      }
    }
    const observation = {
      name,
      evidence: scenarioEvidence.status === 'fulfilled' ? scenarioEvidence.value : null,
      retainedEvidence: retainedEvidence.status === 'fulfilled' ? retainedEvidence.value : null,
      elapsedMs: now - started,
      durationMs: now - previous,
      server: server.status === 'fulfilled' ? server.value : null,
      client: client.status === 'fulfilled' ? client.value : null,
      captureFailures,
    };
    receipt.stages.push(observation);
    previous = now;
    try {
      writeFileSync(`${path}.json`, JSON.stringify(receipt, null, 2));
    } catch (writeError) {
      failures.push(writeError);
    }
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'Stage evidence capture failed');
    }
  };
  try {
    await stage('scenario-start');
    await run(stage);
    await stage('complete');
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await stage('failed');
    } catch (observationError) {
      failures.push(observationError);
    }
    try {
      await page.screenshot({ path: `${path}-failed.png` });
    } catch (screenshotError) {
      failures.push(screenshotError);
    }
    try {
      writeFileSync(
        `${path}.json`,
        JSON.stringify(
          {
            ...receipt,
            failures: failures.map(failureEvidence),
          },
          null,
          2
        )
      );
    } catch (writeError) {
      failures.push(writeError);
    }
    throw failures.length === 1
      ? error
      : new AggregateError(failures, 'Scenario failed with evidence capture failures');
  }
}
