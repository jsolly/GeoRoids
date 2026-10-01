import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  CONTOUR_LOCK,
  contourLockDistance,
  contourLockSpeed,
  contourLockVelocity,
  isContourLockState,
} from '../../shared/contourLock';
import { GAME_TICK_MS, MAX_CATCH_UP_TICKS, MAX_TICK_DEBT_MS } from '../../shared/gameClock';
import { capMotionVelocity, finiteMotionVector, PLAYER_MOTION } from '../../shared/playerMotion';
import { cruiseSpeed } from '../../shared/shipFlight';
import type { ContourLockState, PlayerMotionState, Position } from '../../shared-types';
import { GAME } from '../../src/constants';
import { isTowCableUtility } from '../../src/entities/ship/haulerUtility';
import { getShipKit, hullRadiusForKit } from '../../src/entities/ship/shipKits';
import { checkBoundaryCollision } from '../../src/physics/collision/collisionDetection';
import { TERRAIN } from '../../src/physics/terrain/terrainConfig';
import { terrainSpeedLimit } from '../../src/physics/terrain/terrainTravel';
import type { GameEntity } from './EntityManager';

/** Which envelope check failed, with the numbers behind it, for diagnostics logs. */
interface MotionEnvelopeRejection {
  check: 'velocity' | 'displacement' | 'boundary' | 'anchor' | 'rail';
  mode: PlayerMotionState['mode'];
  elapsedMs: number;
  /** Part of `elapsedMs` during which the server loop itself was blocked. */
  blockedMs: number;
  speed: number;
  velocity: number;
  displacement: number;
  credit: number;
}

/** A server-time span during which the event loop could not read any pose. */
interface BlockedSpan {
  from: number;
  to: number;
}

export type MotionOutcome =
  /** `blockedMs` is the server-blocked time this pose was credited beyond client silence. */
  | { ok: true; blockedMs: number }
  | { ok: false; error: string; envelope?: MotionEnvelopeRejection };

type EnhancedFreePose = Pick<GameEntity, 'position' | 'velocity' | 'angle' | 'thrusting'> & {
  epoch: number;
  sequence: number;
  contourLock?: ContourLockState | null;
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
  /** Earned travel above the lead, spendable only by poses released together. */
  burstCredit: number;
  burstAt: number;
  wasAlive: boolean;
  contourLockAt: number;
  knockback?: { speed: number; at: number };
}

/**
 * Buffered 60 Hz poses released after a network hold or server stall land
 * within the transport jitter window. Credit earned across the gap stays
 * spendable for that long and then expires, so hovering cannot bank a jump.
 */
const BURST_CREDIT_MS = PLAYER_MOTION.poseLeadFrames * GAME_TICK_MS;

/** Ordinary timer jitter is not a blocked loop; anything past two ticks is. */
const BLOCKED_SPAN_MIN_MS = 2 * GAME_TICK_MS;

/** Matches the 30 s stale-actor timeout in EntityManager, so every live pose gap is covered. */
const BLOCKED_SPAN_RETENTION_MS = 30_000;

/**
 * Authoritative lifecycle and pose ownership for players.
 *
 * The service owns only the player transform/session boundary. Ordinary ship
 * flight, asteroid physics, combat, and the Hauler's persistent tow cable stay
 * on their existing systems.
 */
export class PlayerMotionService {
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, Session>();
  private readonly sockets = new Map<WebSocket, Session>();
  private blockedSpans: BlockedSpan[] = [];

