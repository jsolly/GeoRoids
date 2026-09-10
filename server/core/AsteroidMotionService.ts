import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  ASTEROID_MOTION,
  asteroidInertia,
  asteroidMass,
  asteroidSurfaceLatch,
  boundedAngularVelocity,
  capMotionVelocity,
  coupleAsteroidMomentum,
  finiteMotionVector,
  stepReleasedMotion,
  tangentVelocity,
  turnMotionAngle,
} from '../../shared/asteroidMotion';
import { radiusFromMass, sizeScaleFromMass, thrustScaleFromMass } from '../../shared/shipGrowth';
import type {
  AsteroidData,
  AsteroidMotionInput,
  AsteroidMotionState,
  AsteroidToolAction,
  Position,
} from '../../shared-types';
import { GAME, ROID } from '../../src/constants';
import { getShipKit, SHIP_ABILITY } from '../../src/entities/ship/shipKits';
import { getAsteroidFieldRadius, stepAsteroidMotion } from '../../src/physics/asteroidMotion';
import { getGameBoundary } from '../../src/physics/boundary';
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
  mode: AsteroidMotionState['mode'];
  ack: number;
  inputSequence: number;
  toolSequence: number;
  poseSequence: number;
  pending?: AsteroidMotionInput | undefined;
  desired?: AsteroidMotionInput | undefined;
  action?: AsteroidMotionInput | undefined;
  actionSeen: Set<string>;
  lastInputAt: number;
  disconnectedUntil?: number | undefined;
  targetId?: string | undefined;
  payloadId?: string | undefined;
  latchAngle: number;
  latchRadius: number;
  surfaceRadius: number;
  tetherMode: 'spin' | 'anchor' | 'brake';
  latchAt: number;
  releaseTicks: number;
  anchor?: Position | undefined;
  anchorAt: number;
  poseAt: number;
  poseCredit: number;
  wasAlive: boolean;
}

/** Enhanced movement authority. The owner must skip ordinary integration for
 * ownsActorMotion()/ownsAsteroidMotion() and apply all damage/death normally,
 * except collision against the pilot's own attached surface. No tokens are public.
 */
export class AsteroidMotionService {
  private sessions = new Map<string, Session>();
  private tokens = new Map<string, Session>();
  private sockets = new Map<WebSocket, Session>();
  private rockOwners = new Map<string, string>();

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

  private legalSpeed(actor: GameEntity): number {
    // Ship.updateMovement() applies friction without reapplying the mass cap
    // while coasting, then applies terrain force and enforces the raw kit max.
    // That raw kit max is the canonical final client envelope after growth,
    // slope, and a stale pre-growth velocity have all been accounted for.
    return getShipKit(actor.kitId).maxVelocity;
  }

  private owner(socket: WebSocket): Session | undefined {
    const session = this.sockets.get(socket);
    return session?.socket === socket && session.actor.ws === socket ? session : undefined;
  }

  private publish(session: Session): void {
    session.actor.asteroidMotion = {
      epoch: session.epoch,
      mode: session.mode,
      ack: session.ack,
      ...(session.targetId
        ? {
            asteroidId: session.targetId,
            latchAngle: session.latchAngle,
            tetherMode: session.tetherMode,
          }
        : {}),
      ...(session.payloadId ? { payloadId: session.payloadId } : {}),
      ...(session.anchor ? { anchor: { ...session.anchor } } : {}),
    };
  }

