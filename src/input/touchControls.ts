import { getOpenGameOverlay, subscribeGameOverlay } from '../runtime/overlayState';

let listenerScope: AbortController | null = null;

import { playFeedback } from '../audio/feedbackSounds';
import type { Player } from '../entities/player/Player';
import { PlayerManager } from '../entities/player/PlayerManager';
import { canvasManager } from '../rendering/canvasSurface';
import { rotateVectorInto } from '../rendering/travelCamera';
import { logger } from '../utils/Logger';
import { controlSources, resetControlSources } from './controlSources';
import { reconcilePlayerInput, togglePlayerContourLock } from './keybindings';
import { pointerHeadingFromCenter } from './pointerSteering';
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
};

let inputHost: TouchInputHost | null = null;
let actionScope: AbortController | null = null;
let unsubscribeOverlay: (() => void) | null = null;

let initialized = false;
const TAP_MAX_MS = 220;
const TAP_SLOP_PX = 12;
let steerPointerId: number | null = null;
let steerEpoch = 0;
let steerHoldTimer: ReturnType<typeof setTimeout> | null = null;
let steerTap: { x: number; y: number; startedAt: number; canFire: boolean } | null = null;
let steerFlick: { x: number; y: number; startedAt: number; lockVersion: number } | null = null;
let firePointerId: number | null = null;
let abilityPointerId: number | null = null;
let contourLockPointerId: number | null = null;
let abilityButton: HTMLButtonElement | null = null;
let contourLockButton: HTMLButtonElement | null = null;
let abilityPressed = false;
let contourLockPressed = false;
const TOUCH_BIND_SLOP_PX = 40;
let touchListObserved = false;
const liveTouchPoints = new Map<number, { x: number; y: number }>();
let steerTouchId: number | null = null;
let steerClientX = 0;
let steerClientY = 0;

export type TouchControlDiagnostics = {
  pointerHeading: number | null;
  touchFire: boolean;
  steerPointerHeld: boolean;
  liveTouches: number | null;
};

function liveTouchCount(): number | null {
  return touchListObserved ? liveTouchPoints.size : null;
}

function resetTouchListTracking(): void {
  touchListObserved = false;
  liveTouchPoints.clear();
}

function touchIdNear(x: number, y: number): number | null {
  let best: number | null = null;
  let bestDist = TOUCH_BIND_SLOP_PX;
  for (const [id, point] of liveTouchPoints) {
    const dist = Math.hypot(point.x - x, point.y - y);
    if (dist <= bestDist) {
      best = id;
      bestDist = dist;
    }
  }
  return best;
}

function bindSteerTouch(): void {
  if (steerPointerId === null) {
    steerTouchId = null;
    return;
  }
  if (steerTouchId !== null) {
    // First bind wins. A missing id stays reserved so a nearby second finger
    // or a returning thumb cannot steal steer until the next pointerdown.
    return;
  }
  const nearby = touchIdNear(steerClientX, steerClientY);
  if (nearby !== null) {
    steerTouchId = nearby;
    return;
  }
  if (liveTouchPoints.has(steerPointerId)) {
    steerTouchId = steerPointerId;
  }
}

function syncLiveTouches(ev: TouchEvent): void {
  const touches = ev.touches;
  if (!touches || typeof touches.length !== 'number') {
    return;
  }
  touchListObserved = true;
  liveTouchPoints.clear();
  for (let i = 0; i < touches.length; i++) {
    const touch =
      typeof touches.item === 'function' ? touches.item(i) : (touches as unknown as Touch[])[i];
    if (touch) {
      liveTouchPoints.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }
  }
  bindSteerTouch();
}

/** iOS can drop pointerup after capture while the live touch list still tells the truth. */
function onTouchListChange(ev: TouchEvent): void {
  syncLiveTouches(ev);
  if (liveTouchPoints.size > 1) {
    steerFlick = null;
  }
  if (ev.type !== 'touchstart' && liveTouchPoints.size === 0) {
    resetTouchInteraction(requireLocalPlayer(), {
      forgetTouches: false,
    });
  }
}

