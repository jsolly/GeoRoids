import {
  ASTEROID_MOTION,
  capMotionVelocity,
  finiteMotionVector,
  stepReleasedMotion,
  tangentVelocity,
  turnMotionAngle,
} from '../../../shared/asteroidMotion';
import { thrustScaleFromMass } from '../../../shared/shipGrowth';
import type {
  AsteroidData,
  AsteroidMotionInput,
  AsteroidMotionState,
  Position,
  ServerEntityData,
} from '../../../shared-types';
import { GAME } from '../../constants';
import type { Ship } from '../../entities/ship/Ship';
import { getShipKit } from '../../entities/ship/shipKits';

type RockPose = Pick<AsteroidData, 'id' | 'position' | 'rotation' | 'velocity' | 'angularVelocity'>;
type InputOverrides = Partial<
  Pick<AsteroidMotionInput, 'thrust' | 'turn' | 'aimAngle' | 'action' | 'targetId'>
>;
interface PendingInput {
  input: AsteroidMotionInput;
  frames: number;
  predicted: boolean;
}

export interface EnhancedPlayerPose {
  motionEpoch: number;
  motionSequence: number;
  position: Position;
  velocity: Position;
  angle: number;
  thrusting: boolean;
}

const MAX_PENDING = 32;

/** One instance per local player. Call rebase after ordinary entity updates,
 * buildInput only for commands actually sent, and predictFrame after input polling
 * instead of Ship.move while shouldSuppressShipMove() is true. UI motion actions
 * must use this same allocator; a second sequence stream causes rejected controls.
 */
export class AsteroidMotionPrediction {
  private actorId?: string;
  private motion?: AsteroidMotionState;
  private nextInputSequence = 1;
  private nextPoseSequence = 0;
  private pending: PendingInput[] = [];
  private lastCommandFrame?: number;
  private lastSnapshotAt = -1;
  private waitingForResume = false;
  private overflow = false;
  private authoritativeAlive = false;
  private latchRadius?: number;

