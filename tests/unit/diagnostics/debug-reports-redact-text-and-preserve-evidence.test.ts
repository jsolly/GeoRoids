import { expect, test } from 'vitest';
import {
  formatDebugDiagnostics,
  parseDebugReportSubmission,
  sanitizeDebugDiagnostics,
} from '../../../shared/debugReports';
import { createLogRecord } from '../../../shared/logRecords';
import { dropLinkQueries, dropPathQueries } from '../../../shared/queryRedaction';
import type { DebugReportSubmission } from '../../../shared-types';

const report: DebugReportSubmission = {
  version: 1,
  id: '12345678-1234-4123-8123-123456789abc',
  receiptToken: 'c'.repeat(64),
  submittedAt: '2026-10-15T12:00:00.000Z',
  description: 'My ship stopped. Please investigate.',
  diagnostics: {
    state: {
      version: 1,
      capturedAt: '2026-10-15T11:59:00.000Z',
      sessionId: 'page-one',
      input: { pointerHeading: 42, liveTouches: 2 },
      audio: {
        error: {
          cause:
            'Alice disconnected from https://user:password@example.com/ws?resumeToken=secret#private',
        },
      },
    },
    recentLogs: [
      JSON.stringify({
        version: 1,
        source: 'client',
        level: 'error',
        timestamp: '2026-10-15T11:59:00.000Z',
        releaseId: 'a'.repeat(40),
        message: `Alice Bearer password-123 ${'b'.repeat(64)}`,
        context: {
          nested: { resumeToken: 'private', stack: 'https://example.com/error?secret=abc#private' },
        },
      }),
    ],
  },
};

