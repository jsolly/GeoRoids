import { debugIsOn, setDebugPreference } from '../constants/user-preferences';
import { getClientLogContext } from '../utils/clientLogContext';
import { attachEventListener } from '../utils/dom';
import { syncDebugHudVisibility } from './debugHud';

const COPY_LABEL = 'Copy';
const COPIED_LABEL = 'Copied';
const PLAYER_ID_PENDING = 'Available after Enter Game';
const copyResetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

let listenersBound = false;
let confirmedPlayerId = '';

function setHidden(element: HTMLElement | null, hidden: boolean): void {
  if (element) {
    element.hidden = hidden;
  }
}

function copyAriaLabel(button: HTMLButtonElement, copied: boolean): string {
  const target = button.dataset['copyName']?.trim();
  if (!target) {
    return copied ? COPIED_LABEL : COPY_LABEL;
  }
  return copied ? `Copied ${target}` : `Copy ${target}`;
}

async function copyText(value: string, input?: HTMLInputElement | null): Promise<boolean> {
  if (!value) {
    return false;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the select-all path when the clipboard API is blocked.
  }
  if (!input) {
    return false;
  }
  input.focus();
  input.select();
  input.setSelectionRange(0, input.value.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

function flashCopied(button: HTMLButtonElement | null): void {
  if (!button) {
    return;
  }
  const existing = copyResetTimers.get(button);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  button.textContent = COPIED_LABEL;
  button.setAttribute('aria-label', copyAriaLabel(button, true));
  copyResetTimers.set(
    button,
    setTimeout(() => {
      button.textContent = COPY_LABEL;
      button.setAttribute('aria-label', copyAriaLabel(button, false));
      copyResetTimers.delete(button);
    }, 1400)
  );
}

function selectReadableId(input: HTMLInputElement): void {
  if (!input.value) {
    return;
  }
  input.select();
  input.setSelectionRange(0, input.value.length);
}

export function applyDebugPreference(enabled: boolean): void {
  setDebugPreference(enabled);
  if (typeof document === 'undefined') {
    return;
  }
  document.body.classList.toggle('debug-on', enabled);
  const checkbox = document.querySelector<HTMLInputElement>('#debugPref');
  if (checkbox) {
    checkbox.checked = enabled;
  }
  const details = document.querySelector<HTMLDetailsElement>('#advanced-settings');
  if (details && enabled) {
    details.open = true;
  }
  setHidden(document.querySelector('#debug-identity'), !enabled);
  syncDebugIdentity();
  syncDebugHudVisibility();
  if (enabled) {
    document.querySelector('#debug-identity')?.scrollIntoView?.({ block: 'nearest' });
  }
}

function syncDebugIdentity(override?: { playerId?: string; sessionId?: string }): void {
  if (typeof document === 'undefined') {
    return;
  }
  const sessionId = override?.sessionId ?? getClientLogContext().sessionId;
  const playerId = override?.playerId ?? confirmedPlayerId;
  const playerInput = document.querySelector<HTMLInputElement>('#debug-player-id');
  const sessionInput = document.querySelector<HTMLInputElement>('#debug-session-id');
  const copyPlayer = document.querySelector<HTMLButtonElement>('#copy-debug-player-id');
  const chipId = document.querySelector('#debug-play-chip-id');
  const chipCopy = document.querySelector<HTMLButtonElement>('#copy-debug-play-chip');
  const debugOn = document.body.classList.contains('debug-on');
  const inPlay = document.body.classList.contains('in-play');

  if (sessionInput) {
    sessionInput.value = sessionId;
  }
  if (playerInput) {
    playerInput.value = playerId;
    playerInput.placeholder = playerId ? '' : PLAYER_ID_PENDING;
  }
  if (copyPlayer) {
    copyPlayer.disabled = !playerId;
  }
  if (chipId) {
    chipId.textContent = playerId;
  }
  if (chipCopy) {
    chipCopy.disabled = !playerId;
  }
  setHidden(document.querySelector('#debug-play-chip'), !(debugOn && inPlay && playerId));
}

/** Clear remembered correlators between unit tests. */
export function resetDebugIdentityForTests(): void {
  confirmedPlayerId = '';
}

export function mountDebugIdentity(): void {
  if (typeof document === 'undefined') {
    return;
  }
  applyDebugPreference(debugIsOn());
  if (listenersBound) {
    return;
  }
  listenersBound = true;

  const checkbox = document.querySelector<HTMLInputElement>('#debugPref');
  attachEventListener(checkbox, 'change', () => {
    applyDebugPreference(Boolean(checkbox?.checked));
  });

  const playerInput = document.querySelector<HTMLInputElement>('#debug-player-id');
  const sessionInput = document.querySelector<HTMLInputElement>('#debug-session-id');
  attachEventListener(playerInput, 'focus', () => {
    if (playerInput) {
      selectReadableId(playerInput);
    }
  });
  attachEventListener(playerInput, 'click', () => {
    if (playerInput) {
      selectReadableId(playerInput);
    }
  });
  attachEventListener(sessionInput, 'focus', () => {
    if (sessionInput) {
      selectReadableId(sessionInput);
    }
  });
  attachEventListener(sessionInput, 'click', () => {
    if (sessionInput) {
      selectReadableId(sessionInput);
    }
  });

  const copyPlayer = document.querySelector<HTMLButtonElement>('#copy-debug-player-id');
  const copySession = document.querySelector<HTMLButtonElement>('#copy-debug-session-id');
  const copyChip = document.querySelector<HTMLButtonElement>('#copy-debug-play-chip');
  attachEventListener(copyPlayer, 'click', async () => {
    if (await copyText(confirmedPlayerId, playerInput)) {
      flashCopied(copyPlayer);
    }
  });
  attachEventListener(copySession, 'click', async () => {
    if (await copyText(getClientLogContext().sessionId, sessionInput)) {
      flashCopied(copySession);
    }
  });
  attachEventListener(copyChip, 'click', async () => {
    if (await copyText(confirmedPlayerId)) {
      flashCopied(copyChip);
    }
  });

  window.addEventListener('playerIdentityChanged', (event) => {
    const playerId = event.detail?.playerId;
    if (playerId) {
      confirmedPlayerId = playerId;
      syncDebugIdentity();
    }
  });
  window.addEventListener('playViewOn', () => {
    syncDebugIdentity();
  });
  window.addEventListener('playViewOff', () => {
    syncDebugIdentity();
  });
}
