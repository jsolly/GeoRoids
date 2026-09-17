import type { Player } from '../entities/player/Player';
import { PlayerManager } from '../entities/player/PlayerManager';
import { canvasManager } from '../rendering/canvasSurface';
import {
  isPointerOnLocalHauler,
  openShipSchematic,
  SHIP_SCHEMATIC_LONG_PRESS_MS,
} from '../ui/shipSchematic';
import { isShipSchematicOpen } from '../ui/shipSchematicState';
import { shouldUseTouchControls } from '../ui/viewportChrome';
import { logger } from '../utils/Logger';
import { controlSources, resetControlSources } from './controlSources';
import { reconcilePlayerInput } from './keybindings';
import { pointerHeadingFromCenter } from './pointerSteering';
import { readAbilityChrome } from './touchAbility';

const ABILITY_ID = 'touch-ability';
const BOOST_ID = 'touch-boost';
const ROOT_ID = 'touch-controls';

let initialized = false;
const TAP_MAX_MS = 220;
const TAP_SLOP_PX = 12;
let steerPointerId: number | null = null;
let steerHoldTimer: ReturnType<typeof setTimeout> | null = null;
let schematicHoldTimer: ReturnType<typeof setTimeout> | null = null;
let steerTap: { x: number; y: number; startedAt: number; canFire: boolean } | null = null;
let firePointerId: number | null = null;
let abilityPointerId: number | null = null;
let boostPointerId: number | null = null;
let abilityButton: HTMLElement | null = null;
let boostButton: HTMLElement | null = null;
let lastAbilityChromeKey = '';
let lastBoostChromeKey = '';

export function setTouchHeading(player: Player, heading: number | null): void {
  controlSources.pointerHeading = heading;
  reconcilePlayerInput(player);
}

export function setTouchFire(player: Player, held: boolean): void {
  if (isShipSchematicOpen()) {
    controlSources.touchFire = false;
    player.ship.canShoot = true;
    return;
  }
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
  if (isShipSchematicOpen() || player.lives <= 0 || player.ship.exploding) {
    return false;
  }
  return player.ship.activateAbility();
}

function triggerTouchBoost(player: Player): boolean {
  if (player.lives <= 0 || player.ship.exploding) {
    player.ship.boosting = false;
    return false;
  }
  return player.ship.toggleBoost();
}