test('diagnostic text redaction removes embedded secrets while preserving a frozen input snapshot', () => {
  const snapshot = sanitizeDebugDiagnostics(report.diagnostics, ['Alice']);
  const text = formatDebugDiagnostics(snapshot);
  for (const secret of [
    'Alice',
    'password-123',
    'user:password',
    '?resumeToken',
    '?secret',
    '#private',
    'b'.repeat(64),
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(text).toContain('https://example.com/ws');
  expect(text).toContain('"pointerHeading": 42');
  expect(text).toContain('"liveTouches": 2');
  expect(report.diagnostics.recentLogs[0]).toContain('Alice');
  const input = report.diagnostics.state['input'];
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    input['liveTouches'] = 0;
  }
  expect(formatDebugDiagnostics(snapshot)).toContain('"liveTouches": 2');
});

test('report boundary rejects unsupported state dumps and invalid log records without clipping evidence', () => {
  expect(parseDebugReportSubmission(report).description).toBe(report.description);
  expect(() =>
    parseDebugReportSubmission({
      ...report,
      diagnostics: { ...report.diagnostics, state: { ...report.diagnostics.state, rawWorld: {} } },
    })
  ).toThrow('Unsupported diagnostic field');
  expect(() =>
    parseDebugReportSubmission({
      ...report,
      diagnostics: { ...report.diagnostics, recentLogs: ['plaintext'] },
    })
  ).toThrow('Invalid client diagnostic record');
  expect(() => parseDebugReportSubmission({ ...report, description: ' ' })).toThrow(
    'Invalid debug report'
  );
  expect(() => parseDebugReportSubmission({ ...report, description: 'x'.repeat(4001) })).toThrow(
    'Invalid debug report'
  );
});

test.each(['client', 'e', '2026', 'http', 'Bearer', 'token', 'password'])(
  'pilot name %s cannot corrupt structural diagnostic fields',
  (nickname) => {
    const snapshot = sanitizeDebugDiagnostics(report.diagnostics, [nickname]);
    const parsed = parseDebugReportSubmission({ ...report, diagnostics: snapshot });
    expect(parsed.diagnostics.state['capturedAt']).toBe('2026-10-15T11:59:00.000Z');
    const line: unknown = JSON.parse(parsed.diagnostics.recentLogs[0] ?? '');
    expect(line).toMatchObject({
      source: 'client',
      level: 'error',
      timestamp: '2026-10-15T11:59:00.000Z',
    });
    expect(JSON.stringify(snapshot)).not.toContain('user:password');
    expect(JSON.stringify(snapshot)).not.toContain('password-123');
  }
);

test('redacting a repeated short pilot name does not inflate a near-limit log', () => {
  const log = {
    version: 1,
    source: 'client',
    level: 'error',
    timestamp: '2026-10-15T11:59:00.000Z',
    message: 'e '.repeat(3500),
  };
  const snapshot = sanitizeDebugDiagnostics(
    { state: report.diagnostics.state, recentLogs: [JSON.stringify(log)] },
    ['e']
  );
  expect(() => parseDebugReportSubmission({ ...report, diagnostics: snapshot })).not.toThrow();
  expect(new TextEncoder().encode(snapshot.recentLogs[0]).length).toBeLessThanOrEqual(
    new TextEncoder().encode(JSON.stringify(log)).length
  );
});

const hexA = 'a'.repeat(64);
const hexF = 'F'.repeat(64);
const hexC = 'c'.repeat(64);
const longHex = 'b'.repeat(65);
// [input, report sanitizer output, log record output], pinned from the regex
// implementation these replaced, so a linear rewrite must reproduce each one.
const redactionCases: [string, string, string][] = [
  [
    'GET https://user:pw@example.com/ws/play?resumeToken=abc#frag done',
    'GET https://example.com/ws/play done',
    'GET https://user:pw@example.com/ws/play done',
  ],
  ['wss://h.example:8443/socket?x=1', 'wss://h.example:8443/socket', 'wss://h.example:8443/socket'],
  ['http://h/a?b', 'http://h/a', 'http://h/a'],
  ['x/a?b', 'x/a', 'x/a'],
  [
    'see /assets/app.js?v=12#L4 and /index.html#top',
    'see /assets/app.js and /index.html',
    'see /assets/app.js and /index.html',
  ],
  [
    'relative ./src/a.ts?raw and ../b/c?d',
    'relative ./src/a.ts and ../b/c',
    'relative ./src/a.ts and ../b/c',
  ],
  ['a/?b', 'a/?b', 'a/?b'],
  ['/?q', '/?q', '/?q'],
  ['//?q', '//', '//'],
  ['/a?b"tail /c#d', '/a"tail /c', '/a /c'],
  ["/a?b'/c?d", "/a'/c", '/a'],
  ['a?/b?c', 'a?/b', 'a?/b'],
  ['path/only/no/query', 'path/only/no/query', 'path/only/no/query'],
  ['HTTP://Host.Example/Path?Q=1', 'http://host.example/Path', 'HTTP://Host.Example/Path'],
  ['httpſ://h/a?b', '[redacted-url]', 'httpſ://h/a'],
  ['http://[::1/a?b', '[redacted-url]', 'http://[::1/a'],
  ['mailto:/x?y', 'mailto:/x', 'mailto:/x'],
  ['ftp://h/a?b', 'ftp://h/a', 'ftp://h/a'],
  ['not a url http:// nor ?query', 'not a url http:// nor ?query', 'not a url http:// nor ?query'],
  [
    'Authorization: Bearer abc.def-ghi rest',
    '[redacted] [redacted] rest',
    'Authorization=[redacted] [redacted] rest',
  ],
  ['bearer   xyz', 'Bearer [redacted]', 'bearer [redacted]'],
  [
    'password=hunter2; token:abc,secret = s3 resumeToken=r&cookie: c=1',
    '[redacted]; [redacted],[redacted] [redacted]&[redacted]',
    'password=[redacted]; token=[redacted],secret=[redacted] resumeToken=[redacted]&cookie=[redacted]',
  ],
  ['TOKEN=Upper ok', '[redacted] ok', 'TOKEN=[redacted] ok'],
  [
    `hash ${hexA} and ${hexF}x and ${longHex}`,
    `hash [redacted] and ${hexF}x and ${longHex}`,
    `hash ${hexA} and ${hexF}x and ${longHex}`,
  ],
  [
    `mixed /p/q?token=1 Bearer t ${hexC} https://e.com/x?y Alice`,
    'mixed /p/q Bearer [redacted] [redacted] https://e.com/x *',
    `mixed /p/q Bearer [redacted] ${hexC} https://e.com/x Alice`,
  ],
];

test.each(redactionCases)(
  'report and log redaction of %j keep their established output',
  (input, reported, logged) => {
    const snapshot = sanitizeDebugDiagnostics({ state: { browser: input }, recentLogs: [] }, [
      'Alice',
    ]);
    expect(snapshot.state['browser']).toBe(reported);
    const record = createLogRecord({
      timestamp: '2026-10-15T11:59:00.000Z',
      source: 'client',
      level: 'info',
      releaseId: 'release',
      message: input,
    });
    expect(record.message).toBe(logged);
  }
);

test('pathological diagnostic text is redacted in bounded time', () => {
  // Each shape is a worst case for the backtracking patterns these scans
  // replaced: 150,000 slashes alone took the report sanitizer about 34 seconds.
  const size = 150_000;
  const shapes = [
    '/'.repeat(size),
    '/a'.repeat(size / 2),
    `${'/'.repeat(size)}"`,
    'http://'.repeat(size / 7),
    `https://${'/a'.repeat(size / 2)} `,
    'a?'.repeat(size / 2),
    `Bearer${' '.repeat(size)}`,
    `token${' '.repeat(size)}:${' '.repeat(size)}`,
    'a'.repeat(size),
  ];
  const started = performance.now();
  for (const shape of shapes) {
    const snapshot = sanitizeDebugDiagnostics({ state: { browser: shape }, recentLogs: [] });
    expect(typeof snapshot.state['browser']).toBe('string');
    createLogRecord({
      timestamp: '2026-10-15T11:59:00.000Z',
      source: 'client',
      level: 'info',
      releaseId: 'release',
      message: shape,
    });
  }
  // Linear scans finish these in milliseconds; the bound only has to separate
  // that from tens of seconds.
  expect(performance.now() - started).toBeLessThan(1_000);
});

test('an oversized diagnostic string is clipped with a marker that survives a second parse', () => {
  const cap = 8192;
  const marker = '…[truncated]';
  const exact = 'e'.repeat(cap);
  const parsed = parseDebugReportSubmission({
    ...report,
    diagnostics: {
      ...report.diagnostics,
      state: {
        ...report.diagnostics.state,
        browser: `${'x'.repeat(20_000)}tail`,
        page: { exact, split: `${'a'.repeat(cap - marker.length - 1)}🚀${'b'.repeat(100)}` },
      },
    },
  });
  const browser = parsed.diagnostics.state['browser'];
  expect(browser).toBe(`${'x'.repeat(cap - marker.length)}${marker}`);
  const page = parsed.diagnostics.state['page'];
  expect(page).toEqual({
    exact,
    // Clipping never leaves half of a surrogate pair behind.
    split: `${'a'.repeat(cap - marker.length - 1)}${marker}`,
  });
  expect(parseDebugReportSubmission(parsed)).toEqual(parsed);
});

test('linear query stripping matches the backtracking patterns it replaced on generated text', () => {
  // The former patterns are the reference: safe on these short strings, and
  // quadratic only on long runs.
  const formerPath = /(\/[a-z0-9._~!$&'()*+,;=:@%/-]+)[?#][^\s"'<>]*/giu;
  const formerLink = /((?:https?:\/\/[^\s?#]+|\/[a-z0-9._~!$&'()*+,;=:@%/-]+))[?#][^\s]*/giu;
  const pieces = [
    '/',
    '/',
    '//',
    'a',
    'Z',
    '?',
    '#',
    ' ',
    '\n',
    ' ',
    ' ',
    '"',
    "'",
    '<',
    '>',
    'h',
    ':',
    '.',
    '%',
    '-',
    '=',
    '&',
    ';',
    'é',
    '🚀',
    '\uD800',
    'ſ',
    'K',
    'http://',
    'https://',
    'HTTP://',
    'httpſ://',
  ];
  // A dense alphabet reaches the rarer shapes: a quote that ends one query and
  // starts the next path, and a link whose host holds no path character.
  const dense = ['/', 'a', '?', "'", ' ', 'é', 'http://'];
  let seed = 0x9e3779b9;
  const next = (limit: number): number => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return seed % limit;
  };
  for (const [alphabet, longest] of [
    [pieces, 40],
    [dense, 12],
  ] as const) {
    for (let index = 0; index < 20_000; index++) {
      let text = '';
      for (let length = next(longest); length > 0; length--) {
        text += alphabet[next(alphabet.length)];
      }
      expect(dropPathQueries(text), JSON.stringify(text)).toBe(text.replace(formerPath, '$1'));
      expect(dropLinkQueries(text), JSON.stringify(text)).toBe(text.replace(formerLink, '$1'));
    }
  }
  // Pinned separately so the shapes stay covered if the generator changes.
  expect(dropPathQueries("/a?b/c'd?f")).toBe("/a'd?f");
  expect(dropLinkQueries("/a?b/c'd?f")).toBe('/a');
  expect(dropPathQueries('see http://é?x#y z')).toBe('see http://é?x#y z');
  expect(dropLinkQueries('see http://é?x#y z')).toBe('see http://é z');
});
