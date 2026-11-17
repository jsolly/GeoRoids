import { epochField } from '../../shared/epochField';
import { furnaceTravelPose } from '../../shared/furnaceTravel';
import { readReleaseId, releaseField } from '../../shared/releaseId';
import { purchasedHullColor } from '../../shared/townStore';
import { SERVER_RELEASE_ID } from '../release';
import type { PersistentPilot } from '../world/WorldStore';
import type { WorldCheckpoint } from '../world/worldPersistence';
import type { GameEntity } from './EntityManager';
import type { PilotLedgerInputs, PilotRegistration } from './types';

/** Saved pilot memory and write provenance; sessions own raw credentials and persistence owns I/O. */
export class PilotLedger {
  private readonly pilots = new Map<string, PersistentPilot>();
  private readonly dirtyPilots = new Set<string>();
  private readonly actors: PilotLedgerInputs['actors'];
  private readonly now: PilotLedgerInputs['now'];
  private readonly settlementLedger: PilotLedgerInputs['settlementLedger'];

  constructor({ saved, actors, now, settlementLedger }: PilotLedgerInputs) {
    this.actors = actors;
    this.now = now;
    this.settlementLedger = settlementLedger;
    for (const pilot of saved) {
      this.pilots.set(pilot.id, pilot);
    }
  }

  private snapshotPilot(
    actor: GameEntity,
    tokenHash: string,
    clientReleaseId?: string
  ): PersistentPilot {
    const previous = this.pilots.get(actor.id);
    const lastClientReleaseId = readReleaseId(clientReleaseId) ?? previous?.lastClientReleaseId;
    const now = this.now();
    const arrival = actor.furnaceTransit
      ? furnaceTravelPose(
          actor.furnaceTransit,
          actor.furnaceTransit.startedAt + actor.furnaceTransit.durationMs
        )
      : undefined;
    const flight = {
      id: actor.id,
      tokenHash,
      name: actor.name,
      score: actor.score,
      cargo: actor.cargo,
      purchases: [...actor.purchases],
      silk: actor.silk ?? 0,
      equipment: [...(actor.equipment ?? [])],
      lastSeenAt: now,
      kitId: actor.kitId,
      position: arrival?.position ?? { x: actor.position.x, y: actor.position.y },
      velocity: arrival ? { x: 0, y: 0 } : { x: actor.velocity.x, y: actor.velocity.y },
      angle: arrival?.angle ?? actor.angle,
      mass: actor.mass,
      health: actor.health,
      healthRegenTimer: actor.healthRegenTimer,
      shieldFrames: actor.shieldFrames ?? 0,
      shieldCooldownFrames: actor.shieldCooldownFrames ?? 0,
      ...(purchasedHullColor(actor.color) ? { hullColor: actor.color } : {}),
      ...releaseField('lastClientReleaseId', lastClientReleaseId),
    };
    if (previous === undefined) {
      return {
        ...flight,
        credentialReleaseId: SERVER_RELEASE_ID,
        scoreReleaseId: SERVER_RELEASE_ID,
        credentialIssuedAt: now,
        scoreUpdatedAt: now,
        ...releaseField('credentialClientReleaseId', lastClientReleaseId),
        ...releaseField('scoreClientReleaseId', lastClientReleaseId),
      };
    }
    const issuedCredential = previous.tokenHash !== tokenHash;
    const wroteScore = previous.score !== actor.score;
    return {
      ...flight,
      ...(issuedCredential
        ? {
            credentialReleaseId: SERVER_RELEASE_ID,
            credentialIssuedAt: now,
            ...releaseField('credentialClientReleaseId', lastClientReleaseId),
          }
        : {
            ...releaseField('credentialReleaseId', previous.credentialReleaseId),
            ...releaseField('credentialClientReleaseId', previous.credentialClientReleaseId),
            ...epochField('credentialIssuedAt', previous.credentialIssuedAt),
          }),
      ...(wroteScore
        ? {
            scoreReleaseId: SERVER_RELEASE_ID,
            scoreUpdatedAt: now,
            ...releaseField('scoreClientReleaseId', lastClientReleaseId),
          }
        : {
            ...releaseField('scoreReleaseId', previous.scoreReleaseId),
            ...releaseField('scoreClientReleaseId', previous.scoreClientReleaseId),
            ...epochField('scoreUpdatedAt', previous.scoreUpdatedAt),
          }),
    };
  }