  private assertTime(now: number): void {
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError('Motion requires finite server time');
    }
  }

  /**
   * Record a span during which the server loop was blocked. Poses queued then
   * could not be read sooner, so that time is server delay, not client silence.
   */
  public recordBlockedSpan(from: number, to: number): void {
    this.assertTime(from);
    this.assertTime(to);
    if (to - from < BLOCKED_SPAN_MIN_MS) {
      return;
    }
    this.blockedSpans = this.blockedSpans.filter(
      (span) => span.to >= to - BLOCKED_SPAN_RETENTION_MS
    );
    this.blockedSpans.push({ from, to });
  }

  /**
   * Longest single blocked span inside `(from, to]`. Each span is one clock
   * step, and separate steps never add up: the loop read poses between them,
   * so that time is ordinary silence and a stream of late ticks cannot
   * accumulate into a multi-second allowance.
   */
  private blockedMsBetween(from: number, to: number): number {
    let longest = 0;
    for (const span of this.blockedSpans) {
      longest = Math.max(longest, Math.min(span.to, to) - Math.max(span.from, from));
    }
    return Math.min(longest, Math.max(0, to - from));
  }

  private alive(actor: GameEntity): boolean {
    return (
      actor.health > 0 &&
      Number.isFinite(actor.health) &&
      !actor.exploding &&
      actor.respawnTimer === undefined
    );
  }

  private validActor(actor: GameEntity): boolean {
    return (
      this.alive(actor) &&
      actor.asteroidInteractions === 1 &&
      finiteMotionVector(actor.position) &&
      finiteMotionVector(actor.velocity) &&
      Number.isFinite(actor.angle) &&
      Number.isFinite(actor.mass) &&
      actor.mass > 0
    );
  }

  public legalSpeed(
    actor: GameEntity,
    now: number,
    locked = actor.contourLock !== null,
    position = actor.position
  ): number {
    const kit = getShipKit(actor.kitId);
    const cruise = cruiseSpeed(actor.mass, kit.maxVelocity);
    const normal = locked ? contourLockSpeed(cruise) : terrainSpeedLimit(position, cruise);
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

  /** Buffered travel may follow stronger currents before its final reported pose. */
  public maximumTravelSpeed(
    actor: GameEntity,
    now: number,
    locked = actor.contourLock !== null
  ): number {
    const kit = getShipKit(actor.kitId);
    return Math.max(
      this.legalSpeed(actor, now, locked),
      locked
        ? contourLockSpeed(cruiseSpeed(actor.mass, kit.maxVelocity))
        : cruiseSpeed(actor.mass, kit.maxVelocity) * (1 + TERRAIN.CONTOUR_SPEED_BONUS)
    );
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
      poseCredit: this.maximumTravelSpeed(actor, now) * PLAYER_MOTION.poseLeadFrames,
      burstCredit: 0,
      burstAt: now,
      wasAlive: true,
      contourLockAt: now,
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
    session.actor.contourLock = null;
    session.actor.velocity = capMotionVelocity(
      session.actor.velocity,
      this.legalSpeed(session.actor, now)
    );
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
    session.actor.contourLock = null;
    session.actor.velocity = capMotionVelocity(
      session.actor.velocity,
      this.legalSpeed(session.actor, now)
    );
    return true;
  }

  private clearHarpoon(actor: GameEntity): void {
    actor.abilityActiveFrames = 0;
    actor.harpoonTargetId = null;
    delete actor.harpoonLatchPos;
  }

  private handoff(session: Session, now: number, poseCredit?: number): void {
    session.actor.contourLock = null;
    const speed = this.legalSpeed(session.actor, now);
    session.actor.velocity = capMotionVelocity(session.actor.velocity, speed);
    session.epoch += 1;
    session.mode = 'handoff';
    session.ack = 0;
    session.poseSequence = -1;
    session.anchor = { ...session.actor.position };
    session.anchorAt = now;
    session.poseAt = now;
    session.poseCredit = Math.min(
      poseCredit ?? Number.POSITIVE_INFINITY,
      this.maximumTravelSpeed(session.actor, now) * PLAYER_MOTION.poseLeadFrames
    );
    session.burstCredit = 0;
    session.burstAt = now;
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

  private failedEnvelopeCheck(
    session: Session,
    pose: EnhancedFreePose,
    limits: {
      speed: number;
      velocity: number;
      displacement: number;
      credit: number;
      anchorReach: number;
      hullRadius: number;
    }
  ): MotionEnvelopeRejection['check'] | undefined {
    if (limits.velocity > limits.speed + 1e-6) {
      return 'velocity';
    }
    if (limits.displacement > limits.credit + 1e-6) {
      return 'displacement';
    }
    if (checkBoundaryCollision(pose.position, limits.hullRadius)) {
      return 'boundary';
    }
    if (
      session.mode === 'handoff' &&
      session.anchor &&
      Math.hypot(pose.position.x - session.anchor.x, pose.position.y - session.anchor.y) >
        limits.anchorReach
    ) {
      return 'anchor';
    }
    return undefined;
  }

  public acceptFreePose(socket: WebSocket, pose: EnhancedFreePose, now: number): MotionOutcome {
    this.assertTime(now);
    const session = this.owner(socket);
    if (
      !session ||
      !this.validActor(session.actor) ||
      session.actor.furnaceTransit ||
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
      (pose.contourLock != null && !isContourLockState(pose.contourLock)) ||
      Object.keys(pose).some(
        (key) =>
          ![
            'epoch',
            'sequence',
            'position',
            'velocity',
            'angle',
            'thrusting',
            'contourLock',
          ].includes(key)
      ) ||
      now < session.poseAt
    ) {
      return { ok: false, error: 'Invalid or stale enhanced movement pose' };
    }
    const candidate = pose.contourLock ?? null;
    const previousLock = session.actor.contourLock;
    const acquiredAt = previousLock ? session.contourLockAt : now;
    if (candidate && !this.validContourPose(session, pose, candidate, acquiredAt, now)) {
      this.handoff(session, now, session.poseCredit);
      return { ok: false, error: 'Movement left its authoritative contour rail' };
    }
    // The client samples terrain before its final movement step. Include that
    // point and the last accepted position so current exits and turns do not
    // trigger a correction; displacement is still bounded by server-time credit.
    const speed = Math.max(
      this.legalSpeed(session.actor, now, candidate !== null),
      this.legalSpeed(session.actor, now, candidate !== null, {
        x: pose.position.x - pose.velocity.x,
        y: pose.position.y - pose.velocity.y,
      })
    );
    // Use the fastest legal terrain travel for elapsed distance credit. A local
    // endpoint current cannot bound a buffered route through stronger currents.
    // Velocity itself still uses the local ceiling above.
    const travelSpeed = this.maximumTravelSpeed(session.actor, now, candidate !== null);
    const elapsedMs = now - session.poseAt;
    // Client silence is capped at the client's own bounded catch-up so it
    // cannot bank an arbitrary jump. Time the server loop spent blocked is
    // credited in full: the client kept flying and reporting, and nothing it
    // sent could be read until the block ended.
    const blockedMs = this.blockedMsBetween(session.poseAt, now);
    const creditedMs = Math.min(MAX_TICK_DEBT_MS, elapsedMs - blockedMs) + blockedMs;
    const elapsedFrames = (creditedMs * GAME.FPS) / 1000;
    const blockedFrames = (blockedMs * GAME.FPS) / 1000;
    if (now - session.burstAt > BURST_CREDIT_MS) {
      session.burstCredit = 0;
    }
    // Spend elapsed travel before capping unused jitter credit. Capping first
    // rejects ordinary flight whenever updates are more than 150 ms apart.
    const credit = session.poseCredit + session.burstCredit + elapsedFrames * travelSpeed;
    const velocity = Math.hypot(pose.velocity.x, pose.velocity.y);
    const displacement = Math.hypot(
      pose.position.x - session.actor.position.x,
      pose.position.y - session.actor.position.y
    );
    const anchorReach =
      (travelSpeed * (now - session.anchorAt) * GAME.FPS) / 1000 + PLAYER_MOTION.poseTolerance;
    const hullRadius = hullRadiusForKit(session.actor.kitId);
    const failed =
      candidate &&
      !(previousLock
        ? this.validContourRoute(
            session.actor.position,
            pose.position,
            candidate,
            travelSpeed,
            credit
          )
        : this.validContourAcquisition(
            session.actor,
            pose.position,
            candidate,
            travelSpeed,
            credit
          ))
        ? 'rail'
        : this.failedEnvelopeCheck(session, pose, {
            speed,
            velocity,
            displacement,
            credit,
            anchorReach,
            hullRadius,
          });
    if (failed) {
      session.actor.velocity = capMotionVelocity(session.actor.velocity, speed);
      // A fresh epoch makes the client adopt the last accepted pose. Preserve
      // the earned budget so rejected commands cannot mint more movement credit.
      const mode = session.mode;
      this.handoff(session, now, Math.min(travelSpeed * PLAYER_MOTION.poseLeadFrames, credit));
      return {
        ok: false,
        error: 'Enhanced movement exceeds its server-time envelope',
        envelope: {
          check: failed,
          mode,
          elapsedMs,
          blockedMs,
          speed,
          velocity,
          displacement,
          credit,
        },
      };
    }
    const remaining = Math.max(0, credit - displacement);
    session.poseCredit = Math.min(travelSpeed * PLAYER_MOTION.poseLeadFrames, remaining);
    // Buffered poses released together all arrive with zero elapsed time, so
    // the first one must not be the only pose able to spend the gap they were
    // held for. Excess above the lead stays for one jitter window and its clock
    // starts when the excess first appears. Growth is bounded by the client's
    // catch-up plus any blocked server time this pose was credited; a reserve
    // already earned carries over until it is spent or expires.
    const reserveCap = Math.max(
      session.burstCredit,
      travelSpeed * (MAX_CATCH_UP_TICKS + blockedFrames)
    );
    const excess = Math.min(reserveCap, remaining - session.poseCredit);
    if (session.burstCredit <= 0 && excess > 0) {
      session.burstAt = now;
    }
    session.burstCredit = excess;
    session.poseAt = now;
    session.poseSequence = pose.sequence;
    session.mode = 'free';
    session.anchor = undefined;
    session.ack = pose.sequence;
    session.actor.position = { x: pose.position.x, y: pose.position.y };
    session.actor.velocity = { x: pose.velocity.x, y: pose.velocity.y };
    session.actor.angle = pose.angle;
    session.actor.thrusting = pose.thrusting;
    session.actor.contourLock = candidate
      ? { height: candidate.height, direction: candidate.direction }
      : null;
    session.contourLockAt = acquiredAt;
    session.actor.lastUpdate = now;
    this.publish(session);
    return { ok: true, blockedMs };
  }

  /** Publish a server impulse as a new epoch so in-flight client poses cannot erase it. */
  public applyExternalImpulse(actorId: string, now: number): void {
    this.assertTime(now);
    const session = this.sessions.get(actorId);
    if (!session || !this.alive(session.actor)) {
      return;
    }
    session.actor.contourLock = null;
    const speed = Math.hypot(session.actor.velocity.x, session.actor.velocity.y);
    session.knockback = { speed, at: now };
    session.epoch += 1;
    session.mode = 'free';
    session.ack = 0;
    session.poseSequence = -1;
    session.anchor = undefined;
    session.poseAt = now;
    session.anchorAt = now;
    session.poseCredit = this.maximumTravelSpeed(session.actor, now) * PLAYER_MOTION.poseLeadFrames;
    session.burstCredit = 0;
    session.burstAt = now;
    this.publish(session);
  }

  /** Start a fresh client prediction epoch after server-owned pipe travel. */
  public handoffActor(actorId: string, now: number): void {
    const session = this.sessions.get(actorId);
    if (session) {
      delete session.knockback;
      this.handoff(session, now, 0);
    }
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
    return this.placeFixtureSession(session, position, now);
  }

  /** Match the live published test actor to its actual current motion/socket session. */
  public hasLiveActorForTesting(actor: GameEntity): boolean {
    const session = this.sessions.get(actor.id);
    return Boolean(
      session &&
        session.actor === actor &&
        session.socket === actor.ws &&
        actor.ws &&
        actor.ws.readyState === actor.ws.OPEN &&
        actor.playerMotion?.epoch === session.epoch &&
        this.alive(actor)
    );
  }

  /** A test fixture may preserve only the current live actor/session's existing tow. */
  public hasLiveTowForTesting(actor: GameEntity, expectedTowTargetId: string): boolean {
    return (
      this.hasLiveActorForTesting(actor) &&
      isTowCableUtility(actor) &&
      Boolean(expectedTowTargetId) &&
      actor.harpoonTargetId === expectedTowTargetId
    );
  }

  /** Preserve only an already validated, live tow during explicit test placement. */
  public placeTowedActorForTesting(
    actor: GameEntity,
    position: Position,
    now: number,
    expectedTowTargetId: string
  ): boolean {
    this.assertTime(now);
    const session = this.sessions.get(actor.id);
    if (
      !finiteMotionVector(position) ||
      !session ||
      !this.hasLiveTowForTesting(actor, expectedTowTargetId)
    ) {
      return false;
    }
    return this.placeFixtureSession(session, position, now);
  }

  private placeFixtureSession(session: Session, position: Position, now: number): boolean {
    session.epoch += 1;
    session.mode = 'free';
    session.ack = 0;
    session.poseSequence = -1;
    session.anchor = undefined;
    session.poseAt = now;
    session.anchorAt = now;
    session.poseCredit = this.maximumTravelSpeed(session.actor, now) * PLAYER_MOTION.poseLeadFrames;
    session.burstCredit = 0;
    session.burstAt = now;
    session.actor.position = { ...position };
    session.actor.velocity = { x: 0, y: 0 };
    session.actor.thrusting = false;
    session.actor.contourLock = null;
    session.actor.lastUpdate = now;
    this.publish(session);
    return true;
  }

  /** Release at a physical contact even when protection prevents health loss. */
  public releaseContourLock(actorId: string, now: number): void {
    const session = this.sessions.get(actorId);
    if (session?.actor.contourLock) {
      this.handoff(session, now, session.poseCredit);
    }
  }

  private validContourAcquisition(
    actor: GameEntity,
    end: Position,
    state: ContourLockState,
    speed: number,
    credit: number
  ): boolean {
    // The first locked packet can contain ordinary flight before the toggle.
    // Search bounded switch points along the last accepted free-flight velocity,
    // spending its distance before checking the remaining forward rail route.
    // Subsequent packets never receive this acquisition allowance.
    const freeSpeed = Math.hypot(actor.velocity.x, actor.velocity.y);
    const frames = Math.min(MAX_CATCH_UP_TICKS + PLAYER_MOTION.poseLeadFrames, credit / speed);
    for (let halfFrame = 0; halfFrame <= Math.ceil(frames * 2); halfFrame++) {
      const elapsed = Math.min(frames, halfFrame / 2);
      const spent = elapsed * freeSpeed;
      const remaining = credit - spent;
      if (remaining < 0) {
        break;
      }
      const start = {
        x: actor.position.x + actor.velocity.x * elapsed,
        y: actor.position.y + actor.velocity.y * elapsed,
      };
      if (contourLockDistance(start, state) > CONTOUR_LOCK.captureRadius) {
        continue;
      }
      const residual = Math.hypot(end.x - start.x, end.y - start.y);
      if (
        residual <= Math.min(remaining, PLAYER_MOTION.poseTolerance) ||
        this.validContourRoute(start, end, state, speed, remaining)
      ) {
        return true;
      }
      if (freeSpeed < 1e-6) {
        break;
      }
    }
    return false;
  }

  private validContourRoute(
    start: Position,
    end: Position,
    state: ContourLockState,
    speed: number,
    credit: number
  ): boolean {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const displacement = Math.hypot(dx, dy);
    if (displacement > credit + 1e-6) {
      return false;
    }
    if (displacement < 1e-6) {
      return true;
    }
    // The helper takes cruise, so remove its rail multiplier from the envelope speed.
    const cruise = speed / contourLockSpeed(1);
    const first = contourLockVelocity(start, state, cruise);
    if (!first) {
      return false;
    }
    if (displacement <= speed * 2) {
      return (dx * first.x + dy * first.y) / (displacement * Math.hypot(first.x, first.y)) >= 0.92;
    }
    // Walk a bounded forward rail route. Checking only endpoints or the claimed
    // velocity allows a client to fly backwards or jump across a contour bend.
    const steps = Math.min(128, Math.max(1, Math.ceil(credit / speed)));
    const stepDistance = credit / steps;
    let cursor = start;
    for (let step = 0; step < steps; step++) {
      const velocity = contourLockVelocity(cursor, state, cruise);
      if (!velocity) {
        return false;
      }
      const scale = stepDistance / Math.hypot(velocity.x, velocity.y);
      const vx = velocity.x * scale;
      const vy = velocity.y * scale;
      const fraction = Math.max(
        0,
        Math.min(1, ((end.x - cursor.x) * vx + (end.y - cursor.y) * vy) / (vx * vx + vy * vy))
      );
      const distance = Math.hypot(
        end.x - cursor.x - vx * fraction,
        end.y - cursor.y - vy * fraction
      );
      if (distance <= CONTOUR_LOCK.railTolerance) {
        return true;
      }
      cursor = { x: cursor.x + vx, y: cursor.y + vy };
    }
    return false;
  }

  private validContourPose(
    session: Session,
    pose: EnhancedFreePose,
    candidate: ContourLockState,
    acquiredAt: number,
    now: number
  ): boolean {
    const previous = session.actor.contourLock;
    if (
      previous &&
      (previous.height !== candidate.height || previous.direction !== candidate.direction)
    ) {
      return false;
    }
    const allowedDistance =
      now - acquiredAt >= CONTOUR_LOCK.acquisitionMs
        ? CONTOUR_LOCK.railTolerance
        : CONTOUR_LOCK.captureRadius;
    if (contourLockDistance(pose.position, candidate) > allowedDistance) {
      return false;
    }
    const kit = getShipKit(session.actor.kitId);
    const cruise = cruiseSpeed(session.actor.mass, kit.maxVelocity);
    // Client velocity is chosen just before integration. Sampling that point
    // avoids rejecting a real curved rail at its post-step endpoint.
    const expected = contourLockVelocity(
      {
        x: pose.position.x - pose.velocity.x,
        y: pose.position.y - pose.velocity.y,
      },
      candidate,
      cruise
    );
    if (!expected) {
      return false;
    }
    const actualSpeed = Math.hypot(pose.velocity.x, pose.velocity.y);
    const expectedSpeed = Math.hypot(expected.x, expected.y);
    // Acceleration may report less than cruise speed, but cannot aim the rail's
    // extra speed across the terrain or run against the selected direction.
    return (
      actualSpeed < 1e-6 ||
      (pose.velocity.x * expected.x + pose.velocity.y * expected.y) /
        (actualSpeed * expectedSpeed) >=
        0.92
    );
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
      if (
        !session.actor.furnaceTransit &&
        session.mode === 'handoff' &&
        now - session.anchorAt >= PLAYER_MOTION.handoffTimeoutMs
      ) {
        this.handoff(session, now);
      }
      this.publish(session);
    }
    return expired;
  }

  public ownsActorMotion(actorId: string): boolean {
    const session = this.sessions.get(actorId);
    if (!session) {
      return false;
    }
    return Boolean(session.actor.furnaceTransit) || session.mode !== 'free' || !session.socket;
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
    this.blockedSpans = [];
  }
}
