import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, expect, test, vi } from 'vitest';
import StartScreen from '../../../src/components/game/StartScreen.svelte';
import type { GameMenuView } from '../../../src/runtime/uiTypes';

const menuView: GameMenuView = {
  initialName: 'Saved Pilot',
  fallbackName: 'Pilot 42',
  selectedKit: 'scout',
  preferences: { sound: true, music: false, haptics: true, hapticsAvailable: true },
  buildInfo: 'v1 · test-build',
};
let menu: ReturnType<typeof mount> | undefined;

async function settle() {
  flushSync();
  await Promise.resolve();
  flushSync();
}

function element<T extends Element>(selector: string, type: { new (...args: never[]): T }): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) {
    throw new Error(`Missing ${selector}`);
  }
  return found;
}

async function start(initialReady = false, view = menuView) {
  document.body.innerHTML = '';
  const ready = writable(initialReady);
  const joining = writable(false);
  const joinError = writable<string | null>(null);
  const initializationError = writable<string | null>(null);
  const currentView = writable(view);
  const state = {
    ready: fromStore(ready),
    joining: fromStore(joining),
    joinError: fromStore(joinError),
    initializationError: fromStore(initializationError),
    view: fromStore(currentView),
  };
  const onjoin = vi.fn();
  const onretry = vi.fn();
  const onselectship = vi.fn();
  const onpreference = vi.fn();
  menu = mount(StartScreen, {
    target: document.body,
    props: {
      get view() {
        return state.view.current;
      },
      playerName: view.initialName,
      get ready() {
        return state.ready.current;
      },
      get joining() {
        return state.joining.current;
      },
      get joinError() {
        return state.joinError.current;
      },
      get initializationError() {
        return state.initializationError.current;
      },
      onjoin,
      onretry,
      onselectship,
      onpreference,
    },
  });
  await settle();
  return {
    ready,
    joining,
    joinError,
    initializationError,
    currentView,
    onjoin,
    onretry,
    onselectship,
    onpreference,
  };
}

afterEach(async () => {
  if (menu) {
    await unmount(menu);
  }
  menu = undefined;
  vi.restoreAllMocks();
});

test('an early submit is rejected and becoming ready never queues a join', async () => {
  const { ready, onjoin } = await start();
  const submit = element('#start-game', HTMLButtonElement);
  const form = element('form', HTMLFormElement);
  expect(submit.disabled).toBe(true);
  expect(submit.textContent).toContain('Preparing game…');
  submit.click();
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(onjoin).not.toHaveBeenCalled();
  ready.set(true);
  await settle();
  expect(submit.disabled).toBe(false);
  expect(submit.textContent).toContain('Enter Game');
  expect(onjoin).not.toHaveBeenCalled();
});

test('a ready pilot submits the exact name once per gesture and can retry after rejection', async () => {
  const { onjoin, joining, joinError } = await start(true);
  const input = element('#playerNameInput', HTMLInputElement);
  expect(input.maxLength).toBe(20);
  expect(input.autocomplete).toBe('nickname');
  expect(input.placeholder).toBe('Pilot 42');
  input.value = '  Ada Pilot  ';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const submit = element('#start-game', HTMLButtonElement);
  onjoin.mockImplementation(() => joining.set(true));
  submit.click();
  expect(onjoin).toHaveBeenCalledExactlyOnceWith('  Ada Pilot  ');
  await settle();
  expect(submit.disabled).toBe(true);
  expect(submit.textContent).toContain('Joining…');
  element('form', HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
  expect(onjoin).toHaveBeenCalledTimes(1);
  joinError.set('Connection rejected. Try again.');
  joining.set(false);
  await settle();
  expect(element('#join-error', HTMLParagraphElement).textContent).toBe(
    'Connection rejected. Try again.'
  );
  expect(input.value).toBe('  Ada Pilot  ');
  submit.click();
  expect(onjoin).toHaveBeenCalledTimes(2);
  expect(onjoin).toHaveBeenLastCalledWith('  Ada Pilot  ');
});

test('initialization failure exposes retry separately from a rejected join', async () => {
  const { initializationError, joinError, onretry, onjoin } = await start();
  initializationError.set('Audio setup failed.');
  joinError.set('The server could not admit this pilot.');
  await settle();
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(2);
  const retry = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Retry'
  );
  if (!retry) {
    throw new Error('Retry button missing');
  }
  retry.click();
  expect(onretry).toHaveBeenCalledTimes(1);
  expect(onjoin).not.toHaveBeenCalled();
  expect(element('a[href="/wiki/"]', HTMLAnchorElement).textContent).toContain('Field manual');
  expect(document.querySelector('[aria-label="Game version"]')?.textContent).toBe(
    'v1 · test-build'
  );
});

test('pilots change supported preferences and ship selection through real controls', async () => {
  const { onpreference, onselectship, currentView, joining } = await start(true);
  element('#preference-sound', HTMLButtonElement).click();
  element('#preference-music', HTMLButtonElement).click();
  element('#preference-haptics', HTMLButtonElement).click();
  expect(onpreference.mock.calls).toEqual([
    ['sound', false],
    ['music', true],
    ['haptics', false],
  ]);
  const scout = element('#ship-scout', HTMLButtonElement);
  const hauler = element('#ship-hauler', HTMLButtonElement);
  expect(scout.getAttribute('aria-checked')).toBe('true');
  hauler.click();
  expect(onselectship).toHaveBeenCalledExactlyOnceWith('hauler');
  currentView.set({ ...menuView, selectedKit: 'hauler' });
  await settle();
  expect(hauler.getAttribute('aria-checked')).toBe('true');
  hauler.focus();
  hauler.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await settle();
  expect(document.activeElement).toBe(scout);
  expect(onselectship).toHaveBeenLastCalledWith('scout');
  joining.set(true);
  await settle();
  const preferenceCalls = onpreference.mock.calls.length;
  const shipCalls = onselectship.mock.calls.length;
  element('#preference-sound', HTMLButtonElement).click();
  hauler.click();
  expect(onpreference).toHaveBeenCalledTimes(preferenceCalls);
  expect(onselectship).toHaveBeenCalledTimes(shipCalls);
});

test('a device without haptics receives only sound and music controls', async () => {
  await start(true, {
    ...menuView,
    preferences: { ...menuView.preferences, hapticsAvailable: false },
  });
  expect(document.querySelector('#preference-haptics')).toBeNull();
  expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
});