  public register(
    actor: GameEntity,
    socket: WebSocket,
    capability: unknown,
    now: number
  ): { ok: true; resumeToken: string; state: AsteroidMotionState } | { ok: false; error: string } {
    this.assertTime(now);
    if (capability !== 1) {
      return { ok: false, error: 'Enhanced asteroid motion was not negotiated' };
    }
    if (
      !this.validActor(actor) ||
      actor.ws !== socket ||
      this.sessions.has(actor.id) ||
      this.sockets.has(socket)
    ) {
      return { ok: false, error: 'Invalid or already registered authoritative motion owner' };
    }
    if (this.sessions.size >= ASTEROID_MOTION.maxSessions) {
      return { ok: false, error: 'Motion session capacity exhausted' };
    }
    const session: Session = {
      actor,
      socket,
      token: randomBytes(32).toString('hex'),
      epoch: 1,
      mode: 'free',
      ack: 0,
      inputSequence: -1,
      toolSequence: -1,
      poseSequence: -1,
      actionSeen: new Set(),
      lastInputAt: now,
      latchAngle: 0,
      latchRadius: 0,
      surfaceRadius: 0,
      tetherMode: 'spin',
      latchAt: 0,
      releaseTicks: 0,
      anchorAt: now,
      poseAt: now,
      poseCredit: this.legalSpeed(actor) * ASTEROID_MOTION.poseLeadFrames,
      wasAlive: true,
    };
    actor.velocity = capMotionVelocity(actor.velocity, this.legalSpeed(actor));
    this.sessions.set(actor.id, session);
    this.tokens.set(session.token, session);
    this.sockets.set(socket, session);
    this.publish(session);
    return {
      ok: true,
      resumeToken: session.token,
      state: { ...actor.asteroidMotion } as AsteroidMotionState,
    };
  }

