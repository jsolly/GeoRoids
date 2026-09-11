import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { capMotionVelocity, finiteMotionVector, PLAYER_MOTION } from '../../shared/playerMotion';
import { radiusFromMass } from '../../shared/shipGrowth';
import type { PlayerMotionState, Position } from '../../shared-types';
import { GAME } from '../../src/constants';
import { getShipKit } from '../../src/entities/ship/shipKits';
import { checkBoundaryCollision } from '../../src/physics/collision/collisionDetection';
import type { GameEntity } from './EntityManager';

export type MotionOutcome = { ok: true } | { ok: false; error: string };

type EnhancedFreePose = Pick<GameEntity, 'position' | 'velocity' | 'angle' | 'thrusting'> & {
  epoch: number;
  sequence: number;
};

interface Session {
  actor: GameEntity;
  socket?: WebSocket | undefined;
  token: string;
  epoch: number;
  mode: PlayerMotionState['mode'];
  ack: number;
  poseSequence: number;
  disconnectedUntil?: number | undefined;
  anchor?: Position | undefined;
  anchorAt: number;
  poseAt: number;
  poseCredit: number;
  wasAlive: boolean;
  knockback?: { speed: number; at: number };
}

/**
 * Authoritative lifecycle and pose ownership for enhanced human players.
 *
 * The service owns only the player transform/session boundary. Ordinary ship
 * flight, asteroid physics, combat, and the Hauler's short combat harpoon stay
 * on their existing systems.
 */
export class PlayerMotionService {
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, Session>();
  private readonly sockets = new Map<WebSocket, Session>();

