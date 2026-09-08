// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { parseLogArguments, readGameLogs } from '../../../scripts/read-game-logs';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'georoids-timeline-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const at = (second: number) => new Date(Date.UTC(2026, 8, 8, 12, 0, second)).toISOString();
function row(message: string, second: number, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    timestamp: at(second),
    source: 'server',
    level: 'info',
    releaseId: 'test-release',
    category: 'STATE',
    playerId: 'pilot-a',
    message,
    ...extra,
  };
}
async function file(name: string, lines: unknown[]): Promise<string> {
  const destination = path.join(directory, name);
  await writeFile(destination, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return destination;
}

test('an incident merges the selected pilot across both logs using server receive time', async () => {
  const server = await file('server.log', [
    row('joined', 1),
    row('damage.applied', 3, { receivedAt: at(0) }),
    row('another pilot', 4, { playerId: 'pilot-b' }),
  ]);
  const client = await file('client.log', [
    row('snapshot.applied', 59, {
      source: 'client',
      receivedAt: at(2),
      sessionId: 'page-a',
      context: { snapshotSequence: 1 },
    }),
  ]);
  const result = await readGameLogs([{ path: client }, { path: server }], {
    playerId: 'pilot-a',
    last: 10,
  });
  expect(result.records.map((record) => record.message)).toEqual([
    'joined',
    'snapshot.applied',
    'damage.applied',
  ]);
  expect(result.records[1]?.timestamp).toBe(at(59));
  expect(result.records[1]?.receivedAt).toBe(at(2));
  expect(result.ignoredLines).toBe(0);
});

test('a resumed session query excludes other tabs and returns only the newest matching events', async () => {
  const logs = await file('client.log', [
    row('first connection', 1, { source: 'client', sessionId: 'page-a' }),
    row('another tab', 5, { source: 'client', sessionId: 'page-b' }),
    row('reconnecting', 3, { source: 'client', sessionId: 'page-a' }),
    row('rejoined', 4, { source: 'client', sessionId: 'page-a' }),
    row('server event', 6),
  ]);
  const { query } = parseLogArguments([
    '--session',
    'page-a',
    '--source',
    'client',
    '--since',
    at(3),
    '--last',
    '1',
  ]);
  const result = await readGameLogs([{ path: logs }], query);
  expect(result.matched).toBe(2);
  expect(result.records.map((record) => record.message)).toEqual(['rejoined']);
});

test('newest events survive bounded pruning when input files are not chronological', async () => {
  const logs = await file('server.log', [
    row('latest', 50),
    row('old', 2),
    row('second latest', 49),
    row('oldest', 1),
    row('middle', 20),
    row('also old', 3),
    row('recent', 48),
  ]);
  const result = await readGameLogs([{ path: logs }], { last: 2 });
  expect(result.matched).toBe(7);
  expect(result.records.map((record) => record.message)).toEqual(['second latest', 'latest']);
});

test('unreadable evidence fails while absent optional rotations and legacy lines are reported', async () => {
  const logs = await file('server.log', [
    row('current event', 2),
    'old plain-text log',
    { broken: true },
  ]);
  const missing = path.join(directory, 'missing.log');
  const result = await readGameLogs([{ path: missing, optional: true }, { path: logs }], {
    last: 10,
  });
  expect(result.readFiles).toBe(1);
  expect(result.ignoredLines).toBe(2);
  expect(result.records.map((record) => record.message)).toEqual(['current event']);
  await expect(readGameLogs([{ path: missing }], { last: 10 })).rejects.toThrow();
  await expect(readGameLogs([{ path: missing, optional: true }], { last: 10 })).rejects.toThrow(
    'No game log files found'
  );
});

test('a mistyped query fails instead of broadening the incident search', () => {
  expect(() => parseLogArguments(['--last', '0'])).toThrow('--last');
  expect(() => parseLogArguments(['--since', '2026-09-08'])).toThrow('timezone');
  expect(() => parseLogArguments(['--source', 'browser'])).toThrow('--source');
  expect(() => parseLogArguments(['--player'])).toThrow('Missing value');
  expect(() => parseLogArguments(['--pilot', 'pilot-a'])).toThrow('Unknown option');
});
