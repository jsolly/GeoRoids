import { SNAPSHOT_VERSION, type SnapshotMetadata } from '../shared/snapshotProtocol';
import { WORLD } from '../shared/world';
import type { ServerGameSnapshot } from '../shared-types';
import {
  APPLIED_SNAPSHOT_SAMPLE_LIMIT,
  type ClientPerformanceMetrics,
} from '../src/diagnostics/performanceMetrics';

export type ScanDecision = 'not-due' | 'waiting-authoritative' | 'waiting-ui' | 'dispatch';

/** Bind the natural workload before its first world, using the actual negotiated acknowledgment. */
export function bindRegionalPilotOwner(data: unknown, previousOwner: string | undefined): string {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !('id' in data) ||
    typeof data.id !== 'string' ||
    data.id.length === 0 ||
    !('snapshotVersion' in data) ||
    data.snapshotVersion !== SNAPSHOT_VERSION ||
    !('asteroidInteractions' in data) ||
    data.asteroidInteractions !== 1 ||
    !('resumeToken' in data) ||
    typeof data.resumeToken !== 'string' ||
    data.resumeToken.length === 0
  ) {
    throw new Error('Invalid regional joined acknowledgment');
  }
  if (previousOwner !== undefined && data.id !== previousOwner) {
    throw new Error('Regional joined acknowledgment changed the browser owner');
  }
  return data.id;
}

/** A due scan survives a cooling button and a simulation that advances slower than wall time. */
export class RegionalScanSchedule {
  private pending = false;
  private measurementStarted = false;

  plan(
    step: number,
    measured: boolean,
    uiReady: boolean,
    cooldownFrames: number | undefined
  ): ScanDecision {
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new Error('Invalid regional input step');
    }
    if (step % 20 === 0 || (measured && !this.measurementStarted)) {
      this.pending = true;
    }
    this.measurementStarted ||= measured;
    if (!this.pending) {
      return 'not-due';
    }
    if (cooldownFrames !== 0) {
      return 'waiting-authoritative';
    }
    return uiReady ? 'dispatch' : 'waiting-ui';
  }

  dispatched(): void {
    if (!this.pending) {
      throw new Error('Regional scan dispatched without a pending request');
    }
    this.pending = false;
  }
}

export function regionalSnapshotWork(
  state: ServerGameSnapshot,
  metadata: SnapshotMetadata,
  pilotId: string | undefined
) {
  const own = state.entities.find((entity) => entity.id === pilotId);
  if (!own) {
    return undefined;
  }
  const scanning =
    own.kitId === 'scout' &&
    (own.scoutUtility ?? 'mineral_scan') === 'mineral_scan' &&
    (own.abilityActiveFrames ?? 0) > 0;
  return {
    ...metadata,
    gameTime: state.gameTime,
    serverTime: state.serverTime,
    cooldownFrames: own.abilityCooldownFrames,
    scanning,
    expanded:
      scanning &&
      state.asteroids.some(
        (rock) =>
          Math.hypot(rock.position.x - own.position.x, rock.position.y - own.position.y) >
          WORLD.asteroidInterestRadius
      ),
    asteroidRows: state.asteroids.length,
  };
}

export function matchesAppliedRegionalWork(
  decoded: NonNullable<ReturnType<typeof regionalSnapshotWork>> | undefined,
  applied: (SnapshotMetadata & { gameTime: number; serverTime: number | undefined }) | undefined
): boolean {
  return Boolean(
    decoded &&
      applied &&
      typeof applied.serverTime === 'number' &&
      decoded.sequence === applied.sequence &&
      decoded.kind === applied.kind &&
      decoded.gameTime === applied.gameTime &&
      decoded.serverTime === applied.serverTime
  );
}

export function regionalWorkKey(
  ownerId: string,
  snapshot: SnapshotMetadata & { gameTime: number; serverTime: number | undefined }
): string {
  return JSON.stringify([
    ownerId,
    snapshot.sequence,
    snapshot.kind,
    snapshot.gameTime,
    snapshot.serverTime,
  ]);
}

/** A received scan is evidence only when the real client reports this exact successful application. */
export function requireAppliedRegionalWork(
  decoded: NonNullable<ReturnType<typeof regionalSnapshotWork>> | undefined,
  applied: ReturnType<ClientPerformanceMetrics['read']>['appliedSnapshots']['values'][number],
  ownerId: string | undefined,
  measuredSession: number | undefined
) {
  if (!ownerId || applied.ownerId !== ownerId) {
    throw new Error('Applied regional snapshot has no matching browser owner');
  }
  if (
    !Number.isSafeInteger(applied.session) ||
    applied.session < 0 ||
    (measuredSession !== undefined && applied.session !== measuredSession)
  ) {
    throw new Error('Applied regional snapshot changed its measured session');
  }
  if (!decoded || !matchesAppliedRegionalWork(decoded, applied)) {
    throw new Error('Applied regional snapshot has no matching decoded workload witness');
  }
  return decoded;
}

/** Keep every possible undrained application correlatable during staggered setup. */
export class RegionalDecodedWorkCache {
  private readonly values = new Map<string, NonNullable<ReturnType<typeof regionalSnapshotWork>>>();
  private offeredEntries = 0;
  private evictedEntries = 0;
  private omittedRequiredMatches = 0;

  remember(ownerId: string, work: NonNullable<ReturnType<typeof regionalSnapshotWork>>): void {
    this.offeredEntries++;
    this.values.set(regionalWorkKey(ownerId, work), { ...work });
    if (this.values.size > APPLIED_SNAPSHOT_SAMPLE_LIMIT) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) {
        throw new Error('Regional decoded cache lost its oldest entry');
      }
      this.values.delete(oldest);
      this.evictedEntries++;
    }
  }

  match(
    applied: ReturnType<ClientPerformanceMetrics['read']>['appliedSnapshots']['values'][number]
  ) {
    const work = applied.ownerId
      ? this.values.get(regionalWorkKey(applied.ownerId, applied))
      : undefined;
    if (!work) {
      this.omittedRequiredMatches++;
    }
    return work;
  }

  report() {
    return {
      policy:
        'Decoded scalar history shares the applied receipt capacity; every missing required match fails qualification.',
      capacity: APPLIED_SNAPSHOT_SAMPLE_LIMIT,
      offeredEntries: this.offeredEntries,
      retainedEntries: this.values.size,
      evictedEntries: this.evictedEntries,
      omittedRequiredMatches: this.omittedRequiredMatches,
    };
  }
}