export function readTouchControlDiagnostics(): TouchControlDiagnostics {
  return {
    pointerHeading: controlSources.pointerHeading,
    touchFire: controlSources.touchFire,
    steerPointerHeld: steerPointerId !== null,
    liveTouches: liveTouchCount(),
  };
}

export function setTouchHeading(player: Player, heading: number | null): void {
  controlSources.pointerHeading = player.ship.contourLocked ? null : heading;
  reconcilePlayerInput(player);
}

export function setTouchFire(player: Player, held: boolean): void {
  if (getOpenGameOverlay() !== null) {
    controlSources.touchFire = false;
    player.ship.canShoot = true;
    return;
  }
  if (!held) {
    controlSources.touchFire = false;
    player.ship.canShoot = true;
    return;
  }

  if (player.ship.health <= 0 || player.ship.exploding) {
    controlSources.touchFire = false;
    player.ship.canShoot = true;
    return;
  }

  controlSources.touchFire = true;
  player.ship.shoot();
}

export function triggerTouchAbility(player: Player): boolean {
  if (getOpenGameOverlay() !== null || player.ship.health <= 0 || player.ship.exploding) {
    return false;
  }
  return player.ship.activateAbility();
}

function triggerTouchContourLock(player: Player): boolean {
  if (!isInPlay() || isContourLockMenuOpen() || player.ship.health <= 0 || player.ship.exploding) {
    return false;
  }
  const active = togglePlayerContourLock(player);
  return active;
}

export function tickTouchControls(player: Player): void {
  if (player.ship.health <= 0 || player.ship.exploding) {
    resetTouchInteraction(player);
    return;
  }
  if (controlSources.touchFire) {
    player.ship.shoot();
  }
  reconcilePlayerInput(player);
}

function isTouchChromeVisible(): boolean {
  return isInPlay() && (inputHost?.readTouchMode() ?? false);
}

function isInPlay(): boolean {
  return inputHost?.readInPlay() ?? false;
}

function isContourLockMenuOpen(): boolean {
  return getOpenGameOverlay() !== null;
}

/** Read at the presentation cadence, never from the simulation frame. */
export function readActionControls(player: Player | null): ActionControlsView {
  const inPlay = isInPlay();
  const touchMode = inputHost?.readTouchMode() ?? false;
  const alive = player !== null && player.ship.health > 0 && !player.ship.exploding;
  const menuOpen = isContourLockMenuOpen();
  const active = alive && player.ship.contourLocked;
  const ready = alive && !menuOpen && (active || player.ship.canLockContour());
  const ability = player
    ? readAbilityChrome(player.ship)
    : {
        label: 'E',
        name: 'Ability',
        ready: false,
        active: false,
        cooling: false,
        unavailable: true,
        cooldownRatio: 0,
      };
  return {
    inPlay,
    touchMode,
    ability: {
      ...ability,
      cooldownRatio: Math.round(ability.cooldownRatio * 1000) / 1000,
      pressed: abilityPressed,
      disabled: !inPlay || !touchMode || menuOpen || !ability.ready,
    },
    contourLock: {
      label: active ? 'RELEASE LOCK' : 'CONTOUR LOCK',
      name: active
        ? 'Release lock'
        : !alive
          ? 'Contour Lock unavailable while the ship is destroyed'
          : menuOpen
            ? 'Contour Lock unavailable while a menu is open'
            : !ready
              ? 'Contour Lock unavailable: approach a contour'
              : 'Contour Lock: lock onto the nearest contour',
      active,
      disabled: !inPlay || !ready,
      pressed: contourLockPressed,
    },
  };
}

function syncTouchMode(): void {
  const player = requireLocalPlayer();
  if (!isTouchChromeVisible()) {
    resetTouchInteraction(player);
  }
  if (player && isInPlay()) {
    reconcilePlayerInput(player);
  }
  inputHost?.onActionState();
}

