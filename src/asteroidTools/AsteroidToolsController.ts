import type { ReflectionPreview } from '../../shared/asteroidReflection';
import type {
  AsteroidMaterial,
  AsteroidMotionState,
  AsteroidPhenomenon,
  AsteroidToolAction,
  LaserUpgrade,
  Position,
  ShipKitId,
  SoftFactionId,
} from '../../shared-types';

export interface AsteroidToolsTarget {
  id: string;
  position: Position;
  size: number;
  material?: AsteroidMaterial;
  phenomenon?: AsteroidPhenomenon;
}

export interface AsteroidToolsPilotState {
  id?: string;
  position?: Position;
  kitId?: ShipKitId;
  factionId?: SoftFactionId;
  alive?: boolean;
  asteroidMotion?: AsteroidMotionState;
  laserUpgrade?: LaserUpgrade;
}

export interface AsteroidToolsState {
  selectedTargetId?: string;
  selectedTarget?: AsteroidToolsTarget;
  targets: readonly AsteroidToolsTarget[];
  reflectionPreview?: ReflectionPreview;
  pilot?: AsteroidToolsPilotState;
  status: string;
}

export type AsteroidToolsMotionAction = 'latch' | 'release' | 'anchor' | 'brake' | 'spin';
type ConstrainedMotionAction = Exclude<AsteroidToolsMotionAction, 'latch'>;

export interface AsteroidToolsControllerOptions {
  /** Send the server-authoritative latch command. */
  dispatchTool?: (action: AsteroidToolAction) => boolean;
  /** Root adapter that owns the negotiated motion sequence/prediction. */
  dispatchMotionAction?: (action: ConstrainedMotionAction, targetId?: string) => boolean;
  now?: () => number;
  onChange?: (state: AsteroidToolsState) => void;
}

/** One snapshot-shaped update for GameController/ConnectionManager wiring. */
export interface AsteroidToolsControllerUpdate {
  /** Omit to keep the pilot; undefined explicitly clears it. */
  pilot?: AsteroidToolsPilotState | undefined;
  targets?: readonly AsteroidToolsTarget[];
  reflectionPreview?: ReflectionPreview | undefined;
}

type StateListener = (state: AsteroidToolsState) => void;

const UI_ACTION_DEBOUNCE_MS = 250;
const MOTION_KEYS: Readonly<Record<string, AsteroidToolsMotionAction | undefined>> = {
  KeyR: 'anchor',
  KeyX: 'brake',
  KeyC: 'spin',
};

/**
 * Client-side asteroid tools state and action gate.
 *
 * The server owns asteroid poses and Hauler motion. This controller only
 * stores the current snapshot, manages target selection, and forwards a
 * bounded user action to the authoritative transport.
 */
export class AsteroidToolsController {
  private readonly dispatchTool: AsteroidToolsControllerOptions['dispatchTool'];
  private readonly dispatchMotionAction: AsteroidToolsControllerOptions['dispatchMotionAction'];
  private readonly now: () => number;
  private readonly listeners = new Set<StateListener>();
  private readonly targetsById = new Map<string, AsteroidToolsTarget>();
  private state: AsteroidToolsState = {
    targets: [],
    status: 'Tools unavailable',
  };
  private sequence = 0;
  private lastMotionAt = Number.NEGATIVE_INFINITY;
  private lastMotionAction?: AsteroidToolsMotionAction;

  constructor(options: AsteroidToolsControllerOptions = {}) {
    this.dispatchTool = options.dispatchTool;
    this.dispatchMotionAction = options.dispatchMotionAction;
    this.now = options.now ?? (() => Date.now());
    if (options.onChange) {
      this.listeners.add(options.onChange);
    }
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.targetsById.clear();
  }

  getState(): AsteroidToolsState {
    const selectedTarget = this.state.selectedTargetId
      ? this.targetsById.get(this.state.selectedTargetId)
      : undefined;
    return {
      ...this.state,
      targets: [...this.targetsById.values()],
      ...(selectedTarget ? { selectedTarget } : {}),
      ...(this.state.pilot ? { pilot: { ...this.state.pilot } } : {}),
    };
  }

  /** Apply one negotiated snapshot without emitting an intermediate DOM state. */
  update(snapshot: AsteroidToolsControllerUpdate): void {
    let changed = false;
    if ('pilot' in snapshot) {
      this.applyPilot(snapshot.pilot);
      changed = true;
    }
    if ('targets' in snapshot && snapshot.targets) {
      this.applyTargets(snapshot.targets);
      changed = true;
    }
    if ('reflectionPreview' in snapshot) {
      if (snapshot.reflectionPreview) {
        this.state.reflectionPreview = snapshot.reflectionPreview;
      } else {
        delete this.state.reflectionPreview;
      }
      changed = true;
    }
    if (changed) {
      this.publish();
    }
  }

  cancel(): void {
    const changed =
      this.state.selectedTargetId !== undefined || this.state.reflectionPreview !== undefined;
    delete this.state.selectedTargetId;
    delete this.state.reflectionPreview;
    if (changed) {
      this.publish();
    }
  }

  setPilot(pilot: AsteroidToolsPilotState | undefined): void {
    this.applyPilot(pilot);
    this.publish();
  }

  setTargets(targets: readonly AsteroidToolsTarget[]): void {
    this.applyTargets(targets);
    this.publish();
  }