  private assertTime(now: number): void {
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError('Motion requires finite server time');
    }
  }

  private alive(actor: GameEntity): boolean {
    return (
      actor.type === 'human' &&
      actor.health > 0 &&
      Number.isFinite(actor.health) &&
      !actor.exploding &&
      actor.respawnTimer === undefined &&
      actor.lives > 0
    );
  }

  private validActor(actor: GameEntity): boolean {
    return (
      this.alive(actor) &&
      actor.asteroidInteractions === 1 &&
      (actor.factionId === 'ion' || actor.factionId === 'ember') &&
      finiteMotionVector(actor.position) &&
      finiteMotionVector(actor.velocity) &&
      Number.isFinite(actor.angle) &&
      Number.isFinite(actor.mass) &&
      actor.mass > 0 &&
      Number.isFinite(actor.fuel) &&
      Number.isFinite(actor.maxFuel) &&
      actor.fuel >= 0 &&
      actor.fuel <= actor.maxFuel
    );
  }

  public legalSpeed(actor: GameEntity, now: number): number {
    const normal = getShipKit(actor.kitId).maxVelocity;
    const impulse = this.sessions.get(actor.id)?.knockback;
    if (!impulse) {
      return normal;
    }
    // Match the client's fixed-step decay, allowing the existing transport-jitter budget.
    const elapsedFrames = Math.max(
      0,
      ((now - impulse.at) * GAME.FPS) / 1000 - PLAYER_MOTION.poseLeadFrames
    );
    return Math.max(normal, impulse.speed * PLAYER_MOTION.knockbackRetention ** elapsedFrames);
  }

  private owner(socket: WebSocket): Session | undefined {
    const session = this.sockets.get(socket);
    return session?.socket === socket && session.actor.ws === socket ? session : undefined;
  }

  private publish(session: Session): void {
    session.actor.playerMotion = {
      epoch: session.epoch,
      mode: session.mode,
      ack: session.ack,
      ...(session.anchor ? { anchor: { ...session.anchor } } : {}),
    };
  }

  public register(
    actor: GameEntity,
    socket: WebSocket,
    capability: unknown,
    now: number
  ): { ok: true; resumeToken: string; state: PlayerMotionState } | { ok: false; error: string } {
    this.assertTime(now);
    if (capability !== 1) {
      return { ok: false, error: 'Enhanced player motion was not negotiated' };
    }
    if (
      !this.validActor(actor) ||
      actor.ws !== socket ||
      this.sessions.has(actor.id) ||
      this.sockets.has(socket)
    ) {
      return { ok: false, error: 'Invalid or already registered authoritative motion owner' };
    }
    if (this.sessions.size >= PLAYER_MOTION.maxSessions) {
      return { ok: false, error: 'Motion session capacity exhausted' };
    }
    const session: Session = {
      actor,
      socket,
      token: randomBytes(32).toString('hex'),
      epoch: 1,
      mode: 'free',
      ack: 0,
      poseSequence: -1,
      anchorAt: now,
      poseAt: now,
      poseCredit: this.legalSpeed(actor, now) * PLAYER_MOTION.poseLeadFrames,
      wasAlive: true,
    };
    actor.velocity = capMotionVelocity(actor.velocity, this.legalSpeed(actor, now));
    this.sessions.set(actor.id, session);
    this.tokens.set(session.token, session);
    this.sockets.set(socket, session);
    this.publish(session);
    return {
      ok: true,
      resumeToken: session.token,
      state: {
        epoch: session.epoch,
        mode: session.mode,
        ack: session.ack,
        ...(session.anchor ? { anchor: { ...session.anchor } } : {}),
      },
    };
  }

  /** Atomic bearer-token takeover; root closes supersededSocket after rebinding. */
  public resume(
    token: unknown,
    socket: WebSocket,
    now: number
  ):
    | { ok: true; actor: GameEntity; resumeToken: string; supersededSocket?: WebSocket }
    | { ok: false; error: string } {
    this.assertTime(now);
    if (typeof token !== 'string' || token.length !== 64) {
      return { ok: false, error: 'Invalid motion resume request' };
    }
    const session = this.tokens.get(token);
    if (!session || (session.disconnectedUntil !== undefined && now >= session.disconnectedUntil)) {
      return { ok: false, error: 'Motion resume token is absent or expired' };
    }
    const existing = this.sockets.get(socket);
    if (existing) {
      if (existing !== session || this.owner(socket) !== session) {
        return { ok: false, error: 'Socket already owns a different motion session' };
      }
      return { ok: true, actor: session.actor, resumeToken: session.token };
    }
    const old = session.socket;
    if (old) {
      this.sockets.delete(old);
    }
    session.socket = socket;
    session.actor.ws = socket;
    session.disconnectedUntil = undefined;
    // Pending commands were never simulated. Resume from the acknowledged pose
    // so a replacement socket starts at the same sequence frontier.
    session.poseSequence = session.ack;
    session.actor.lastUpdate = now;
    this.sockets.set(socket, session);
    this.publish(session);
    return {
      ok: true,
      actor: session.actor,
      resumeToken: session.token,
      ...(old ? { supersededSocket: old } : {}),
    };
  }

  public transportClosed(socket: WebSocket, now: number): boolean {
    this.assertTime(now);
    const session = this.owner(socket);
    if (!session) {
      return false;
    }
    this.sockets.delete(socket);
    session.socket = undefined;
    delete session.actor.ws;
    session.disconnectedUntil = now + PLAYER_MOTION.reconnectGraceMs;
    session.actor.thrusting = false;
    return true;
  }

  private clearHarpoon(actor: GameEntity): void {
    actor.abilityActiveFrames = 0;
    actor.harpoonTimer = 0;
    delete actor.harpoonTargetId;
    delete actor.harpoonLatchPos;
  }

  private handoff(session: Session, now: number): void {
    session.epoch += 1;
    session.mode = 'handoff';
    session.ack = 0;
    session.poseSequence = -1;
    session.anchor = { ...session.actor.position };
    session.anchorAt = now;
    session.poseAt = now;
    session.poseCredit = this.legalSpeed(session.actor, now) * PLAYER_MOTION.poseLeadFrames;
    session.actor.thrusting = false;
    this.publish(session);
  }

  /** Call on authoritative death/respawn even if both occur between service ticks. */
  public invalidateLife(actorId: string, now: number): void {
    this.assertTime(now);
    const session = this.sessions.get(actorId);
    if (!session) {
      return;
    }
    session.wasAlive = this.alive(session.actor);
    delete session.knockback;
    session.actor.velocity = capMotionVelocity(
      session.actor.velocity,
      this.legalSpeed(session.actor, now)
    );
    this.clearHarpoon(session.actor);
    this.handoff(session, now);
  }

  public quit(socket: WebSocket): string | undefined {
    const session = this.owner(socket);
    if (!session) {
      return undefined;
    }
    this.removeSession(session);
    return session.actor.id;
  }

  private removeSession(session: Session): void {
    if (session.socket) {
      this.sockets.delete(session.socket);
    }
    this.tokens.delete(session.token);
    this.sessions.delete(session.actor.id);
    delete session.actor.playerMotion;
  }

  /** Terminal authoritative removal, including an owner currently in socket grace. */
  public forgetActor(actorId: string): void {
    const session = this.sessions.get(actorId);
    if (session) {
      this.removeSession(session);
    }
  }

  public acceptFreePose(socket: WebSocket, pose: EnhancedFreePose, now: number): MotionOutcome {
    this.assertTime(now);
    const session = this.owner(socket);
    if (
      !session ||
      !this.validActor(session.actor) ||
      !['free', 'handoff'].includes(session.mode)
    ) {
      return { ok: false, error: 'Server still owns this motion transform' };
    }
    if (
      !pose ||
      pose.epoch !== session.epoch ||
      !Number.isSafeInteger(pose.sequence) ||
      pose.sequence < 0 ||
      pose.sequence <= session.poseSequence ||
      !finiteMotionVector(pose.position) ||
      !finiteMotionVector(pose.velocity) ||
      !Number.isFinite(pose.angle) ||
      Math.abs(pose.angle) > Math.PI * 2 ||
      typeof pose.thrusting !== 'boolean' ||
      Object.keys(pose).some(
        (key) => !['epoch', 'sequence', 'position', 'velocity', 'angle', 'thrusting'].includes(key)
      ) ||
      now < session.poseAt
    ) {
      return { ok: false, error: 'Invalid or stale enhanced movement pose' };
    }
    const speed = this.legalSpeed(session.actor, now);
    const elapsedFrames = ((now - session.poseAt) * GAME.FPS) / 1000;
    const credit = Math.min(
      speed * PLAYER_MOTION.poseLeadFrames,
      session.poseCredit + elapsedFrames * speed
    );
    const displacement = Math.hypot(
      pose.position.x - session.actor.position.x,
      pose.position.y - session.actor.position.y
    );
    const anchorReach =
      (speed * (now - session.anchorAt) * GAME.FPS) / 1000 + PLAYER_MOTION.poseTolerance;
    if (
      Math.hypot(pose.velocity.x, pose.velocity.y) > speed + 1e-6 ||
      displacement > credit + 1e-6 ||
      checkBoundaryCollision(pose.position, radiusFromMass(session.actor.mass)) ||
      (session.mode === 'handoff' &&
        session.anchor &&
        Math.hypot(pose.position.x - session.anchor.x, pose.position.y - session.anchor.y) >
          anchorReach)
    ) {
      return { ok: false, error: 'Enhanced movement exceeds its server-time envelope' };
    }
    session.poseCredit = Math.max(0, credit - displacement);
    session.poseAt = now;
    session.poseSequence = pose.sequence;
    session.mode = 'free';
    session.anchor = undefined;
    session.ack = pose.sequence;
    session.actor.position = { x: pose.position.x, y: pose.position.y };
    session.actor.velocity = { x: pose.velocity.x, y: pose.velocity.y };
    session.actor.angle = pose.angle;
    session.actor.thrusting = pose.thrusting;
    session.actor.lastUpdate = now;
    this.publish(session);
    return { ok: true };
  }

  /** Publish a server impulse as a new epoch so in-flight client poses cannot erase it. */
  public applyExternalImpulse(actorId: string, now: number): void {
    this.assertTime(now);
    const session = this.sessions.get(actorId);
    if (!session || !this.alive(session.actor)) {
      return;
    }
    const speed = Math.hypot(session.actor.velocity.x, session.actor.velocity.y);
    const normal = getShipKit(session.actor.kitId).maxVelocity;
    session.knockback = { speed, at: now };
    session.epoch += 1;
    session.mode = 'free';
    session.ack = 0;
    session.poseSequence = -1;
    session.anchor = undefined;
    session.poseAt = now;
    session.anchorAt = now;
    session.poseCredit = Math.max(normal, speed) * PLAYER_MOTION.poseLeadFrames;
    this.publish(session);
  }

  /** Keep test-only fixture placement coherent with enhanced motion ownership. */
  public placeActorForTesting(actorId: string, position: Position, now: number): boolean {
    this.assertTime(now);
    if (!finiteMotionVector(position)) {
      return false;
    }
    const session = this.sessions.get(actorId);
    if (!session) {
      return false;
    }
    this.clearHarpoon(session.actor);
    session.epoch += 1;
    session.mode = 'free';
    session.ack = 0;
    session.poseSequence = -1;
    session.anchor = undefined;
    session.poseAt = now;
    session.anchorAt = now;
    session.poseCredit = this.legalSpeed(session.actor, now) * PLAYER_MOTION.poseLeadFrames;
    session.actor.position = { ...position };
    session.actor.velocity = { x: 0, y: 0 };
    session.actor.thrusting = false;
    session.actor.lastUpdate = now;
    this.publish(session);
    return true;
  }

  /** Advance session deadlines and lifecycle epochs; ship/asteroid physics stay elsewhere. */
  public step(now: number): string[] {
    this.assertTime(now);
    const expired: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.disconnectedUntil !== undefined && now >= session.disconnectedUntil) {
        expired.push(session.actor.id);
        this.removeSession(session);
        continue;
      }
      const alive = this.alive(session.actor);
      if (alive !== session.wasAlive) {
        session.wasAlive = alive;
        this.handoff(session, now);
      }
      if (session.mode === 'handoff' && now - session.anchorAt >= PLAYER_MOTION.handoffTimeoutMs) {
        this.handoff(session, now);
      }
      this.publish(session);
    }
    return expired;
  }

  public ownsActorMotion(actorId: string): boolean {
    const session = this.sessions.get(actorId);
    return !!session && (session.mode !== 'free' || !session.socket);
  }

  public getState(actorId: string): PlayerMotionState | undefined {
    const state = this.sessions.get(actorId)?.actor.playerMotion;
    return state
      ? { ...state, ...(state.anchor ? { anchor: { ...state.anchor } } : {}) }
      : undefined;
  }

  public reset(): void {
    for (const session of this.sessions.values()) {
      this.removeSession(session);
    }
  }
}
