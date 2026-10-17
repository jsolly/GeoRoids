import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { StoredDebugReport } from '../../../src/diagnostics/debugReportStorage';
import type { GameRuntime, GameRuntimeHosts } from '../../../src/runtime/gameRuntime';
import type { TownStoreView } from '../../../src/runtime/townStore';
import type { GamePresentation, InventoryView } from '../../../src/runtime/uiTypes';

const boundary = vi.hoisted(() => ({
  create: vi.fn(),
  imported: vi.fn(),
  readReport: vi.fn<() => Promise<StoredDebugReport | null>>(),
  writeReport: vi.fn<(value: StoredDebugReport | null) => Promise<void>>(),
}));
vi.mock('../../../src/diagnostics/debugReportStorage', () => ({
  createDebugReportStorage: () => ({ read: boundary.readReport, write: boundary.writeReport }),
}));
vi.mock('../../../src/runtime/gameRuntime', async () => {
  await boundary.imported();
  return { createGameRuntime: boundary.create };
});

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const initialView: GamePresentation = {
  menu: {
    initialName: 'Saved pilot',
    fallbackName: 'Pilot 42',
    selectedKit: 'scout',
    preferences: { sound: true, music: false, haptics: false, hapticsAvailable: false },
    buildInfo: 'test-build',
  },
  inPlay: false,
  joining: false,
  joinError: null,
  failureNotice: null,
  overlay: null,
  inventory: null,
  townStore: null,
  townTravel: null,
  debug: null,
  network: null,
  hints: [],
  phone: null,
  spawnActive: false,
  controls: {
    inPlay: false,
    touchMode: false,
    ability: {
      label: 'E',
      name: 'Ability',
      ready: false,
      active: false,
      cooling: false,
      unavailable: true,
      cooldownRatio: 0,
      pressed: false,
      disabled: true,
    },
    contourLock: {
      label: 'CONTOUR LOCK',
      name: 'Contour Lock',
      active: false,
      disabled: true,
      pressed: false,
    },
  },
};
let svelte: typeof import('svelte');
let shell: ReturnType<typeof svelte.mount> | undefined;
let publish: (view: GamePresentation) => void;
let hosts: GameRuntimeHosts | undefined;
let signal: AbortSignal | undefined;
let runtime: GameRuntime;
let teardownOrder: string[];

