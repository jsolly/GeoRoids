import type { Player } from '../entities/player/Player';
import { PlayerManager } from '../entities/player/PlayerManager';
import { shouldUseTouchControls } from '../ui/viewportChrome';
import { logger } from '../utils/Logger';
import { controlSources, resetTouchSources } from './controlSources';
import { reconcilePlayerInput } from './keybindings';
import { readAbilityChrome, readShieldChrome } from './touchAbility';
import { readStickSample, type StickSample } from './touchStick';

const STICK_ID = 'touch-stick';
const KNOB_ID = 'touch-stick-knob';
const FIRE_ID = 'touch-fire';
const ABILITY_ID = 'touch-ability';
const SHIELD_ID = 'touch-shield';
const ROOT_ID = 'touch-controls';

let initialized = false;
let stickPointerId: number | null = null;
let firePointerId: number | null = null;
let abilityPointerId: number | null = null;
let shieldPointerId: number | null = null;
let abilityButton: HTMLElement | null = null;
let shieldButton: HTMLElement | null = null;
let lastAbilityChromeKey = '';
let lastShieldChromeKey = '';
let abilityPointerClickPending = false;
let shieldPointerClickPending = false;

export function applyStickSample(player: Player, sample: StickSample | null): void {
  if (!sample?.aim) {
    controlSources.touchThrust = false;
    controlSources.touchHeading = null;
    controlSources.touchStickActive = false;
    reconcilePlayerInput(player);
    return;
  }

  controlSources.touchStickActive = true;
  controlSources.touchHeading = sample.heading;
  controlSources.touchThrust = sample.thrusting;
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

export function triggerTouchShield(player: Player): boolean {
  if (player.lives <= 0 || player.ship.exploding) {
    return false;
  }
  return player.ship.requestShieldToggle();
}

export function tickTouchControls(player: Player): void {
  if (isTouchChromeVisible()) {
    syncAbilityChrome(player);
    syncShieldChrome(player);
  }
  if (player.lives <= 0 || player.ship.exploding) {
    resetTouchInteraction(player);
    return;
  }
  if (controlSources.touchFire) {
    player.ship.shoot();
  }
  if (controlSources.touchStickActive) {
    reconcilePlayerInput(player);
  }
}

export function isTouchChromeVisible(): boolean {
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
    lastShieldChromeKey = '';
    return;
  }

  const player = requireLocalPlayer();
  if (player) {
    syncAbilityChrome(player);
    syncShieldChrome(player);
  } else {
    lastAbilityChromeKey = '';
    lastShieldChromeKey = '';
  }
}

function resetKnob(): void {
  const knob = document.getElementById(KNOB_ID);
  if (knob) {
    knob.style.transform = 'translate(-50%, -50%)';
  }
}

function setFirePressed(pressed: boolean): void {
  document.getElementById(FIRE_ID)?.classList.toggle('is-pressed', pressed);
}

function setAbilityPressed(pressed: boolean): void {
  document.getElementById(ABILITY_ID)?.classList.toggle('is-pressed', pressed);
}

