import { GAME, SHIP } from '../../shared/constants/gameplay';
import { PLAYER_SHIELD } from '../../shared/playerShield';
import { playFeedback } from '../audio/feedbackSounds';
import type { Player } from '../entities/player/Player';
import { PlayerManager } from '../entities/player/PlayerManager';
import { beginNavigation, stopNavigation } from '../entities/ship/navigation';
import { playLocalHaptic } from '../fx/haptics';
import { getOpenGameOverlay, subscribeGameOverlay } from '../runtime/overlayState';
import { controlSources, resetControlSources } from './controlSources';
import { reconcilePlayerInput, togglePlayerContourLock } from './keybindings';
import {
  actionsForTarget,
  chooseObjectAction,
  interactionTargets,
  type ObjectAction,
  type ObjectMenu,
  objectMenuAt,
  tickObjectApproach,
  worldPoint,
} from './objectActions';
import { steeringTurn } from './pointerSteering';
import { readAbilityChrome } from './touchAbility';

export type TouchInputHost = {
  canvas: HTMLCanvasElement;
  readInPlay: () => boolean;
  readTouchMode: () => boolean;
  onActionState: () => void;
};
export type TouchActionElements = {
  ability: HTMLButtonElement;
  contourLock: HTMLButtonElement;
  fire?: HTMLButtonElement;
  stop?: HTMLButtonElement;
  shield?: HTMLButtonElement;
};
export type ActionControlsView = {
  inPlay: boolean;
  touchMode: boolean;
  ability: ReturnType<typeof readAbilityChrome> & { pressed: boolean; disabled: boolean };
  contourLock: {
    label: string;
    name: string;
    active: boolean;
    disabled: boolean;
    pressed: boolean;
  };
  navigation?: { status: string; travelling: boolean };
  shield?: { active: boolean; ratio: number; disabled: boolean; seconds: number };
  menu?: ObjectMenu | null;
  holding?: boolean;
};
export type TouchControlDiagnostics = {
  pointerHeading: number | null;
  touchFire: boolean;
  steerPointerHeld: boolean;
  liveTouches: number | null;
};
type Gesture =
  | {
      kind: 'pending' | 'rotating' | 'moved' | 'menu';
      id: number;
      x: number;
      y: number;
      at: number;
      shipOrigin: boolean;
      lockVersion: number;
    }
  | { kind: 'shield'; ids: Set<number> };
