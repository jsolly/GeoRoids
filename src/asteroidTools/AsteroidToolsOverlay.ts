import type { ReflectionPreview } from '../../shared/asteroidReflection';
import type { AsteroidToolsMotionAction, AsteroidToolsState } from './AsteroidToolsController';

export interface AsteroidToolsOverlayCallbacks {
  onOpen: () => void;
  onClose: () => void;
  onSelectTarget: (targetId: string | undefined) => void;
  onMotion: (action: AsteroidToolsMotionAction) => void;
}

export interface AsteroidToolsOverlayOptions {
  container?: HTMLElement;
  callbacks?: Partial<AsteroidToolsOverlayCallbacks>;
}

const MOTION_LABELS: Readonly<Record<AsteroidToolsMotionAction, string>> = {
  latch: 'Latch rock',
  release: 'Release',
  anchor: 'Anchor',
  brake: 'Brake',
  spin: 'Spin',
};

const MOTION_HINTS: Readonly<Record<AsteroidToolsMotionAction, string>> = {
  latch: 'Attach to the selected rock',
  release: 'Detach and keep momentum',
  anchor: 'Attach the selected second rock',
  brake: 'Dampen tethered spin',
  spin: 'Resume tethered spin',
};

const OVERLAY_STYLE_ID = 'asteroid-tools-overlay-style';

function addText<T extends HTMLElement>(element: T, text: string): T {
  element.textContent = text;
  return element;
}

function createButton(
  doc: Document,
  label: string,
  className: string,
  onClick: () => void
): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function formatDistance(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? `${Math.round(value)}m` : '—';
}

function previewTerminationLabel(termination: ReflectionPreview['termination']): string {
  switch (termination) {
    case 'distance':
      return 'Range limit';
    case 'bounce-limit':
      return 'Max bounces';
    case 'blocked':
      return 'Blocked';
    case 'stationary':
      return 'No path';
  }
}

function targetBaseLabel(target: AsteroidToolsState['targets'][number]): string {
  if (target.phenomenon?.kind === 'reflective') {
    return 'Reflective metal';
  }
  if (target.material) {
    return target.material.slice(0, 1).toUpperCase() + target.material.slice(1);
  }
  return 'Asteroid';
}

function targetDistance(
  target: AsteroidToolsState['targets'][number],
  pilot: AsteroidToolsState['pilot']
): number | undefined {
  if (!pilot?.position) {
    return undefined;
  }
  const distance = Math.hypot(
    target.position.x - pilot.position.x,
    target.position.y - pilot.position.y
  );
  return Number.isFinite(distance) ? distance : undefined;
}

