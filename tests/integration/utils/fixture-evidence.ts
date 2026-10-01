import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { Page } from 'playwright';
import { civicLot } from '../../../shared/furnaces';
import { getFixtureState } from './test-server-control';

function fixtureEvidenceMetadata() {
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  const digest = createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--binary']));
  for (const file of execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)) {
    digest.update(file).update(readFileSync(file));
  }
  const packageInfo: unknown = JSON.parse(
    readFileSync(join(process.cwd(), 'node_modules/playwright/package.json'), 'utf8')
  );
  if (
    !packageInfo ||
    typeof packageInfo !== 'object' ||
    !('version' in packageInfo) ||
    typeof packageInfo.version !== 'string'
  ) {
    throw new Error('Playwright version unavailable');
  }
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirtyTree: status.length > 0,
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
  observations: { asteroidIds?: () => readonly string[]; evidence?: () => unknown } = {}
): Promise<void> {
  const directory =
    process.env['GEOROIDS_TEST_SCREENSHOTS_DIR'] ??
    join(process.cwd(), 'tests/integration/browser/screenshots');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${scenario}-${Date.now()}`);
  const receipt = {
    ...fixtureEvidenceMetadata(),
    browser: page.context().browser()?.version(),
    scenario,
    stages: [] as {
      name: string;
      elapsedMs: number;
      durationMs: number;
      server: unknown;
      client: unknown;
      evidence: unknown;
      captureFailures: { source: 'server' | 'client' | 'scenario'; error: FailureEvidence }[];
    }[],
  };
  const started = performance.now();
  let previous = started;
  const stage = async (name: string) => {
    const now = performance.now();
    const [server, client, scenarioEvidence] = await Promise.allSettled([
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
      Promise.resolve().then(() => structuredClone(observations.evidence?.() ?? null)),
    ]);
    const failures: unknown[] = [];
    const captureFailures: { source: 'server' | 'client' | 'scenario'; error: FailureEvidence }[] =
      [];
    for (const [source, result] of [
      ['server', server],
      ['client', client],
      ['scenario', scenarioEvidence],
    ] as const) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
        captureFailures.push({ source, error: failureEvidence(result.reason) });
      }
    }
    const observation = {
      name,
      evidence: scenarioEvidence.status === 'fulfilled' ? scenarioEvidence.value : null,
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