async function settle() {
  for (let step = 0; step < 8; step++) {
    await Promise.resolve();
    svelte.flushSync();
  }
}
async function start() {
  const { default: GameShell } = await import('../../../src/components/game/GameShell.svelte');
  shell = svelte.mount(GameShell, { target: document.body });
  await settle();
}
function element<T extends Element>(selector: string, type: { new (...args: never[]): T }): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) {
    throw new Error(`Missing ${selector}`);
  }
  return found;
}
beforeEach(async () => {
  window.history.replaceState(null, '', '/');
  boundary.readReport.mockReset().mockResolvedValue(null);
  boundary.writeReport.mockReset().mockRejectedValue(new Error('test browser storage failure'));
  vi.resetModules();
  svelte = await import('svelte');
  document.body.innerHTML = '';
  document.body.className = 'existing';
  boundary.create.mockReset();
  boundary.imported.mockReset().mockResolvedValue(undefined);
  hosts = undefined;
  signal = undefined;
  teardownOrder = [];
  runtime = {
    commands: {
      crewAction: vi.fn(),
      signalHere: vi.fn(),
      join: vi.fn(),
      selectShip: vi.fn(),
      setPreference: vi.fn(),
      openInventory: vi.fn(),
      closeInventory: vi.fn(),
      inventoryPage: vi.fn(),
      equipSatellite: vi.fn(),
      equipUtility: vi.fn(),
      drawInventory: vi.fn(() => ({ refresh: vi.fn(), dispose: vi.fn() })),
      closeTownStore: vi.fn(),
      selectTownView: vi.fn(),
      purchaseTownOffer: vi.fn(),
      requestFurnaceTravel: vi.fn(),
      openUniverseMap: vi.fn(),
      closeUniverseMap: vi.fn(),
      mountUniverseMap: vi.fn(),
      mountTouchActions: vi.fn(() => () => {}),
      activateHint: vi.fn(),
      toggleDebugHud: vi.fn(),
      readDiagnostics: vi.fn(() => ''),
      captureDiagnostics: vi.fn(() => ({
        state: { version: 1, capturedAt: new Date().toISOString(), sessionId: 'test-page' },
        recentLogs: [],
      })),
      startPhoneCollection: vi.fn(),
      stopPhoneCollection: vi.fn(),
      recoverPhoneCollection: vi.fn(),
      downloadPhoneCollection: vi.fn(async () => null),
    },
    subscribe: vi.fn((listener) => {
      publish = listener;
      listener(initialView);
      return () => {
        teardownOrder.push('unsubscribe');
      };
    }),
    dispose: vi.fn(() => {
      teardownOrder.push('dispose');
    }),
  };
  boundary.create.mockImplementation((nextHosts: GameRuntimeHosts, nextSignal: AbortSignal) => {
    hosts = nextHosts;
    signal = nextSignal;
    return runtime;
  });
});
afterEach(async () => {
  if (shell) {
    await svelte.unmount(shell);
  }
  shell = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('loading gestures are discarded and ready gestures call the runtime synchronously', async () => {
  const imported = deferred();
  boundary.imported.mockReturnValue(imported.promise);
  await start();
  const button = element('#start-game', HTMLButtonElement);
  expect(button.disabled).toBe(true);
  element('form', HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
  expect(runtime.commands.join).not.toHaveBeenCalled();
  imported.release();
  await vi.dynamicImportSettled();
  await settle();
  expect(button.disabled).toBe(false);
  expect(runtime.commands.join).not.toHaveBeenCalled();
  const input = element('#playerNameInput', HTMLInputElement);
  expect(input.value).toBe('Saved pilot');
  input.value = '  Edited pilot  ';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  publish({ ...initialView, menu: { ...initialView.menu, buildInfo: 'new-build' } });
  await settle();
  expect(input.value).toBe('  Edited pilot  ');
  button.click();
  expect(runtime.commands.join).toHaveBeenCalledExactlyOnceWith('  Edited pilot  ');
  element('#preference-sound', HTMLButtonElement).click();
  expect(runtime.commands.setPreference).toHaveBeenCalledExactlyOnceWith('sound', false);
  element('#ship-hauler', HTMLButtonElement).click();
  expect(runtime.commands.selectShip).toHaveBeenCalledExactlyOnceWith('hauler');
});

test.each(['  Early pilot  ', ''])(
  'a pilot keeps the pre-ready name draft %j through runtime initialization',
  async (draft) => {
    const imported = deferred();
    boundary.imported.mockReturnValue(imported.promise);
    await start();
    const input = element('#playerNameInput', HTMLInputElement);
    expect(input.disabled).toBe(false);
    input.value = 'Temporary pilot';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = draft;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(input.value).toBe(draft);
    expect(runtime.commands.join).not.toHaveBeenCalled();
    imported.release();
    await vi.dynamicImportSettled();
    await settle();
    expect(input.value).toBe(draft);
    publish({
      ...initialView,
      menu: { ...initialView.menu, initialName: 'Another saved pilot', buildInfo: 'new-build' },
    });
    await settle();
    expect(input.value).toBe(draft);
    const button = element('#start-game', HTMLButtonElement);
    expect(button.disabled).toBe(false);
    button.click();
    expect(runtime.commands.join).toHaveBeenCalledExactlyOnceWith(draft);
  }
);

test('a failed initialization exposes retry and the second attempt subscribes once', async () => {
  boundary.create.mockImplementationOnce(() => {
    throw new Error('Canvas unavailable');
  });
  await start();
  await vi.dynamicImportSettled();
  await settle();
  expect(document.body.textContent).toContain('Canvas unavailable');
  expect(element('#start-game', HTMLButtonElement).disabled).toBe(true);
  expect(runtime.subscribe).not.toHaveBeenCalled();
  const input = element('#playerNameInput', HTMLInputElement);
  input.value = '  Retry pilot  ';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const retry = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Retry'
  );
  if (!retry) {
    throw new Error('Missing retry');
  }
  retry.click();
  await vi.dynamicImportSettled();
  await settle();
  expect(boundary.create).toHaveBeenCalledTimes(2);
  expect(runtime.subscribe).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain('Canvas unavailable');
  expect(input.value).toBe('  Retry pilot  ');
  element('#start-game', HTMLButtonElement).click();
  expect(runtime.commands.join).toHaveBeenCalledExactlyOnceWith('  Retry pilot  ');
});

test('unmount during module loading aborts startup before creating a runtime', async () => {
  const imported = deferred();
  boundary.imported.mockReturnValue(imported.promise);
  await start();
  if (!shell) {
    throw new Error('Missing shell');
  }
  await svelte.unmount(shell);
  shell = undefined;
  imported.release();
  await vi.dynamicImportSettled();
  await settle();
  expect(boundary.create).not.toHaveBeenCalled();
  expect(document.body.className).toBe('existing');
});

test('unmount after runtime creation disposes it before a ready subscription can attach', async () => {
  let stopped: Promise<void> | undefined;
  boundary.create.mockImplementationOnce(() => {
    queueMicrotask(() => {
      if (shell) {
        stopped = svelte.unmount(shell);
        shell = undefined;
      }
    });
    return runtime;
  });
  await start();
  await vi.dynamicImportSettled();
  await settle();
  await stopped;
  expect(runtime.subscribe).not.toHaveBeenCalled();
  expect(runtime.dispose).toHaveBeenCalledTimes(1);
  expect(document.body.className).toBe('existing');
});

test('play and geometry update body classes synchronously and preserve shell canvases through menu transitions', async () => {
  document.body.classList.add('touch-play', 'game-overlay-open');
  await start();
  await vi.dynamicImportSettled();
  await settle();
  if (!hosts) {
    throw new Error('Missing runtime hosts');
  }
  const gameCanvas = hosts.canvas;
  expect(hosts.titleCanvas).toBe(element('#title-terrain', HTMLCanvasElement));
  expect(hosts.titleCanvas.getAttribute('aria-hidden')).toBe('true');
  expect(document.querySelector('#title-starfield')).toBeNull();
  const spawnCanvas = hosts.spawnCanvas;
  expect(spawnCanvas).toBe(element('#spawn-fly-in', HTMLCanvasElement));
  hosts.placeChrome({
    width: 390,
    height: 760,
    touchControls: true,
    mobileControlsTop: 120,
    mapX: 300,
    mapY: 200,
    schematicY: 148,
  });
  expect(document.body.classList.contains('touch-play')).toBe(false);
  expect(document.body.classList.contains('game-overlay-open')).toBe(false);
  publish({ ...initialView, inPlay: true });
  expect(document.body.classList.contains('in-play')).toBe(true);
  expect(document.body.classList.contains('touch-play')).toBe(true);
  publish({ ...initialView, inPlay: true, overlay: 'debug-report' });
  expect(document.body.classList.contains('game-overlay-open')).toBe(true);
  publish({ ...initialView, inPlay: true });
  expect(document.body.classList.contains('game-overlay-open')).toBe(false);
  await settle();
  expect(document.querySelector('#town-store-toggle')).toBeNull();
  const area = element('#gameArea', HTMLDivElement);
  expect(area.hidden).toBe(false);
  expect(area.style.width).toBe('390px');
  expect(area.style.height).toBe('760px');
  const wrapper = element('#gameWrapper', HTMLElement);
  expect(wrapper.style.getPropertyValue('--mobile-controls-top')).toBe('120px');
  expect(wrapper.style.getPropertyValue('--map-toggle-x')).toBe('300px');
  expect(wrapper.style.getPropertyValue('--map-toggle-y')).toBe('200px');
  expect(wrapper.style.getPropertyValue('--schematic-toggle-y')).toBe('148px');
  expect(element('#start-screen', HTMLDivElement).hidden).toBe(true);
  publish({ ...initialView, failureNotice: 'Restart your flight.' });
  expect(document.body.classList.contains('in-play')).toBe(false);
  expect(document.body.classList.contains('touch-play')).toBe(false);
  await settle();
  expect(document.body.textContent).toContain('Restart your flight.');
  expect(gameCanvas.isConnected && spawnCanvas.isConnected).toBe(true);
  expect(element('#gameCanvas', HTMLCanvasElement)).toBe(gameCanvas);
  if (!shell) {
    throw new Error('Missing shell');
  }
  await svelte.unmount(shell);
  shell = undefined;
  expect(teardownOrder).toEqual(['unsubscribe', 'dispose']);
  expect(signal?.aborted).toBe(true);
  expect(document.body.className).toBe('existing touch-play game-overlay-open');
  hosts.placeChrome({
    width: 1,
    height: 1,
    touchControls: false,
    mobileControlsTop: 0,
    mapX: 0,
    mapY: 0,
    schematicY: 0,
  });
  publish({ ...initialView, inPlay: true });
  expect(document.body.className).toBe('existing touch-play game-overlay-open');
});

test('inventory Return focuses the playfield while a later Escape restores the inventory opener', async () => {
  await start();
  await vi.dynamicImportSettled();
  await settle();
  vi.useFakeTimers();
  const flight: GamePresentation = { ...initialView, inPlay: true };
  const inventory: InventoryView = {
    page: 0,
    pages: 1,
    total: 0,
    silk: 0,
    description: 'No stored satellites.',
    canEquipSatellite: true,
    kitName: 'Scout',
    items: [],
    tools: [],
  };
  vi.mocked(runtime.commands.openInventory).mockImplementation(() => {
    publish({ ...flight, overlay: 'inventory', inventory });
  });
  vi.mocked(runtime.commands.closeInventory).mockImplementation(() => publish(flight));
  publish(flight);
  await settle();
  const opener = element('#ship-schematic-toggle', HTMLButtonElement);
  expect(opener.getAttribute('aria-keyshortcuts')).toBe('V');
  expect(opener.querySelector('kbd')?.textContent).toBe('V');
  opener.focus();
  opener.click();
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  expect(runtime.commands.openInventory).toHaveBeenCalledTimes(1);
  expect(runtime.commands.drawInventory).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  const returnButton = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Return to flight'
  );
  if (!returnButton) {
    throw new Error('Missing return to flight');
  }
  returnButton.click();
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('#gameCanvas'));
  expect(
    vi.mocked(runtime.commands.drawInventory).mock.results[0]?.value.dispose
  ).toHaveBeenCalledTimes(1);
  opener.focus();
  opener.click();
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  element('[role="dialog"]', HTMLDivElement).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  expect(runtime.commands.closeInventory).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(opener);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('Town Square mode and purchase actions reach the runtime and Return closes only the town overlay', async () => {
  await start();
  await vi.dynamicImportSettled();
  await settle();
  vi.useFakeTimers();
  const flight: GamePresentation = { ...initialView, inPlay: true };
  const town: TownStoreView = {
    mode: 'entry',
    title: 'Town Square',
    sourceName: 'Town Hearth',
    bank: 500,
    level: 2,
    status: '',
    atTown: true,
    offers: [
      {
        id: 'banner',
        name: 'Crew Banner',
        cost: 200,
        level: 1,
        owned: false,
        locked: false,
        available: true,
      },
    ],
  };
  vi.mocked(runtime.commands.selectTownView).mockImplementation((mode) =>
    publish({ ...flight, overlay: 'town-store', townStore: { ...town, mode } })
  );
  vi.mocked(runtime.commands.closeTownStore).mockImplementation(() => publish(flight));
  publish(flight);
  await settle();
  element('#gameCanvas', HTMLCanvasElement).focus();
  publish({ ...flight, overlay: 'town-store', townStore: town });
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  const store = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Store'
  );
  if (!store) {
    throw new Error('Missing Store');
  }
  store.click();
  expect(runtime.commands.selectTownView).toHaveBeenCalledExactlyOnceWith('store');
  await settle();
  const buy = element('[data-town-offer="banner"]', HTMLButtonElement);
  buy.click();
  expect(runtime.commands.purchaseTownOffer).toHaveBeenCalledExactlyOnceWith('banner');
  const returnButton = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Return to flight'
  );
  if (!returnButton) {
    throw new Error('Missing return');
  }
  returnButton.click();
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  expect(runtime.commands.closeTownStore).toHaveBeenCalledTimes(1);
  expect(runtime.commands.closeInventory).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.querySelector('#gameCanvas'));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test.each(['inventory', 'town-store'] satisfies ('inventory' | 'town-store')[])(
  'a handoff from %s to the other overlay dismisses back to a connected flight control',
  async (first) => {
    await start();
    await vi.dynamicImportSettled();
    await settle();
    vi.useFakeTimers();
    const flight: GamePresentation = { ...initialView, inPlay: true };
    const inventory: InventoryView = {
      page: 0,
      pages: 1,
      total: 0,
      silk: 0,
      description: 'No stored satellites.',
      canEquipSatellite: true,
      kitName: 'Scout',
      items: [],
      tools: [],
    };
    const townStore: TownStoreView = {
      mode: 'entry',
      title: 'Town Square',
      sourceName: 'Town Hearth',
      bank: 0,
      level: 1,
      status: '',
      atTown: true,
      offers: [],
    };
    vi.mocked(runtime.commands.closeInventory).mockImplementation(() => publish(flight));
    vi.mocked(runtime.commands.closeTownStore).mockImplementation(() => publish(flight));
    publish(flight);
    await settle();
    const launcher = element('#ship-schematic-toggle', HTMLButtonElement);
    launcher.focus();
    publish({
      ...flight,
      overlay: first,
      inventory: first === 'inventory' ? inventory : null,
      townStore: first === 'town-store' ? townStore : null,
    });
    await settle();
    await vi.runAllTimersAsync();
    await settle();
    const oldControl = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Return to flight'
    );
    if (!oldControl) {
      throw new Error('Missing old overlay control');
    }
    oldControl.focus();
    const second = first === 'inventory' ? 'town-store' : 'inventory';
    publish({
      ...flight,
      overlay: second,
      inventory: second === 'inventory' ? inventory : null,
      townStore: second === 'town-store' ? townStore : null,
    });
    await settle();
    await vi.runAllTimersAsync();
    await settle();
    expect(oldControl.isConnected).toBe(false);
    const dialog = element('[role="dialog"]', HTMLDivElement);
    expect(dialog.contains(document.activeElement)).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    await vi.runAllTimersAsync();
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const canvas = element('#gameCanvas', HTMLCanvasElement);
    expect(document.activeElement === canvas || document.activeElement === launcher).toBe(true);
    expect(document.activeElement?.isConnected).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  }
);

