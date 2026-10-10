import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, expect, test, vi } from 'vitest';
import TownPanel from '../../../src/components/game/TownPanel.svelte';
import type { TownStoreView, TownView } from '../../../src/runtime/townStore';

const initialView: TownStoreView = {
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
    {
      id: 'beacon',
      name: 'Beacon',
      cost: 100,
      level: 1,
      owned: true,
      locked: false,
      available: false,
    },
    {
      id: 'tower',
      name: 'Tower',
      cost: 1000,
      level: 4,
      owned: false,
      locked: true,
      available: false,
    },
    {
      id: 'plaque',
      name: 'Plaque',
      cost: 700,
      level: 1,
      owned: false,
      locked: false,
      available: false,
    },
  ],
};
let panel: ReturnType<typeof mount> | undefined;

async function settle() {
  flushSync();
  await Promise.resolve();
  flushSync();
}
function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!match) {
    throw new Error(`Missing ${label}`);
  }
  return match;
}
async function start(initial = initialView) {
  document.body.innerHTML = '';
  const view = writable(initial);
  const state = fromStore(view);
  const onmode = vi.fn((mode: TownView) => view.update((previous) => ({ ...previous, mode })));
  const onpurchase = vi.fn();
  const onclose = vi.fn();
  const disposeTravel = vi.fn();
  const mountTravel = vi.fn((host: HTMLElement) => {
    expect(host.id).toBe('legacy-furnace-travel');
    expect(host.childNodes).toHaveLength(0);
    const marker = document.createElement('span');
    marker.textContent = 'Imperative travel map';
    host.append(marker);
    return () => {
      marker.remove();
      disposeTravel();
    };
  });
  panel = mount(TownPanel, {
    target: document.body,
    props: {
      get view() {
        return state.current;
      },
      onmode,
      onpurchase,
      onclose,
      mountTravel,
    },
  });
  await settle();
  return { view, onmode, onpurchase, onclose, mountTravel, disposeTravel };
}
afterEach(async () => {
  if (panel) {
    await unmount(panel);
  }
  panel = undefined;
});

test('Town Square offers exact purchase commands while owned, locked and unaffordable offers stay disabled', async () => {
  const { view, onmode, onpurchase, onclose } = await start();
  expect(document.body.textContent).toContain('Town Hearth');
  expect(document.body.textContent).toContain('Bank 500 · Settlement level 2');
  button('Store').click();
  expect(onmode).toHaveBeenCalledExactlyOnceWith('store');
  await settle();
  button('Buy Crew Banner').click();
  expect(onpurchase).toHaveBeenCalledExactlyOnceWith('banner');
  for (const label of ['Purchased', 'Unlocks at level 4', 'Buy Plaque']) {
    expect(button(label).disabled).toBe(true);
    button(label).click();
  }
  expect(onpurchase).toHaveBeenCalledTimes(1);
  button('Buy Crew Banner').focus();
  view.update((previous) => ({
    ...previous,
    status: 'Crew Banner purchased.',
    offers: previous.offers.map((offer) =>
      offer.id === 'banner' ? { ...offer, owned: true, available: false } : offer
    ),
  }));
  await settle();
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Crew Banner purchased.');
  expect(document.activeElement).toBe(button('Return to flight'));
  button('Back to Town Square').click();
  expect(onmode).toHaveBeenLastCalledWith('entry');
  await settle();
  expect(document.querySelectorAll('[data-town-offer]')).toHaveLength(0);
  button('Return to flight').click();
  expect(onclose).toHaveBeenCalledTimes(1);
});

test('travel mode mounts one isolated map host and navigation disposes it before returning to Store', async () => {
  const { onmode, mountTravel, disposeTravel } = await start();
  button('Fast Travel').click();
  expect(onmode).toHaveBeenCalledExactlyOnceWith('travel');
  await settle();
  expect(mountTravel).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#legacy-furnace-travel')?.textContent).toBe(
    'Imperative travel map'
  );
  button('Back to Town Square').click();
  await settle();
  expect(disposeTravel).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#legacy-furnace-travel')).toBeNull();
  button('Store').click();
  await settle();
  expect(mountTravel).toHaveBeenCalledTimes(1);
});

test('keyed offers retain focus across bank ticks and transfer focus when buying becomes unavailable', async () => {
  const store: TownStoreView = { ...initialView, mode: 'store' };
  const { view } = await start(store);
  const buy = button('Buy Crew Banner');
  buy.focus();
  view.set({ ...store, bank: 450 });
  await settle();
  expect(button('Buy Crew Banner')).toBe(buy);
  expect(document.activeElement).toBe(buy);
  for (const reason of ['purchased', 'locked', 'insufficient']) {
    view.set(store);
    await settle();
    buy.focus();
    view.set({
      ...store,
      bank: reason === 'insufficient' ? 0 : store.bank,
      offers: store.offers.map((offer) =>
        offer.id === 'banner'
          ? {
              ...offer,
              available: false,
              owned: reason === 'purchased',
              locked: reason === 'locked',
            }
          : offer
      ),
    });
    await settle();
    expect(buy.disabled).toBe(true);
    expect(document.activeElement).toBe(button('Return to flight'));
  }
});

test('a remote furnace exposes travel without a Town Square back action and unmount disposes the map', async () => {
  const { disposeTravel } = await start({
    ...initialView,
    mode: 'travel',
    atTown: false,
    title: 'Furnace travel',
  });
  expect(
    [...document.querySelectorAll('button')].some((candidate) =>
      candidate.textContent?.includes('Back to Town Square')
    )
  ).toBe(false);
  if (!panel) {
    throw new Error('Missing panel');
  }
  await unmount(panel);
  panel = undefined;
  expect(disposeTravel).toHaveBeenCalledTimes(1);
});
