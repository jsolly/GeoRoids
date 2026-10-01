import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { authorizeSequencer, validateTimingReport, writeJson } from './integration-shards.mjs';

const phases = [
  'environmentSetupDuration',
  'prepareDuration',
  'setupDuration',
  'collectDuration',
  'duration',
];
function requireEvidence(condition, message) {
  if (!condition) {
    throw new Error(`Integration timing: ${message}`);
  }
}
function sameFiles(actual, expected) {
  return (
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}
function phaseTotal(diagnostic) {
  requireEvidence(
    phases.every((key) => Number.isFinite(diagnostic[key]) && diagnostic[key] >= 0),
    'invalid phase duration'
  );
  return phases.reduce((total, key) => total + diagnostic[key], 0);
}

/** Pure lifecycle recorder; the default reporter obtains its identity only by authorization. */
export function createTimingRecorder(issued, persist = writeJson, now = () => performance.now()) {
  const selected = issued.plan.shards.find((shard) => shard.index === issued.index)?.files;
  requireEvidence(Array.isArray(selected), 'assignment missing');
  const expected = new Set(selected);
  requireEvidence(expected.size === selected.length, 'duplicate assignment');
  const origin = now();
  const rows = new Map();
  const receipt = {
    version: 1,
    runId: issued.runId,
    shard: issued.index,
    worktree: issued.worktree,
    sourceFingerprint: issued.sourceFingerprint.sha256,
    node: process.version,
    vitest: JSON.parse(
      readFileSync(createRequire(import.meta.url).resolve('vitest/package.json'), 'utf8')
    ).version,
    reporterStartedAt: Date.now(),
    reporterElapsedMs: 0,
    reason: null,
    complete: false,
    evidenceErrors: [],
    unhandledErrorCount: 0,
    files: [],
  };
  const destination = join(issued.directory, 'file-timings.json');
  let chain = Promise.resolve();
  let sticky;
  function failure(error) {
    sticky ??= error;
    if (receipt.evidenceErrors.length < 8) {
      receipt.evidenceErrors.push(String(error));
    }
    receipt.complete = false;
  }
  function save() {
    receipt.files = [...rows.values()];
    receipt.reporterElapsedMs = now() - origin;
    const snapshot = structuredClone(receipt);
    // A caught previous failure allows partial evidence to be retained, but
    // every subsequent callback still rejects with the original sticky error.
    chain = chain
      .catch(() => {})
      .then(async () => {
        try {
          if (sticky) {
            snapshot.complete = false;
            snapshot.evidenceErrors = [...receipt.evidenceErrors];
          }
          await persist(destination, snapshot);
        } catch (error) {
          failure(error);
        }
        if (sticky) {
          throw sticky;
        }
      });
    return chain;
  }
  function guarded(run) {
    try {
      run();
    } catch (error) {
      failure(error);
    }
    return save();
  }
  function event(module, stage) {
    return guarded(() => {
      const file = realpathSync(module.moduleId);
      requireEvidence(expected.has(file), 'module outside assignment');
      let row = rows.get(file);
      if (!row) {
        row = { file, state: 'queued', ended: false, diagnostic: null, phaseTotalMs: null };
        rows.set(file, row);
      }
      const key = `${stage}AtMs`;
      requireEvidence(row[key] === undefined, `duplicate ${stage} event`);
      row[key] = now() - origin;
      row.state = module.state();
      if (stage === 'ended') {
        row.ended = true;
        const diagnostic = module.diagnostic();
        row.diagnostic = Object.fromEntries(phases.map((phase) => [phase, diagnostic[phase]]));
        row.phaseTotalMs = phaseTotal(row.diagnostic);
        row.queuedToEndMs = row.queuedAtMs === undefined ? null : row.endedAtMs - row.queuedAtMs;
        row.reporterObservedStartedToEndMs =
          row.startedAtMs === undefined ? null : row.endedAtMs - row.startedAtMs;
      }
    });
  }
  return {
    onTestRunStart(specifications) {
      return guarded(() => {
        requireEvidence(
          sameFiles(
            specifications.map((specification) => realpathSync(specification.moduleId)),
            issued.plan.inventory.map((entry) => entry.file)
          ),
          'pre-shard inventory differs'
        );
      });
    },
    onTestModuleQueued: (module) => event(module, 'queued'),
    onTestModuleCollected: (module) => event(module, 'collected'),
    onTestModuleStart: (module) => event(module, 'started'),
    onTestModuleEnd: (module) => event(module, 'ended'),
    onTestRunEnd(modules, errors, reason) {
      return guarded(() => {
        receipt.reason = reason;
        receipt.unhandledErrorCount = errors.length;
        receipt.files = [...rows.values()];
        receipt.complete = reason === 'passed' && !sticky && errors.length === 0;
        if (receipt.complete) {
          requireEvidence(
            sameFiles(
              modules.map((module) => realpathSync(module.moduleId)),
              selected
            ),
            'final module set differs'
          );
          validateTimingReport(receipt, issued, selected);
        }
      });
    },
  };
}

export default class IntegrationTimingReporter {
  async onTestRunStart(specifications) {
    const issued = authorizeSequencer();
    this.recorder = createTimingRecorder(issued);
    await this.recorder.onTestRunStart(specifications);
  }
  onTestModuleQueued(module) {
    return this.recorder.onTestModuleQueued(module);
  }
  onTestModuleCollected(module) {
    return this.recorder.onTestModuleCollected(module);
  }
  onTestModuleStart(module) {
    return this.recorder.onTestModuleStart(module);
  }
  onTestModuleEnd(module) {
    return this.recorder.onTestModuleEnd(module);
  }
  onTestRunEnd(modules, errors, reason) {
    return this.recorder.onTestRunEnd(modules, errors, reason);
  }
}