test('canceling an unsubmitted report recaptures the current incident before reopening and sends that snapshot', async () => {
  window.history.replaceState(null, '', '/debug');
  const overlays = await import('../../../src/runtime/overlayState');
  const diagnosticView: GamePresentation = {
    ...initialView,
    debug: {
      playerId: '',
      sessionId: 'test-page',
      hudHidden: false,
      fps: '60',
      rtt: '0',
      snapshot: '0',
      motion: '',
      world: '',
      releases: '',
    },
  };
  vi.mocked(runtime.subscribe).mockImplementation((listener) => {
    listener(diagnosticView);
    return overlays.subscribeGameOverlay((overlay) => listener({ ...diagnosticView, overlay }));
  });
  let incident = 'before-cancel';
  vi.mocked(runtime.commands.captureDiagnostics).mockImplementation(() => {
    expect(overlays.getOpenGameOverlay()).toBeNull();
    return {
      state: { version: 1, capturedAt: new Date().toISOString(), sessionId: incident },
      recentLogs: [],
    };
  });
  await start();
  await vi.dynamicImportSettled();
  await settle();
  vi.useFakeTimers();
  const button = (label: string) => {
    const found = [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === label
    );
    if (!found) {
      throw new Error(`Missing ${label}`);
    }
    return found;
  };
  button('Report a problem').click();
  await settle();
  const firstField = element('#debug-report-description', HTMLTextAreaElement);
  firstField.value = 'Controls stopped responding';
  firstField.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  button('Cancel').click();
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  incident = 'after-cancel';
  button('Report a problem').click();
  await settle();
  expect(element('#debug-report-description', HTMLTextAreaElement).value).toBe(
    'Controls stopped responding'
  );
  expect(document.querySelector('pre')?.textContent).toContain('after-cancel');
  expect(document.querySelector('pre')?.textContent).not.toContain('before-cancel');
  button('Send').click();
  await settle();
  expect(boundary.writeReport).toHaveBeenCalledWith({
    kind: 'submission',
    submission: expect.objectContaining({
      description: 'Controls stopped responding',
      diagnostics: expect.objectContaining({
        state: expect.objectContaining({ sessionId: 'after-cancel' }),
      }),
    }),
  });
  expect(runtime.commands.captureDiagnostics).toHaveBeenCalledTimes(2);
  button('Cancel').click();
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  incident = 'after-submission';
  button('Report a problem').click();
  await settle();
  expect(runtime.commands.captureDiagnostics).toHaveBeenCalledTimes(2);
  expect(document.querySelector('pre')?.textContent).toContain('after-cancel');
  expect(document.querySelector('pre')?.textContent).not.toContain('after-submission');
  button('Cancel').click();
  await settle();
  await vi.runAllTimersAsync();
});

