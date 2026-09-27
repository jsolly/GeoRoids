import type { Player } from '../entities/player/Player';
import { PlayerManager } from '../entities/player/PlayerManager';
import { canvasManager } from '../rendering/canvasSurface';
import { isShipSchematicOpen } from '../ui/shipSchematicState';
import { isTownStoreOpen } from '../ui/townStoreState';
import { isUniverseMapOpen } from '../ui/universeMap';
import { shouldUseTouchControls } from '../ui/viewportChrome';
import { logger } from '../utils/Logger';
import { controlSources, resetControlSources } from './controlSources';
import { reconcilePlayerInput, togglePlayerContourLock } from './keybindings';
import { pointerHeadingFromCenter } from './pointerSteering';
import { readAbilityChrome } from './touchAbility';

const ABILITY_ID = 'touch-ability';
const CONTOUR_LOCK_ID = 'touch-contour-lock';
const ROOT_ID = 'touch-controls';

let initialized = false;
const TAP_MAX_MS = 220;
const TAP_SLOP_PX = 12;
let steerPointerId: number | null = null;
let steerEpoch = 0;
let steerHoldTimer: ReturnType<typeof setTimeout> | null = null;
let steerTap: { x: number; y: number; startedAt: number; canFire: boolean } | null = null;
let firePointerId: number | null = null;
let abilityPointerId: number | null = null;
let contourLockPointerId: number | null = null;
let abilityButton: HTMLButtonElement | null = null;
let contourLockButton: HTMLButtonElement | null = null;
let lastAbilityChromeKey = '';
let lastContourLockChromeKey = '';
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
  if (isShipSchematicOpen() || isTownStoreOpen()) {
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
  if (
    isShipSchematicOpen() ||
    isTownStoreOpen() ||
    player.ship.health <= 0 ||
    player.ship.exploding
  ) {
    return false;
  }
  return player.ship.activateAbility();
}

function triggerTouchContourLock(player: Player): boolean {
  if (!isInPlay() || isContourLockMenuOpen() || player.ship.health <= 0 || player.ship.exploding) {
    syncContourLockChrome(player);
    return false;
  }
  const active = togglePlayerContourLock(player);
  syncContourLockChrome(player);
  return active;
}

export function tickTouchControls(player: Player): void {
  if (isInPlay()) {
    syncContourLockChrome(player);
    if (isTouchChromeVisible()) {
      syncAbilityChrome(player);
    }
  }
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
  return typeof document !== 'undefined' && document.body.classList.contains('touch-play');
}

function isInPlay(): boolean {
  return typeof document !== 'undefined' && document.body.classList.contains('in-play');
}

function isContourLockMenuOpen(): boolean {
  return isUniverseMapOpen() || isShipSchematicOpen() || isTownStoreOpen();
}

export function syncTouchChrome(
  inPlay = typeof document !== 'undefined' && document.body.classList.contains('in-play')
): void {
  if (typeof document === 'undefined') {
    return;
  }

  const use = inPlay && shouldUseTouchControls();
  document.body.classList.toggle('touch-play', use);
  const root = document.querySelector<HTMLElement>(`#${ROOT_ID}`);
  if (root) {
    root.hidden = !inPlay;
    root.setAttribute('aria-hidden', inPlay ? 'false' : 'true');
    root.classList.toggle('is-touch', use);
    root.classList.toggle('is-desktop', inPlay && !use);
  }
  if (!inPlay) {
    resetTouchInteraction(requireLocalPlayer());
    lastAbilityChromeKey = '';
    lastContourLockChromeKey = '';
    return;
  }

  if (!use) {
    // The desktop contourLock button shares this overlay, while touch steering and
    // firing must release their pointer sources as soon as touch chrome hides.
    resetTouchInteraction(requireLocalPlayer());
  }

  const player = requireLocalPlayer();
  if (player) {
    reconcilePlayerInput(player);
    if (use) {
      syncAbilityChrome(player);
    }
    syncContourLockChrome(player);
  } else {
    lastAbilityChromeKey = '';
    lastContourLockChromeKey = '';
  }
}