function setAbilityPressed(pressed: boolean): void {
  if (abilityPressed !== pressed) {
    abilityPressed = pressed;
    inputHost?.onActionState();
  }
}

function setContourLockPressed(pressed: boolean): void {
  if (contourLockPressed !== pressed) {
    contourLockPressed = pressed;
    inputHost?.onActionState();
  }
}

function releasePointerCapture(element: HTMLElement | null, pointerId: number | null): void {
  if (element && pointerId !== null && element.hasPointerCapture(pointerId)) {
    element.releasePointerCapture(pointerId);
  }
}

function clearSteerHoldTimer(): void {
  if (steerHoldTimer !== null) {
    clearTimeout(steerHoldTimer);
    steerHoldTimer = null;
  }
}

/** Clear every pointer source when the browser takes the gesture away. */
function resetTouchInteraction(player: Player | null, options?: { forgetTouches?: boolean }): void {
  const canvas = inputHost?.canvas ?? null;
  const ability = abilityButton;
  const contourLock = contourLockButton;
  const activeSteerPointerId = steerPointerId;
  const activeFirePointerId = firePointerId;
  const activeAbilityPointerId = abilityPointerId;
  const activeContourLockPointerId = contourLockPointerId;
  steerFlick = null;
  steerPointerId = null;
  steerTouchId = null;
  clearSteerHoldTimer();
  steerTap = null;
  firePointerId = null;
  abilityPointerId = null;
  contourLockPointerId = null;
  releasePointerCapture(canvas, activeSteerPointerId);
  releasePointerCapture(canvas, activeFirePointerId);
  releasePointerCapture(ability, activeAbilityPointerId);
  releasePointerCapture(contourLock, activeContourLockPointerId);
  if (player) {
    setTouchHeading(player, null);
    setTouchFire(player, false);
  } else {
    resetControlSources();
  }
  setAbilityPressed(false);
  setContourLockPressed(false);
  if (options?.forgetTouches !== false) {
    resetTouchListTracking();
  }
}

function requireLocalPlayer(): Player | null {
  return PlayerManager.getInstance().getLocalPlayer();
}

function abandonSteerPointer(player: Player, canvas: HTMLCanvasElement | null): void {
  const previous = steerPointerId;
  steerFlick = null;
  steerPointerId = null;
  steerTouchId = null;
  clearSteerHoldTimer();
  steerTap = null;
  releasePointerCapture(canvas, previous);
  setTouchHeading(player, null);
}

function beginSteerPointer(ev: PointerEvent): void {
  const ship = requireLocalPlayer()?.ship;
  steerFlick =
    ship?.contourLocked &&
    firePointerId === null &&
    abilityPointerId === null &&
    contourLockPointerId === null
      ? {
          x: ev.clientX,
          y: ev.clientY,
          startedAt: ev.timeStamp,
          lockVersion: ship.contourLockInputVersion,
        }
      : null;
  steerPointerId = ev.pointerId;
  steerEpoch = controlSources.steeringEpoch;
  steerClientX = ev.clientX;
  steerClientY = ev.clientY;
  bindSteerTouch();
  steerTap =
    firePointerId === null
      ? { x: ev.clientX, y: ev.clientY, startedAt: ev.timeStamp, canFire: true }
      : null;
  if (steerTap) {
    steerHoldTimer = setTimeout(() => {
      steerHoldTimer = null;
      steerTap = null;
      moveSteering(ev);
    }, TAP_MAX_MS);
  } else {
    moveSteering(ev);
  }
}

function reservedSteerHasNoLiveFinger(): boolean {
  if (steerPointerId === null || !touchListObserved) {
    return false;
  }
  bindSteerTouch();
  if (steerTouchId !== null) {
    return !liveTouchPoints.has(steerTouchId);
  }
  return liveTouchPoints.size > 0 && touchIdNear(steerClientX, steerClientY) === null;
}

