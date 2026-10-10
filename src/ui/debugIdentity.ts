import { debugIsOn } from '../constants/user-preferences';
import { buildClientDiagnostics } from '../diagnostics/clientDiagnostics';
import { getClientLogContext } from '../utils/clientLogContext';
import { logger } from '../utils/Logger';
import { syncDebugHudVisibility } from './debugHud';

const COPY_LABEL = 'Copy';
const COPIED_LABEL = 'Copied!';
const PLAYER_ID_PENDING = 'Available after Enter Game';
const copyResetTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();

let listenersBound = false;
let listenerScope: AbortController | null = null;
let confirmedPlayerId = '';
let previousDebugMode: boolean | undefined;

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

async function copyText(
  value: string,
  signal: AbortSignal,
  input?: HTMLInputElement | null
): Promise<boolean> {
  if (!value) {
    return false;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return !signal.aborted;
    }
  } catch {
    // Fall through to the select-all path when the clipboard API is blocked.
  }
  if (signal.aborted || (input && !input.isConnected)) {
    return false;
  }
  const previousFocus = document.activeElement;
  const target = input ?? document.createElement('textarea');
  if (!input) {
    target.value = value;
    target.readOnly = true;
    target.style.position = 'fixed';
    target.style.opacity = '0';
    document.body.append(target);
  }
  try {
    target.focus({ preventScroll: true });
    target.select();
    target.setSelectionRange(0, target.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (!input) {
      target.remove();
    }
    if (previousFocus instanceof HTMLElement) {
      previousFocus.focus({ preventScroll: true });
    }
  }
}

function flashCopyResult(button: HTMLButtonElement | null, copied: boolean): void {
  if (!button || !listenersBound || !button.isConnected) {
    return;
  }
  const label = button.dataset['copyLabel'] ?? COPY_LABEL;
  const existing = copyResetTimers.get(button);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  button.textContent = copied ? COPIED_LABEL : 'Copy failed';
  button.setAttribute('aria-label', copied ? copyAriaLabel(button, true) : 'Copy failed');
  copyResetTimers.set(
    button,
    setTimeout(() => {
      button.textContent = label;
      button.setAttribute('aria-label', copyAriaLabel(button, false));
      copyResetTimers.delete(button);
    }, 3000)
  );
}

function selectReadableId(input: HTMLInputElement): void {
  if (!input.value) {
    return;
  }
  input.select();
  input.setSelectionRange(0, input.value.length);
}

export function syncDebugMode(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const enabled = debugIsOn();
  document.body.classList.toggle('debug-on', enabled);
  setHidden(document.querySelector('#debug-identity'), !enabled);
  logger.applyConfiguredLogLevel();
  syncDebugIdentity();
  syncDebugHudVisibility();
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

  const hudPlayer = document.querySelector('#debug-hud-player-id');
  const hudSession = document.querySelector('#debug-hud-session-id');
  if (hudPlayer) {
    hudPlayer.textContent = playerId || 'Not joined';
  }
  if (hudSession) {
    hudSession.textContent = sessionId;
  }
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
}

/** Clear remembered correlators between unit tests. */
export function resetDebugIdentityForTests(): void {
  confirmedPlayerId = '';
}

export function mountDebugIdentity(): void {
  if (typeof document === 'undefined') {
    return;
  }
  if (listenersBound) {
    syncDebugMode();
    return;
  }
  previousDebugMode = document.body.classList.contains('debug-on');
  syncDebugMode();
  listenersBound = true;
  listenerScope = new AbortController();
  const { signal } = listenerScope;

  const playerInput = document.querySelector<HTMLInputElement>('#debug-player-id');
  const sessionInput = document.querySelector<HTMLInputElement>('#debug-session-id');
  playerInput?.addEventListener(
    'focus',
    () => {
      if (playerInput) {
        selectReadableId(playerInput);
      }
    },
    { signal }
  );
  playerInput?.addEventListener(
    'click',
    () => {
      if (playerInput) {
        selectReadableId(playerInput);
      }
    },
    { signal }
  );
  sessionInput?.addEventListener(
    'focus',
    () => {
      if (sessionInput) {
        selectReadableId(sessionInput);
      }
    },
    { signal }
  );
  sessionInput?.addEventListener(
    'click',
    () => {
      if (sessionInput) {
        selectReadableId(sessionInput);
      }
    },
    { signal }
  );

  const copyPlayer = document.querySelector<HTMLButtonElement>('#copy-debug-player-id');
  const copySession = document.querySelector<HTMLButtonElement>('#copy-debug-session-id');
  copyPlayer?.addEventListener(
    'click',
    async () => {
      const copied = await copyText(confirmedPlayerId, signal, playerInput);
      if (!signal.aborted) {
        flashCopyResult(copyPlayer, copied);
      }
    },
    { signal }
  );
  copySession?.addEventListener(
    'click',
    async () => {
      const copied = await copyText(getClientLogContext().sessionId, signal, sessionInput);
      if (!signal.aborted) {
        flashCopyResult(copySession, copied);
      }
    },
    { signal }
  );

  const copyDiagnostics = document.querySelector<HTMLButtonElement>('#copy-debug-diagnostics');
  copyDiagnostics?.addEventListener(
    'click',
    async () => {
      const copied = await copyText(buildClientDiagnostics(), signal);
      if (!signal.aborted) {
        flashCopyResult(copyDiagnostics, copied);
      }
    },
    { signal }
  );

  window.addEventListener(
    'playerIdentityChanged',
    (event) => {
      const playerId = event.detail?.playerId;
      if (playerId) {
        confirmedPlayerId = playerId;
        syncDebugIdentity();
      }
    },
    { signal }
  );
  window.addEventListener(
    'playViewOn',
    () => {
      syncDebugIdentity();
    },
    { signal }
  );
  window.addEventListener(
    'playViewOff',
    () => {
      syncDebugIdentity();
    },
    { signal }
  );
}

export function disposeDebugIdentity(): void {
  if (previousDebugMode !== undefined) {
    document.body.classList.toggle('debug-on', previousDebugMode);
    previousDebugMode = undefined;
  }
  listenerScope?.abort();
  listenerScope = null;
  listenersBound = false;
  confirmedPlayerId = '';
  for (const timer of copyResetTimers.values()) {
    clearTimeout(timer);
  }
  copyResetTimers.clear();
}
