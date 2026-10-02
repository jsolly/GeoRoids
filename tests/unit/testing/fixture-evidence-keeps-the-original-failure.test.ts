/* @vitest-environment node */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Page } from 'playwright';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  write: vi.fn(),
  observe: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.end(
        args[0] === 'diff'
          ? Buffer.from('diff')
          : args[0] === 'rev-parse'
            ? 'fixture-revision\n'
            : ''
      );
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  },
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdirSync: vi.fn(),
  readFileSync: () => '{"version":"1.63.0"}',
  writeFileSync: boundary.write,
}));
vi.mock('../../integration/utils/test-server-control', () => ({
  getFixtureState: boundary.observe,
}));

import { withFixtureEvidence } from '../../integration/utils/fixture-evidence';

beforeEach(() => {
  boundary.observe.mockResolvedValue({ seed: 42, sockets: { total: 0, open: 0 }, players: [] });
});

afterEach(() => {
  vi.resetAllMocks();
});

test('receipt writing failures retain the original scenario error and screenshot failure', async () => {
  const original = new Error('Player fixture placement failed: HTTP 404 {"reason":"dead"}');
  const writeFailure = new Error('receipt disk full');
  const screenshotFailure = new Error('page closed during screenshot');
  boundary.write
    .mockImplementationOnce(() => undefined)
    .mockImplementation(() => {
      throw writeFailure;
    });
  // The browser is an external boundary; this scene deliberately fails before gameplay.
  const page = {
    context: () => ({ browser: () => ({ version: () => '153.0.8010.12' }) }),
    isClosed: () => false,
    evaluate: async () => ({ health: 0, motionEpoch: 4 }),
    screenshot: () => Promise.reject(screenshotFailure),
  } as unknown as Page;
  let failure: unknown;
  try {
    await withFixtureEvidence(page, 'rejected-placement', () => Promise.reject(original));
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) {
    throw new Error('Expected preserved failures');
  }
  expect(failure.errors).toEqual([original, writeFailure, screenshotFailure, writeFailure]);
  expect(boundary.write).toHaveBeenCalledTimes(3);
});

