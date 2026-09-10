// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  collectLiveReportMetadata,
  createLiveReport,
  writeLiveReport,
} from '../../../benchmarks/live-report';

test('live sessions require a readable lockfile and a real committed revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'georoids-provenance-'));
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
      ...(input !== undefined ? { input } : {}),
    }).trim();
  try {
    // Commit hooks export Git paths that can redirect fixture mutations into
    // the parent checkout despite cwd. Metadata probes need the same isolation.
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('GIT_')) {
        vi.stubEnv(name, undefined);
      }
    }
    git(['init']);
    const lockfile = '{"lockfileVersion":3,"packages":{}}\n';
    await writeFile(join(root, 'package-lock.json'), lockfile);
    expect(() => collectLiveReportMetadata({ root })).toThrow(/rev-parse HEAD/);

    const tree = git(['mktree'], '');
    const commit = git(
      [
        '-c',
        'user.name=Benchmark fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit-tree',
        tree,
      ],
      'Benchmark provenance fixture\n'
    );
    git(['update-ref', 'HEAD', commit]);
    const metadata = collectLiveReportMetadata({ root });
    expect(metadata.git.commit).toBe(commit);
    expect(metadata.git.dirty).toBe(true);
    expect(metadata.git.lockfileSha256).toBe(createHash('sha256').update(lockfile).digest('hex'));

    await rm(join(root, 'package-lock.json'));
    expect(() => collectLiveReportMetadata({ root })).toThrow(/ENOENT.*package-lock.json/);
    await rm(join(root, '.git'), { recursive: true });
    expect(() => collectLiveReportMetadata({ root })).toThrow(/not a git repository/);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

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