function ensureStyles(doc: Document): void {
  if (doc.getElementById(OVERLAY_STYLE_ID)) {
    return;
  }
  const style = doc.createElement('style');
  style.id = OVERLAY_STYLE_ID;
  style.textContent = `
.asteroid-tools-overlay {
  --tools-line: color-mix(in srgb, var(--palette-hud-muted, #64748b) 72%, transparent);
  --tools-bright: var(--palette-hud, #e2e8f0);
  --tools-accent: var(--palette-local, #5eead4);
  --tools-amber: var(--palette-laser, #FDE68A);
  --tools-cream: var(--palette-loot, #E8D5A3);
  position: absolute;
  z-index: 30;
  top: calc(5.5rem + env(safe-area-inset-top, 0px));
  right: max(0.5rem, env(safe-area-inset-right, 0px));
  width: min(19rem, calc(100vw - 1rem));
  max-height: min(74dvh, 38rem);
  overflow-x: hidden;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 0.65rem;
  border: 1px solid var(--tools-line);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--palette-bg, #000011) 88%, transparent);
  color: var(--tools-bright);
  font: 0.78rem/1.3 'Courier New', ui-monospace, monospace;
  pointer-events: auto;
  overscroll-behavior: contain;
}
.asteroid-tools-overlay,
.asteroid-tools-overlay * { box-sizing: border-box; }
.asteroid-tools-overlay[hidden],
.asteroid-tools-launcher[hidden] { display: none !important; }
.asteroid-tools-overlay__header,
.asteroid-tools-overlay__motion-grid { display: flex; gap: 0.4rem; }
.asteroid-tools-overlay__header {
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.45rem;
}
.asteroid-tools-overlay__close,
.asteroid-tools-launcher,
.asteroid-tools-overlay__motion-grid button {
  min-height: 2rem;
  padding: 0.32rem 0.48rem;
  border: 1px solid var(--tools-line);
  border-radius: 0.28rem;
  background: color-mix(in srgb, var(--palette-bg, #000011) 74%, transparent);
  color: var(--tools-bright);
  font: inherit;
  font-size: 0.66rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  touch-action: manipulation;
  user-select: none;
}
.asteroid-tools-overlay__close { flex: 0 0 auto; }
.asteroid-tools-launcher {
  position: absolute;
  z-index: 29;
  top: calc(5.5rem + env(safe-area-inset-top, 0px));
  left: max(0.5rem, env(safe-area-inset-left, 0px));
  border-color: var(--tools-accent);
  color: var(--tools-accent);
}
.asteroid-tools-overlay__title,
.asteroid-tools-overlay legend {
  margin: 0;
  color: var(--tools-accent);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.asteroid-tools-overlay__status {
  max-width: 62%;
  overflow: hidden;
  color: var(--palette-hud-muted, #64748b);
  font-size: 0.68rem;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asteroid-tools-overlay__section,
.asteroid-tools-overlay fieldset {
  min-width: 0;
  margin: 0.55rem 0 0;
  padding: 0.45rem;
  border: 1px solid color-mix(in srgb, var(--tools-line) 80%, transparent);
}
.asteroid-tools-overlay__target-label {
  display: grid;
  gap: 0.25rem;
  color: var(--palette-hud-muted, #64748b);
  font-size: 0.68rem;
}
.asteroid-tools-overlay__target {
  width: 100%;
  min-height: 2rem;
  padding: 0.3rem;
  border: 1px solid var(--tools-line);
  border-radius: 0.25rem;
  background: var(--palette-bg, #000011);
  color: var(--tools-bright);
  font: inherit;
  font-size: 0.7rem;
}
.asteroid-tools-overlay__preview,
.asteroid-tools-overlay__upgrade {
  display: grid;
  gap: 0.12rem;
  margin-top: 0.55rem;
  padding: 0.3rem 0.4rem;
  border-left: 2px solid var(--tools-cream);
  color: var(--palette-hud-muted, #64748b);
  font-size: 0.66rem;
}
.asteroid-tools-overlay__preview strong,
.asteroid-tools-overlay__upgrade strong {
  color: var(--tools-bright);
  font-size: 0.68rem;
  font-weight: 700;
}
.asteroid-tools-overlay__upgrade { border-left-color: var(--tools-amber); }
.asteroid-tools-overlay__motion-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.asteroid-tools-overlay__motion-grid button { min-width: 0; }
.asteroid-tools-overlay button:focus-visible,
.asteroid-tools-overlay select:focus-visible {
  outline: 2px solid var(--tools-cream);
  outline-offset: 2px;
}
.asteroid-tools-overlay button:disabled,
.asteroid-tools-overlay select:disabled { cursor: not-allowed; opacity: 0.4; }
@media (max-width: 520px) {
  .asteroid-tools-overlay {
    top: calc(5.5rem + env(safe-area-inset-top, 0px));
    right: max(0.35rem, env(safe-area-inset-right, 0px));
    width: min(18rem, calc(100vw - 0.7rem));
    max-height: min(70dvh, 34rem);
    padding: 0.5rem;
  }
}
@media (orientation: landscape) and (max-height: 500px) {
  .asteroid-tools-overlay {
    max-height: calc(100dvh - 6rem - env(safe-area-inset-top, 0px));
    width: min(20rem, calc(100vw - 0.7rem));
  }
}
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Accessible DOM companion for the canvas asteroid tools. */
export class AsteroidToolsOverlay {
  private readonly document: Document;
  private readonly callbacks: Partial<AsteroidToolsOverlayCallbacks>;
  private readonly root: HTMLElement;
  private readonly launcher: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly targetSelect: HTMLSelectElement;
  private readonly targetPlaceholder: HTMLOptionElement;
  private readonly preview: HTMLElement;
  private readonly upgrade: HTMLElement;
  private readonly motionFieldset: HTMLFieldSetElement;
  private readonly motionButtons = new Map<AsteroidToolsMotionAction, HTMLButtonElement>();
  private readonly targetOptions = new Map<string, HTMLOptionElement>();
  private previousSelectedTargetId?: string;
  private previousSelectedTargetPresent = false;
  private wasActive = false;
  private mounted = false;

  static mount(options: AsteroidToolsOverlayOptions = {}): AsteroidToolsOverlay {
    const overlay = new AsteroidToolsOverlay(options);
    overlay.mount(options.container);
    return overlay;
  }

  constructor(options: AsteroidToolsOverlayOptions = {}) {
    const doc = globalThis.document;
    if (!doc) {
      throw new Error('AsteroidToolsOverlay requires a browser document');
    }
    this.document = doc;
    this.callbacks = options.callbacks ?? {};
    ensureStyles(doc);

    this.root = doc.createElement('section');
    this.root.className = 'asteroid-tools-overlay';
    this.root.id = 'asteroid-tools-overlay';
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Asteroid tools');
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');

    this.launcher = createButton(doc, 'Tools', 'asteroid-tools-launcher', () => {
      this.callbacks.onOpen?.();
    });
    this.launcher.id = 'asteroid-tools-launcher';
    this.launcher.dataset['asteroidToolsAction'] = 'open';
    this.launcher.setAttribute('aria-label', 'Open asteroid tools');
    this.launcher.setAttribute('aria-expanded', 'false');

    const header = doc.createElement('header');
    header.className = 'asteroid-tools-overlay__header';
    const title = addText(doc.createElement('h2'), 'Asteroid tools');
    title.className = 'asteroid-tools-overlay__title';
    this.status = addText(doc.createElement('span'), 'Tools unavailable');
    this.status.className = 'asteroid-tools-overlay__status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    const closeButton = createButton(doc, 'Close', 'asteroid-tools-overlay__close', () => {
      this.callbacks.onClose?.();
    });
    closeButton.dataset['asteroidToolsAction'] = 'close';
    closeButton.setAttribute('aria-label', 'Close asteroid tools');
    header.append(title, this.status, closeButton);

    const targetSection = doc.createElement('section');
    targetSection.className = 'asteroid-tools-overlay__section';
    const targetLabel = addText(doc.createElement('label'), 'Target');
    targetLabel.className = 'asteroid-tools-overlay__target-label';
    this.targetSelect = doc.createElement('select');
    this.targetSelect.className = 'asteroid-tools-overlay__target';
    this.targetSelect.dataset['asteroidToolsTarget'] = 'true';
    this.targetSelect.setAttribute('aria-label', 'Asteroid target');
    this.targetPlaceholder = doc.createElement('option');
    this.targetPlaceholder.value = '';
    this.targetSelect.append(this.targetPlaceholder);
    this.targetSelect.addEventListener('change', () => {
      this.callbacks.onSelectTarget?.(this.targetSelect.value || undefined);
    });
    targetLabel.append(this.targetSelect);
    targetSection.append(targetLabel);

    this.preview = doc.createElement('div');
    this.preview.className = 'asteroid-tools-overlay__preview';
    this.preview.setAttribute('role', 'status');
    this.upgrade = doc.createElement('div');
    this.upgrade.className = 'asteroid-tools-overlay__upgrade';

    this.motionFieldset = doc.createElement('fieldset');
    const motionLegend = addText(doc.createElement('legend'), 'Hauler motion');
    this.motionFieldset.append(motionLegend);
    const motionGrid = doc.createElement('div');
    motionGrid.className = 'asteroid-tools-overlay__motion-grid';
    for (const action of ['latch', 'release', 'anchor', 'brake', 'spin'] as const) {
      const button = createButton(
        doc,
        MOTION_LABELS[action],
        'asteroid-tools-overlay__motion',
        () => {
          this.callbacks.onMotion?.(action);
        }
      );
      button.dataset['asteroidToolsMotion'] = action;
      button.setAttribute('aria-label', MOTION_HINTS[action]);
      this.motionButtons.set(action, button);
      motionGrid.append(button);
    }
    this.motionFieldset.append(motionGrid);

    this.root.append(header, targetSection, this.preview, this.upgrade, this.motionFieldset);
  }

  mount(container: HTMLElement | undefined = undefined): void {
    if (this.mounted) {
      return;
    }
    const parent = container ?? this.document.getElementById('gameArea') ?? this.document.body;
    parent.append(this.launcher, this.root);
    this.mounted = true;
  }

  update(state: AsteroidToolsState): void {
    const becameActive = state.active && !this.wasActive;
    const focusInsideBeforeUpdate = this.root.contains(this.document.activeElement);
    const becameInactive = !state.active && this.wasActive && focusInsideBeforeUpdate;
    this.root.hidden = !state.active;
    this.root.setAttribute('aria-hidden', state.active ? 'false' : 'true');
    this.launcher.hidden = state.active || state.pilot === undefined;
    this.launcher.setAttribute('aria-expanded', state.active ? 'true' : 'false');
    this.status.textContent = state.status;

    const alive = state.pilot?.alive !== false && state.pilot !== undefined;
    const selected = state.selectedTargetId !== undefined;
    this.renderTargets(state);
    const selectedTargetRemoved =
      state.selectedTargetId !== undefined && !this.targetOptions.has(state.selectedTargetId);
    const selectedTargetPresent =
      state.selectedTargetId !== undefined && this.targetOptions.has(state.selectedTargetId);
    const stateSelectionChanged = state.selectedTargetId !== this.previousSelectedTargetId;
    const selectedTargetReappeared = selectedTargetPresent && !this.previousSelectedTargetPresent;
    const shouldSyncSelection =
      stateSelectionChanged || selectedTargetRemoved || selectedTargetReappeared;
    if (shouldSyncSelection) {
      const nextValue = selectedTargetRemoved ? '' : (state.selectedTargetId ?? '');
      if (this.targetSelect.value !== nextValue) {
        this.targetSelect.value = nextValue;
      }
    }
    if (state.selectedTargetId !== undefined) {
      this.previousSelectedTargetId = state.selectedTargetId;
    } else {
      delete this.previousSelectedTargetId;
    }
    this.previousSelectedTargetPresent = selectedTargetPresent;
    this.targetSelect.disabled = !alive || state.targets.length === 0;

    this.preview.replaceChildren();
    if (state.reflectionPreview) {
      const heading = addText(this.document.createElement('strong'), 'Predicted bounce path');
      const detail = addText(
        this.document.createElement('span'),
        `${state.reflectionPreview.impacts.length} impact${state.reflectionPreview.impacts.length === 1 ? '' : 's'} · ${Math.round(state.reflectionPreview.traveledDistance)}m · ${previewTerminationLabel(state.reflectionPreview.termination)}`
      );
      this.preview.append(heading, detail);
      this.preview.hidden = false;
    } else {
      this.preview.hidden = true;
    }

    this.upgrade.replaceChildren();
    const laserUpgrade = state.pilot?.laserUpgrade;
    const now = Date.now();
    if (
      laserUpgrade &&
      laserUpgrade.charges > 0 &&
      Number.isFinite(laserUpgrade.expiresAt) &&
      laserUpgrade.expiresAt > now
    ) {
      const heading = addText(this.document.createElement('strong'), 'Laser upgrade');
      const remainingSeconds = Math.max(1, Math.ceil((laserUpgrade.expiresAt - now) / 1000));
      const detail = addText(
        this.document.createElement('span'),
        `${laserUpgrade.charges} charge${laserUpgrade.charges === 1 ? '' : 's'} · ${remainingSeconds}s remaining`
      );
      this.upgrade.append(heading, detail);
      this.upgrade.hidden = false;
    } else {
      this.upgrade.hidden = true;
    }

    const isHauler = state.pilot?.kitId === 'hauler';
    this.motionFieldset.hidden = !isHauler;
    this.motionFieldset.setAttribute('aria-hidden', isHauler ? 'false' : 'true');
    const mode = state.pilot?.asteroidMotion?.mode;
    for (const action of ['latch', 'release', 'anchor', 'brake', 'spin'] as const) {
      const button = this.motionButtons.get(action);
      if (!button) {
        continue;
      }
      const needsTarget =
        action === 'latch' ||
        action === 'anchor' ||
        (action === 'brake' && !state.pilot?.asteroidMotion?.payloadId);
      button.disabled =
        !alive ||
        !isHauler ||
        (needsTarget && !selected) ||
        (action !== 'latch' && mode !== 'latched' && mode !== 'released');
    }

    this.wasActive = state.active;
    if (becameActive) {
      this.focusFirstEnabledControl();
    } else if (becameInactive && !this.launcher.hidden) {
      this.launcher.focus();
    }
  }

  destroy(): void {
    this.launcher.remove();
    this.root.remove();
    this.targetOptions.clear();
    delete this.previousSelectedTargetId;
    this.previousSelectedTargetPresent = false;
    this.wasActive = false;
    this.mounted = false;
  }

  getElement(): HTMLElement {
    return this.root;
  }

  /** Update labels in place so a live pose snapshot cannot close a native
   * target picker or erase a selection between the user's pointerdown and
   * change events. Structural option work is limited to roster changes. */
  private renderTargets(state: AsteroidToolsState): void {
    this.targetPlaceholder.textContent =
      state.targets.length > 0 ? 'Select an asteroid…' : 'No asteroids in range';
    this.targetPlaceholder.disabled = state.targets.length > 0;

    const baseLabels = state.targets.map((target) => targetBaseLabel(target));
    const labelCounts = new Map<string, number>();
    for (const label of baseLabels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    const labelSeen = new Map<string, number>();
    const ids = new Set(state.targets.map((target) => target.id));
    for (const [id, option] of this.targetOptions) {
      if (!ids.has(id)) {
        option.remove();
        this.targetOptions.delete(id);
      }
    }

    for (const [index, target] of state.targets.entries()) {
      const baseLabel = baseLabels[index] ?? 'Asteroid';
      const seen = (labelSeen.get(baseLabel) ?? 0) + 1;
      labelSeen.set(baseLabel, seen);
      let option = this.targetOptions.get(target.id);
      if (!option) {
        option = this.document.createElement('option');
        option.value = target.id;
        this.targetOptions.set(target.id, option);
      }
      const ordinal = (labelCounts.get(baseLabel) ?? 0) > 1 ? ` · ${seen}` : '';
      option.textContent = `${baseLabel} · ${formatDistance(targetDistance(target, state.pilot))}${ordinal}`;
    }

    const currentIds = Array.from(this.targetSelect.options)
      .slice(1)
      .map((option) => option.value);
    const orderChanged =
      currentIds.length !== state.targets.length ||
      currentIds.some((id, index) => id !== state.targets[index]?.id);
    if (orderChanged) {
      this.targetSelect.append(this.targetPlaceholder);
      for (const target of state.targets) {
        const option = this.targetOptions.get(target.id);
        if (option) {
          this.targetSelect.append(option);
        }
      }
    }
  }

  private focusFirstEnabledControl(): void {
    const control = this.root.querySelector<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    );
    control?.focus();
  }
}