function setShieldPressed(pressed: boolean): void {
  document.getElementById(SHIELD_ID)?.classList.toggle('is-pressed', pressed);
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

function getShieldButton(): HTMLElement | null {
  if (!shieldButton?.isConnected) {
    const next = document.getElementById(SHIELD_ID);
    if (next !== shieldButton) {
      shieldButton = next;
      lastShieldChromeKey = '';
    }
  }
  return shieldButton;
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

function syncShieldChrome(player: Player): void {
  const button = getShieldButton();
  if (!button) {
    return;
  }
  const state = readShieldChrome(player.ship);
  const key = `${state.ready}|${state.active}|${state.cooling}|${state.unavailable}|${state.cooldownRatio.toFixed(3)}`;
  if (key === lastShieldChromeKey) {
    return;
  }
  lastShieldChromeKey = key;
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

/** Clear every pointer source when the browser takes the gesture away. */
function resetTouchInteraction(player: Player | null): void {
  const stick = document.getElementById(STICK_ID);
  const fire = document.getElementById(FIRE_ID);
  const ability = document.getElementById(ABILITY_ID);
  const shield = document.getElementById(SHIELD_ID);
  const activeStickPointerId = stickPointerId;
  const activeFirePointerId = firePointerId;
  const activeAbilityPointerId = abilityPointerId;
  const activeShieldPointerId = shieldPointerId;
  stickPointerId = null;
  firePointerId = null;
  abilityPointerId = null;
  shieldPointerId = null;
  abilityPointerClickPending = false;
  shieldPointerClickPending = false;
  releasePointerCapture(stick, activeStickPointerId);
  releasePointerCapture(fire, activeFirePointerId);
  releasePointerCapture(ability, activeAbilityPointerId);
  releasePointerCapture(shield, activeShieldPointerId);
  if (player) {
    applyStickSample(player, null);
    setTouchFire(player, false);
  } else {
    resetTouchSources();
  }
  resetKnob();
  setFirePressed(false);
  setAbilityPressed(false);
  setShieldPressed(false);
}

function requireLocalPlayer(): Player | null {
  try {
    return PlayerManager.getInstance().getLocalPlayer();
  } catch (error: unknown) {
    logger.debug(
      'INPUT',
      'Touch controls ignored — no local player',
      error instanceof Error ? { message: error.message } : {}
    );
    return null;
  }
}

function ensureTouchDom(): {
  root: HTMLElement;
  stick: HTMLElement;
  knob: HTMLElement;
  fire: HTMLElement;
  ability: HTMLElement;
  shield: HTMLElement;
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

  let stick = document.getElementById(STICK_ID);
  if (!stick) {
    stick = document.createElement('div');
    stick.id = STICK_ID;
    stick.className = 'touch-stick';
    stick.setAttribute('role', 'slider');
    stick.setAttribute('aria-label', 'Steer and thrust');
    root.appendChild(stick);
  }

  let knob = document.getElementById(KNOB_ID);
  if (!knob) {
    knob = document.createElement('div');
    knob.id = KNOB_ID;
    knob.className = 'touch-stick-knob';
    stick.appendChild(knob);
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

  let shield = document.getElementById(SHIELD_ID);
  if (!shield) {
    shield = document.createElement('button');
    shield.id = SHIELD_ID;
    shield.className = 'touch-shield';
    shield.setAttribute('type', 'button');
    shield.setAttribute('aria-label', 'Shield bubble');
    shield.setAttribute('aria-disabled', 'true');
    shield.textContent = 'SHIELD';
    root.appendChild(shield);
  }
  shield.setAttribute('type', 'button');
  if (!shield.getAttribute('aria-label')) {
    shield.setAttribute('aria-label', 'Shield bubble');
  }

  let fire = document.getElementById(FIRE_ID);
  if (!fire) {
    fire = document.createElement('button');
    fire.id = FIRE_ID;
    fire.className = 'touch-fire';
    fire.setAttribute('type', 'button');
    fire.setAttribute('aria-label', 'Fire');
    fire.textContent = 'FIRE';
    root.appendChild(fire);
  }
  fire.setAttribute('type', 'button');
  if (!fire.getAttribute('aria-label')) {
    fire.setAttribute('aria-label', 'Fire');
  }

  return { root, stick, knob, fire, ability, shield };
}

function stickOrigin(stick: HTMLElement): { x: number; y: number } {
  const rect = stick.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function onStickPointerDown(ev: PointerEvent, stick: HTMLElement, knob: HTMLElement): void {
  if (stickPointerId !== null) {
    return;
  }
  ev.preventDefault();
  stickPointerId = ev.pointerId;
  stick.setPointerCapture(ev.pointerId);
  moveStick(ev, stick, knob);
}

function onStickPointerMove(ev: PointerEvent, stick: HTMLElement, knob: HTMLElement): void {
  if (ev.pointerId !== stickPointerId) {
    return;
  }
  ev.preventDefault();
  moveStick(ev, stick, knob);
}

function onStickPointerUp(ev: PointerEvent, stick: HTMLElement): void {
  if (ev.pointerId !== stickPointerId) {
    return;
  }
  ev.preventDefault();
  stickPointerId = null;
  releasePointerCapture(stick, ev.pointerId);
  resetKnob();
  const player = requireLocalPlayer();
  if (player) {
    applyStickSample(player, null);
  } else {
    resetTouchSources();
  }
}

function moveStick(ev: PointerEvent, stick: HTMLElement, knob: HTMLElement): void {
  const origin = stickOrigin(stick);
  const sample = readStickSample(ev.clientX, ev.clientY, origin.x, origin.y);
  knob.style.transform = `translate(calc(-50% + ${sample.knobX}px), calc(-50% + ${sample.knobY}px))`;
  const player = requireLocalPlayer();
  if (player) {
    applyStickSample(player, sample);
  }
}

function onFirePointerDown(ev: PointerEvent, fire: HTMLElement): void {
  if (firePointerId !== null) {
    return;
  }
  ev.preventDefault();
  firePointerId = ev.pointerId;
  fire.setPointerCapture(ev.pointerId);
  setFirePressed(true);
  const player = requireLocalPlayer();
  if (player) {
    setTouchFire(player, true);
  } else {
    controlSources.touchFire = true;
  }
}

function onFirePointerUp(ev: PointerEvent, fire: HTMLElement): void {
  if (ev.pointerId !== firePointerId) {
    return;
  }
  ev.preventDefault();
  firePointerId = null;
  releasePointerCapture(fire, ev.pointerId);
  setFirePressed(false);
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

function onShieldPointerDown(ev: PointerEvent, shield: HTMLElement): void {
  if (shieldPointerId !== null) {
    return;
  }
  ev.preventDefault();
  // Pointer activation already performs the action. Consume the follow-up
  // native click so a touch tap cannot toggle F twice.
  shieldPointerClickPending = true;
  shieldPointerId = ev.pointerId;
  shield.setPointerCapture(ev.pointerId);
  setShieldPressed(true);
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchShield(player);
    syncShieldChrome(player);
  }
}

function onShieldPointerUp(ev: PointerEvent, shield: HTMLElement): void {
  if (ev.pointerId !== shieldPointerId) {
    return;
  }
  ev.preventDefault();
  shieldPointerId = null;
  releasePointerCapture(shield, ev.pointerId);
  setShieldPressed(false);
  if (ev.type === 'pointercancel') {
    shieldPointerClickPending = false;
  } else {
    window.setTimeout(() => {
      shieldPointerClickPending = false;
    }, 0);
  }
}

function onShieldClick(ev: MouseEvent): void {
  if (shieldPointerClickPending) {
    shieldPointerClickPending = false;
    return;
  }
  const player = requireLocalPlayer();
  if (player) {
    triggerTouchShield(player);
    syncShieldChrome(player);
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

  const { stick, knob, fire, ability, shield } = ensureTouchDom();
  abilityButton = ability;
  shieldButton = shield;

  stick.addEventListener('pointerdown', (ev) => onStickPointerDown(ev, stick, knob));
  stick.addEventListener('pointermove', (ev) => onStickPointerMove(ev, stick, knob));
  stick.addEventListener('pointerup', (ev) => onStickPointerUp(ev, stick));
  stick.addEventListener('pointercancel', (ev) => onStickPointerUp(ev, stick));
  stick.addEventListener('lostpointercapture', () => {
    if (stickPointerId !== null) {
      resetTouchInteraction(requireLocalPlayer());
    }
  });

  fire.addEventListener('pointerdown', (ev) => onFirePointerDown(ev, fire));
  fire.addEventListener('pointerup', (ev) => onFirePointerUp(ev, fire));
  fire.addEventListener('pointercancel', (ev) => onFirePointerUp(ev, fire));
  fire.addEventListener('lostpointercapture', () => {
    if (firePointerId !== null) {
      resetTouchInteraction(requireLocalPlayer());
    }
  });

  ability.addEventListener('pointerdown', (ev) => onAbilityPointerDown(ev, ability));
  ability.addEventListener('pointerup', (ev) => onAbilityPointerUp(ev, ability));
  ability.addEventListener('pointercancel', (ev) => onAbilityPointerUp(ev, ability));
  ability.addEventListener('click', onAbilityClick);
  ability.addEventListener('lostpointercapture', () => {
    if (abilityPointerId !== null) {
      resetTouchInteraction(requireLocalPlayer());
    }
  });

  shield.addEventListener('pointerdown', (ev) => onShieldPointerDown(ev, shield));
  shield.addEventListener('pointerup', (ev) => onShieldPointerUp(ev, shield));
  shield.addEventListener('pointercancel', (ev) => onShieldPointerUp(ev, shield));
  shield.addEventListener('click', onShieldClick);
  shield.addEventListener('lostpointercapture', () => {
    if (shieldPointerId !== null) {
      resetTouchInteraction(requireLocalPlayer());
    }
  });

  window.addEventListener('playViewOn', () => syncTouchChrome(true));
  window.addEventListener('playViewOff', () => syncTouchChrome(false));
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
