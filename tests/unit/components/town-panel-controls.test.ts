import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CIVIC_LOTS, TOWN_HEARTH } from '../../../shared/furnaces';
import TownPanel from '../../../src/components/game/TownPanel.svelte';
import type { TownStoreView, TownView } from '../../../src/runtime/townStore';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

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
  const ontravel = vi.fn();
  panel = mount(TownPanel, {
    target: document.body,
    props: {
      get view() {
        return state.current;
      },
      onmode,
      onpurchase,
      onclose,
      travel: { source: TOWN_HEARTH, destinations: CIVIC_LOTS.slice(0, 1), rotation: 0 },
      ontravel,
    },
  });
  await settle();
  return { view, onmode, onpurchase, onclose, ontravel };
}
afterEach(async () => {
  if (panel) {
    await unmount(panel);
  }
  panel = undefined;
  vi.unstubAllGlobals();
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

test('travel mode renders furnace destinations and navigation removes them before returning to Store', async () => {
  const { onmode, ontravel } = await start();
  button('Fast Travel').click();
  expect(onmode).toHaveBeenCalledExactlyOnceWith('travel');
  await settle();
  const marker = document.querySelector<HTMLButtonElement>('[data-furnace-id]');
  if (!marker || !CIVIC_LOTS[0]) {
    throw new Error('Missing furnace destination');
  }
  marker.click();
  expect(ontravel).toHaveBeenCalledExactlyOnceWith(CIVIC_LOTS[0].id);
  button('Back to Town Square').click();
  await settle();
  expect(document.querySelector('.furnace-travel-viewport')).toBeNull();
  marker.click();
  expect(ontravel).toHaveBeenCalledTimes(1);
  button('Store').click();
  await settle();
  expect(document.querySelector('.furnace-travel-viewport')).toBeNull();
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
  await start({
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
  expect(document.querySelector('.furnace-travel-viewport')).toBeNull();
});