  setReflectionPreview(preview: ReflectionPreview | undefined): void {
    if (preview) {
      this.state.reflectionPreview = preview;
    } else {
      delete this.state.reflectionPreview;
    }
    this.publish();
  }

  selectTarget(targetId: string | undefined): boolean {
    if (targetId === undefined || targetId === '') {
      if (this.state.selectedTargetId === undefined) {
        return false;
      }
      delete this.state.selectedTargetId;
      delete this.state.reflectionPreview;
      this.publish();
      return true;
    }
    if (!this.targetsById.has(targetId)) {
      return false;
    }
    if (targetId === this.state.selectedTargetId) {
      return true;
    }
    this.state.selectedTargetId = targetId;
    delete this.state.reflectionPreview;
    this.state.status = 'Target selected';
    this.publish();
    return true;
  }

  requestMotion(action: AsteroidToolsMotionAction): boolean {
    if (!this.canInteract() || this.state.pilot?.kitId !== 'hauler') {
      return false;
    }
    const motion = this.state.pilot.asteroidMotion;
    if (action !== 'latch' && (!motion || !['latched', 'released'].includes(motion.mode))) {
      return false;
    }
    const needsTarget =
      action === 'latch' || action === 'anchor' || (action === 'brake' && !motion?.payloadId);
    if (needsTarget && !this.state.selectedTargetId) {
      return false;
    }
    const now = this.currentTime();
    if (action === this.lastMotionAction && now - this.lastMotionAt < UI_ACTION_DEBOUNCE_MS) {
      return false;
    }

    let dispatched = false;
    if (action === 'latch') {
      if (!this.dispatchTool || !this.state.selectedTargetId) {
        return false;
      }
      dispatched = this.dispatchTool({
        action: 'latch',
        targetId: this.state.selectedTargetId,
        sequence: this.nextSequence(),
      });
    } else if (this.dispatchMotionAction) {
      dispatched = this.dispatchMotionAction(
        action,
        action === 'anchor' || (action === 'brake' && !motion?.payloadId)
          ? this.state.selectedTargetId
          : undefined
      );
    }
    if (!dispatched) {
      return false;
    }
    this.lastMotionAt = now;
    this.lastMotionAction = action;
    this.state.status = `${action[0]?.toUpperCase() ?? ''}${action.slice(1)} requested`;
    this.publish();
    return true;
  }

  /** Cycle targets by distance so every action is available without a pointer. */
  cycleTarget(): boolean {
    const position = this.state.pilot?.position;
    if (!this.canInteract() || !position) {
      return false;
    }
    const targets = [...this.targetsById.values()].sort(
      (a, b) =>
        Math.hypot(a.position.x - position.x, a.position.y - position.y) -
          Math.hypot(b.position.x - position.x, b.position.y - position.y) ||
        a.id.localeCompare(b.id)
    );
    const index = targets.findIndex((target) => target.id === this.state.selectedTargetId);
    return this.selectTarget(targets[(index + 1) % targets.length]?.id);
  }

  handleKeyDown(event: Pick<KeyboardEvent, 'code' | 'repeat' | 'preventDefault'>): boolean {
    if (event.repeat || !this.canInteract()) {
      return false;
    }
    if (event.code === 'Escape') {
      if (!this.state.selectedTargetId) {
        return false;
      }
      this.cancel();
    } else if (event.code === 'KeyT') {
      if (!this.cycleTarget()) {
        return false;
      }
    } else {
      let action = MOTION_KEYS[event.code];
      if (event.code === 'KeyQ') {
        action = this.state.pilot?.asteroidMotion?.mode === 'latched' ? 'release' : 'latch';
      }
      if (!action || this.state.pilot?.kitId !== 'hauler') {
        return false;
      }
      if (!this.state.selectedTargetId && (action === 'latch' || action === 'anchor')) {
        this.cycleTarget();
      }
      if (!this.requestMotion(action)) {
        return false;
      }
    }
    event.preventDefault();
    return true;
  }

  private canInteract(): boolean {
    return this.state.pilot !== undefined && this.state.pilot.alive !== false;
  }

  private applyPilot(pilot: AsteroidToolsPilotState | undefined): void {
    if (pilot) {
      this.state.pilot = { ...pilot };
    } else {
      delete this.state.pilot;
    }
    if (!pilot || pilot.alive === false) {
      delete this.state.selectedTargetId;
      delete this.state.reflectionPreview;
      this.state.status = 'Tools unavailable';
      return;
    }
    const mode = pilot.asteroidMotion?.mode;
    this.state.status =
      mode === 'latched'
        ? `Latched · ${pilot.asteroidMotion?.tetherMode ?? 'spin'}`
        : mode === 'released'
          ? 'Released'
          : mode === 'handoff'
            ? 'Settling'
            : 'Ready';
  }

  private applyTargets(targets: readonly AsteroidToolsTarget[]): void {
    this.targetsById.clear();
    for (const target of targets) {
      if (target.id.length > 0) {
        this.targetsById.set(target.id, { ...target });
      }
    }
    if (this.state.selectedTargetId && !this.targetsById.has(this.state.selectedTargetId)) {
      delete this.state.selectedTargetId;
      delete this.state.reflectionPreview;
    }
  }

  private currentTime(): number {
    const value = this.now();
    return Number.isFinite(value) ? value : Date.now();
  }

  private nextSequence(): number {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Asteroid tools action sequence exhausted');
    }
    this.sequence += 1;
    return this.sequence;
  }

  private publish(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
