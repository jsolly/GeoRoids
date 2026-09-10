import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

function isClosed(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.CLOSED;
}

import { SnapshotDecoder } from '../shared/snapshotProtocol';
import type { Measurement } from './results';

export const DEFAULT_TRANSPORT_SAMPLE_OPTIONS = { durationMs: 2_000, seed: 42 };
const DEADLINE_MS = 5_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEventLoopDelay(value: unknown) {
  assert(record(value), 'Missing server event-loop measurements');
  const metric = (name: string) => {
    const number = value[name];
    assert(
      typeof number === 'number' && Number.isFinite(number) && number >= 0,
      `Invalid server event-loop measurement: ${name}`
    );
    return number;
  };
  return { meanMs: metric('meanMs'), p99Ms: metric('p99Ms'), maxMs: metric('maxMs') };
}

/** Real scheduling is nondeterministic. The seed selects client IDs and requested poses only. */
export async function runTransportSample(options = DEFAULT_TRANSPORT_SAMPLE_OPTIONS) {
  const { durationMs, seed } = options;
  assert(Number.isSafeInteger(seed), 'seed must be a safe integer');
  assert(
    Number.isSafeInteger(durationMs) && durationMs >= 250 && durationMs <= 30_000,
    'durationMs must be an integer from 250 through 30000'
  );
  const failures: unknown[] = [];
  const failed = new AbortController();
  const fail = (error: unknown) => {
    failures.push(error);
    failed.abort(error);
  };
  const deadline = () => AbortSignal.any([failed.signal, AbortSignal.timeout(DEADLINE_MS)]);
  let stopping = false;
  let measuring = false;
  let closedMessage: unknown;
  const counts = {
    participants: 2,
    sentPackets: 0,
    receivedPackets: 0,
    sentPayloadBytes: 0,
    receivedPayloadBytes: 0,
    maxBufferedAmount: 0,
  };
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./transport-server.ts', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'test', PORT: '0' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }
  );
  child.on('error', fail);
  child.on('exit', (code, signal) => {
    if (!stopping || code !== 0 || signal !== null) {
      fail(new Error(`Transport child exited unexpectedly: code=${code}, signal=${signal}`));
    }
  });
  child.on('message', (message: unknown) => {
    if (!record(message)) {
      fail(new Error('Invalid transport child IPC message'));
    } else if (message['type'] === 'closed' && stopping && closedMessage === undefined) {
      closedMessage = message['eventLoopDelayMs'];
    } else if (message['type'] !== 'ready') {
      fail(new Error(`Transport child failure: ${JSON.stringify(message)}`));
    }
  });

  const ids = [0, 1].map((index) => `benchmark-transport-${seed.toString(36)}-${index}`);
  function connect(id: string, port: number) {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?snapshotVersion=1&asteroidInteractions=1`
    );
    const decoder = new SnapshotDecoder();
    const state = {
      id,
      socket,
      joined: false,
      sequence: 0,
      snapshotPackets: 0,
      decodedParticipantIds: [] as string[],
      lastSnapshotAt: 0,
      pingSentAt: 0,
      pingRttMs: [] as number[],
      snapshotDeliveryIntervalMs: [] as number[],
    };
    socket.on('error', fail);
    socket.on('close', () => {
      if (!stopping) {
        fail(new Error(`Transport client ${id} closed unexpectedly`));
      }
    });
    socket.on('message', (raw) => {
      try {
        const receivedAt = performance.now();
        const text = String(raw);
        if (measuring) {
          counts.receivedPackets++;
          counts.receivedPayloadBytes += Buffer.byteLength(text);
        }
        const message: unknown = JSON.parse(text);
        assert(record(message) && typeof message['type'] === 'string', 'Invalid server message');
        const data = message['data'];
        switch (message['type']) {
          case 'error':
            throw new Error(`Server rejected transport client: ${JSON.stringify(data)}`);
          case 'joined':
            assert(
              record(data) && data['id'] === id && !state.joined,
              `Join identity mismatch for ${id}`
            );
            assert(
              data['snapshotVersion'] === 1 && data['asteroidInteractions'] === 1,
              'Server did not negotiate enhanced snapshots'
            );
            state.joined = true;
            break;
          case 'snapshot': {
            assert(state.joined && record(data), 'Snapshot arrived before join');
            assert.equal(data['sequence'], state.sequence + 1, 'Snapshot sequence did not advance');
            const decoded = decoder.decode(data);
            state.decodedParticipantIds = decoded.entities
              .filter((entity) => entity.type === 'human')
              .map((entity) => entity.id)
              .sort();
            state.sequence++;
            state.snapshotPackets++;
            if (measuring) {
              assert.deepEqual(state.decodedParticipantIds, ids, 'Snapshot lost a participant');
              if (state.lastSnapshotAt > 0) {
                state.snapshotDeliveryIntervalMs.push(receivedAt - state.lastSnapshotAt);
              }
              state.lastSnapshotAt = receivedAt;
            }
            break;
          }
          case 'pong':
            if (measuring) {
              assert(state.pingSentAt > 0, 'Unsolicited pong');
              state.pingRttMs.push(receivedAt - state.pingSentAt);
              state.pingSentAt = 0;
            }
            break;
        }
      } catch (error) {
        fail(error);
      }
    });
    return state;
  }
  const clients: ReturnType<typeof connect>[] = [];
  function send(client: ReturnType<typeof connect>, message: object) {
    const text = JSON.stringify(message);
    client.socket.send(text, (error) => {
      if (error) {
        fail(error);
      }
    });
    if (measuring) {
      counts.sentPackets++;
      counts.sentPayloadBytes += Buffer.byteLength(text);
      counts.maxBufferedAmount = Math.max(counts.maxBufferedAmount, client.socket.bufferedAmount);
    }
  }

  try {
    const [ready]: unknown[] = await once(child, 'message', { signal: deadline() });
    assert(record(ready) && ready['type'] === 'ready', 'Child did not report readiness');
    const port = ready['port'];
    assert(
      typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535,
      'Child reported an invalid port'
    );
    for (const [index, id] of ids.entries()) {
      const client = connect(id, port);
      clients.push(client);
      await once(client.socket, 'open', { signal: deadline() });
      const angle = (((seed % 360) + index * 180) * Math.PI) / 180;
      send(client, {
        type: 'join',
        data: {
          id,
          name: `Transport Pilot ${index}`,
          position: { x: Math.cos(angle) * 600, y: Math.sin(angle) * 600 },
          kitId: 'dart',
          factionId: index === 0 ? 'ion' : 'ember',
          asteroidInteractions: 1,
          snapshotVersion: 1,
        },
      });
    }
    await Promise.all(
      clients.map(async (client) => {
        const signal = deadline();
        while (!client.joined || !ids.every((id) => client.decodedParticipantIds.includes(id))) {
          await once(client.socket, 'message', { signal });
        }
      })
    );
    failed.signal.throwIfAborted();
    measuring = true;
    const end = performance.now() + durationMs;
    while (performance.now() < end) {
      for (const client of clients) {
        if (client.pingSentAt === 0) {
          client.pingSentAt = performance.now();
          send(client, { type: 'ping', timestamp: Date.now() });
        }
      }
      await delay(Math.min(100, Math.max(1, end - performance.now())), undefined, {
        signal: failed.signal,
      });
    }
    for (const client of clients) {
      assert(client.pingRttMs.length > 0, `No ping RTT samples for ${client.id}`);
      assert(
        client.snapshotDeliveryIntervalMs.length > 0,
        `No delivery intervals for ${client.id}`
      );
      assert.deepEqual(client.decodedParticipantIds, ids, 'Final snapshot missed a participant');
    }
  } catch (error) {
    fail(error);
  } finally {
    measuring = false;
    stopping = true;
    // Forced cleanup still fails the sample, even if termination succeeds.
    const closedClients = await Promise.allSettled(
      clients.map(async ({ socket }) => {
        if (socket.readyState === WebSocket.CLOSED) {
          return;
        }
        try {
          const closed = once(socket, 'close', { signal: AbortSignal.timeout(DEADLINE_MS) });
          socket.close(1000, 'Benchmark complete');
          await closed;
        } catch (error) {
          fail(error);
          if (!isClosed(socket)) {
            const terminated = once(socket, 'close', { signal: AbortSignal.timeout(DEADLINE_MS) });
            socket.terminate();
            await terminated;
          }
        }
      })
    );
    for (const outcome of closedClients) {
      if (outcome.status === 'rejected') {
        fail(outcome.reason);
      }
    }
    try {
      assert(
        child.exitCode === null && child.signalCode === null && child.connected,
        'Transport child exited before owned shutdown'
      );
      const closed = once(child, 'close', { signal: AbortSignal.timeout(DEADLINE_MS) });
      child.send({ type: 'shutdown' }, (error) => {
        if (error) {
          fail(error);
        }
      });
      const [code, signal] = await closed;
      assert(code === 0 && signal === null, 'Transport child shutdown failed');
      readEventLoopDelay(closedMessage);
    } catch (error) {
      fail(error);
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          const terminated = once(child, 'close', { signal: AbortSignal.timeout(DEADLINE_MS) });
          try {
            assert(child.kill('SIGKILL'), 'Could not terminate transport child');
          } finally {
            await terminated;
          }
        } catch (terminationError) {
          fail(terminationError);
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Transport measurement or cleanup failed');
  }
  return {
    primaryMetric: 'pingRttMs',
    samples: {
      pingRttMs: clients.flatMap((client) => client.pingRttMs),
      snapshotDeliveryIntervalMs: clients.flatMap((client) => client.snapshotDeliveryIntervalMs),
    },
    counts,
    parameters: {
      ...options,
      serverSeed: 'owned by createServerInstance',
      scheduling: 'native, nondeterministic',
      eventLoopWindow: 'server startup through shutdown',
      bufferObservation: 'client bufferedAmount immediately after measured sends',
    },
    witness: {
      participants: clients.map((client) => ({
        id: client.id,
        joined: client.joined,
        snapshotPackets: client.snapshotPackets,
        firstSequence: 1,
        lastSequence: client.sequence,
        decodedParticipantIds: client.decodedParticipantIds,
      })),
      serverEventLoopDelayMs: readEventLoopDelay(closedMessage),
    },
    cleanup: 'complete',
  } satisfies Measurement;
}
