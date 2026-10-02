// @vitest-environment node
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { readBenchmarkCompression } from '../../../benchmarks/websocket-compression';
import { createServerInstance } from '../../../server/createServer';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import { WireClient } from '../../support/wireClient';

test('the isolated compression selector rejects unknown modes and returns independent tuning objects', () => {
  expect(readBenchmarkCompression(undefined)).toEqual({ mode: 'none', perMessageDeflate: false });
  expect(readBenchmarkCompression('none')).toEqual({ mode: 'none', perMessageDeflate: false });
  for (const invalid of [
    '',
    'true',
    'level6',
    'deflate-level1-no-context ',
    'deflate-level1-no-context-8k ',
    'deflate-level1-no-context-8192',
  ]) {
    expect(() => readBenchmarkCompression(invalid)).toThrow('GEOROIDS_BENCHMARK_COMPRESSION');
  }
  const candidate = readBenchmarkCompression('deflate-level1-no-context');
  expect(candidate).toEqual({
    mode: 'deflate-level1-no-context',
    perMessageDeflate: {
      zlibDeflateOptions: { level: 1, memLevel: 5 },
      serverMaxWindowBits: 15,
      clientMaxWindowBits: 15,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 4,
      threshold: 1024,
    },
  });
  assert(candidate.perMessageDeflate);
  assert(candidate.perMessageDeflate.zlibDeflateOptions);
  candidate.perMessageDeflate.zlibDeflateOptions.level = 9;
  const next = readBenchmarkCompression('deflate-level1-no-context');
  assert(next.perMessageDeflate);
  expect(next.perMessageDeflate.zlibDeflateOptions?.level).toBe(1);
  const wider = readBenchmarkCompression('deflate-level1-no-context-8k');
  expect(wider.mode).toBe('deflate-level1-no-context-8k');
  // The original remains a separate arm; this candidate changes one option only.
  expect(wider.perMessageDeflate).toEqual({ ...next.perMessageDeflate, threshold: 8192 });
  assert(wider.perMessageDeflate);
  wider.perMessageDeflate.threshold = 1;
  expect(readBenchmarkCompression('deflate-level1-no-context-8k').perMessageDeflate).toEqual({
    ...next.perMessageDeflate,
    threshold: 8192,
  });
  expect(readBenchmarkCompression('deflate-level1-no-context').perMessageDeflate).toEqual(
    next.perMessageDeflate
  );
});

test.each([
  { mode: 'deflate-level1-no-context', candidate: false, offered: true, negotiated: false },
  { mode: 'deflate-level1-no-context', candidate: true, offered: true, negotiated: true },
  { mode: 'deflate-level1-no-context', candidate: true, offered: false, negotiated: false },
  { mode: 'deflate-level1-no-context-8k', candidate: false, offered: true, negotiated: false },
  { mode: 'deflate-level1-no-context-8k', candidate: true, offered: true, negotiated: true },
  { mode: 'deflate-level1-no-context-8k', candidate: true, offered: false, negotiated: false },
])(
  'a real socket preserves lossless text with mode=$mode, candidate=$candidate and offered=$offered',
  async ({ mode, candidate, offered, negotiated }) => {
    // The benchmark variable must not change the production factory's default.
    vi.stubEnv('GEOROIDS_BENCHMARK_COMPRESSION', mode);
    const tuning = readBenchmarkCompression(mode);
    const server = createServerInstance({
      port: 0,
      nodeEnv: 'test',
      ...(candidate ? { perMessageDeflate: tuning.perMessageDeflate } : {}),
    });
    let client: WireClient | undefined;
    try {
      const port = await server.listening;
      const text = JSON.stringify({ type: 'transportProof', data: '飛行士 🛰️ Δ'.repeat(512) });
      server.wss.once('connection', (socket) => socket.send(text));
      client = new WireClient(
        new WebSocket(
          `ws://127.0.0.1:${port}/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1`,
          { perMessageDeflate: offered }
        )
      );
      let extensions = '';
      client.ws.on('upgrade', (response) => {
        const header = response.headers['sec-websocket-extensions'];
        extensions = Array.isArray(header) ? header.join(', ') : (header ?? '');
      });
      const message = once(client.ws, 'message', { signal: AbortSignal.timeout(2000) });
      const [, received] = await Promise.all([client.open(), message]);
      expect(String(received[0])).toBe(text);
      expect(client.ws.extensions).toBe(negotiated ? 'permessage-deflate' : '');
      if (negotiated) {
        expect(extensions).toContain('server_no_context_takeover');
        expect(extensions).toContain('client_no_context_takeover');
      } else {
        expect(extensions).toBe('');
      }
      client.assertHealthy();
    } finally {
      try {
        await client?.close();
      } finally {
        try {
          await server.close();
        } finally {
          vi.unstubAllEnvs();
        }
      }
    }
  }
);