  private assertTime(now: number): void {
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError('Prediction requires a finite local clock');
    }
  }

  public shouldSuppressPose(): boolean {
    return this.waitingForResume || this.overflow || (!!this.motion && this.motion.mode !== 'free');
  }

  public shouldSuppressShipMove(): boolean {
    return this.shouldSuppressPose();
  }

  /** The caller requests a fresh snapshot and logs this reason; overflow never
   * silently drops unacknowledged commands or enables legacy movement.
   */
  public recoveryReason(): string | undefined {
    return this.overflow
      ? 'Asteroid motion acknowledgment queue exhausted; request a fresh snapshot'
      : undefined;
  }

  public getState(): AsteroidMotionState | undefined {
    return this.motion
      ? { ...this.motion, ...(this.motion.anchor ? { anchor: { ...this.motion.anchor } } : {}) }
      : undefined;
  }

  public rebase(
    snapshot: ServerEntityData,
    ship: Ship,
    now: number,
    rocks: readonly RockPose[] = []
  ): boolean {
    this.assertTime(now);
    const state = snapshot.asteroidMotion;
    if (!state) {
      // Negotiated absence is terminal only when not awaiting a resumable
      // keyframe. A pre-joined legacy row cannot turn constrained movement on.
      if (this.waitingForResume) {
        return false;
      }
      if (this.motion) {
        throw new Error('Enhanced entity snapshot omitted its motion state');
      }
      return false;
    }
    if (
      !snapshot.id ||
      !Number.isSafeInteger(state.epoch) ||
      state.epoch < 0 ||
      !Number.isSafeInteger(state.ack) ||
      state.ack < 0 ||
      !['free', 'latched', 'released', 'handoff'].includes(state.mode) ||
      !finiteMotionVector(snapshot.position) ||
      !finiteMotionVector(snapshot.velocity) ||
      !Number.isFinite(snapshot.angle) ||
      !Number.isFinite(snapshot.fuel) ||
      !Number.isFinite(snapshot.maxFuel) ||
      snapshot.fuel < 0 ||
      snapshot.fuel > snapshot.maxFuel ||
      !Number.isFinite(snapshot.mass) ||
      snapshot.mass <= 0 ||
      (state.mode === 'latched' && (!state.asteroidId || !Number.isFinite(state.latchAngle))) ||
      (state.mode === 'handoff' && (!state.anchor || !finiteMotionVector(state.anchor)))
    ) {
      throw new RangeError('Invalid authoritative asteroid motion snapshot');
    }
    if (this.actorId && snapshot.id !== this.actorId) {
      this.reset();
    }
    const previous = this.motion;
    if (
      now < this.lastSnapshotAt ||
      (previous &&
        (state.epoch < previous.epoch ||
          (state.epoch === previous.epoch && state.ack < previous.ack)))
    ) {
      return false;
    }
    const newEpoch = !previous || state.epoch !== previous.epoch;
    const resumed = this.waitingForResume;
    const wasConstrained = !!previous && previous.mode !== 'free';
    if (newEpoch || resumed) {
      this.pending = [];
      delete this.lastCommandFrame;
      delete this.latchRadius;
      this.nextInputSequence = state.ack + 1;
      this.nextPoseSequence = state.ack + 1;
    } else {
      this.pending = this.pending.filter((entry) => entry.input.sequence > state.ack);
      this.nextInputSequence = Math.max(this.nextInputSequence, state.ack + 1);
      this.nextPoseSequence = Math.max(this.nextPoseSequence, state.ack + 1);
    }
    this.actorId = snapshot.id;
    this.motion = { ...state, ...(state.anchor ? { anchor: { ...state.anchor } } : {}) };
    this.lastSnapshotAt = now;
    this.waitingForResume = false;
    this.overflow = this.pending.length >= MAX_PENDING;
    this.authoritativeAlive =
      snapshot.health > 0 && !snapshot.exploding && snapshot.respawnTimer === undefined;
    if (!this.authoritativeAlive) {
      this.pending = [];
    }
    // Never write health or resurrect a local predicted death. Lifecycle belongs
    // to Player.updateFromServer; only motion/resources are reconciled here.
    if (state.mode !== 'free' || newEpoch || resumed || wasConstrained) {
      ship.fuel = snapshot.fuel;
      ship.maxFuel = snapshot.maxFuel;
      ship.lastLocalFuelWriteMs = 0;
      ship.position = { ...snapshot.position };
      ship.velocity = { ...snapshot.velocity };
      ship.angle = snapshot.angle;
      ship.thrusting = snapshot.thrusting;
      delete ship.targetPosition;
      delete ship.targetVelocity;
      delete ship.targetAngle;
      ship.mass = snapshot.mass;
    }
    if (state.mode === 'latched') {
      const target = rocks.find((rock) => rock.id === state.asteroidId);
      if (target) {
        this.latchRadius = Math.hypot(
          snapshot.position.x - target.position.x,
          snapshot.position.y - target.position.y
        );
      } else {
        delete this.latchRadius;
      }
    }
    if (state.mode === 'free' || state.mode === 'handoff' || !this.authoritativeAlive) {
      this.pending = [];
    } else {
      for (const entry of this.pending) {
        this.predictEntry(ship, entry, rocks);
        entry.predicted = true;
      }
    }
    return true;
  }

  /** Build from the actual post-poll Ship input. Angular-velocity sign carries
   * keyboard/touch turning; aimAngle is the actual current mouse/stick heading.
   * Multiple action packets in one 60Hz frame receive zero additional motion dt.
   */
  public buildInput(
    ship: Ship,
    now: number,
    overrides: InputOverrides = {}
  ): AsteroidMotionInput | null {
    this.assertTime(now);
    if (
      !this.motion ||
      !['latched', 'released'].includes(this.motion.mode) ||
      this.waitingForResume ||
      !this.authoritativeAlive ||
      ship.exploding ||
      ship.health <= 0
    ) {
      return null;
    }
    if (this.pending.length >= MAX_PENDING) {
      this.overflow = true;
      return null;
    }
    const turn =
      overrides.turn ?? (ship.angularVelocity > 0 ? 1 : ship.angularVelocity < 0 ? -1 : 0);
    const angle = overrides.aimAngle ?? ship.angle;
    const thrust = overrides.thrust ?? ship.thrusting;
    if (
      !Number.isFinite(angle) ||
      ![-1, 0, 1].includes(turn) ||
      typeof thrust !== 'boolean' ||
      (overrides.action !== undefined &&
        !['release', 'anchor', 'brake', 'spin'].includes(overrides.action)) ||
      (overrides.targetId !== undefined &&
        (typeof overrides.targetId !== 'string' ||
          !overrides.targetId ||
          overrides.targetId.length > 128))
    ) {
      throw new RangeError('Invalid local asteroid motion control');
    }
    const frame = Math.floor((now * GAME.FPS) / 1000);
    if (this.lastCommandFrame !== undefined && frame < this.lastCommandFrame) {
      throw new RangeError('Prediction input clock moved backwards');
    }
    const frames = this.lastCommandFrame === frame ? 0 : 1;
    this.lastCommandFrame = frame;
    const input: AsteroidMotionInput = {
      epoch: this.motion.epoch,
      sequence: this.nextInputSequence++,
      thrust,
      turn: turn as -1 | 0 | 1,
      aimAngle: Math.atan2(Math.sin(angle), Math.cos(angle)),
      ...(overrides.action ? { action: overrides.action } : {}),
      ...(overrides.targetId ? { targetId: overrides.targetId } : {}),
    };
    this.pending.push({ input, frames, predicted: false });
    return { ...input };
  }

  private predictEntry(ship: Ship, entry: PendingInput, rocks: readonly RockPose[]): void {
    if (!this.motion || entry.frames === 0 || !this.authoritativeAlive) {
      return;
    }
    const kit = getShipKit(ship.kitId);
    if (this.motion.mode === 'released') {
      stepReleasedMotion(
        ship,
        entry.input,
        (kit.thrust / GAME.FPS) * thrustScaleFromMass(ship.mass),
        kit.turnSpeed,
        entry.frames
      );
    } else if (this.motion.mode === 'latched') {
      // Do not forecast server torque, fuel spend, payload momentum, or rock spin.
      // The pilot follows the supplied authoritative/render-interpolated rock pose.
      ship.angle = turnMotionAngle(ship.angle, entry.input, kit.turnSpeed, entry.frames);
      const rock = rocks.find((candidate) => candidate.id === this.motion?.asteroidId);
      if (
        rock &&
        this.latchRadius !== undefined &&
        finiteMotionVector(rock.position) &&
        Number.isFinite(rock.rotation) &&
        Number.isFinite(rock.angularVelocity) &&
        finiteMotionVector(rock.velocity)
      ) {
        const angle = rock.rotation + (this.motion.latchAngle ?? 0);
        const offset = {
          x: Math.cos(angle) * this.latchRadius,
          y: Math.sin(angle) * this.latchRadius,
        };
        ship.position = { x: rock.position.x + offset.x, y: rock.position.y + offset.y };
        ship.velocity = capMotionVelocity(
          tangentVelocity(rock.velocity, offset, rock.angularVelocity),
          ASTEROID_MOTION.maxLinearVelocity
        );
      }
    }
    ship.thrusting = entry.input.thrust;
  }

  /** Safe to call repeatedly per render: each queued 60Hz step is applied once. */
  public predictFrame(ship: Ship, now: number, rocks: readonly RockPose[] = []): void {
    this.assertTime(now);
    if (this.waitingForResume || !this.authoritativeAlive || ship.exploding || ship.health <= 0) {
      return;
    }
    for (const entry of this.pending) {
      if (!entry.predicted) {
        this.predictEntry(ship, entry, rocks);
        entry.predicted = true;
      }
    }
  }

  /** Handoff is a dedicated acknowledgment, not a normal unsuppressed pose.
   * Keep Ship.move suppressed until a free-mode server snapshot confirms it.
   * Also use this allocator to decorate ordinary enhanced free poses.
   */
  public buildHandoffPose(ship: Ship): EnhancedPlayerPose | null {
    if (
      !this.motion ||
      !['handoff', 'free'].includes(this.motion.mode) ||
      this.waitingForResume ||
      !this.authoritativeAlive ||
      ship.exploding ||
      ship.health <= 0
    ) {
      return null;
    }
    if (
      !finiteMotionVector(ship.position) ||
      !finiteMotionVector(ship.velocity) ||
      !Number.isFinite(ship.angle)
    ) {
      throw new RangeError('Cannot acknowledge an invalid local motion pose');
    }
    return {
      motionEpoch: this.motion.epoch,
      motionSequence: this.nextPoseSequence++,
      position: { ...ship.position },
      velocity: { ...ship.velocity },
      angle: Math.atan2(Math.sin(ship.angle), Math.cos(ship.angle)),
      thrusting: ship.thrusting,
    };
  }

  public transportClosed(): void {
    if (!this.motion) {
      return;
    }
    this.waitingForResume = true;
    this.pending = [];
    delete this.lastCommandFrame;
    this.overflow = false;
  }

  public reset(): void {
    delete this.actorId;
    delete this.motion;
    this.nextInputSequence = 1;
    this.nextPoseSequence = 0;
    this.pending = [];
    delete this.lastCommandFrame;
    this.lastSnapshotAt = -1;
    this.waitingForResume = false;
    this.overflow = false;
    this.authoritativeAlive = false;
    delete this.latchRadius;
  }
}