function evidencePage(evaluate = vi.fn().mockResolvedValue({ health: 17, motionEpoch: 4 })): Page {
  return {
    context: () => ({ browser: () => ({ version: () => '153.0.8010.12' }) }),
    isClosed: () => false,
    evaluate,
    screenshot: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function finalReceipt(): unknown {
  return JSON.parse(String(boundary.write.mock.calls.at(-1)?.[1]));
}

test('a failed server observation retains the independent client evidence and sanitized failure', async () => {
  boundary.observe.mockRejectedValue(new Error('HTTP 503 resumeToken=private-value'));
  const evaluate = vi.fn().mockResolvedValue({ health: 17, motionEpoch: 4 });
  await expect(
    withFixtureEvidence(evidencePage(evaluate), 'server-capture-failure', () => Promise.resolve())
  ).rejects.toThrow('evidence capture failures');
  expect(evaluate).toHaveBeenCalledTimes(2);
  const observation = expect.objectContaining({
    server: null,
    client: { health: 17, motionEpoch: 4 },
    captureFailures: [
      {
        source: 'server',
        error: expect.objectContaining({ message: 'HTTP 503 resumeToken=[redacted]' }),
      },
    ],
  });
  expect(finalReceipt()).toMatchObject({ stages: [observation, observation] });
  expect(JSON.stringify(finalReceipt())).not.toContain('private-value');
});

test('a failed client observation retains the independent authoritative server evidence', async () => {
  const evaluate = vi.fn().mockRejectedValue(new Error('page evaluation failed'));
  await expect(
    withFixtureEvidence(evidencePage(evaluate), 'client-capture-failure', () => Promise.resolve())
  ).rejects.toThrow('evidence capture failures');
  expect(boundary.observe).toHaveBeenCalledTimes(2);
  const observation = expect.objectContaining({
    server: { seed: 42, sockets: { total: 0, open: 0 }, players: [] },
    client: null,
    captureFailures: [
      {
        source: 'client',
        error: expect.objectContaining({ message: 'page evaluation failed' }),
      },
    ],
  });
  expect(finalReceipt()).toMatchObject({ stages: [observation, observation] });
});

test('a teardown receipt retains both concrete failures and their nested causes', async () => {
  const original = new AggregateError(
    [
      new Error('page close failed', { cause: new Error('socket close failed') }),
      new Error('World reset failed: HTTP 500 {"reason":"socket-close-failed"}'),
    ],
    'Scenario teardown failed',
    { cause: new Error('owned socket departure incomplete') }
  );
  await expect(
    withFixtureEvidence(evidencePage(), 'teardown', () => Promise.reject(original))
  ).rejects.toBe(original);
  expect(finalReceipt()).toMatchObject({
    failures: [
      {
        name: 'AggregateError',
        message: 'Scenario teardown failed',
        cause: expect.objectContaining({ message: 'owned socket departure incomplete' }),
        errors: [
          expect.objectContaining({
            message: 'page close failed',
            cause: expect.objectContaining({ message: 'socket close failed' }),
          }),
          expect.objectContaining({
            message: 'World reset failed: HTTP 500 {"reason":"socket-close-failed"}',
          }),
        ],
      },
    ],
  });
});

test('cyclic and deeply nested error causes produce bounded receipts without replacing the failure', async () => {
  const cyclic = new Error('cycle');
  cyclic.cause = cyclic;
  let deep: Error = new Error('leaf');
  for (let index = 0; index < 20; index++) {
    deep = new Error(`depth-${index}`, { cause: deep });
  }
  const original = new AggregateError(
    [cyclic, deep, ...Array.from({ length: 12 }, () => new Error('extra'))],
    'bounded graph'
  );
  await expect(
    withFixtureEvidence(evidencePage(), 'bounded', () => Promise.reject(original))
  ).rejects.toBe(original);
  const receipt = JSON.stringify(finalReceipt());
  expect(receipt).toContain('[circular error]');
  expect(receipt).toContain('[error evidence limit]');
  expect(receipt).toContain('[6 additional errors omitted]');
  expect(receipt).not.toContain('leaf');
  expect(receipt.length).toBeLessThan(25000);
});

test('selected rock IDs and wire receipts follow the scenario while evidence failures keep both observations', async () => {
  let selected: string[] = [];
  await withFixtureEvidence(
    evidencePage(),
    'selected-host',
    async (stage) => {
      selected = ['belt-42-60-0'];
      await stage('host-selected');
    },
    {
      asteroidIds: () => selected,
      evidence: () => ({ acknowledgement: { requestId: 'shot', projectileId: 'accepted' } }),
    }
  );
  expect(boundary.observe.mock.calls).toEqual([[[]], [['belt-42-60-0']], [['belt-42-60-0']]]);
  expect(finalReceipt()).toMatchObject({
    stages: expect.arrayContaining([
      expect.objectContaining({
        evidence: { acknowledgement: { requestId: 'shot', projectileId: 'accepted' } },
      }),
    ]),
  });
  boundary.write.mockClear();
  await expect(
    withFixtureEvidence(evidencePage(), 'failed-wire-capture', () => Promise.resolve(), {
      evidence: () => {
        throw new Error('wire capture failed');
      },
    })
  ).rejects.toThrow('evidence capture failures');
  expect(finalReceipt()).toMatchObject({
    stages: expect.arrayContaining([
      expect.objectContaining({
        server: { seed: 42, sockets: { total: 0, open: 0 }, players: [] },
        client: { health: 17, motionEpoch: 4 },
        evidence: null,
        captureFailures: [
          {
            source: 'scenario',
            error: expect.objectContaining({ message: 'wire capture failed' }),
          },
        ],
      }),
    ]),
  });
});