function onPlayfieldPointerDown(ev: PointerEvent): void {
  const canvas = inputHost?.canvas ?? null;
  if (!canvas || !isTouchChromeVisible() || ev.pointerType !== 'touch' || ev.target !== canvas) {
    return;
  }
  const player = requireLocalPlayer();
  if (!player || player.ship.health <= 0 || player.ship.exploding) {
    return;
  }
  ev.preventDefault();
  reconcilePlayerInput(player);
  if (reservedSteerHasNoLiveFinger()) {
    abandonSteerPointer(player, canvas);
  }
  if (steerPointerId !== null) {
    steerFlick = null;
    if (steerTap) {
      moveSteering({ clientX: steerTap.x, clientY: steerTap.y });
    }
    clearSteerHoldTimer();
    steerTap = null;
    onFirePointerDown(ev);
    return;
  }
  beginSteerPointer(ev);
}

function onSteerPointerMove(ev: PointerEvent): void {
  if (ev.pointerId !== steerPointerId) {
    return;
  }
  ev.preventDefault();
  if (steerTap && Math.hypot(ev.clientX - steerTap.x, ev.clientY - steerTap.y) <= TAP_SLOP_PX) {
    return;
  }
  clearSteerHoldTimer();
  steerTap = null;
  moveSteering(ev);
}

function shouldIgnoreLostCapture(ev: PointerEvent): boolean {
  if (ev.type !== 'lostpointercapture') {
    return false;
  }
  const touches = liveTouchCount();
  return touches !== null && touches > 0;
}

function onPlayfieldPointerUp(ev: PointerEvent): void {
  if (ev.pointerId === firePointerId) {
    onFirePointerUp(ev);
    return;
  }
  if (shouldIgnoreLostCapture(ev) && ev.pointerId === steerPointerId) {
    return;
  }
  if (ev.pointerId !== steerPointerId) {
    return;
  }
  ev.preventDefault();
  const flick = steerFlick;
  const elapsed = flick ? ev.timeStamp - flick.startedAt : 0;
  const dx = flick ? ev.clientX - flick.x : 0;
  const dy = flick ? ev.clientY - flick.y : 0;
  const distance = Math.hypot(dx, dy);
  const player = requireLocalPlayer();
  const attempted =
    ev.type === 'pointerup' &&
    flick !== null &&
    elapsed > 0 &&
    elapsed <= TAP_MAX_MS &&
    distance >= 24 &&
    distance / elapsed >= 0.25 &&
    steerEpoch === controlSources.steeringEpoch &&
    player !== null &&
    player.ship.contourLockInputVersion === flick.lockVersion;
  const hopped =
    attempted &&
    player.ship.hopContour(
      rotateVectorInto({ x: 0, y: 0 }, dx, dy, -canvasManager.getCameraRotation())
    );
  if (attempted) {
    playFeedback(hopped ? 'contourFlickSuccess' : 'contourFlickBlocked');
  }
  const tap =
    !hopped &&
    ev.type === 'pointerup' &&
    steerTap?.canFire &&
    ev.timeStamp - steerTap.startedAt <= TAP_MAX_MS &&
    Math.hypot(ev.clientX - steerTap.x, ev.clientY - steerTap.y) <= TAP_SLOP_PX;
  steerFlick = null;
  steerPointerId = null;
  steerTouchId = null;
  clearSteerHoldTimer();
  steerTap = null;
  releasePointerCapture(inputHost?.canvas ?? null, ev.pointerId);
  if (player) {
    setTouchHeading(player, null);
    if (tap) {
      setTouchFire(player, true);
      setTouchFire(player, false);
    }
  } else {
    controlSources.pointerHeading = null;
  }
}

