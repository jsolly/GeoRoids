import type { Player } from '../entities/player/Player';
import { PlayerManager } from '../entities/player/PlayerManager';
import { canvasManager } from '../rendering/canvas';
import { shouldUseTouchControls } from '../ui/viewportChrome';
import { logger } from '../utils/Logger';
import { controlSources, resetControlSources } from './controlSources';
import { reconcilePlayerInput } from './keybindings';
import { pointerHeadingFromCenter } from './pointerSteering';
import { readAbilityChrome } from './touchAbility';

const ABILITY_ID = 'touch-ability';
const ROOT_ID = 'touch-controls';

let initialized = false;
const TAP_MAX_MS = 220;
const TAP_SLOP_PX = 12;
let steerPointerId: number | null = null;
let steerHoldTimer: ReturnType<typeof setTimeout> | null = null;
let steerTap: { x: number; y: number; startedAt: number; canFire: boolean } | null = null;
let firePointerId: number | null = null;
let abilityPointerId: number | null = null;
let abilityButton: HTMLElement | null = null;
let lastAbilityChromeKey = '';
let abilityPointerClickPending = false;

export function setTouchHeading(player: Player, heading: number | null): void {
  controlSources.pointerHeading = heading;
  reconcilePlayerInput(player);
}

export function setTouchFire(player: Player, held: boolean): void {
  if (!held) {
    controlSources.touchFire = false;
    player.ship.canShoot = true;
    return;
  }

  if (player.lives <= 0 || player.ship.exploding) {
    controlSources.touchFire = false;
    player.ship.canShoot = true;
    return;
  }

  controlSources.touchFire = true;
  player.ship.shoot();
}

export function triggerTouchAbility(player: Player): boolean {
  if (player.lives <= 0 || player.ship.exploding) {
    return false;
  }
  return player.ship.activateAbility();
}