test('a report draft keeps its focused textarea across flight publications and keyboard viewport changes', async () => {
  window.history.replaceState(null, '', '/debug');
  await start();
  await vi.dynamicImportSettled();
  await settle();
  vi.useFakeTimers();
  const flight: GamePresentation = {
    ...initialView,
    inPlay: true,
    overlay: 'debug-report',
    debug: {
      playerId: 'test-pilot',
      sessionId: 'test-page',
      hudHidden: false,
      fps: '60',
      rtt: '0',
      snapshot: '0',
      motion: '',
      world: '',
      releases: '',
    },
  };
  publish(flight);
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  const field = element('#debug-report-description', HTMLTextAreaElement);
  field.focus();
  field.value = 'The keyboard';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.setSelectionRange(4, 12);
  await settle();
  const geometry = {
    width: 800,
    height: 700,
    touchControls: true,
    mobileControlsTop: 80,
    mapX: 0,
    mapY: 0,
    schematicY: 0,
  };
  hosts?.placeChrome(geometry);
  window.dispatchEvent(new Event('resize'));
  window.visualViewport?.dispatchEvent(new Event('resize'));
  publish({ ...flight, controls: { ...flight.controls, touchMode: true } });
  await settle();
  await vi.runAllTimersAsync();
  await settle();
  expect(element('#debug-report-description', HTMLTextAreaElement)).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe('The keyboard');
  expect([field.selectionStart, field.selectionEnd]).toEqual([4, 12]);
});

