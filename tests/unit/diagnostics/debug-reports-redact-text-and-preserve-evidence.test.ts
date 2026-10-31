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
  // Case folding and Unicode whitespace decide where these runs end.
  ['HTTP://é?x', 'http://xn--9ca/', 'HTTP://é'],
  ['/ſ?x', '/ſ', '/ſ'],
  ['/\u212a?x', '/\u212a', '/\u212a'],
  ['http://x a?q', 'http://x/ a?q', 'http://x a?q'],
  ['http://x\u3000a?q', 'http://x/\u3000a?q', 'http://x\u3000a?q'],
  ['http://x\u00a0a?q', 'http://x/\u00a0a?q', 'http://x\u00a0a?q'],
  ['ws://[ ws://: ok', '[redacted-url] [redacted-url] ok', 'ws://[ ws://: ok'],
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

const cap = 8192;
const marker = '…[truncated]';

function harmlessText(length: number): string {
  return 'lorem ipsum dolor '.repeat(Math.ceil(length / 18)).slice(0, length);
}

/** Milliseconds per run over `times` runs, stopping once `limit` has passed. */
function perRun(work: () => void, times: number, limit = Number.POSITIVE_INFINITY): number {
  const started = performance.now();
  let runs = 0;
  while (runs < times) {
    work();
    runs++;
    if (performance.now() - started > limit) {
      break;
    }
  }
  return (performance.now() - started) / runs;
}

// Linear work costs about as much as harmless text of the same size; the
// backtracking patterns these scans replaced cost hundreds of times more, and
// unbounded URL parsing about twenty times more.
const RATIO_LIMIT = 10;

/**
 * How many times harmless input's cost the shape costs. Both sides repeat
 * until a harmless sample spans several scheduler slices, because on a loaded
 * machine a run shorter than one slice often escapes preemption while a longer
 * one never does. Rounds alternate, so load lands on both sides, and each keeps
 * its fastest round. A shape past both a second and a thousand baselines is
 * already far beyond the limit, so measuring stops there.
 */
function workRatio(shape: () => void, harmless: () => void): number {
  // The fastest of a few single runs: a preempted one would undercount repeats.
  const once = Math.min(...Array.from({ length: 5 }, () => perRun(harmless, 1)));
  const times = Math.ceil(20 / Math.max(once, 0.01));
  let shapeBest = Number.POSITIVE_INFINITY;
  let harmlessBest = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 5; round++) {
    harmlessBest = Math.min(harmlessBest, perRun(harmless, times));
    const watchdog = Math.max(harmlessBest * 1_000, 1_000);
    const cost = perRun(shape, times, watchdog);
    shapeBest = Math.min(shapeBest, cost);
    if (cost > watchdog) {
      break;
    }
  }
  return shapeBest / harmlessBest;
}

function logRecordFor(message: string) {
  return createLogRecord({
    timestamp: '2026-10-15T11:59:00.000Z',
    source: 'client',
    level: 'info',
    releaseId: 'release',
    message,
  });
}

test.each([
  ['slashes', '/'.repeat(50_000)],
  ['slash pairs', '/a'.repeat(25_000)],
  ['slashes before a quote', `${'/'.repeat(50_000)}"`],
  ['repeated schemes', 'http://'.repeat(7_000)],
  ['a link over slash pairs', `https://${'/a'.repeat(25_000)} `],
  ['query markers', 'a?'.repeat(25_000)],
  ['spaces after Bearer', `Bearer${' '.repeat(50_000)}`],
  ['spaces around a key separator', `token${' '.repeat(25_000)}:${' '.repeat(25_000)}`],
  // Large enough that the URL-parse budget's fixed cost does not dominate.
  ['URLs that cannot parse', 'ws://[ '.repeat(50_000)],
])('%s cost redaction about what harmless text of the same length costs', (_name, shape) => {
  const harmless = harmlessText(shape.length);
  const sanitize = (text: string) => () => {
    sanitizeDebugDiagnostics({ state: { browser: text }, recentLogs: [] });
  };
  const log = (text: string) => () => {
    logRecordFor(text);
  };
  expect(workRatio(sanitize(shape), sanitize(harmless))).toBeLessThan(RATIO_LIMIT);
  expect(workRatio(log(shape), log(harmless))).toBeLessThan(RATIO_LIMIT);
});

