import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, expect, test, vi } from 'vitest';
import PhoneCollector from '../../../src/components/game/PhoneCollector.svelte';
import { ClientPerformanceMetrics } from '../../../src/diagnostics/performanceMetrics';
import {
  createPhoneCollector,
  type PhoneCollectorDownload,
  type PhoneCollectorView,
} from '../../../src/diagnostics/phoneCollector';

const ready: PhoneCollectorView = {
  phase: 'ready',
  status: 'Performance: ready',
  device: '',
  conditions: '',
  canStart: true,
  canStop: false,
  canRecover: true,
  canDownload: false,
};
let component: ReturnType<typeof mount> | undefined;
let disposeController: (() => void) | undefined;
afterEach(async () => {
  if (component) {
    await unmount(component);
  }
  component = undefined;
  disposeController?.();
  disposeController = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});
function button(name: string) {
  const result = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  if (!result) {
    throw new Error(`Missing ${name}`);
  }
  return result;
}
function start(
  view = ready,
  ondownload: () => Promise<PhoneCollectorDownload | null> = async () => null
) {
  document.body.replaceChildren();
  const model = writable(view);
  const state = fromStore(model);
  const onstart = vi.fn();
  const onstop = vi.fn();
  const onrecover = vi.fn();
  component = mount(PhoneCollector, {
    target: document.body,
    props: {
      get view() {
        return state.current;
      },
      onstart,
      onstop,
      onrecover,
      ondownload,
    },
  });
  flushSync();
  return { model, onstart, onstop, onrecover };
}

test('phone controls submit bounded metadata and keep focus when recording hides the initiating controls', () => {
  const { model, onstart, onstop, onrecover } = start();
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Performance: ready');
  const device = document.querySelector<HTMLInputElement>('[aria-label="Device model and OS"]');
  const conditions = document.querySelector<HTMLInputElement>('[aria-label="Test conditions"]');
  if (!device || !conditions) {
    throw new Error('Missing metadata');
  }
  expect(device.maxLength).toBe(256);
  expect(conditions.maxLength).toBe(512);
  device.value = 'iPhone / iOS';
  device.dispatchEvent(new Event('input', { bubbles: true }));
  conditions.value = 'Wi-Fi / cool';
  conditions.dispatchEvent(new Event('input', { bubbles: true }));
  model.set({ ...ready });
  flushSync();
  expect(device.value).toBe('iPhone / iOS');
  expect(conditions.value).toBe('Wi-Fi / cool');
  button('Start').focus();
  button('Start').click();
  expect(onstart).toHaveBeenCalledExactlyOnceWith('iPhone / iOS', 'Wi-Fi / cool');
  model.set({
    ...ready,
    phase: 'recording',
    status: 'Performance: recording',
    canStart: false,
    canStop: true,
    canRecover: false,
  });
  flushSync();
  expect(document.activeElement).toBe(document.querySelector('[role="status"]'));
  expect(document.querySelector('details')).toBeNull();
  expect(
    [...document.querySelectorAll('button')].map((element) => element.textContent?.trim())
  ).toEqual(['Stop']);
  button('Stop').click();
  expect(onstop).toHaveBeenCalledOnce();
  model.set({
    ...ready,
    phase: 'stopped',
    device: 'Recovered phone',
    conditions: 'Recovered conditions',
    canDownload: true,
  });
  flushSync();
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="Device model and OS"]')?.value
  ).toBe('Recovered phone');
  button('Recover last session').click();
  expect(onrecover).toHaveBeenCalledOnce();
});

test('a storage rejection is presented in the mounted collector status', async () => {
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('Storage denied');
    },
  });
  const model = writable(ready);
  const state = fromStore(model);
  const controller = createPhoneCollector(new ClientPerformanceMetrics(true), () =>
    model.set(controller.read())
  );
  disposeController = controller.dispose;
  let pending = Promise.resolve();
  document.body.replaceChildren();
  component = mount(PhoneCollector, {
    target: document.body,
    props: {
      get view() {
        return state.current;
      },
      onstart: (device: string, conditions: string) => {
        pending = controller.start(device, conditions);
      },
      onstop: controller.stop,
      onrecover: controller.recover,
      ondownload: controller.download,
    },
  });
  flushSync();
  button('Start').click();
  await pending;
  flushSync();
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Incomplete: Storage denied');
});

test('download uses the mounted anchor and unmount revokes every pending object URL', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const createObjectURL = vi.fn(() => 'blob:phone-recording');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    }
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const result = { blob: new Blob(['sample']), filename: 'phone.json' };
  const ondownload = vi.fn(async () => result);
  start({ ...ready, phase: 'stopped', canDownload: true }, ondownload);
  button('Download').click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(ondownload).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="status"]')?.textContent).not.toContain('failed');
  expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(result.blob);
  expect(click).toHaveBeenCalledOnce();
  expect(document.querySelector('a')?.getAttribute('href')).toBe('blob:phone-recording');
  expect(document.querySelector('a')?.download).toBe('phone.json');
  if (!component) {
    throw new Error('Missing collector');
  }
  await unmount(component);
  component = undefined;
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:phone-recording');
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['resolve', 'reject'])(
  'a download settling by %s after unmount cannot create a URL or touch a new collector',
  async (settlement) => {
    const createObjectURL = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = createObjectURL;
      }
    );
    const result = Promise.withResolvers<PhoneCollectorDownload | null>();
    start({ ...ready, phase: 'stopped', canDownload: true }, () => result.promise);
    button('Download').click();
    if (!component) {
      throw new Error('Missing collector');
    }
    await unmount(component);
    component = undefined;
    start();
    if (settlement === 'resolve') {
      result.resolve({ blob: new Blob(['late']), filename: 'late.json' });
    } else {
      result.reject(new Error('Late failure'));
    }
    await Promise.resolve();
    flushSync();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Performance: ready');
  }
);