async function startWithReportReceipt(state: 'pending' | 'blocked' | 'delivered') {
  window.history.replaceState(null, '', '/debug');
  const overlays = await import('../../../src/runtime/overlayState');
  const diagnosticView: GamePresentation = {
    ...initialView,
    debug: {
      playerId: '',
      sessionId: 'test-page',
      hudHidden: false,
      fps: '60',
      rtt: '0',
      snapshot: '0',
      motion: '',
      world: '',
      releases: '',
    },
  };
  vi.mocked(runtime.subscribe).mockImplementation((listener) => {
    listener(diagnosticView);
    return overlays.subscribeGameOverlay((overlay) => listener({ ...diagnosticView, overlay }));
  });
  const id = crypto.randomUUID();
  boundary.writeReport.mockResolvedValue(undefined);
  boundary.readReport.mockResolvedValue({
    kind: 'receipt',
    receipt: { id, state },
    receiptToken: 'a'.repeat(64),
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ id, state }), { status: 200 })
  );
  await start();
  await vi.dynamicImportSettled();
  await settle();
  boundary.writeReport.mockClear();
  return { overlays, id };
}

function reportButton(label: string) {
  const found = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label
  );
  if (!found) {
    throw new Error(`Missing ${label}`);
  }
  return found;
}

test('Report a problem starts a fresh editor on the first click after a delivered report', async () => {
  const { overlays } = await startWithReportReceipt('delivered');
  boundary.writeReport.mockResolvedValue(undefined);
  vi.mocked(runtime.commands.captureDiagnostics).mockImplementation(() => {
    expect(overlays.getOpenGameOverlay()).toBeNull();
    return { state: { sessionId: 'new-incident' }, recentLogs: [] };
  });
  reportButton('Report a problem').click();
  reportButton('Report a problem').click();
  await settle();
  const field = element('#debug-report-description', HTMLTextAreaElement);
  expect(field.value).toBe('');
  expect(field.disabled).toBe(false);
  expect(document.querySelector('pre')?.textContent).toContain('new-incident');
  expect(document.body.textContent).not.toContain('Delivered');
  expect(boundary.writeReport).toHaveBeenCalledExactlyOnceWith(null);
  expect(runtime.commands.captureDiagnostics).toHaveBeenCalledTimes(1);
  field.value = 'Second incident';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(reportButton('Send').disabled).toBe(false);
});