  /** Atomic bearer-token takeover; root closes supersededSocket after rebinding.
   * Keep the same token through a flap; quit/reset/grace expiry invalidate it.
   */
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
      // Snapshot initialization may repeat join on the same physical socket.
      // This is not a transport flap: retain pending input, acknowledgments and dt.
      return { ok: true, actor: session.actor, resumeToken: session.token };
    }
    const old = session.socket;
    if (old) {
      this.sockets.delete(old);
    }
    session.socket = socket;
    session.actor.ws = socket;
    session.disconnectedUntil = undefined;
    // A transport replacement discards commands that were received but never
    // simulated. Keep the acknowledged frontier authoritative; otherwise the
    // resumed client starts at ack + 1 while the server rejects that sequence
    // as an already-seen input.
    session.inputSequence = session.ack;
    session.pending = undefined;
    session.desired = undefined;
    session.action = undefined;
    session.lastInputAt = now;
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
    session.disconnectedUntil = now + ASTEROID_MOTION.reconnectGraceMs;
    // `inputSequence` advances on receipt, while `ack` advances only when the
    // game tick consumes the pending command. Dropping pending input must roll
    // the receipt frontier back to the last simulated command for a clean
    // reconnect sequence.
    session.inputSequence = session.ack;
    session.pending = undefined;
    session.desired = undefined;
    session.action = undefined;
    session.actor.thrusting = false;
    return true;
  }

  private dropAttachments(session: Session): void {
    if (session.targetId) {
      this.rockOwners.delete(session.targetId);
    }
    if (session.payloadId) {
      this.rockOwners.delete(session.payloadId);
    }
    session.targetId = undefined;
    session.payloadId = undefined;
    session.actor.harpoonTimer = 0;
    delete session.actor.harpoonTargetId;
    delete session.actor.harpoonLatchPos;
    session.actor.abilityActiveFrames = 0;
  }

  private handoff(session: Session, now: number): void {
    this.dropAttachments(session);
    session.epoch += 1;
    session.mode = 'handoff';
    session.ack = 0;
    session.inputSequence = -1;
    session.poseSequence = -1;
    session.pending = undefined;
    session.desired = undefined;
    session.action = undefined;
    session.anchor = { ...session.actor.position };
    session.anchorAt = now;
    session.poseAt = now;
    session.poseCredit = this.legalSpeed(session.actor) * ASTEROID_MOTION.poseLeadFrames;
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
    session.actor.velocity = capMotionVelocity(
      session.actor.velocity,
      this.legalSpeed(session.actor)
    );
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
    this.dropAttachments(session);
    if (session.socket) {
      this.sockets.delete(session.socket);
    }
    this.tokens.delete(session.token);
    this.sessions.delete(session.actor.id);
    delete session.actor.asteroidMotion;
  }

  /** Terminal authoritative removal, including an owner currently in socket grace. */
  public forgetActor(actorId: string): void {
    const session = this.sessions.get(actorId);
    if (session) {
      this.removeSession(session);
    }
  }

  private physical(rock: AsteroidData | undefined): rock is AsteroidData {
    return (
      !!rock &&
      rock.health > 0 &&
      finiteMotionVector(rock.position) &&
      finiteMotionVector(rock.velocity) &&
      Number.isFinite(rock.rotation) &&
      Number.isFinite(rock.angularVelocity) &&
      Number.isFinite(rock.size) &&
      rock.size > 0 &&
      rock.size <= ASTEROID_MOTION.maxRockSize
    );
  }

  public latch(
    socket: WebSocket,
    action: AsteroidToolAction,
    rocks: readonly AsteroidData[],
    now: number
  ): MotionOutcome {
    this.assertTime(now);
    if (rocks.length > 1024) {
      throw new RangeError('Motion world exceeds bounded work');
    }
    const session = this.owner(socket);
    if (
      !session ||
      !this.validActor(session.actor) ||
      session.actor.kitId !== 'hauler' ||
      session.mode !== 'free'
    ) {
      return { ok: false, error: 'Enhanced latch requires the live free Hauler owner' };
    }
    if (
      action?.action !== 'latch' ||
      !Number.isSafeInteger(action.sequence) ||
      action.sequence <= session.toolSequence ||
      typeof action.targetId !== 'string' ||
      Object.keys(action).some((key) => !['action', 'sequence', 'targetId'].includes(key))
    ) {
      return { ok: false, error: 'Invalid or replayed latch command' };
    }
    const rock = rocks.find((entry) => entry.id === action.targetId);
    if (
      !this.physical(rock) ||
      this.rockOwners.has(rock.id) ||
      session.actor.abilityCooldownFrames > 0 ||
      Math.hypot(
        session.actor.position.x - rock.position.x,
        session.actor.position.y - rock.position.y
      ) >
        rock.size + ASTEROID_MOTION.latchRange
    ) {
      return { ok: false, error: 'Latch target is unavailable or out of range' };
    }
    const surface = asteroidSurfaceLatch(rock, session.actor.position);
    const radius =
      surface.radius +
      (getShipKit(session.actor.kitId).size / 2) * sizeScaleFromMass(session.actor.mass) +
      6;
    const offset = {
      x: Math.cos(rock.rotation + surface.angle) * radius,
      y: Math.sin(rock.rotation + surface.angle) * radius,
    };
    const incoming = capMotionVelocity(session.actor.velocity, this.legalSpeed(session.actor));
    const relative = { x: incoming.x - rock.velocity.x, y: incoming.y - rock.velocity.y };
    const inertia = asteroidInertia(rock);
    rock.angularVelocity = boundedAngularVelocity(
      (inertia * boundedAngularVelocity(rock.angularVelocity) +
        session.actor.mass * (offset.x * relative.y - offset.y * relative.x)) /
        (inertia + session.actor.mass * radius * radius)
    );
    rock.velocity = capMotionVelocity(rock.velocity, ASTEROID_MOTION.maxLinearVelocity);
    session.epoch += 1;
    session.mode = 'latched';
    session.ack = 0;
    session.inputSequence = -1;
    session.toolSequence = action.sequence;
    session.targetId = rock.id;
    session.latchAngle = surface.angle;
    session.surfaceRadius = surface.radius;
    session.latchRadius = radius;
    session.latchAt = now;
    session.tetherMode = 'spin';
    session.anchor = undefined;
    session.actionSeen.clear();
    session.pending = undefined;
    session.desired = undefined;
    session.lastInputAt = now;
    this.rockOwners.set(rock.id, session.actor.id);
    session.actor.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES.hauler;
    this.capAttachedSpeed(session, rock);
    this.placePilot(session, rock);
    this.publish(session);
    return { ok: true };
  }

  public input(
    socket: WebSocket,
    input: AsteroidMotionInput,
    rocks: readonly AsteroidData[],
    now: number
  ): MotionOutcome {
    this.assertTime(now);
    if (rocks.length > 1024) {
      throw new RangeError('Motion world exceeds bounded work');
    }
    const session = this.owner(socket);
    if (
      !session ||
      !this.validActor(session.actor) ||
      !['latched', 'released'].includes(session.mode)
    ) {
      return { ok: false, error: 'No owned constrained motion epoch' };
    }
    if (
      !input ||
      input.epoch !== session.epoch ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0 ||
      input.sequence <= session.inputSequence ||
      typeof input.thrust !== 'boolean' ||
      ![-1, 0, 1].includes(input.turn) ||
      !Number.isFinite(input.aimAngle) ||
      Math.abs(input.aimAngle) > Math.PI * 2 ||
      Object.keys(input).some(
        (key) =>
          !['epoch', 'sequence', 'thrust', 'turn', 'aimAngle', 'action', 'targetId'].includes(key)
      ) ||
      (input.action !== undefined &&
        !['release', 'anchor', 'brake', 'spin'].includes(input.action)) ||
      (input.targetId !== undefined &&
        (typeof input.targetId !== 'string' || input.targetId.length > 128))
    ) {
      return { ok: false, error: 'Invalid, stale, or replayed motion input' };
    }
    if (input.action) {
      if (session.mode !== 'latched' || session.action || session.actionSeen.has(input.action)) {
        return { ok: false, error: 'Motion action is already applied or unavailable' };
      }
      if (input.action === 'anchor' || (input.action === 'brake' && !session.payloadId)) {
        const primary = rocks.find((entry) => entry.id === session.targetId);
        const target = rocks.find((entry) => entry.id === input.targetId);
        if (
          !this.physical(primary) ||
          !this.physical(target) ||
          target.id === primary.id ||
          session.payloadId ||
          this.rockOwners.has(target.id) ||
          Math.hypot(
            primary.position.x - target.position.x,
            primary.position.y - target.position.y
          ) > ASTEROID_MOTION.payloadRange ||
          Math.hypot(
            primary.position.x - target.position.x,
            primary.position.y - target.position.y
          ) <=
            primary.size + target.size + 4
        ) {
          return {
            ok: false,
            error: 'Payload requires a separate nearby unowned physical asteroid',
          };
        }
      } else if (input.targetId !== undefined) {
        return { ok: false, error: 'This motion action does not accept a target' };
      }
      session.action = { ...input };
    } else if (input.targetId !== undefined) {
      return { ok: false, error: 'A target requires an anchor action' };
    }
    session.inputSequence = input.sequence;
    session.pending = { ...input };
    session.lastInputAt = now;
    return { ok: true };
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
    const speed = this.legalSpeed(session.actor);
    const elapsedFrames = ((now - session.poseAt) * GAME.FPS) / 1000;
    const credit = Math.min(
      speed * ASTEROID_MOTION.poseLeadFrames,
      session.poseCredit + elapsedFrames * speed
    );
    const displacement = Math.hypot(
      pose.position.x - session.actor.position.x,
      pose.position.y - session.actor.position.y
    );
    const anchorReach =
      (speed * (now - session.anchorAt) * GAME.FPS) / 1000 + ASTEROID_MOTION.poseTolerance;
    if (
      Math.hypot(pose.velocity.x, pose.velocity.y) > speed + 1e-6 ||
      displacement > credit + 1e-6 ||
      // Enhanced free poses are client-owned between constrained epochs, but
      // they still belong to the same kill-wall as every other pilot. Reject
      // the edge-crossing pose instead of allowing an attacker to walk out of
      // the authoritative arena one accepted pose at a time.
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
    this.dropAttachments(session);
    session.epoch += 1;
    session.mode = 'free';
    session.ack = 0;
    session.inputSequence = -1;
    session.poseSequence = -1;
    session.pending = undefined;
    session.desired = undefined;
    session.action = undefined;
    session.targetId = undefined;
    session.payloadId = undefined;
    session.anchor = undefined;
    session.poseAt = now;
    session.anchorAt = now;
    session.lastInputAt = now;
    session.poseCredit = this.legalSpeed(session.actor) * ASTEROID_MOTION.poseLeadFrames;
    session.actor.position = { ...position };
    session.actor.velocity = { x: 0, y: 0 };
    session.actor.thrusting = false;
    session.actor.lastUpdate = now;
    this.publish(session);
    return true;
  }

  private placePilot(session: Session, rock: AsteroidData): void {
    const angle = rock.rotation + session.latchAngle;
    const offset = {
      x: Math.cos(angle) * session.latchRadius,
      y: Math.sin(angle) * session.latchRadius,
    };
    session.actor.position = { x: rock.position.x + offset.x, y: rock.position.y + offset.y };
    session.actor.velocity = capMotionVelocity(
      tangentVelocity(rock.velocity, offset, rock.angularVelocity),
      ASTEROID_MOTION.maxLinearVelocity
    );
    session.actor.harpoonTargetId = rock.id;
    session.actor.harpoonLatchPos = {
      x: rock.position.x + Math.cos(angle) * session.surfaceRadius,
      y: rock.position.y + Math.sin(angle) * session.surfaceRadius,
    };
    session.actor.harpoonTimer = 2;
    session.actor.abilityActiveFrames = 2;
  }

  private capAttachedSpeed(session: Session, rock: AsteroidData): void {
    const centerSpeed = Math.hypot(rock.velocity.x, rock.velocity.y);
    const omegaLimit =
      Math.max(0, ASTEROID_MOTION.maxLinearVelocity - centerSpeed) / session.latchRadius;
    rock.angularVelocity = Math.max(
      -omegaLimit,
      Math.min(omegaLimit, boundedAngularVelocity(rock.angularVelocity))
    );
  }

  private release(session: Session): void {
    this.dropAttachments(session);
    session.mode = 'released';
    session.releaseTicks = 0;
    session.actor.velocity = capMotionVelocity(
      session.actor.velocity,
      ASTEROID_MOTION.maxLinearVelocity
    );
  }

  /** Keep a coupled pair inside the same shared belt as ordinary asteroids.
   *
   * Move the pair's center as one body so the tether length and relative
   * momentum survive a boundary correction. The inner scale matches
   * `containAsteroidPositionInto`; it leaves the same small buffer used by
   * ordinary field motion instead of inventing a second arena radius.
   */
  private containCoupledRocks(primary: AsteroidData, payload: AsteroidData): void {
    const { cx, cy } = getGameBoundary();
    const targetRadius = getAsteroidFieldRadius() * ROID.FIELD_INNER_SCALE;
    const primaryMass = asteroidMass(primary);
    const payloadMass = asteroidMass(payload);
    const totalMass = primaryMass + payloadMass;
    const center = {
      x: (primaryMass * primary.position.x + payloadMass * payload.position.x) / totalMass,
      y: (primaryMass * primary.position.y + payloadMass * payload.position.y) / totalMass,
    };
    const primaryOffset = {
      x: primary.position.x - center.x,
      y: primary.position.y - center.y,
    };
    const payloadOffset = {
      x: payload.position.x - center.x,
      y: payload.position.y - center.y,
    };
    const extent = Math.max(
      Math.hypot(primaryOffset.x, primaryOffset.y),
      Math.hypot(payloadOffset.x, payloadOffset.y)
    );
    const centerOffset = { x: center.x - cx, y: center.y - cy };
    const centerDistance = Math.hypot(centerOffset.x, centerOffset.y);

    if (centerDistance > 1e-6 && centerDistance + extent > targetRadius) {
      const allowedCenterDistance = Math.max(0, targetRadius - extent);
      const scale = allowedCenterDistance / centerDistance;
      const shift = {
        x: centerOffset.x * (scale - 1),
        y: centerOffset.y * (scale - 1),
      };
      primary.position.x += shift.x;
      primary.position.y += shift.y;
      payload.position.x += shift.x;
      payload.position.y += shift.y;

      // Reflect only the shared translational component. Applying the same
      // correction to both velocities preserves the pair's relative orbit.
      const normal = {
        x: centerOffset.x / centerDistance,
        y: centerOffset.y / centerDistance,
      };
      const centerVelocity = {
        x: (primaryMass * primary.velocity.x + payloadMass * payload.velocity.x) / totalMass,
        y: (primaryMass * primary.velocity.y + payloadMass * payload.velocity.y) / totalMass,
      };
      const radialVelocity = centerVelocity.x * normal.x + centerVelocity.y * normal.y;
      if (radialVelocity > 0) {
        const impulse = 2 * radialVelocity;
        primary.velocity.x -= impulse * normal.x;
        primary.velocity.y -= impulse * normal.y;
        payload.velocity.x -= impulse * normal.x;
        payload.velocity.y -= impulse * normal.y;
      }

      return;
    }

    // This is unreachable for normal payload ranges, but keeps malformed or
    // externally enlarged pairs finite without leaving either rock outside
    // the shared field. The normal path above always preserves separation.
    if (centerDistance <= 1e-6 && extent > targetRadius && extent > 1e-6) {
      const scale = targetRadius / extent;
      primary.position.x = cx + primaryOffset.x * scale;
      primary.position.y = cy + primaryOffset.y * scale;
      payload.position.x = cx + payloadOffset.x * scale;
      payload.position.y = cy + payloadOffset.y * scale;
    }
  }

  /** Cap the reconstructed pair as one body after rotation and wall bounce.
   * A common scale preserves relative velocity direction and tether geometry.
   */
  private capCoupledRockVelocity(primary: AsteroidData, payload: AsteroidData): void {
    const pairSpeed = Math.max(
      Math.hypot(primary.velocity.x, primary.velocity.y),
      Math.hypot(payload.velocity.x, payload.velocity.y)
    );
    if (
      Number.isFinite(pairSpeed) &&
      pairSpeed > ASTEROID_MOTION.maxLinearVelocity &&
      pairSpeed > 0
    ) {
      const sharedScale = ASTEROID_MOTION.maxLinearVelocity / pairSpeed;
      primary.velocity.x *= sharedScale;
      primary.velocity.y *= sharedScale;
      payload.velocity.x *= sharedScale;
      payload.velocity.y *= sharedScale;
    }
  }

  private advanceRocks(
    primary: AsteroidData,
    payload: AsteroidData | undefined,
    frames: number
  ): void {
    if (!payload) {
      // Shockwaves and loot blasts can alter an owned rock after the previous
      // motion tick. Re-cap the single-rock path before integrating it, then
      // use the same boundary bounce as ordinary AsteroidManager motion.
      primary.velocity = capMotionVelocity(primary.velocity, ASTEROID_MOTION.maxLinearVelocity);
      const next = stepAsteroidMotion(primary.position, primary.velocity, frames);
      primary.position = next.position;
      primary.velocity = next.velocity;
      primary.rotation += primary.angularVelocity * frames;
      return;
    }
    const m1 = asteroidMass(primary);
    const m2 = asteroidMass(payload);
    const total = m1 + m2;
    const offset = {
      x: payload.position.x - primary.position.x,
      y: payload.position.y - primary.position.y,
    };
    const r2 = offset.x * offset.x + offset.y * offset.y;
    const relative = {
      x: payload.velocity.x - primary.velocity.x,
      y: payload.velocity.y - primary.velocity.y,
    };
    const omega = (offset.x * relative.y - offset.y * relative.x) / r2;
    const center = {
      x: (m1 * primary.position.x + m2 * payload.position.x) / total,
      y: (m1 * primary.position.y + m2 * payload.position.y) / total,
    };
    const velocity = {
      x: (m1 * primary.velocity.x + m2 * payload.velocity.x) / total,
      y: (m1 * primary.velocity.y + m2 * payload.velocity.y) / total,
    };
    const angle = omega * frames;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const rotated = { x: offset.x * c - offset.y * s, y: offset.x * s + offset.y * c };
    center.x += velocity.x * frames;
    center.y += velocity.y * frames;
    primary.position = {
      x: center.x - (m2 / total) * rotated.x,
      y: center.y - (m2 / total) * rotated.y,
    };
    payload.position = {
      x: center.x + (m1 / total) * rotated.x,
      y: center.y + (m1 / total) * rotated.y,
    };
    primary.velocity = tangentVelocity(
      velocity,
      { x: (-m2 / total) * rotated.x, y: (-m2 / total) * rotated.y },
      omega
    );
    payload.velocity = tangentVelocity(
      velocity,
      { x: (m1 / total) * rotated.x, y: (m1 / total) * rotated.y },
      omega
    );
    primary.rotation += primary.angularVelocity * frames;
    payload.rotation += payload.angularVelocity * frames;
    this.containCoupledRocks(primary, payload);
    this.capCoupledRockVelocity(primary, payload);
  }

  /** Call once per authoritative simulation tick; `now` drives wall-clock
   * deadlines while `simulationFrames` supplies the fixed physics delta.
   * Returned expired actor IDs must be removed by root's existing disconnect
   * lifecycle.
   */
  public step(now: number, rocks: readonly AsteroidData[], simulationFrames = 1): string[] {
    this.assertTime(now);
    if (!Number.isFinite(simulationFrames) || simulationFrames < 0) {
      throw new RangeError('Motion requires finite simulation frames');
    }
    const framesPerStep = Math.min(ASTEROID_MOTION.maxFramesPerStep, simulationFrames);
    if (rocks.length > 1024) {
      throw new RangeError('Motion world exceeds bounded work');
    }
    const indexed = new Map(rocks.map((rock) => [rock.id, rock]));
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
      let remaining = framesPerStep;
      if (!alive || remaining <= 0) {
        continue;
      }
      if (session.mode === 'free' && session.socket) {
        continue;
      }
      const primary = session.targetId ? indexed.get(session.targetId) : undefined;
      let payload = session.payloadId ? indexed.get(session.payloadId) : undefined;
      if (session.targetId && !this.physical(primary)) {
        this.release(session);
      }
      if (session.payloadId && !this.physical(payload)) {
        this.rockOwners.delete(session.payloadId);
        session.payloadId = undefined;
        payload = undefined;
      }
      if (session.pending && session.socket) {
        session.desired = session.pending;
        session.ack = session.pending.sequence;
        session.pending = undefined;
      }
      if (session.action && session.socket && session.mode === 'latched') {
        const action = session.action;
        session.action = undefined;
        if (action.action) {
          session.actionSeen.add(action.action);
        }
        if (action.action === 'release') {
          this.release(session);
        } else if (
          (action.action === 'anchor' || action.action === 'brake') &&
          !session.payloadId
        ) {
          const target = indexed.get(action.targetId ?? '');
          if (
            this.physical(primary) &&
            this.physical(target) &&
            !this.rockOwners.has(target.id) &&
            Math.hypot(
              target.position.x - primary.position.x,
              target.position.y - primary.position.y
            ) >
              primary.size + target.size + 4 &&
            Math.hypot(
              target.position.x - primary.position.x,
              target.position.y - primary.position.y
            ) <= ASTEROID_MOTION.payloadRange
          ) {
            session.payloadId = target.id;
            payload = target;
            this.rockOwners.set(target.id, session.actor.id);
            session.tetherMode = action.action;
          }
        } else if (action.action === 'spin' || action.action === 'brake') {
          session.tetherMode = action.action;
        }
      }
      if (session.mode === 'latched' && now - session.latchAt >= ASTEROID_MOTION.latchLifetimeMs) {
        this.release(session);
      }
      const active =
        session.socket && now - session.lastInputAt <= ASTEROID_MOTION.inputTimeoutMs
          ? session.desired
          : undefined;
      const neutral = { thrust: false, turn: 0 as const, aimAngle: session.actor.angle };
      const input = active ?? neutral;
      const kit = getShipKit(session.actor.kitId);
      while (remaining > 1e-8) {
        const frames = Math.min(1, remaining);
        remaining -= frames;
        if (session.mode === 'latched' && this.physical(primary)) {
          session.actor.angle = turnMotionAngle(session.actor.angle, input, kit.turnSpeed, frames);
          session.actor.thrusting =
            input.thrust && session.actor.fuel >= ASTEROID_MOTION.fuelPerFrame * frames;
          if (session.actor.thrusting) {
            const cost = ASTEROID_MOTION.fuelPerFrame * frames;
            session.actor.fuel -= cost;
            const radial = primary.rotation + session.latchAngle;
            const lever = {
              x: Math.cos(radial) * session.latchRadius,
              y: Math.sin(radial) * session.latchRadius,
            };
            const force =
              (kit.thrust / GAME.FPS) *
              thrustScaleFromMass(session.actor.mass) *
              session.actor.mass;
            const torque =
              lever.x * -Math.sin(session.actor.angle) * force -
              lever.y * Math.cos(session.actor.angle) * force;
            const inertia =
              asteroidInertia(primary) + session.actor.mass * session.latchRadius ** 2;
            primary.angularVelocity = boundedAngularVelocity(
              primary.angularVelocity + (torque / inertia) * frames
            );
            primary.spinClass = 'charged';
          }
          if (this.physical(payload)) {
            coupleAsteroidMomentum(
              primary,
              payload,
              asteroidInertia(primary) + session.actor.mass * session.latchRadius ** 2,
              frames
            );
          }
          this.capAttachedSpeed(session, primary);
          this.advanceRocks(primary, payload, frames);
          this.placePilot(session, primary);
        } else {
          // Release drag always applies, so holding thrust cannot maintain an
          // unbounded boost; once ordinary speed is reached authority hands back.
          const motionInput = session.mode === 'released' ? input : neutral;
          session.actor.thrusting = motionInput.thrust;
          stepReleasedMotion(
            session.actor,
            motionInput,
            (kit.thrust / GAME.FPS) * thrustScaleFromMass(session.actor.mass),
            kit.turnSpeed,
            frames
          );
        }
      }
      if (session.mode === 'released') {
        session.releaseTicks += 1;
        if (
          session.releaseTicks >= 2 &&
          Math.hypot(session.actor.velocity.x, session.actor.velocity.y) <=
            this.legalSpeed(session.actor)
        ) {
          this.handoff(session, now);
        }
      } else if (
        session.mode === 'handoff' &&
        now - session.anchorAt >= ASTEROID_MOTION.handoffTimeoutMs
      ) {
        this.handoff(session, now); // Fresh anchor; no acknowledgment never grants arbitrary pose authority.
      }
      this.publish(session);
    }
    return expired;
  }

  public ownsActorMotion(actorId: string): boolean {
    const session = this.sessions.get(actorId);
    return !!session && (session.mode !== 'free' || !session.socket);
  }
  public ownsAsteroidMotion(asteroidId: string): boolean {
    return this.rockOwners.has(asteroidId);
  }
  public isAttachedTo(actorId: string, asteroidId: string): boolean {
    return this.sessions.get(actorId)?.targetId === asteroidId;
  }
  public beforeRemove(asteroidId: string): void {
    const owner = this.rockOwners.get(asteroidId);
    const session = owner ? this.sessions.get(owner) : undefined;
    if (!session) {
      return;
    }
    if (session.targetId === asteroidId) {
      this.release(session);
    } else {
      this.rockOwners.delete(asteroidId);
      session.payloadId = undefined;
    }
    this.publish(session);
  }
  public getState(actorId: string): AsteroidMotionState | undefined {
    const state = this.sessions.get(actorId)?.actor.asteroidMotion;
    return state
      ? { ...state, ...(state.anchor ? { anchor: { ...state.anchor } } : {}) }
      : undefined;
  }
  public seedNaturalSpinners(
    rocks: readonly AsteroidData[]
  ): Array<Pick<AsteroidData, 'id' | 'angularVelocity' | 'spinClass'>> {
    if (rocks.length > 1024) {
      throw new RangeError('Motion world exceeds bounded work');
    }
    const needed = Math.max(
      0,
      3 - rocks.filter((rock) => rock.spinClass !== undefined && this.physical(rock)).length
    );
    return rocks
      .filter((rock) => this.physical(rock) && !rock.spinClass && rock.size >= 20)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, needed)
      .map((rock, index) => ({
        id: rock.id,
        angularVelocity: index % 2 === 0 ? 0.16 : -0.16,
        spinClass: 'natural',
      }));
  }
  public reset(): void {
    for (const session of this.sessions.values()) {
      this.removeSession(session);
    }
    this.rockOwners.clear();
  }
}