export function tickTouchControls(player: Player): void {
  if (isTouchChromeVisible()) {
    syncAbilityChrome(player);
  }
  if (player.lives <= 0 || player.ship.exploding) {
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

export function syncTouchChrome(
  inPlay = typeof document !== 'undefined' && document.body.classList.contains('in-play')
): void {
  if (typeof document === 'undefined') {
    return;
  }

  const use = inPlay && shouldUseTouchControls();
  document.body.classList.toggle('touch-play', use);
  const root = document.getElementById(ROOT_ID);
  if (root) {
    root.hidden = !use;
    root.setAttribute('aria-hidden', use ? 'false' : 'true');
  }
  if (!use) {
    resetTouchInteraction(requireLocalPlayer());
    lastAbilityChromeKey = '';
    return;
  }

  const player = requireLocalPlayer();
  if (player) {
    reconcilePlayerInput(player);
    syncAbilityChrome(player);
  } else {
    lastAbilityChromeKey = '';
  }
}

function setAbilityPressed(pressed: boolean): void {
  document.getElementById(ABILITY_ID)?.classList.toggle('is-pressed', pressed);
}

function getAbilityButton(): HTMLElement | null {
  if (!abilityButton?.isConnected) {
    const next = document.getElementById(ABILITY_ID);
    if (next !== abilityButton) {
      abilityButton = next;
      lastAbilityChromeKey = '';
    }
  }
  return abilityButton;
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
  button.setAttribute('aria-disabled', state.ready ? 'false' : 'true');
  button.classList.toggle('is-ready', state.ready);
  button.classList.toggle('is-cooling', state.cooling && !state.active);
  button.classList.toggle('is-unavailable', state.unavailable);
  button.classList.toggle('is-active', state.active);
  button.style.setProperty('--action-cool', state.cooldownRatio.toFixed(3));
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
function resetTouchInteraction(player: Player | null): void {
  const canvas = canvasManager.getCanvas();
  const ability = document.getElementById(ABILITY_ID);
  const activeSteerPointerId = steerPointerId;
  const activeFirePointerId = firePointerId;
  const activeAbilityPointerId = abilityPointerId;
  steerPointerId = null;
  clearSteerHoldTimer();
  steerTap = null;
  firePointerId = null;
  abilityPointerId = null;
  abilityPointerClickPending = false;
  releasePointerCapture(canvas, activeSteerPointerId);
  releasePointerCapture(canvas, activeFirePointerId);
  releasePointerCapture(ability, activeAbilityPointerId);
  if (player) {
    setTouchHeading(player, null);
    setTouchFire(player, false);
  } else {
    resetControlSources();
  }
  setAbilityPressed(false);
}

function requireLocalPlayer(): Player | null {
  return PlayerManager.getInstance().getLocalPlayer();
}

function ensureTouchDom(): {
  root: HTMLElement;
  ability: HTMLElement;
} {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'touch-controls';
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);
  }

  let ability = document.getElementById(ABILITY_ID);
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

  return { root, ability };
}

function onPlayfieldPointerDown(ev: PointerEvent): void {
  const canvas = canvasManager.getCanvas();
  if (!canvas || !isTouchChromeVisible() || ev.pointerType !== 'touch' || ev.target !== canvas) {
    return;
  }
  const player = requireLocalPlayer();
  if (!player || player.lives <= 0 || player.ship.exploding) {
    return;
  }
  ev.preventDefault();
  reconcilePlayerInput(player);
  if (steerPointerId !== null) {
    if (steerTap) {
      moveSteering({ clientX: steerTap.x, clientY: steerTap.y });
    }
    clearSteerHoldTimer();
    steerTap = null;
    onFirePointerDown(ev, canvas);
    return;
  }
  steerPointerId = ev.pointerId;
  steerTap =
    firePointerId === null
      ? { x: ev.clientX, y: ev.clientY, startedAt: ev.timeStamp, canFire: true }
      : null;
  canvas.setPointerCapture(ev.pointerId);
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

function onPlayfieldPointerUp(ev: PointerEvent): void {
  if (ev.pointerId === firePointerId) {
    onFirePointerUp(ev);
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
  if (!player || !canvas) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  // CSS pixels keep the resting zone the same physical size at every device DPR.
  const dx = ev.clientX - rect.left - rect.width / 2;
  const dy = ev.clientY - rect.top - rect.height / 2;
  setTouchHeading(player, pointerHeadingFromCenter(dx, dy, player.ship.r));
}

function onFirePointerDown(ev: PointerEvent, canvas: HTMLCanvasElement): void {
  if (firePointerId !== null) {
    return;
  }
  ev.preventDefault();
  firePointerId = ev.pointerId;
  canvas.setPointerCapture(ev.pointerId);
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
  // Pointer activation already performs the action. Consume the follow-up
  // native click so a touch tap cannot activate E twice.
  if (steerTap) {
    steerTap.canFire = false;
  }
  abilityPointerClickPending = true;
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
  abilityPointerId = null;
  releasePointerCapture(ability, ev.pointerId);
  setAbilityPressed(false);
  if (ev.type === 'pointercancel') {
    abilityPointerClickPending = false;
  } else {
    // Browsers dispatch the compatibility click immediately after pointerup.
    // If a platform suppresses it, avoid carrying the dedup marker into the
    // next keyboard or programmatic activation.
    window.setTimeout(() => {
      abilityPointerClickPending = false;
    }, 0);
  }
}

function onAbilityClick(ev: MouseEvent): void {
  if (abilityPointerClickPending) {
    abilityPointerClickPending = false;
    return;
  }
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchAbility(player);
    syncAbilityChrome(player);
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

  const { ability } = ensureTouchDom();
  abilityButton = ability;

  document.addEventListener('pointerdown', onPlayfieldPointerDown, {
    passive: false,
    capture: true,
  });
  document.addEventListener('pointermove', onSteerPointerMove, { passive: false });
  document.addEventListener('pointerup', onPlayfieldPointerUp);
  document.addEventListener('pointercancel', onPlayfieldPointerUp);
  document.addEventListener('lostpointercapture', onPlayfieldPointerUp);

  ability.addEventListener('pointerdown', (ev) => onAbilityPointerDown(ev, ability));
  ability.addEventListener('pointerup', (ev) => onAbilityPointerUp(ev, ability));
  ability.addEventListener('pointercancel', (ev) => onAbilityPointerUp(ev, ability));
  ability.addEventListener('click', onAbilityClick);
  ability.addEventListener('lostpointercapture', () => {
    if (abilityPointerId !== null) {
      resetTouchInteraction(requireLocalPlayer());
    }
  });

  window.addEventListener('playViewOn', () => syncTouchChrome(true));
  window.addEventListener('playViewOff', () => syncTouchChrome(false));
  // A modal universe map can cover the playfield while the game keeps cruising.
  // Drop any active touch gesture before the dialog takes pointer ownership.
  window.addEventListener('gameMapOpen', () => resetTouchInteraction(requireLocalPlayer()));
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
