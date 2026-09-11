import type { Player } from '../entities/player/Player';
import { PlayerManager } from '../entities/player/PlayerManager';
import { canvasManager } from '../rendering/canvas';
import { shouldUseTouchControls } from '../ui/viewportChrome';
import { logger } from '../utils/Logger';
import { controlSources, resetTouchSources } from './controlSources';
import { reconcilePlayerInput } from './keybindings';
import { readAbilityChrome, readShieldChrome } from './touchAbility';

const FIRE_ID = 'touch-fire';
const ABILITY_ID = 'touch-ability';
const SHIELD_ID = 'touch-shield';
const ROOT_ID = 'touch-controls';

let initialized = false;
let steerPointerId: number | null = null;
let firePointerId: number | null = null;
let abilityPointerId: number | null = null;
let shieldPointerId: number | null = null;
let abilityButton: HTMLElement | null = null;
let shieldButton: HTMLElement | null = null;
let lastAbilityChromeKey = '';
let lastShieldChromeKey = '';
let abilityPointerClickPending = false;
let shieldPointerClickPending = false;

export function setTouchHeading(player: Player, heading: number | null): void {
  controlSources.touchSteeringActive = heading !== null;
  controlSources.touchHeading = heading;
  controlSources.touchThrust = heading !== null;
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
  if (controlSources.touchSteeringActive) {
    reconcilePlayerInput(player);
  }
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
  const canvas = canvasManager.getCanvas();
  const fire = document.getElementById(FIRE_ID);
  const ability = document.getElementById(ABILITY_ID);
  const shield = document.getElementById(SHIELD_ID);
  const activeSteerPointerId = steerPointerId;
  const activeFirePointerId = firePointerId;
  const activeAbilityPointerId = abilityPointerId;
  const activeShieldPointerId = shieldPointerId;
  steerPointerId = null;
  firePointerId = null;
  abilityPointerId = null;
  shieldPointerId = null;
  abilityPointerClickPending = false;
  shieldPointerClickPending = false;
  releasePointerCapture(canvas, activeSteerPointerId);
  releasePointerCapture(fire, activeFirePointerId);
  releasePointerCapture(ability, activeAbilityPointerId);
  releasePointerCapture(shield, activeShieldPointerId);
  if (player) {
    setTouchHeading(player, null);
    setTouchFire(player, false);
  } else {
    resetTouchSources();
  }
  setFirePressed(false);
  setAbilityPressed(false);
  setShieldPressed(false);
}

function requireLocalPlayer(): Player | null {
  return PlayerManager.getInstance().getLocalPlayer();
}

function ensureTouchDom(): {
  root: HTMLElement;
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

  return { root, fire, ability, shield };
}

function onSteerPointerDown(ev: PointerEvent): void {
  const canvas = canvasManager.getCanvas();
  if (
    !canvas ||
    !isTouchChromeVisible() ||
    ev.pointerType !== 'touch' ||
    ev.target !== canvas ||
    steerPointerId !== null
  ) {
    return;
  }
  const player = requireLocalPlayer();
  if (!player || player.lives <= 0 || player.ship.exploding) {
    return;
  }
  ev.preventDefault();
  steerPointerId = ev.pointerId;
  canvas.setPointerCapture(ev.pointerId);
  moveSteering(ev);
}

function onSteerPointerMove(ev: PointerEvent): void {
  if (ev.pointerId !== steerPointerId) {
    return;
  }
  ev.preventDefault();
  moveSteering(ev);
}

function onSteerPointerUp(ev: PointerEvent): void {
  if (ev.pointerId !== steerPointerId) {
    return;
  }
  ev.preventDefault();
  steerPointerId = null;
  releasePointerCapture(canvasManager.getCanvas(), ev.pointerId);
  const player = requireLocalPlayer();
  if (player) {
    setTouchHeading(player, null);
  } else {
    controlSources.touchHeading = null;
    controlSources.touchThrust = false;
    controlSources.touchSteeringActive = false;
  }
}

function moveSteering(ev: PointerEvent): void {
  const player = requireLocalPlayer();
  const canvas = canvasManager.getCanvas();
  if (!player || !canvas) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const viewport = canvasManager.getViewportSize();
  const dx = ((ev.clientX - rect.left) * viewport.width) / rect.width - viewport.width / 2;
  const dy = ((ev.clientY - rect.top) * viewport.height) / rect.height - viewport.height / 2;
  // A touch exactly on the ship thrusts along its current heading.
  setTouchHeading(player, dx === 0 && dy === 0 ? player.ship.angle : Math.atan2(-dy, dx));
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

  const { fire, ability, shield } = ensureTouchDom();
  abilityButton = ability;
  shieldButton = shield;

  document.addEventListener('pointerdown', onSteerPointerDown, { passive: false, capture: true });
  document.addEventListener('pointermove', onSteerPointerMove, { passive: false });
  document.addEventListener('pointerup', onSteerPointerUp);
  document.addEventListener('pointercancel', onSteerPointerUp);
  document.addEventListener('lostpointercapture', onSteerPointerUp);

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