function setAbilityPressed(pressed: boolean): void {
  document.querySelector(`#${ABILITY_ID}`)?.classList.toggle('is-pressed', pressed);
}

function setContourLockPressed(pressed: boolean): void {
  document.querySelector(`#${CONTOUR_LOCK_ID}`)?.classList.toggle('is-pressed', pressed);
}

function getAbilityButton(): HTMLButtonElement | null {
  if (!abilityButton?.isConnected) {
    const next = document.querySelector<HTMLButtonElement>(`#${ABILITY_ID}`);
    if (next !== abilityButton) {
      abilityButton = next;
      lastAbilityChromeKey = '';
    }
  }
  return abilityButton;
}

function getContourLockButton(): HTMLButtonElement | null {
  if (!contourLockButton?.isConnected) {
    const next = document.querySelector<HTMLButtonElement>(`#${CONTOUR_LOCK_ID}`);
    if (next !== contourLockButton) {
      contourLockButton = next;
      lastContourLockChromeKey = '';
    }
  }
  return contourLockButton;
}

function syncAbilityChrome(player: Player): void {
  const button = getAbilityButton();
  if (!button) {
    return;
  }
  const state = readAbilityChrome(player.ship);
  const key = `${state.label}|${state.ready}|${state.active}|${state.cooling}|${state.unavailable}|${state.cooldownRatio.toFixed(3)}`;
  if (key === lastAbilityChromeKey) {
    return;
  }
  lastAbilityChromeKey = key;
  button.textContent = state.label;
  button.setAttribute('aria-label', state.name);
  button.title = state.name;
  button.setAttribute('aria-disabled', state.ready ? 'false' : 'true');
  button.classList.toggle('is-ready', state.ready);
  button.classList.toggle('is-cooling', state.cooling && !state.active);
  button.classList.toggle('is-unavailable', state.unavailable);
  button.classList.toggle('is-active', state.active);
  button.style.setProperty('--action-cool', state.cooldownRatio.toFixed(3));
}

function syncContourLockChrome(player: Player): void {
  const button = getContourLockButton();
  if (!button) {
    return;
  }
  const alive = player.ship.health > 0 && !player.ship.exploding;
  const menuOpen = isContourLockMenuOpen();
  const active = alive && player.ship.contourLocked;
  const ready = alive && !menuOpen && (active || player.ship.canLockContour());
  const disabled = !isInPlay() || !ready;
  const key = `${active}|${disabled}|${alive}|${menuOpen}`;
  if (key === lastContourLockChromeKey) {
    return;
  }
  lastContourLockChromeKey = key;
  const label = active
    ? 'Release lock'
    : !alive
      ? 'Contour Lock unavailable while the ship is destroyed'
      : menuOpen
        ? 'Contour Lock unavailable while a menu is open'
        : !ready
          ? 'Contour Lock unavailable: approach a contour'
          : 'Contour Lock: lock onto the nearest contour';
  button.textContent = active ? 'RELEASE LOCK' : 'CONTOUR LOCK';
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  button.disabled = disabled;
  button.title = label;
  button.classList.toggle('is-active', active);
  button.classList.toggle('is-unavailable', disabled);
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
  const canvas = canvasManager.getCanvas();
  const ability = document.querySelector<HTMLElement>(`#${ABILITY_ID}`);
  const contourLock = document.querySelector<HTMLElement>(`#${CONTOUR_LOCK_ID}`);
  const activeSteerPointerId = steerPointerId;
  const activeFirePointerId = firePointerId;
  const activeAbilityPointerId = abilityPointerId;
  const activeContourLockPointerId = contourLockPointerId;
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

function ensureTouchDom(): {
  root: HTMLElement;
  ability: HTMLButtonElement;
  contourLock: HTMLButtonElement;
} {
  let root = document.querySelector<HTMLElement>(`#${ROOT_ID}`);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'touch-controls';
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);
  }

  let ability = document.querySelector<HTMLButtonElement>(`#${ABILITY_ID}`);
  if (!ability) {
    ability = document.createElement('button');
    ability.id = ABILITY_ID;
    ability.className = 'touch-ability';
    ability.setAttribute('type', 'button');
    ability.setAttribute('aria-label', 'Ability');
    ability.setAttribute('aria-disabled', 'true');
    ability.textContent = 'E';
    root.appendChild(ability);
  }
  ability.setAttribute('type', 'button');
  if (!ability.getAttribute('aria-label')) {
    ability.setAttribute('aria-label', 'Ability');
  }

  let contourLock = document.querySelector<HTMLButtonElement>(`#${CONTOUR_LOCK_ID}`);
  if (!contourLock) {
    contourLock = document.createElement('button');
    contourLock.id = CONTOUR_LOCK_ID;
    contourLock.className = 'touch-contour-lock';
    contourLock.setAttribute('type', 'button');
    contourLock.setAttribute('aria-label', 'Contour Lock');
    contourLock.setAttribute('aria-pressed', 'false');
    contourLock.setAttribute('aria-disabled', 'true');
    contourLock.disabled = true;
    contourLock.textContent = 'CONTOUR LOCK';
    root.appendChild(contourLock);
  }
  contourLock.setAttribute('type', 'button');
  contourLock.disabled = true;
  if (!contourLock.getAttribute('aria-disabled')) {
    contourLock.setAttribute('aria-disabled', 'true');
  }
  if (!contourLock.getAttribute('aria-label')) {
    contourLock.setAttribute('aria-label', 'Contour Lock');
  }

  return { root, ability, contourLock };
}

