import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseLogRecord } from '../shared/logRecords';
import type { DiagnosticLogRecord } from '../shared-types';

export interface LogQuery {
  playerId?: string;
  sessionId?: string;
  source?: 'client' | 'server';
  since?: number;
  last: number;
}

interface LogInput {
  path: string;
  optional?: boolean;
}

const DEFAULT_FILES = [
  'logs/server.log.1',
  'logs/server.log',
  'logs/client.log.1',
  'logs/client.log',
];
const MAX_LINE_BYTES = 16 * 1024;
const HELP = `Read a merged GeoRoids JSONL incident timeline.

Usage: npm run --silent logs -- [--player ID] [--session ID] [--source client|server]
                      [--since ISO_TIMESTAMP] [--last 1..1000] [--file PATH]...

Defaults: newest 100 records from current and rotated server/client logs.
Client rows sort by server receivedAt; other rows sort by timestamp.
--file replaces the default files and may be repeated. Output is JSONL.
Run from the GeoRoids repository root. No network requests are made.`;

export function parseLogArguments(args: string[]): { files: LogInput[]; query: LogQuery } {
  const files: LogInput[] = [];
  const query: LogQuery = { last: 100 };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag ?? 'option'}`);
    }
    index++;
    switch (flag) {
      case '--file':
        files.push({ path: value });
        break;
      case '--player':
        query.playerId = value;
        break;
      case '--session':
        query.sessionId = value;
        break;
      case '--source':
        if (value !== 'client' && value !== 'server') {
          throw new Error('--source must be client or server');
        }
        query.source = value;
        break;
      case '--since': {
        const since = Date.parse(value);
        if (!Number.isFinite(since) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
          throw new Error('--since requires an ISO timestamp with a timezone');
        }
        query.since = since;
        break;
      }
      case '--last': {
        const last = Number(value);
        if (!/^\d+$/.test(value) || !Number.isInteger(last) || last < 1 || last > 1000) {
          throw new Error('--last must be an integer from 1 to 1000');
        }
        query.last = last;
        break;
      }
      default:
        throw new Error(`Unknown option: ${flag ?? ''}`);
    }
  }
  return {
    files: files.length ? files : DEFAULT_FILES.map((path) => ({ path, optional: true })),
    query,
  };
}

/** Streaming inputs and periodic pruning retain at most twice the requested row limit. */
export async function readGameLogs(files: LogInput[], query: LogQuery) {
  let records: Array<{ at: number; order: number; record: DiagnosticLogRecord }> = [];
  let readFiles = 0;
  let ignoredLines = 0;
  let matched = 0;
  const compare = (left: (typeof records)[number], right: (typeof records)[number]) =>
    left.at - right.at || left.order - right.order;

  for (const input of files) {
    const stream = createReadStream(input.path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    // readline does not forward stream errors to its async iterator.
    let streamError: Error | undefined;
    stream.on('error', (error) => {
      streamError = error;
      lines.close();
    });
    try {
      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const record = Buffer.byteLength(line) <= MAX_LINE_BYTES ? parseLogRecord(line) : undefined;
        const at = record
          ? Date.parse(
              record.source === 'client'
                ? (record.receivedAt ?? record.timestamp)
                : record.timestamp
            )
          : Number.NaN;
        if (!record || !Number.isFinite(at)) {
          ignoredLines++;
          continue;
        }
        if (
          (query.playerId && record.playerId !== query.playerId) ||
          (query.sessionId && record.sessionId !== query.sessionId) ||
          (query.source && record.source !== query.source) ||
          (query.since !== undefined && at < query.since)
        ) {
          continue;
        }
        records.push({ at, order: matched++, record });
        if (records.length >= query.last * 2) {
          records = records.sort(compare).slice(-query.last);
        }
      }
      if (streamError) {
        throw streamError;
      }
      readFiles++;
    } catch (error) {
      if (
        !input.optional ||
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  if (!readFiles) {
    throw new Error(
      'No game log files found. Start the game or pass --file with a saved JSONL log.'
    );
  }
  return {
    records: records
      .sort(compare)
      .slice(-query.last)
      .map(({ record }) => record),
    ignoredLines,
    matched,
    readFiles,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const { files, query } = parseLogArguments(args);
  const result = await readGameLogs(files, query);
  for (const record of result.records) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
  process.stderr.write(
    `Read ${result.readFiles} files; matched ${result.matched} records; returned ${result.records.length}.` +
      (result.ignoredLines
        ? ` Ignored ${result.ignoredLines} legacy, malformed, or oversized lines.`
        : '') +
      '\n'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`logs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
