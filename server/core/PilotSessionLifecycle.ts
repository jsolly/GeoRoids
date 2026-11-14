import { createHash } from 'node:crypto';
import { GAME } from '../../shared/constants/gameplay';
import { cargoCapacity } from '../../shared/economy';
import { sanitizePlayerName } from '../../shared/player';
import { applyShipKitStats } from '../../shared/shipKits';
import type { ShipKitId } from '../../shared-types';
import { type RestorableFlight, restorableFlight } from '../world/WorldStore';
import { PILOT_RESUME_TOKEN_PATTERN } from './constants';
import type { GameEntity } from './EntityManager';
import type { PlayerMotionService } from './PlayerMotionService';
import type { PilotSessionInputs, PilotSessionRegistration, PilotSessionResume } from './types';

// These private shapes each belong to exactly one private helper.
type RequestedPilotIdentity = {
  readonly actor: GameEntity;
  readonly requestedKit: ShipKitId | undefined;
  readonly requestedName: string | undefined;
  readonly invalidateMotionOnKitChange: boolean;
};
type RecentPilotFlight = {
  readonly actor: GameEntity;
  readonly flight: RestorableFlight;
  readonly requestedKit: ShipKitId | undefined;
};

/** Owns registration, live/saved resume, requested identity and saved-flight restoration. */
export class PilotSessionLifecycle {
  constructor(private readonly inputs: PilotSessionInputs) {}

  register({
    actor,
    socket,
    clientReleaseId,
  }: PilotSessionRegistration): ReturnType<PlayerMotionService['register']> {
    if (actor.botRole !== undefined) {
      return { ok: false, error: 'AI ships cannot register pilot credentials' };
    }
    const result = this.inputs.motion.register(actor, socket, this.inputs.now());
    if (!result.ok) {
      return result;
    }
    this.inputs.ledger.recordRegistration({
      actor,
      tokenHash: createHash('sha256').update(result.resumeToken).digest('hex'),
      clientReleaseId,
    });
    return result;
  }

  resume({
    token,
    socket,
    requestedKit,
    requestedName,
    clientReleaseId,
  }: PilotSessionResume): ReturnType<PlayerMotionService['resume']> {
    if (!PILOT_RESUME_TOKEN_PATTERN.test(token)) {
      return { ok: false, error: 'Invalid pilot resume token' };
    }
    const hash = createHash('sha256').update(token).digest('hex');
    let saved = this.inputs.ledger.findByTokenHash(hash);
    const live = this.inputs.motion.resume(token, socket, this.inputs.now());
    if (live.ok) {
      if (live.supersededSocket) {
        this.inputs.cancelCharge(live.actor);
      }
      this.inputs.ledger.rememberClientRelease(live.actor.id, clientReleaseId);
      this.inputs.rescue.finishIfExpired(live.actor);
      if (
        live.actor.downedUntil == null ||
        live.actor.downedUntil === 0 ||
        Number.isNaN(live.actor.downedUntil)
      ) {
        this.applyRequestedPilotIdentity({
          actor: live.actor,
          requestedKit,
          requestedName,
          invalidateMotionOnKitChange: true,
        });
      }
      return live;
    }
    if (!saved || this.inputs.actors.getEntityBySocket(socket)) {
      return live;
    }
    // Expired transport grace may still own an actor until the next simulation tick.
    if (this.inputs.actors.getEntity(saved.id)) {
      this.inputs.removeActor(saved.id);
      saved = this.inputs.ledger.saved(saved.id) ?? saved;
    }
    const savedDowned = this.inputs.campaign.get('downed', saved.id);
    const flight = restorableFlight(saved, this.inputs.now());
    const actor = this.inputs.addActor({
      id: saved.id,
      name: saved.name,
      socket,
      position: flight?.position,
      kitId: savedDowned != null ? saved.kitId : (requestedKit ?? flight?.kitId),
    });
    if (saved.hullColor != null && saved.hullColor !== '') {
      actor.color = saved.hullColor;
    }
    this.applyRequestedPilotIdentity({
      actor,
      requestedKit: undefined,
      requestedName,
      invalidateMotionOnKitChange: false,
    });
    actor.score = this.inputs.localPlayground ? Math.max(5_000, saved.score) : saved.score;
    actor.cargo = saved.cargo ?? 0;
    actor.purchases = [...(saved.purchases ?? [])];
    this.fitCargo(actor);
    actor.silk = saved.silk ?? 0;
    actor.equipment = [...(saved.equipment ?? [])];
    if (flight && savedDowned == null) {
      this.restoreRecentFlight({ actor, flight, requestedKit });
    }
    const registered = this.register({ actor, socket, clientReleaseId });
    if (!registered.ok) {
      this.inputs.removeActor(actor.id);
      return registered;
    }
    this.inputs.seedInteractions();
    if (!this.inputs.rescue.restoreDowned(actor) && saved.health === 0) {
      actor.health = 0;
      this.inputs.actors.scheduleShipRespawn(actor);
    }
    this.inputs.ledger.capture(actor.id);
    return { ok: true, actor, resumeToken: registered.resumeToken };
  }

  private applyRequestedPilotIdentity({
    actor,
    requestedKit,
    requestedName,
    invalidateMotionOnKitChange,
  }: RequestedPilotIdentity): void {
    if (requestedKit && requestedKit !== actor.kitId) {
      applyShipKitStats(actor, requestedKit);
      this.fitCargo(actor);
      actor.harpoonTargetId = null;
      delete actor.harpoonLatchPos;
      if (invalidateMotionOnKitChange) {
        this.inputs.motion.invalidateLife(actor.id, this.inputs.now());
      }
    }
    const name = sanitizePlayerName(requestedName ?? '');
    if (!name || name === actor.name) {
      return;
    }
    const taken = this.inputs.actors
      .getAllEntities()
      .filter((candidate) => candidate.botRole === undefined)
      .some(
        (candidate) =>
          candidate.id !== actor.id && candidate.name.toLowerCase() === name.toLowerCase()
      );
    if (taken) {
      return;
    }
    actor.name = name;
  }

  private restoreRecentFlight({ actor, flight, requestedKit }: RecentPilotFlight): void {
    const shieldElapsed = Math.floor(
      (Math.max(0, this.inputs.now() - flight.lastSeenAt) * GAME.FPS) / 1000
    );
    actor.shieldFrames = Math.max(0, (flight.shieldFrames ?? 0) - shieldElapsed);
    actor.shieldCooldownFrames = Math.max(0, (flight.shieldCooldownFrames ?? 0) - shieldElapsed);
    actor.angle = flight.angle;
    if (!requestedKit || requestedKit === flight.kitId) {
      actor.mass = flight.mass;
      actor.health = flight.health > 0 ? Math.min(flight.health, actor.maxHealth) : actor.maxHealth;
      const elapsedFrames = Math.floor(
        (Math.max(0, this.inputs.now() - flight.lastSeenAt) * GAME.FPS) / 1000
      );
      actor.healthRegenTimer = Math.max(0, (flight.healthRegenTimer ?? 0) - elapsedFrames);
    }
    if (flight.velocity) {
      actor.velocity = { x: flight.velocity.x, y: flight.velocity.y };
    }
    delete actor.spawnProtectionTimer;
  }

  private fitCargo(entity: GameEntity): void {
    entity.cargo = Math.min(entity.cargo, cargoCapacity(entity.kitId));
  }
}