function abandonSteerPointer(player: Player, canvas: HTMLCanvasElement | null): void {
  const previous = steerPointerId;
  steerPointerId = null;
  steerTouchId = null;
  clearSteerHoldTimer();
  steerTap = null;
  releasePointerCapture(canvas, previous);
  setTouchHeading(player, null);
}

function beginSteerPointer(ev: PointerEvent): void {
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
  const canvas = canvasManager.getCanvas();
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
  const tap =
    ev.type === 'pointerup' &&
    steerTap !== null &&
    steerTap.canFire &&
    ev.timeStamp - steerTap.startedAt <= TAP_MAX_MS &&
    Math.hypot(ev.clientX - steerTap.x, ev.clientY - steerTap.y) <= TAP_SLOP_PX;
  steerPointerId = null;
  steerTouchId = null;
  clearSteerHoldTimer();
  steerTap = null;
  releasePointerCapture(canvasManager.getCanvas(), ev.pointerId);
  const player = requireLocalPlayer();
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
  const canvas = canvasManager.getCanvas();
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
  releasePointerCapture(canvasManager.getCanvas(), ev.pointerId);
  const player = requireLocalPlayer();
  if (player) {
    setTouchFire(player, false);
  } else {
    controlSources.touchFire = false;
  }
}

function onAbilityPointerDown(ev: PointerEvent, ability: HTMLElement): void {
  if (abilityPointerId !== null) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  if (steerTap) {
    steerTap.canFire = false;
  }
  abilityPointerId = ev.pointerId;
  ability.setPointerCapture(ev.pointerId);
  setAbilityPressed(true);
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchAbility(player);
    syncAbilityChrome(player);
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
  if (ev.detail !== 0) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchAbility(player);
    syncAbilityChrome(player);
  }
}

function onContourLockPointerDown(ev: PointerEvent, contourLock: HTMLElement): void {
  if (contourLockPointerId !== null || contourLock.matches(':disabled')) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  if (steerTap) {
    steerTap.canFire = false;
  }
  contourLockPointerId = ev.pointerId;
  contourLock.setPointerCapture(ev.pointerId);
  setContourLockPressed(true);
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchContourLock(player);
    syncContourLockChrome(player);
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
    syncContourLockChrome(player);
  }
  ev.stopPropagation();
}