function uploadBody(state: string[], logMessage: string, logs = 80): string {
  return JSON.stringify({
    ...report,
    diagnostics: {
      state: { ...report.diagnostics.state, browser: state },
      recentLogs: Array.from({ length: logs }, () =>
        JSON.stringify({
          version: 1,
          source: 'client',
          level: 'error',
          timestamp: '2026-10-15T12:00:00.000Z',
          message: logMessage,
        })
      ),
    },
  });
}

test.each([
  // The quadratic case for both former query patterns: once about 45 seconds.
  ['slashes', uploadBody(['/'.repeat(150_000)], '/'.repeat(8_000))],
  // `new URL` throws every seven bytes: once about a second per MiB of state.
  [
    'URLs that cannot parse',
    uploadBody(
      Array.from({ length: 240 }, () => 'ws://[ '.repeat(1_170)),
      '',
      0
    ),
  ],
])(
  'two back-to-back uploads of %s cost the worker about what harmless uploads do',
  (_name, body) => {
    const parsed = JSON.parse(body) as {
      diagnostics: { state: { browser: string[] }; recentLogs: string[] };
    };
    const harmless = uploadBody(
      parsed.diagnostics.state.browser.map((text) => harmlessText(text.length)),
      harmlessText(8_000),
      parsed.diagnostics.recentLogs.length
    );
    // Parsing cleans each log record and the sanitizer redacts the rest: the
    // worker's whole CPU share of an upload, without the SQLite write.
    const twoUploads = (text: string) => () => {
      for (let upload = 0; upload < 2; upload++) {
        sanitizeDebugDiagnostics(parseDebugReportSubmission(JSON.parse(text)).diagnostics, [
          'server-credential',
        ]);
      }
    };
    expect(workRatio(twoUploads(body), twoUploads(harmless))).toBeLessThan(RATIO_LIMIT);
  }
);

test('one sanitizer pass parses 2,048 URLs across state and logs, then redacts the rest whole', () => {
  const link = (index: number) => `https://pilot:hunter2@example.com/frame${index}?session=1#top`;
  const links = (from: number, count: number) =>
    Array.from({ length: count }, (_, offset) => link(from + offset)).join(' ');
  const { state, recentLogs } = sanitizeDebugDiagnostics({
    state: { browser: links(0, 1_020), audio: links(1_020, 1_020) },
    recentLogs: [
      JSON.stringify({ message: links(2_040, 5) }),
      JSON.stringify({ message: links(2_045, 5) }),
    ],
  });
  const texts = [
    state['browser'] as string,
    state['audio'] as string,
    ...recentLogs.map((line) => (JSON.parse(line) as { message: string }).message),
  ];
  const words = texts.flatMap((text) => text.split(' '));
  expect(words).toHaveLength(2_050);
  expect(words.slice(0, 2_048)).toEqual(
    Array.from({ length: 2_048 }, (_, index) => `https://example.com/frame${index}`)
  );
  expect(words.slice(2_048)).toEqual(['[redacted-url]', '[redacted-url]']);
  expect(texts.join(' ')).not.toContain('hunter2');
});

function clippedState(state: Record<string, string>) {
  return parseDebugReportSubmission({
    ...report,
    diagnostics: { ...report.diagnostics, state: { ...report.diagnostics.state, ...state } },
  });
}

test('an oversized diagnostic string is clipped with a marker that survives a second parse', () => {
  const exact = 'e'.repeat(cap);
  const parsed = clippedState({
    browser: `${'x/'.repeat(10_000)}tail`,
    canvas: exact,
    // A high surrogate at the cut is dropped with its pair.
    graphics: `${'a'.repeat(cap - marker.length - 1)}🚀${'b'.repeat(100)}`,
    // A pair that ends exactly at the cut is kept whole.
    audio: `${'a'.repeat(cap - marker.length - 2)}🚀${'b'.repeat(100)}`,
  });
  expect(parsed.diagnostics.state).toMatchObject({
    browser: `${'x/'.repeat((cap - marker.length) / 2)}${marker}`,
    canvas: exact,
    graphics: `${'a'.repeat(cap - marker.length - 1)}${marker}`,
    audio: `${'a'.repeat(cap - marker.length - 2)}🚀${marker}`,
  });
  expect(parseDebugReportSubmission(parsed)).toEqual(parsed);
});

