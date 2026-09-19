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
  boosting: boolean;
  boostDepleted: boolean;
}

/** Reconcile authoritative corrections, respawns and reconnects; ordinary flight stays predicted. */
export class PlayerMotionReconciliation {
  private actorId?: string;
  private motion?: PlayerMotionState;
  private nextPoseSequence = 0;
  private lastSnapshotAt = -1;
  private waitingForResume = false;
  private authoritativeAlive = false;
  private acknowledgedBoostVersion = 0;
  private pendingBoost: { version: number; sequence: number } | undefined;

  private assertTime(now: number): void {
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError('Prediction requires a finite local clock');
    }
  }

  public awaitAuthoritativePose(): void {
    this.waitingForResume = true;
  }

  public shouldSuppressPose(): boolean {
    const motion = this.motion;
    return this.waitingForResume || (motion !== undefined && motion.mode !== 'free');
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
    const wasConstrained = previous !== undefined && previous.mode !== 'free';
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
      ship.position = { ...snapshot.position };
      ship.velocity = { ...snapshot.velocity };
      ship.knockbackVelocityLimit = Math.hypot(snapshot.velocity.x, snapshot.velocity.y);
      ship.angle = snapshot.angle;
      ship.mass = snapshot.mass;
    }
    this.reconcileBoost(snapshot, ship, newEpoch || resumed || wasConstrained);
    return true;
  }

  private reconcileBoost(snapshot: ServerEntityData, ship: Ship, reset: boolean): void {
    const authoritative = snapshot.boost;
    // During separate server/client deploys, an old row must not replenish the
    // finite local tank or undo its current input.
    if (!authoritative) {
      return;
    }
    if (reset) {
      ship.boost = { ...authoritative };
      this.acknowledgedBoostVersion = ship.boostInputVersion;
      this.pendingBoost = undefined;
      if (ship.movementLocked || ship.exploding || ship.health <= 0) {
        ship.stopBoost();
      }
      return;
    }
    const pending = this.pendingBoost;
    if (pending && (snapshot.playerMotion?.ack ?? -1) >= pending.sequence) {
      this.acknowledgedBoostVersion = pending.version;
      this.pendingBoost = undefined;
    }
    const pendingInput = ship.boostInputVersion !== this.acknowledgedBoostVersion;
    // A fresh partial-charge activation can overtake an old recharge snapshot.
    // Once acknowledged, the server may still end the burst if its tank is empty.
    if (pendingInput && ship.boost.phase === 'active' && authoritative.phase === 'exhausted') {
      return;
    }
    if (authoritative.phase === 'exhausted') {
      ship.boost = { ...authoritative };
      return;
    }
    // Old active echoes cannot restart a tank that locally ran empty.
    if (ship.boost.phase === 'exhausted') {
      if (!pendingInput && authoritative.phase === 'idle') {
        ship.boost = { ...authoritative };
      }
      return;
    }
    const phase = pendingInput ? ship.boost.phase : authoritative.phase;
    const charge =
      pendingInput || phase === 'active'
        ? Math.min(ship.boost.charge, authoritative.charge)
        : authoritative.charge;
    ship.boost = { phase: phase === 'active' && charge <= 0 ? 'exhausted' : phase, charge };
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
    const sequence = this.nextPoseSequence++;
    if (
      ship.boostInputVersion !== this.acknowledgedBoostVersion &&
      this.pendingBoost?.version !== ship.boostInputVersion
    ) {
      this.pendingBoost = { version: ship.boostInputVersion, sequence };
    }
    return {
      motionEpoch: this.motion.epoch,
      motionSequence: sequence,
      position: { ...ship.position },
      velocity: { ...ship.velocity },
      angle: Math.atan2(Math.sin(ship.angle), Math.cos(ship.angle)),
      thrusting: ship.thrusting,
      boosting: ship.boosting,
      boostDepleted: ship.boost.phase === 'exhausted',
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
    this.acknowledgedBoostVersion = 0;
    this.pendingBoost = undefined;
  }
}
