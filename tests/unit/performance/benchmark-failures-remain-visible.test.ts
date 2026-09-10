// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  collectLiveReportMetadata,
  createLiveReport,
  writeLiveReport,
} from '../../../benchmarks/live-report';

test('invalid timing samples produce a failed artifact and a failing command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-report-'));
  const path = join(directory, 'failure.json');
  try {
    const report = createLiveReport({
      kind: 'websocket-load',
      metadata: collectLiveReportMetadata(),
      measurement: {
        primaryMetric: 'tickMs',
        samples: { tickMs: [Number.NaN] },
        counts: { observed: 1 },
        parameters: {},
        witness: {},
        cleanup: 'complete',
      },
      details: { originalFailure: 'invalid sample' },
    });
    await expect(writeLiveReport(path, report)).rejects.toThrow();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.status).toBe('failed');
    expect(saved.validationFailure.message).toBeTruthy();
    expect(saved.details.originalFailure).toBe('invalid sample');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed benchmark inputs cannot retain a passing result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-report-'));
  const path = join(directory, 'drift.json');
  try {
    const metadata = collectLiveReportMetadata();
    const report = createLiveReport({
      kind: 'realtime-client',
      metadata: { ...metadata, git: { ...metadata.git, sourceSha256: 'earlier-inputs' } },
      measurement: {
        primaryMetric: 'frameMs',
        samples: { frameMs: [16] },
        counts: { frames: 1 },
        parameters: {},
        witness: {},
        cleanup: 'complete',
      },
      details: {},
    });
    await expect(writeLiveReport(path, report)).rejects.toThrow('changed during the session');
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