function moveSteering(ev: Pick<PointerEvent, 'clientX' | 'clientY'>): void {
  const player = requireLocalPlayer();
  const canvas = inputHost?.canvas ?? null;
  if (!player || !canvas || steerEpoch !== controlSources.steeringEpoch) {
    return;
  }
  steerClientX = ev.clientX;
  steerClientY = ev.clientY;
  bindSteerTouch();
  const rect = canvas.getBoundingClientRect();
  // CSS pixels keep the resting zone the same physical size at every device DPR.
  const dx = ev.clientX - rect.left - rect.width / 2;
  const dy = ev.clientY - rect.top - rect.height / 2;
  setTouchHeading(player, pointerHeadingFromCenter(dx, dy, player.ship.r));
}

function onFirePointerDown(ev: PointerEvent): void {
  if (firePointerId !== null) {
    return;
  }
  ev.preventDefault();
  firePointerId = ev.pointerId;
  const player = requireLocalPlayer();
  if (player) {
    setTouchFire(player, true);
  } else {
    controlSources.touchFire = true;
  }
}

function onFirePointerUp(ev: PointerEvent): void {
  if (ev.pointerId !== firePointerId) {
    return;
  }
  ev.preventDefault();
  firePointerId = null;
  releasePointerCapture(inputHost?.canvas ?? null, ev.pointerId);
  const player = requireLocalPlayer();
  if (player) {
    setTouchFire(player, false);
  } else {
    controlSources.touchFire = false;
  }
}

function onAbilityPointerDown(ev: PointerEvent, ability: HTMLElement): void {
  if (abilityPointerId !== null || !isTouchChromeVisible() || getOpenGameOverlay() !== null) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  if (steerTap) {
    steerTap.canFire = false;
  }
  steerFlick = null;
  abilityPointerId = ev.pointerId;
  ability.setPointerCapture(ev.pointerId);
  setAbilityPressed(true);
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchAbility(player);
    inputHost?.onActionState();
  }
}

function onAbilityPointerUp(ev: PointerEvent, ability: HTMLElement): void {
  if (ev.pointerId !== abilityPointerId) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  abilityPointerId = null;
  releasePointerCapture(ability, ev.pointerId);
  setAbilityPressed(false);
}

function onAbilityClick(ev: MouseEvent): void {
  // Pointer presses already activate on pointerdown. Their click can arrive
  // later; only keyboard/accessibility/programmatic clicks have no click count.
  if (ev.detail !== 0 || !isTouchChromeVisible()) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchAbility(player);
    inputHost?.onActionState();
  }
}

function onContourLockPointerDown(ev: PointerEvent, contourLock: HTMLElement): void {
  const player = requireLocalPlayer();
  if (contourLockPointerId !== null || readActionControls(player).contourLock.disabled) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  if (steerTap) {
    steerTap.canFire = false;
  }
  steerFlick = null;
  contourLockPointerId = ev.pointerId;
  contourLock.setPointerCapture(ev.pointerId);
  setContourLockPressed(true);
  if (player) {
    triggerTouchContourLock(player);
    inputHost?.onActionState();
  }
}

function onContourLockPointerUp(ev: PointerEvent, contourLock: HTMLElement): void {
  if (ev.pointerId !== contourLockPointerId) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  contourLockPointerId = null;
  releasePointerCapture(contourLock, ev.pointerId);
  setContourLockPressed(false);
}

function onContourLockClick(ev: MouseEvent): void {
  if (ev.detail !== 0) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchContourLock(player);
    inputHost?.onActionState();
  }
  ev.stopPropagation();
}

function resetIfPageIsInactive(): void {
  if (typeof document === 'undefined' || document.visibilityState === 'hidden') {
    resetTouchInteraction(requireLocalPlayer());
  }
}