export function tickTouchControls(player: Player): void {
  if (isTouchChromeVisible()) {
    syncAbilityChrome(player);
    syncBoostChrome(player);
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
  const root = document.querySelector<HTMLElement>(`#${ROOT_ID}`);
  if (root) {
    root.hidden = !use;
    root.setAttribute('aria-hidden', use ? 'false' : 'true');
  }
  if (!use) {
    resetTouchInteraction(requireLocalPlayer());
    lastAbilityChromeKey = '';
    lastBoostChromeKey = '';
    return;
  }

  const player = requireLocalPlayer();
  if (player) {
    reconcilePlayerInput(player);
    syncAbilityChrome(player);
    syncBoostChrome(player);
  } else {
    lastAbilityChromeKey = '';
    lastBoostChromeKey = '';
  }
}

function setAbilityPressed(pressed: boolean): void {
  document.querySelector(`#${ABILITY_ID}`)?.classList.toggle('is-pressed', pressed);
}

function setBoostPressed(pressed: boolean): void {
  document.querySelector(`#${BOOST_ID}`)?.classList.toggle('is-pressed', pressed);
}

function getAbilityButton(): HTMLElement | null {
  if (!abilityButton?.isConnected) {
    const next = document.querySelector<HTMLElement>(`#${ABILITY_ID}`);
    if (next !== abilityButton) {
      abilityButton = next;
      lastAbilityChromeKey = '';
    }
  }
  return abilityButton;
}

function getBoostButton(): HTMLElement | null {
  if (!boostButton?.isConnected) {
    const next = document.querySelector<HTMLElement>(`#${BOOST_ID}`);
    if (next !== boostButton) {
      boostButton = next;
      lastBoostChromeKey = '';
    }
  }
  return boostButton;
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

function syncBoostChrome(player: Player): void {
  const button = getBoostButton();
  if (!button) {
    return;
  }
  const alive = player.lives > 0 && player.ship.health > 0 && !player.ship.exploding;
  const active = alive && player.ship.boosting;
  const key = `${alive}|${active}`;
  if (key === lastBoostChromeKey) {
    return;
  }
  lastBoostChromeKey = key;
  button.textContent = 'BOOST';
  button.setAttribute('aria-label', active ? 'Stop boost' : 'Boost');
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.setAttribute('aria-disabled', alive ? 'false' : 'true');
  button.classList.toggle('is-active', active);
  button.classList.toggle('is-unavailable', !alive);
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

function clearSchematicHoldTimer(): void {
  if (schematicHoldTimer !== null) {
    clearTimeout(schematicHoldTimer);
    schematicHoldTimer = null;
  }
}

/** Clear every pointer source when the browser takes the gesture away. */
function resetTouchInteraction(player: Player | null): void {
  const canvas = canvasManager.getCanvas();
  const ability = document.querySelector<HTMLElement>(`#${ABILITY_ID}`);
  const boost = document.querySelector<HTMLElement>(`#${BOOST_ID}`);
  const activeSteerPointerId = steerPointerId;
  const activeFirePointerId = firePointerId;
  const activeAbilityPointerId = abilityPointerId;
  const activeBoostPointerId = boostPointerId;
  steerPointerId = null;
  clearSteerHoldTimer();
  clearSchematicHoldTimer();
  steerTap = null;
  firePointerId = null;
  abilityPointerId = null;
  boostPointerId = null;
  releasePointerCapture(canvas, activeSteerPointerId);
  releasePointerCapture(canvas, activeFirePointerId);
  releasePointerCapture(ability, activeAbilityPointerId);
  releasePointerCapture(boost, activeBoostPointerId);
  if (player) {
    setTouchHeading(player, null);
    setTouchFire(player, false);
  } else {
    resetControlSources();
  }
  setAbilityPressed(false);
  setBoostPressed(false);
}

function requireLocalPlayer(): Player | null {
  return PlayerManager.getInstance().getLocalPlayer();
}

function ensureTouchDom(): {
  root: HTMLElement;
  ability: HTMLElement;
  boost: HTMLElement;
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

  let ability = document.querySelector<HTMLElement>(`#${ABILITY_ID}`);
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

  let boost = document.querySelector<HTMLElement>(`#${BOOST_ID}`);
  if (!boost) {
    boost = document.createElement('button');
    boost.id = BOOST_ID;
    boost.className = 'touch-boost';
    boost.setAttribute('type', 'button');
    boost.setAttribute('aria-label', 'Boost');
    boost.setAttribute('aria-pressed', 'false');
    boost.setAttribute('aria-disabled', 'true');
    boost.textContent = 'BOOST';
    root.appendChild(boost);
  }
  boost.setAttribute('type', 'button');
  if (!boost.getAttribute('aria-label')) {
    boost.setAttribute('aria-label', 'Boost');
  }

  return { root, ability, boost };
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
    if (isPointerOnLocalHauler(ev.clientX, ev.clientY)) {
      schematicHoldTimer = setTimeout(() => {
        schematicHoldTimer = null;
        if (steerTap) {
          steerTap.canFire = false;
        }
        if (openShipSchematic()) {
          resetTouchInteraction(player);
        }
      }, SHIP_SCHEMATIC_LONG_PRESS_MS);
    }
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
  clearSchematicHoldTimer();
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
  clearSchematicHoldTimer();
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
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchAbility(player);
    syncAbilityChrome(player);
  }
  ev.stopPropagation();
}

function onBoostPointerDown(ev: PointerEvent, boost: HTMLElement): void {
  if (boostPointerId !== null) {
    return;
  }
  ev.preventDefault();
  if (steerTap) {
    steerTap.canFire = false;
  }
  boostPointerId = ev.pointerId;
  boost.setPointerCapture(ev.pointerId);
  setBoostPressed(true);
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchBoost(player);
    syncBoostChrome(player);
  }
}

function onBoostPointerUp(ev: PointerEvent, boost: HTMLElement): void {
  if (ev.pointerId !== boostPointerId) {
    return;
  }
  ev.preventDefault();
  boostPointerId = null;
  releasePointerCapture(boost, ev.pointerId);
  setBoostPressed(false);
}

function onBoostClick(ev: MouseEvent): void {
  if (ev.detail !== 0) {
    return;
  }
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchBoost(player);
    syncBoostChrome(player);
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

  const { ability, boost } = ensureTouchDom();
  abilityButton = ability;
  boostButton = boost;

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

  boost.addEventListener('pointerdown', (ev) => onBoostPointerDown(ev, boost));
  boost.addEventListener('pointerup', (ev) => onBoostPointerUp(ev, boost));
  boost.addEventListener('pointercancel', (ev) => onBoostPointerUp(ev, boost));
  boost.addEventListener('click', onBoostClick);
  boost.addEventListener('lostpointercapture', () => {
    if (boostPointerId !== null) {
      resetTouchInteraction(requireLocalPlayer());
    }
  });

  window.addEventListener('playViewOn', () => syncTouchChrome(true));
  window.addEventListener('playViewOff', () => syncTouchChrome(false));
  // A modal universe map can cover the playfield while the game keeps cruising.
  // Drop any active touch gesture before the dialog takes pointer ownership.
  window.addEventListener('gameMapOpen', () => resetTouchInteraction(requireLocalPlayer()));
  window.addEventListener('gameSchematicOpen', () => resetTouchInteraction(requireLocalPlayer()));
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