  rememberClientRelease(id: string, clientReleaseId?: string): void {
    const releaseId = readReleaseId(clientReleaseId);
    const saved = this.pilots.get(id);
    if (!saved || releaseId === undefined) {
      return;
    }
    this.setPilot({ ...saved, lastClientReleaseId: releaseId });
  }

  private writePilotScore(pilot: PersistentPilot, score: number): PersistentPilot {
    const next: PersistentPilot = {
      ...pilot,
      score,
      scoreReleaseId: SERVER_RELEASE_ID,
      scoreUpdatedAt: this.now(),
    };
    delete next.scoreClientReleaseId;
    return next;
  }

  provenance(
    id: PersistentPilot['id']
  ): Pick<
    PersistentPilot,
    | 'credentialReleaseId'
    | 'credentialClientReleaseId'
    | 'credentialIssuedAt'
    | 'scoreReleaseId'
    | 'scoreClientReleaseId'
    | 'scoreUpdatedAt'
  > {
    const saved = this.pilots.get(id);
    if (!saved) {
      return {};
    }
    return {
      ...releaseField('credentialReleaseId', saved.credentialReleaseId),
      ...releaseField('credentialClientReleaseId', saved.credentialClientReleaseId),
      ...epochField('credentialIssuedAt', saved.credentialIssuedAt),
      ...releaseField('scoreReleaseId', saved.scoreReleaseId),
      ...releaseField('scoreClientReleaseId', saved.scoreClientReleaseId),
      ...epochField('scoreUpdatedAt', saved.scoreUpdatedAt),
    };
  }

  capture(id: PersistentPilot['id']): void {
    const previous = this.pilots.get(id);
    const actor = this.actors.getEntity(id);
    if (!previous || !actor) {
      return;
    }
    this.setPilot(this.snapshotPilot(actor, previous.tokenHash));
  }

  recordRegistration({ actor, tokenHash, clientReleaseId }: PilotRegistration): void {
    this.setPilot(this.snapshotPilot(actor, tokenHash, clientReleaseId));
  }

  has(id: PersistentPilot['id']): boolean {
    return this.pilots.has(id);
  }

  /** Trusted session lookup, retaining the saved row identity and existing linear digest search. */
  findByTokenHash(hash: PersistentPilot['tokenHash']): Readonly<PersistentPilot> | undefined {
    return [...this.pilots.values()].find((pilot) => pilot.tokenHash === hash);
  }

  /** Re-read after complete actor removal captures its last flight into memory. */
  saved(id: PersistentPilot['id']): Readonly<PersistentPilot> | undefined {
    return this.pilots.get(id);
  }

  savedName(id: PersistentPilot['id']): PersistentPilot['name'] | undefined {
    return this.pilots.get(id)?.name;
  }

  /** Award a score to a live actor or to its saved offline pilot record. */
  awardPoints(entityId: string, points: number): number | undefined {
    const entity = this.actors.getEntity(entityId);
    if (entity) {
      if (entity.botRole === undefined) {
        entity.score += points;
      }
      this.settlementLedger.addPoints(points);
      this.capture(entityId);
      return entity.score;
    }
    const saved = this.pilots.get(entityId);
    if (saved) {
      const next = this.writePilotScore(saved, saved.score + points);
      this.setPilot(next);
      this.settlementLedger.addPoints(points);
      return next.score;
    }
    return undefined;
  }

  checkpointRows(): WorldCheckpoint['pilots'] {
    const pilots: PersistentPilot[] = [];
    for (const id of this.dirtyPilots) {
      const pilot = this.pilots.get(id);
      if (pilot) {
        pilots.push(pilot);
      }
    }
    return pilots;
  }

  /** Called synchronously after handoff/inline success, never by a later durable or network ACK. */
  submitted(): void {
    this.dirtyPilots.clear();
  }

  reset(): void {
    this.pilots.clear();
    this.dirtyPilots.clear();
  }

  private setPilot(pilot: PersistentPilot): void {
    this.pilots.set(pilot.id, pilot);
    this.dirtyPilots.add(pilot.id);
  }
}