test('a clip through a secret drops its prefix and redaction keeps the clip marker', () => {
  const hex = '0123456789abcdef'.repeat(4);
  const filler = (length: number) => 'z '.repeat(length / 2);
  const parsed = clippedState({
    // 30 characters of a 64-hex secret before the cut, 34 after it.
    browser: `${filler(cap - marker.length - 30)}${hex}`,
    // A query that the cut leaves open would otherwise run into the marker.
    page: `${filler(cap - marker.length - 12)}/p?token=abcdefghijklmnopqrstuvwxyz`,
    // A word longer than the reach keeps all but its last 128 characters.
    canvas: 'w'.repeat(cap * 2),
  });
  expect(parsed.diagnostics.state).toMatchObject({
    browser: `${filler(cap - marker.length - 30)}${marker}`,
    page: `${filler(cap - marker.length - 12)}/p?token=${marker}`,
    canvas: `${'w'.repeat(cap - marker.length - 128)}${marker}`,
  });
  const redacted = sanitizeDebugDiagnostics(parsed.diagnostics, ['e', 'r']).state;
  expect(redacted['browser']).toBe(`${filler(cap - marker.length - 30)}${marker}`);
  expect(redacted['page']).toBe(`${filler(cap - marker.length - 12)}/p${marker}`);
  expect(redacted['canvas']).toBe(`${'w'.repeat(cap - marker.length - 128)}${marker}`);
});

/** mulberry32: every output bit depends on the whole state, unlike an LCG's low bits. */
function seeded(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296) * limit);
  };
}

test('linear query stripping matches the backtracking patterns it replaced on generated text', () => {
  // The former patterns are the reference: safe on these short strings, and
  // quadratic only on long runs.
  const formerPath = /(\/[a-z0-9._~!$&'()*+,;=:@%/-]+)[?#][^\s"'<>]*/giu;
  const formerLink = /((?:https?:\/\/[^\s?#]+|\/[a-z0-9._~!$&'()*+,;=:@%/-]+))[?#][^\s]*/giu;
  const unicode = ['ſ', 'K', ' ', ' ', '　', '\ud800', '\udc00', 'é', '🚀'];
  const alphabets: [string, string[], number][] = [
    [
      'mixed',
      [
        ...['/', '/', '//', 'a', 'Z', '?', '#', ' ', '\n', '"', "'", '<', '>'],
        ...['h', ':', '.', '%', '-', '=', '&', ';'],
        ...['http://', 'https://', 'HTTP://', 'httpſ://'],
        ...unicode,
      ],
      40,
    ],
    // Dense alphabets reach rarer shapes: a quote that ends one query and starts
    // the next path, a link whose host holds no path character, and runs whose
    // ends turn on case folding or Unicode whitespace.
    ['quotes and hosts', ['/', 'a', '?', "'", ' ', 'é', 'http://'], 16],
    ['folding and spaces', ['/', '?', '#', 'x', 'HTTP://', ...unicode], 12],
  ];
  const next = seeded(0x9e3779b9);
  for (const [name, alphabet, longest] of alphabets) {
    const seen = new Set<string>();
    for (let index = 0; index < 20_000; index++) {
      let text = '';
      for (let length = next(longest + 1); length > 0; length--) {
        text += alphabet[next(alphabet.length)];
      }
      seen.add(text);
      expect(dropPathQueries(text), JSON.stringify(text)).toBe(text.replace(formerPath, '$1'));
      expect(dropLinkQueries(text), JSON.stringify(text)).toBe(text.replace(formerLink, '$1'));
    }
    expect(seen.size, name).toBeGreaterThan(15_000);
  }
  // Pinned separately so the shapes stay covered if the generator changes.
  expect(dropPathQueries("/a?b/c'd?f")).toBe("/a'd?f");
  expect(dropLinkQueries("/a?b/c'd?f")).toBe('/a');
  expect(dropPathQueries('see http://é?x#y z')).toBe('see http://é?x#y z');
  expect(dropLinkQueries('see http://é?x#y z')).toBe('see http://é z');
});