function resetIfPageIsInactive(): void {
  if (typeof document === 'undefined' || document.visibilityState === 'hidden') {
    resetTouchInteraction(requireLocalPlayer());
  }
}

export function initializeTouchControls(): void {
  if (initialized || typeof document === 'undefined') {
    return;
  }

  const { ability, contourLock } = ensureTouchDom();
  abilityButton = ability;
  contourLockButton = contourLock;

  document.addEventListener('pointerdown', onPlayfieldPointerDown, {
    passive: false,
    capture: true,
  });
  document.addEventListener('pointermove', onSteerPointerMove, { passive: false });
  document.addEventListener('pointerup', onPlayfieldPointerUp);
  document.addEventListener('pointercancel', onPlayfieldPointerUp);
  document.addEventListener('lostpointercapture', onPlayfieldPointerUp);
  document.addEventListener('touchstart', onTouchListChange, { capture: true, passive: true });
  document.addEventListener('touchend', onTouchListChange, { capture: true, passive: true });
  document.addEventListener('touchcancel', onTouchListChange, { capture: true, passive: true });

  ability.addEventListener('pointerdown', (ev) => onAbilityPointerDown(ev, ability));
  ability.addEventListener('pointerup', (ev) => onAbilityPointerUp(ev, ability));
  ability.addEventListener('pointercancel', (ev) => onAbilityPointerUp(ev, ability));
  ability.addEventListener('click', onAbilityClick);
  ability.addEventListener('lostpointercapture', () => {
    if (abilityPointerId !== null) {
      resetTouchInteraction(requireLocalPlayer());
    }
  });

  contourLock.addEventListener('pointerdown', (ev) => onContourLockPointerDown(ev, contourLock));
  contourLock.addEventListener('pointerup', (ev) => onContourLockPointerUp(ev, contourLock));
  contourLock.addEventListener('pointercancel', (ev) => onContourLockPointerUp(ev, contourLock));
  contourLock.addEventListener('click', onContourLockClick);
  contourLock.addEventListener('lostpointercapture', () => {
    if (contourLockPointerId !== null) {
      resetTouchInteraction(requireLocalPlayer());
    }
  });

  window.addEventListener('playViewOn', () => syncTouchChrome(true));
  window.addEventListener('playViewOff', () => syncTouchChrome(false));
  // A modal universe map can cover the playfield while the game keeps cruising.
  // Drop any active touch gesture before the dialog takes pointer ownership.
  window.addEventListener('gameMapOpen', () => {
    resetTouchInteraction(requireLocalPlayer());
    const player = requireLocalPlayer();
    if (player) {
      syncContourLockChrome(player);
    }
  });
  window.addEventListener('gameMapClose', () => {
    const player = requireLocalPlayer();
    if (player) {
      syncContourLockChrome(player);
    }
  });
  window.addEventListener('gameSchematicOpen', () => {
    resetTouchInteraction(requireLocalPlayer());
    const player = requireLocalPlayer();
    if (player) {
      syncContourLockChrome(player);
    }
  });
  window.addEventListener('gameSchematicClose', () => {
    const player = requireLocalPlayer();
    if (player) {
      syncContourLockChrome(player);
    }
  });
  window.addEventListener('resize', () => syncTouchChrome());
  window.addEventListener('orientationchange', () => {
    resetTouchInteraction(requireLocalPlayer());
    syncTouchChrome();
  });
  window.addEventListener('blur', () => resetTouchInteraction(requireLocalPlayer()));
  window.addEventListener('pagehide', () => resetTouchInteraction(requireLocalPlayer()));
  document.addEventListener('visibilitychange', resetIfPageIsInactive);
  window.visualViewport?.addEventListener('resize', () => syncTouchChrome());

  initialized = true;
  syncTouchChrome();
  logger.debug('INPUT', 'Touch controls initialized', {
    visible: isTouchChromeVisible(),
  });
}
