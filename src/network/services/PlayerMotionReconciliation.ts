import { finiteMotionVector } from '../../../shared/playerMotion';
import type { PlayerMotionState, Position, ServerEntityData } from '../../../shared-types';
import type { Ship } from '../../entities/ship/Ship';

interface PlayerPose {
  motionEpoch: number;
  motionSequence: number;
  position: Position;
  velocity: Position;
  angle: number;
  thrusting: boolean;
}

/** Reconcile authoritative respawns and reconnects; ordinary flight stays client-predicted. */
export class PlayerMotionReconciliation {
  private actorId?: string;
  private motion?: PlayerMotionState;
  private nextPoseSequence = 0;
  private lastSnapshotAt = -1;
  private waitingForResume = false;
  private authoritativeAlive = false;

  private assertTime(now: number): void {
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError('Prediction requires a finite local clock');
    }
  }

  public shouldSuppressPose(): boolean {
    return this.waitingForResume || (!!this.motion && this.motion.mode !== 'free');
  }

  public shouldSuppressShipMove(): boolean {
    return this.shouldSuppressPose();
  }

  public rebase(snapshot: ServerEntityData, ship: Ship, now: number): boolean {
    this.assertTime(now);
    const state = snapshot.playerMotion;
    if (!state) {
      // Absence is terminal only when not awaiting a resumable keyframe. A
      // pre-acknowledgment row cannot turn constrained movement on.
      if (this.waitingForResume) {
        return false;
      }
      if (this.motion) {
        throw new Error('Player snapshot omitted its motion state');
      }
      return false;
    }
    if (
      !snapshot.id ||
      !Number.isSafeInteger(state.epoch) ||
      state.epoch < 0 ||
      !Number.isSafeInteger(state.ack) ||
      state.ack < 0 ||
      !['free', 'handoff'].includes(state.mode) ||
      !finiteMotionVector(snapshot.position) ||
      !finiteMotionVector(snapshot.velocity) ||
      !Number.isFinite(snapshot.angle) ||
      !Number.isFinite(snapshot.fuel) ||
      !Number.isFinite(snapshot.maxFuel) ||
      snapshot.fuel < 0 ||
      snapshot.fuel > snapshot.maxFuel ||
      !Number.isFinite(snapshot.mass) ||
      snapshot.mass <= 0 ||
      (state.mode === 'handoff' && (!state.anchor || !finiteMotionVector(state.anchor)))
    ) {
      throw new RangeError('Invalid authoritative player motion snapshot');
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
      this.nextPoseSequence = state.ack + 1;
    } else {
      this.nextPoseSequence = Math.max(this.nextPoseSequence, state.ack + 1);
    }
    this.actorId = snapshot.id;
    this.motion = { ...state, ...(state.anchor ? { anchor: { ...state.anchor } } : {}) };
    this.lastSnapshotAt = now;
    this.waitingForResume = false;
    this.authoritativeAlive =
      snapshot.health > 0 && !snapshot.exploding && snapshot.respawnTimer === undefined;
    // Never write health or resurrect a local predicted death. Lifecycle belongs
    // to Player.updateFromServer; motion/resources are reconciled here, while
    // ship.thrusting remains owned by local keyboard, mouse, and touch intent.
    if (state.mode !== 'free' || newEpoch || resumed || wasConstrained) {
      ship.fuel = snapshot.fuel;
      ship.maxFuel = snapshot.maxFuel;
      ship.lastLocalFuelWriteMs = 0;
      ship.position = { ...snapshot.position };
      ship.velocity = { ...snapshot.velocity };
      ship.knockbackVelocityLimit = Math.hypot(snapshot.velocity.x, snapshot.velocity.y);
      ship.angle = snapshot.angle;
      ship.mass = snapshot.mass;
    }
    return true;
  }

  /** Handoff is a dedicated acknowledgment, not a normal unsuppressed pose.
   * Keep Ship.update movement suppressed until a free-mode server snapshot confirms it.
   * Also use this allocator to decorate ordinary free poses.
   */
  public buildHandoffPose(ship: Ship): PlayerPose | null {
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
  }

  public reset(): void {
    delete this.actorId;
    delete this.motion;
    this.nextPoseSequence = 0;
    this.lastSnapshotAt = -1;
    this.waitingForResume = false;
    this.authoritativeAlive = false;
  }
}
