import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import {
  bindRegionalPilotOwner,
  matchesAppliedRegionalWork,
  RegionalDecodedWorkCache,
  RegionalScanSchedule,
  regionalSnapshotWork,
  regionalWorkKey,
  requireAppliedRegionalWork,
} from '../../../benchmarks/regional-scan-workload';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import {
  SNAPSHOT_VERSION,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import {
  APPLIED_SNAPSHOT_SAMPLE_LIMIT,
  ClientPerformanceMetrics,
} from '../../../src/diagnostics/performanceMetrics';
import { snapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';
import { snapshotFixture } from '../network/snapshotFixture';

test('a natural browser binds its actual joined owner before applying and acknowledging its first keyframe', () => {
  const engine = new GameEngine(42);
  const broadcaster = new GameStateBroadcaster(engine);
  const handler = new MessageHandler(engine, broadcaster);
  const socket = new RecordingSocket();
  const wireDecoder = new SnapshotDecoder();
  const clientDecoder = new SnapshotDecoder();
  const metrics = new ClientPerformanceMetrics(true);
  let owner: string | undefined;
  let firstWork: ReturnType<typeof regionalSnapshotWork>;
  try {
    handler.handleMessage(
      {
        type: 'join',
        data: {
          id: 'natural-browser',
          name: 'Natural browser',
          kitId: 'scout',
          snapshotVersion: SNAPSHOT_VERSION,
          asteroidInteractions: 1,
        },
      },
      socket
    );
    for (const raw of socket.sent) {
      const wire = wireDecoder.readMessage(raw, { acceptSnapshots: owner !== undefined });
      const client = clientDecoder.readMessage(raw, { acceptSnapshots: owner !== undefined });
      if (wire.kind === 'message') {
        const envelope = wire.message;
        if (
          envelope &&
          typeof envelope === 'object' &&
          'type' in envelope &&
          envelope.type === 'joined' &&
          'data' in envelope
        ) {
          owner = bindRegionalPilotOwner(envelope.data, owner);
          wireDecoder.reset();
          clientDecoder.reset();
          metrics.resetSnapshotWitness();
          expect(metrics.read().lastSnapshot).toBeUndefined();
        }
        continue;
      }
      assert.equal(wire.kind, 'snapshot');
      assert.equal(client.kind, 'snapshot');
      assert(owner && wire.kind === 'snapshot' && client.kind === 'snapshot');
      expect(wire.metadata.kind).toBe('keyframe');
      firstWork = regionalSnapshotWork(wire.state, wire.metadata, owner);
      const appliedOwner = owner;
      assert(client.state.entities.some((entity) => entity.id === appliedOwner));
      metrics.snapshotApplied({
        ownerId: owner,
        ...client.metadata,
        gameTime: client.state.gameTime,
        serverTime: client.state.serverTime,
      });
      expect(matchesAppliedRegionalWork(firstWork, metrics.read().lastSnapshot)).toBe(true);
      const actualApplication = metrics.read().appliedSnapshots.values.at(-1);
      assert(actualApplication);
      expect(
        requireAppliedRegionalWork(
          firstWork,
          actualApplication,
          owner,
          metrics.read().snapshotSession
        )
      ).toEqual(firstWork);
      handler.handleMessage(
        { type: 'snapshotAck', data: { sequence: client.metadata.sequence } },
        socket
      );
    }
    assert(firstWork, 'Initial natural keyframe carried the joined owner');
    expect(owner).toBe('natural-browser');
    expect(metrics.read().lastSnapshot?.sequence).toBe(1);
    expect(firstWork.asteroidRows).toBeGreaterThan(0);
    expect(firstWork.scanning).toBe(false);
    // The first applied ACK retires initial credit; the next real server offer
    // retains the same socket's sequence and decoder baseline generation.
    socket.clear();
    engine.advanceOneFrame();
    broadcaster.broadcastGameState();
    const next = socket.sent[socket.inbox.findIndex((message) => message.type === 'snapshot')];
    assert(next, 'The healthy joined browser received the next server offer');
    const applied = clientDecoder.readMessage(next, { acceptSnapshots: true });
    assert(applied.kind === 'snapshot');
    expect(applied.metadata.sequence).toBe(2);
    expect(applied.metadata.kind).toBe('delta');
    const joined = {
      id: owner,
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      resumeToken: 'private',
    };
    expect(bindRegionalPilotOwner(joined, owner)).toBe(owner);
    expect(() => bindRegionalPilotOwner({ ...joined, id: 'other-pilot' }, owner)).toThrow(
      'changed the browser owner'
    );
    expect(() => bindRegionalPilotOwner({ ...joined, snapshotVersion: 1 }, owner)).toThrow(
      'Invalid regional joined'
    );
    expect(() => bindRegionalPilotOwner({ ...joined, resumeToken: '' }, owner)).toThrow(
      'Invalid regional joined'
    );
  } finally {
    engine.stopGameLoop();
    broadcaster.stopPeriodicBroadcast();
  }
});

test('a natural pilot retries a due scan after simulation lag keeps the real cooldown active', () => {
  const schedule = new RegionalScanSchedule();
  expect(schedule.plan(19, false, true, 0)).toBe('not-due');
  expect(schedule.plan(20, false, true, 0)).toBe('dispatch');
  schedule.dispatched();
  // Measurement starts while the warmup scan still cools. Neither wall time
  // nor a new measured phase is permission to reset the authoritative timer.
  expect(schedule.plan(31, true, false, 600)).toBe('waiting-authoritative');
  expect(schedule.plan(40, true, false, 45)).toBe('waiting-authoritative');
  expect(schedule.plan(41, true, false, 0)).toBe('waiting-ui');
  expect(schedule.plan(42, true, true, 0)).toBe('dispatch');
  // A failed input dispatch leaves the pending action available for the next slot.
  expect(schedule.plan(43, true, true, 0)).toBe('dispatch');
  schedule.dispatched();
  expect(schedule.plan(44, true, true, 0)).toBe('not-due');
});

test('natural scans fail closed on missing cooldown evidence and use the trusted input readiness', () => {
  const schedule = new RegionalScanSchedule();
  for (const cooldown of [undefined, Number.NaN, -1, 1, Number.POSITIVE_INFINITY]) {
    expect(schedule.plan(20, false, true, cooldown)).toBe('waiting-authoritative');
  }
  expect(schedule.plan(21, false, false, 0)).toBe('waiting-ui');
  expect(schedule.plan(22, false, true, 0)).toBe('dispatch');
  schedule.dispatched();
  expect(() => schedule.dispatched()).toThrow('without a pending request');
  expect(() => schedule.plan(0, false, true, 0)).toThrow('Invalid regional input step');
});

test('normal and expanded scan work count only when the decoded state matches actual client application', () => {
  const state = snapshotFixture();
  state.serverTime = 1_700_000_000_000;
  const own = state.entities.find((entity) => entity.id === 'pilot-0');
  const rock = state.asteroids[0];
  assert(own && rock);
  rock.position = { x: own.position.x + WORLD.asteroidInterestRadius + 1, y: own.position.y };
  const metadata = { kind: 'delta', sequence: 7 } as const;
  const normal = regionalSnapshotWork(state, metadata, own.id);
  assert(normal);
  expect(normal.scanning).toBe(false);
  expect(normal.expanded).toBe(false);
  own.abilityActiveFrames = 120;
  own.abilityCooldownFrames = 1200;
  const scan = regionalSnapshotWork(state, metadata, own.id);
  assert(scan);
  expect(scan.scanning).toBe(true);
  expect(scan.expanded).toBe(true);
  const applied = {
    ...metadata,
    gameTime: state.gameTime,
    serverTime: state.serverTime,
  };
  expect(matchesAppliedRegionalWork(scan, undefined)).toBe(false);
  expect(matchesAppliedRegionalWork(undefined, applied)).toBe(false);
  expect(matchesAppliedRegionalWork(scan, { ...applied, sequence: 6 })).toBe(false);
  expect(matchesAppliedRegionalWork(scan, { ...applied, kind: 'keyframe' })).toBe(false);
  expect(matchesAppliedRegionalWork(scan, { ...applied, gameTime: state.gameTime + 1 })).toBe(
    false
  );
  expect(matchesAppliedRegionalWork(scan, { ...applied, serverTime: undefined })).toBe(false);
  expect(
    matchesAppliedRegionalWork(scan, { ...applied, serverTime: (state.serverTime ?? 0) + 1 })
  ).toBe(false);
  expect(matchesAppliedRegionalWork(scan, applied)).toBe(true);
  // Tool swaps and missing pilots cannot masquerade as Mineral Scan coverage.
  own.scoutUtility = 'survey_probe';
  expect(regionalSnapshotWork(state, metadata, own.id)?.scanning).toBe(false);
  expect(regionalSnapshotWork(state, metadata, 'missing-pilot')).toBeUndefined();
  own.scoutUtility = 'mineral_scan';
  state.asteroids = [
    { ...rock, position: { x: own.position.x + WORLD.asteroidInterestRadius, y: own.position.y } },
  ];
  expect(regionalSnapshotWork(state, metadata, own.id)?.expanded).toBe(false);
  // Retained proof consists of detached scalars, not a mutable world row.
  own.abilityCooldownFrames = 0;
  own.abilityActiveFrames = 0;
  expect(scan.cooldownFrames).toBe(1200);
  expect(scan.scanning).toBe(true);
});

test('a short expanded scan applied between two normal worlds remains evidence after a single browser drain', () => {
  const decoder = new SnapshotDecoder();
  const recorder = new ClientPerformanceMetrics(true);
  // Transport/session resets are recorder-owned; a wire join ordinal is not this ID.
  recorder.resetSnapshotWitness();
  recorder.resetSnapshotWitness();
  recorder.resetSnapshotWitness();
  const cache = new Map<string, NonNullable<ReturnType<typeof regionalSnapshotWork>>>();
  for (let tick = 0; tick < 3; tick++) {
    const state = snapshotFixture(tick);
    state.serverTime = 1000 + tick * 17;
    const owner = state.entities.find((entity) => entity.id === 'pilot-0');
    const rock = state.asteroids[0];
    assert(owner && rock);
    owner.abilityActiveFrames = tick === 1 ? 120 : 0;
    rock.position = { x: owner.position.x + WORLD.asteroidInterestRadius + 1, y: owner.position.y };
    const encoder = new SnapshotEncoder(state);
    const actual = decoder.readMessage(snapshotMessage(encoder.encode(tick + 1)), {
      acceptSnapshots: true,
    });
    assert(actual.kind === 'snapshot');
    const work = regionalSnapshotWork(actual.state, actual.metadata, owner.id);
    assert(work);
    cache.set(regionalWorkKey(owner.id, work), work);
    // Mirrors production: successful decode and world membership precede receipt/ACK.
    assert(actual.state.entities.some((entity) => entity.id === owner.id));
    recorder.snapshotApplied({
      ownerId: owner.id,
      ...actual.metadata,
      gameTime: actual.state.gameTime,
      serverTime: actual.state.serverTime,
    });
  }
  const drain = recorder.read(true);
  expect(drain.snapshotSession).toBe(3);
  expect(drain.lastSnapshot?.sequence).toBe(3);
  expect(drain.appliedSnapshots.count).toBe(3);
  const works = drain.appliedSnapshots.values.map((actual) => {
    assert(actual.ownerId);
    return requireAppliedRegionalWork(
      cache.get(regionalWorkKey(actual.ownerId, actual)),
      actual,
      'pilot-0',
      drain.snapshotSession
    );
  });
  expect(works.map((work) => work.scanning)).toEqual([false, true, false]);
  expect(works.filter((work) => work.expanded)).toHaveLength(1);
  const scan = drain.appliedSnapshots.values[1];
  assert(scan?.ownerId);
  const decoded = cache.get(regionalWorkKey(scan.ownerId, scan));
  expect(() =>
    requireAppliedRegionalWork(decoded, { ...scan, ownerId: undefined }, 'pilot-0', 3)
  ).toThrow('owner');
  expect(() => requireAppliedRegionalWork(decoded, scan, 'other-pilot', 3)).toThrow('owner');
  expect(() => requireAppliedRegionalWork(decoded, scan, 'pilot-0', 4)).toThrow('session');
  expect(() => requireAppliedRegionalWork(undefined, scan, 'pilot-0', 3)).toThrow('decoded');
  expect(() =>
    requireAppliedRegionalWork(decoded, { ...scan, serverTime: undefined }, 'pilot-0', 3)
  ).toThrow('decoded');
});

test('staggered natural setup keeps more than 1024 actual pre-drain applications correlatable', () => {
  const cache = new RegionalDecodedWorkCache();
  const recorder = new ClientPerformanceMetrics(true);
  const decoder = new SnapshotDecoder();
  const setupState = snapshotFixture();
  setupState.serverTime = 1000;
  const encoder = new SnapshotEncoder(setupState);
  for (let sequence = 1; sequence <= 1536; sequence++) {
    const actual = decoder.readMessage(snapshotMessage(encoder.encode(sequence)), {
      acceptSnapshots: true,
    });
    assert(actual.kind === 'snapshot');
    const work = regionalSnapshotWork(actual.state, actual.metadata, 'pilot-0');
    assert(work);
    cache.remember('pilot-0', work);
    recorder.snapshotApplied({
      ownerId: 'pilot-0',
      ...actual.metadata,
      gameTime: actual.state.gameTime,
      serverTime: actual.state.serverTime,
    });
  }
  const drain = recorder.read(true);
  expect(drain.appliedSnapshots.count).toBe(1536);
  expect(drain.appliedSnapshots.omittedSamples).toBe(0);
  for (const applied of drain.appliedSnapshots.values) {
    expect(
      requireAppliedRegionalWork(cache.match(applied), applied, 'pilot-0', drain.snapshotSession)
        .sequence
    ).toBe(applied.sequence);
  }
  expect(cache.report()).toMatchObject({
    capacity: APPLIED_SNAPSHOT_SAMPLE_LIMIT,
    retainedEntries: 1536,
    evictedEntries: 0,
    omittedRequiredMatches: 0,
  });
  const first = drain.appliedSnapshots.values[0];
  assert(first);
  const original = cache.match(first);
  assert(original);
  for (let sequence = 1537; sequence <= APPLIED_SNAPSHOT_SAMPLE_LIMIT + 1; sequence++) {
    cache.remember('pilot-0', { ...original, sequence });
  }
  expect(cache.report()).toMatchObject({
    retainedEntries: APPLIED_SNAPSHOT_SAMPLE_LIMIT,
    evictedEntries: 1,
  });
  expect(() =>
    requireAppliedRegionalWork(cache.match(first), first, 'pilot-0', drain.snapshotSession)
  ).toThrow('matching decoded');
  expect(cache.report().omittedRequiredMatches).toBe(1);
});