test.each(['pending', 'blocked'] as const)(
  'a %s receipt remains recoverable and New report opens a focused editor in the same dialog',
  async (state) => {
    const { overlays, id } = await startWithReportReceipt(state);
    boundary.writeReport.mockResolvedValue(undefined);
    reportButton('Report a problem').click();
    await settle();
    const dialog = element('[role="dialog"]', HTMLDivElement);
    expect(document.querySelector('textarea')).toBeNull();
    expect(dialog.textContent).toContain(id);
    expect(boundary.writeReport).not.toHaveBeenCalled();
    expect(reportButton('Retry / check delivery').disabled).toBe(false);
    vi.mocked(runtime.commands.captureDiagnostics).mockReturnValue({
      state: { sessionId: 'another-incident' },
      recentLogs: [],
    });
    reportButton('New report').click();
    await settle();
    const field = element('#debug-report-description', HTMLTextAreaElement);
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(overlays.getOpenGameOverlay()).toBe('debug-report');
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
    expect(document.querySelector('pre')?.textContent).toContain('another-incident');
    field.value = 'Another incident';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(reportButton('Send').disabled).toBe(false);
  }
);

test('a failed delivered-receipt reset keeps the receipt and recovery controls visible', async () => {
  const { id } = await startWithReportReceipt('delivered');
  boundary.writeReport.mockRejectedValue(new Error('storage quota'));
  reportButton('Report a problem').click();
  await settle();
  expect(document.querySelector('textarea')).toBeNull();
  expect(document.body.textContent).toContain(id);
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain(
    'Browser storage could not start a new report'
  );
  expect(reportButton('New report').disabled).toBe(false);
});

test('finishing a receipt reset after shell disposal does not reopen the report', async () => {
  const { overlays } = await startWithReportReceipt('delivered');
  const reset = deferred();
  boundary.writeReport.mockReturnValue(reset.promise);
  reportButton('Report a problem').click();
  if (!shell) {
    throw new Error('Missing shell');
  }
  await svelte.unmount(shell);
  shell = undefined;
  reset.release();
  await settle();
  expect(overlays.getOpenGameOverlay()).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