let host: TouchInputHost | null = null;
let scope: AbortController | null = null;
let actionsScope: AbortController | null = null;
let unsubscribe: (() => void) | null = null;
let gesture: Gesture | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let fireTimer: ReturnType<typeof setTimeout> | null = null;
let firing: {
  id: number;
  x: number;
  y: number;
  at: number;
  charging: boolean;
  dragging: boolean;
} | null = null;
let menu: ObjectMenu | null = null;
let status = '';
let rotationHeading: number | null = null;
const captures = new Map<number, HTMLElement>();
let abilityPressed = false;
let contourPressed = false;
const live = new Set<number>();
const notify = () => host?.onActionState();
const player = () => PlayerManager.getInstance().getLocalPlayer();
function touchInputActive(): boolean {
  return Boolean(host?.readInPlay() && host.readTouchMode() && getOpenGameOverlay() === null);
}
function clearHold(): void {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
  }
  holdTimer = null;
}
function clearFire(): void {
  if (fireTimer !== null) {
    clearTimeout(fireTimer);
  }
  fireTimer = null;
}
function release(id: number): void {
  const element = captures.get(id);
  captures.delete(id);
  if (element?.hasPointerCapture?.(id)) {
    element.releasePointerCapture(id);
  }
}
function capture(element: HTMLElement, id: number): void {
  captures.set(id, element);
  element.setPointerCapture?.(id);
}
function reset(stop = true): void {
  clearHold();
  clearFire();
  const captured = [...captures.entries()];
  captures.clear();
  const p = player();
  p?.ship.finishWeaponCharge(false);
  if (p && stop) {
    stopNavigation(p.ship);
  }
  gesture = null;
  firing = null;
  menu = null;
  rotationHeading = null;
  live.clear();
  abilityPressed = false;
  contourPressed = false;
  resetControlSources();
  for (const [id, element] of captured) {
    if (element.hasPointerCapture?.(id)) {
      element.releasePointerCapture(id);
    }
  }
  notify();
}
export function setTouchHeading(p: Player, heading: number | null): void {
  controlSources.pointerHeading = p.ship.contourLocked ? null : heading;
  reconcilePlayerInput(p);
}
export function setTouchFire(p: Player, held: boolean): void {
  controlSources.touchFire =
    held && p.ship.health > 0 && !p.ship.exploding && getOpenGameOverlay() === null;
  if (controlSources.touchFire) {
    p.ship.shoot();
  } else {
    p.ship.canShoot = true;
  }
}
export function triggerTouchAbility(p: Player): boolean {
  return (
    getOpenGameOverlay() === null &&
    p.ship.health > 0 &&
    !p.ship.exploding &&
    p.ship.activateAbility()
  );
}
export function tickTouchControls(p: Player): void {
  if (p.ship.health <= 0 || p.ship.exploding) {
    reset();
    return;
  }
  if (host && (!host.readInPlay() || (!host.readTouchMode() && (gesture || firing)))) {
    reset();
  }
  reconcilePlayerInput(p);
  if (rotationHeading !== null) {
    p.ship.cargoHover = false;
    p.ship.angularVelocity = steeringTurn(
      p.ship.angle,
      rotationHeading,
      (SHIP.TURN_SPEED * Math.PI) / (180 * GAME.FPS)
    );
  }
  tickObjectApproach(p);
  if (p.ship.arrivalFrames === 12) {
    playLocalHaptic(true, 'pickup');
  }
}
export function readTouchControlDiagnostics(): TouchControlDiagnostics {
  return {
    pointerHeading: controlSources.pointerHeading,
    touchFire: controlSources.touchFire,
    steerPointerHeld: gesture !== null,
    liveTouches: live.size,
  };
}
export function readActionControls(p: Player | null): ActionControlsView {
  const alive = p !== null && p.ship.health > 0 && !p.ship.exploding;
  const ability = p
    ? readAbilityChrome(p.ship)
    : {
        label: 'Ability',
        name: 'Ability',
        ready: false,
        active: false,
        cooling: false,
        unavailable: true,
        cooldownRatio: 0,
      };
  const locked = Boolean(p?.ship.contourLocked);
  return {
    inPlay: host?.readInPlay() ?? false,
    touchMode: host?.readTouchMode() ?? false,
    ability: {
      ...ability,
      pressed: abilityPressed,
      disabled: !touchInputActive() || !ability.ready,
    },
    contourLock: {
      label: locked ? 'RELEASE LOCK' : 'CONTOUR LOCK',
      name: locked
        ? 'Release lock'
        : !alive
          ? 'Contour Lock unavailable while the ship is destroyed'
          : (p?.ship.canLockContour() ?? false) === false
            ? 'Contour Lock unavailable: approach a contour'
            : 'Contour Lock: lock onto the nearest contour',
      active: locked,
      disabled:
        !alive || getOpenGameOverlay() !== null || !(locked || (p?.ship.canLockContour() ?? false)),
      pressed: contourPressed,
    },
    navigation: {
      status:
        p?.ship.navigationStatus !== undefined && p.ship.navigationStatus.length > 0
          ? p.ship.navigationStatus
          : status,
      travelling: Boolean(p?.ship.navigation),
    },
    shield: {
      active: (p?.ship.shieldFrames ?? 0) > 0,
      seconds: Math.ceil(
        ((p?.ship.shieldFrames ?? 0) > 0
          ? (p?.ship.shieldFrames ?? 0)
          : (p?.ship.shieldCooldownFrames ?? 0)) / GAME.FPS
      ),
      ratio: (p?.ship.shieldCooldownFrames ?? 0) / PLAYER_SHIELD.cooldownFrames,
      disabled: !touchInputActive() || !alive || (p?.ship.shieldCooldownFrames ?? 0) > 0,
    },
    menu,
    holding: gesture?.kind === 'pending',
  };
}
export function activateObjectMenuAction(action: ObjectAction): void {
  const p = player();
  const selected = menu;
  if (!p || !selected?.actions.some((a) => a.action === action && !a.disabled)) {
    return;
  }
  const message = chooseObjectAction(p, selected.target, action);
  if (action === 'inspect' || action === 'signal') {
    status = message;
  } else {
    status = '';
    p.ship.navigationStatus = message;
  }
  menu = null;
  notify();
}
export function dismissObjectMenu(): void {
  menu = null;
  notify();
}
/** Keyboard pilots can inspect and cycle the same visible targets as a long press. */
export function cycleObjectMenuTarget(): void {
  const p = player();
  if (
    !p ||
    p.ship.health <= 0 ||
    p.ship.exploding ||
    !host?.readInPlay() ||
    getOpenGameOverlay() !== null
  ) {
    return;
  }
  const targets = interactionTargets(p);
  const index = targets.findIndex((candidate) => candidate.id === menu?.target.id);
  const target = targets[index + 1] ?? targets[0];
  if (!target) {
    status = 'No visible objects';
    menu = null;
  } else {
    const rect = host.canvas.getBoundingClientRect();
    menu = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      target,
      actions: actionsForTarget(p, target),
    };
  }
  notify();
}
function down(ev: PointerEvent): void {
  if (!touchInputActive() || ev.pointerType !== 'touch' || ev.target !== host?.canvas) {
    return;
  }
  const p = player();
  if (!p || p.ship.health <= 0 || p.ship.exploding) {
    return;
  }
  ev.preventDefault();
  live.add(ev.pointerId);
  capture(host.canvas, ev.pointerId);
  if (gesture) {
    clearHold();
    menu = null;
    rotationHeading = null;
    const ids = gesture.kind === 'shield' ? gesture.ids : new Set([gesture.id]);
    ids.add(ev.pointerId);
    if (gesture.kind !== 'shield') {
      p.ship.activateShield();
    }
    gesture = { kind: 'shield', ids };
    notify();
    return;
  }
  menu = null;
  status = '';
  const pos = worldPoint(p, ev.clientX, ev.clientY);
  gesture = {
    kind: 'pending',
    id: ev.pointerId,
    x: ev.clientX,
    y: ev.clientY,
    at: ev.timeStamp,
    shipOrigin: Math.hypot(pos.x - p.ship.position.x, pos.y - p.ship.position.y) <= p.ship.r,
    lockVersion: p.ship.contourLockInputVersion,
  };
  holdTimer = setTimeout(() => {
    if (gesture?.kind !== 'pending') {
      return;
    }
    gesture.kind = 'menu';
    menu = objectMenuAt(p, ev.clientX, ev.clientY);
    notify();
  }, 450);
  notify();
}
function move(ev: PointerEvent): void {
  const p = player();
  if (!p) {
    return;
  }
  if (firing?.id === ev.pointerId) {
    if (Math.hypot(ev.clientX - firing.x, ev.clientY - firing.y) > 12) {
      if (!firing.dragging) {
        stopNavigation(p.ship);
        firing.dragging = true;
      }
      rotationHeading = Math.atan2(-(ev.clientY - firing.y), ev.clientX - firing.x);
    }
    return;
  }
  const g = gesture;
  if (!g || g.kind === 'shield' || g.id !== ev.pointerId || g.kind === 'menu') {
    return;
  }
  if (Math.hypot(ev.clientX - g.x, ev.clientY - g.y) <= 12) {
    return;
  }
  clearHold();
  if (g.shipOrigin) {
    if (g.kind !== 'rotating') {
      stopNavigation(p.ship);
    }
    g.kind = 'rotating';
    const point = worldPoint(p, ev.clientX, ev.clientY);
    rotationHeading = Math.atan2(-(point.y - p.ship.position.y), point.x - p.ship.position.x);
  } else {
    g.kind = 'moved';
  }
  notify();
}
function up(ev: PointerEvent): void {
  live.delete(ev.pointerId);
  // Release capture after state transitions to avoid replaying pointer completion.
  queueMicrotask(() => release(ev.pointerId));
  if (firing?.id === ev.pointerId) {
    const f = firing;
    firing = null;
    clearFire();
    rotationHeading = null;
    const p = player();
    if (p) {
      if (f.charging) {
        p.ship.finishWeaponCharge(ev.type === 'pointerup');
      } else if (
        ev.type === 'pointerup' &&
        touchInputActive() &&
        p.ship.health > 0 &&
        !p.ship.exploding
      ) {
        p.ship.shoot();
      }
    }
    notify();
    return;
  }
  const g = gesture;
  if (!g) {
    return;
  }
  if (g.kind === 'shield') {
    g.ids.delete(ev.pointerId);
    if (!g.ids.size) {
      gesture = null;
    }
    return;
  }
  if (g.id !== ev.pointerId) {
    return;
  }
  clearHold();
  gesture = null;
  rotationHeading = null;
  if (ev.type !== 'pointerup' || !touchInputActive()) {
    menu = null;
    notify();
    return;
  }
  const p = player();
  if (!p) {
    return;
  }
  if (p.ship.contourLockInputVersion !== g.lockVersion) {
    menu = null;
    notify();
    return;
  }
  const duration = ev.timeStamp - g.at;
  const dx = ev.clientX - g.x,
    dy = ev.clientY - g.y;
  const distance = Math.hypot(dx, dy);
  if (g.kind === 'menu') {
    const element = document
      .elementFromPoint(ev.clientX, ev.clientY)
      ?.closest<HTMLElement>('[data-object-action]');
    const action = menu?.actions.find((a) => a.action === element?.dataset['objectAction']);
    if (action) {
      activateObjectMenuAction(action.action);
    } else if (distance > 12) {
      dismissObjectMenu();
    }
  } else if (g.kind === 'pending' && duration <= 220 && distance <= 12) {
    stopNavigation(p.ship);
    beginNavigation(p.ship, worldPoint(p, ev.clientX, ev.clientY));
  } else if (g.kind === 'moved') {
    if (p.ship.contourLocked) {
      if (
        duration > 0 &&
        duration <= 220 &&
        distance >= 24 &&
        distance / duration >= 0.25 &&
        p.ship.contourLockInputVersion === g.lockVersion
      ) {
        const hopped = p.ship.hopContour({ x: dx, y: dy });
        playFeedback(hopped ? 'contourFlickSuccess' : 'contourFlickBlocked');
      }
    } else if (duration <= 350 && distance >= 40) {
      triggerTouchAbility(p);
    }
  }
  notify();
}
export function initializeTouchControls(input: TouchInputHost): void {
  disposeTouchControls();
  host = input;
  scope = new AbortController();
  const signal = scope.signal;
  document.addEventListener(
    'keydown',
    (ev) => {
      if (!host?.readInPlay() || getOpenGameOverlay() !== null) {
        return;
      }
      if (ev.code === 'Escape' && menu) {
        ev.preventDefault();
        dismissObjectMenu();
      } else if (
        ev.code === 'KeyO' &&
        !ev.repeat &&
        !(
          ev.target instanceof Element &&
          ev.target.closest('input, textarea, select, button, summary, a[href], [contenteditable]')
        )
      ) {
        ev.preventDefault();
        cycleObjectMenuTarget();
      }
    },
    { signal }
  );
  document.addEventListener('pointerdown', down, { capture: true, passive: false, signal });
  document.addEventListener('pointermove', move, { passive: false, signal });
  document.addEventListener('pointerup', up, { signal });
  document.addEventListener('pointercancel', up, { signal });
  document.addEventListener(
    'lostpointercapture',
    (ev) => {
      if (live.has(ev.pointerId)) {
        return;
      }
      up(ev);
    },
    { signal }
  );
  document.addEventListener(
    'touchend',
    (ev) => {
      if (ev.touches.length === 0) {
        gesture = null;
        live.clear();
        clearHold();
        rotationHeading = null;
        if (firing) {
          const id = firing.id;
          firing = null;
          clearFire();
          player()?.ship.finishWeaponCharge(false);
          release(id);
        }
        for (const id of [...captures.keys()]) {
          release(id);
        }
      }
    },
    { signal }
  );
  document.addEventListener('touchcancel', () => reset(), { signal });
  for (const event of ['blur', 'pagehide', 'playViewOff', 'orientationchange']) {
    window.addEventListener(event, () => reset(), { signal });
  }
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) {
        reset();
      }
    },
    { signal }
  );
  unsubscribe = subscribeGameOverlay((overlay) => {
    if (overlay !== null) {
      reset();
    }
  });
  notify();
}
export function disposeTouchControls(): void {
  scope?.abort();
  actionsScope?.abort();
  unsubscribe?.();
  unsubscribe = null;
  if (host) {
    reset();
  }
  host = null;
  scope = null;
  actionsScope = null;
}
export function mountTouchActionControls(elements: TouchActionElements): () => void {
  actionsScope?.abort();
  const owner = new AbortController();
  actionsScope = owner;
  const signal = owner.signal;
  const bindButton = (
    element: HTMLButtonElement | undefined,
    run: () => void,
    pressed: (value: boolean) => void
  ) => {
    let held: number | null = null;
    element?.addEventListener(
      'pointerdown',
      (ev) => {
        if (!touchInputActive() && element !== elements.contourLock) {
          return;
        }
        if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        held = ev.pointerId;
        capture(element, ev.pointerId);
        pressed(true);
        run();
        notify();
      },
      { signal }
    );
    const finish = (ev: PointerEvent) => {
      if (held !== ev.pointerId) {
        return;
      }
      held = null;
      pressed(false);
      release(ev.pointerId);
      notify();
    };
    element?.addEventListener('pointerup', finish, { signal });
    element?.addEventListener('pointercancel', finish, { signal });
    element?.addEventListener('lostpointercapture', finish, { signal });
    element?.addEventListener(
      'click',
      (ev) => {
        ev.stopPropagation();
        if (ev.detail === 0 && (touchInputActive() || element === elements.contourLock)) {
          run();
          notify();
        }
      },
      { signal }
    );
  };
  bindButton(
    elements.ability,
    () => {
      const p = player();
      if (p) {
        triggerTouchAbility(p);
      }
    },
    (v) => {
      abilityPressed = v;
    }
  );
  bindButton(
    elements.contourLock,
    () => {
      const p = player();
      if (p && !readActionControls(p).contourLock.disabled) {
        togglePlayerContourLock(p);
      }
    },
    (v) => {
      contourPressed = v;
    }
  );
  bindButton(
    elements.stop,
    () => {
      const p = player();
      if (p) {
        stopNavigation(p.ship);
        p.ship.navigationStatus = '';
        status = '';
      }
    },
    () => {}
  );
  bindButton(
    elements.shield,
    () => player()?.ship.activateShield(),
    () => {}
  );
  elements.fire?.addEventListener(
    'pointerdown',
    (ev) => {
      if (!touchInputActive() || firing) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const p = player();
      if (!p || p.ship.health <= 0) {
        return;
      }
      if (elements.fire) {
        capture(elements.fire, ev.pointerId);
      }
      firing = {
        id: ev.pointerId,
        x: ev.clientX,
        y: ev.clientY,
        at: ev.timeStamp,
        charging: false,
        dragging: false,
      };
      fireTimer = setTimeout(() => {
        if (firing) {
          firing.charging = true;
          p.ship.beginWeaponCharge();
        }
      }, 220);
    },
    { signal }
  );
  elements.fire?.addEventListener(
    'lostpointercapture',
    (ev) => {
      if (firing?.id === ev.pointerId) {
        clearFire();
        firing = null;
        rotationHeading = null;
        player()?.ship.finishWeaponCharge(false);
      }
    },
    { signal }
  );
  elements.fire?.addEventListener(
    'click',
    (ev) => {
      if (ev.detail === 0 && touchInputActive()) {
        player()?.ship.shoot();
      }
    },
    { signal }
  );
  return () => {
    owner.abort();
    if (actionsScope === owner) {
      reset();
      actionsScope = null;
    }
  };
}

export function selectedObjectId(): string | null {
  return menu?.target.id ?? null;
}