export function initializeTouchControls(host: TouchInputHost): void {
  if (initialized || typeof document === 'undefined') {
    return;
  }
  inputHost = host;
  listenerScope = new AbortController();
  const { signal } = listenerScope;

  document.addEventListener('pointerdown', onPlayfieldPointerDown, {
    passive: false,
    capture: true,
    signal,
  });
  document.addEventListener('pointermove', onSteerPointerMove, { passive: false, signal });
  document.addEventListener('pointerup', onPlayfieldPointerUp, { signal });
  document.addEventListener('pointercancel', onPlayfieldPointerUp, { signal });
  document.addEventListener('lostpointercapture', onPlayfieldPointerUp, { signal });
  document.addEventListener('touchstart', onTouchListChange, {
    capture: true,
    passive: true,
    signal,
  });
  document.addEventListener('touchend', onTouchListChange, {
    capture: true,
    passive: true,
    signal,
  });
  document.addEventListener('touchcancel', onTouchListChange, {
    capture: true,
    passive: true,
    signal,
  });

  window.addEventListener('playViewOn', syncTouchMode, { signal });
  window.addEventListener('playViewOff', syncTouchMode, { signal });
  unsubscribeOverlay = subscribeGameOverlay((overlay) => {
    if (overlay !== null) {
      resetTouchInteraction(requireLocalPlayer());
    }
    inputHost?.onActionState();
  });
  window.addEventListener('resize', () => syncTouchMode(), { signal });
  window.addEventListener(
    'orientationchange',
    () => {
      resetTouchInteraction(requireLocalPlayer());
      syncTouchMode();
    },
    { signal }
  );
  window.addEventListener('blur', () => resetTouchInteraction(requireLocalPlayer()), { signal });
  window.addEventListener('pagehide', () => resetTouchInteraction(requireLocalPlayer()), {
    signal,
  });
  document.addEventListener('visibilitychange', resetIfPageIsInactive, { signal });
  window.visualViewport?.addEventListener('resize', () => syncTouchMode(), { signal });

  initialized = true;
  syncTouchMode();
  logger.debug('INPUT', 'Touch controls initialized', {
    visible: isTouchChromeVisible(),
  });
}

export function disposeTouchControls(): void {
  listenerScope?.abort();
  listenerScope = null;
  initialized = false;
  resetTouchInteraction(requireLocalPlayer(), { forgetTouches: true });
  unsubscribeOverlay?.();
  unsubscribeOverlay = null;
  inputHost = null;
}

/** Bind only the mounted Svelte action elements; TypeScript owns gesture capture. */
export function mountTouchActionControls(elements: TouchActionElements): () => void {
  actionScope?.abort();
  resetTouchInteraction(requireLocalPlayer());
  const scope = new AbortController();
  actionScope = scope;
  const { signal } = scope;
  const { ability, contourLock } = elements;
  abilityButton = ability;
  contourLockButton = contourLock;
  ability.addEventListener('pointerdown', (ev) => onAbilityPointerDown(ev, ability), { signal });
  ability.addEventListener('pointerup', (ev) => onAbilityPointerUp(ev, ability), { signal });
  ability.addEventListener('pointercancel', (ev) => onAbilityPointerUp(ev, ability), { signal });
  ability.addEventListener('click', onAbilityClick, { signal });
  ability.addEventListener(
    'lostpointercapture',
    () => {
      if (abilityPointerId !== null) {
        resetTouchInteraction(requireLocalPlayer());
      }
    },
    { signal }
  );

  contourLock.addEventListener('pointerdown', (ev) => onContourLockPointerDown(ev, contourLock), {
    signal,
  });
  contourLock.addEventListener('pointerup', (ev) => onContourLockPointerUp(ev, contourLock), {
    signal,
  });
  contourLock.addEventListener('pointercancel', (ev) => onContourLockPointerUp(ev, contourLock), {
    signal,
  });
  contourLock.addEventListener('click', onContourLockClick, { signal });
  contourLock.addEventListener(
    'lostpointercapture',
    () => {
      if (contourLockPointerId !== null) {
        resetTouchInteraction(requireLocalPlayer());
      }
    },
    { signal }
  );

  return () => {
    scope.abort();
    if (actionScope !== scope) {
      return;
    }
    resetTouchInteraction(requireLocalPlayer());
    abilityButton = null;
    contourLockButton = null;
    actionScope = null;
  };
}
