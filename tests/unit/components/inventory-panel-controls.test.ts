import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, expect, test, vi } from 'vitest';
import InventoryPanel from '../../../src/components/game/InventoryPanel.svelte';
import {
  mountShipSchematicCanvases,
  type SchematicSelection,
} from '../../../src/rendering/shipSchematicCanvas';
import type { InventoryView } from '../../../src/runtime/uiTypes';

const satellites = Array.from({ length: 60 }, (_, index) => ({
  id: `satellite-${index}`,
  name: `Survey satellite ${index}`,
  health: 8,
  maxHealth: 10,
  remainingSeconds: 90,
  equipped: false,
}));
const initialView: InventoryView = {
  page: 0,
  pages: 3,
  total: 60,
  silk: 7,
  description: 'Stored satellites retain their lifetime until equipped.',
  canEquipSatellite: true,
  kitName: 'Hauler',
  items: satellites.slice(0, 24),
  tools: [
    {
      id: 'tow_cable',
      name: 'Tow Cable',
      copy: 'Bring asteroids to a furnace.',
      available: true,
      selected: true,
    },
    {
      id: 'boost_coupling',
      name: 'Boost Coupling',
      copy: 'Cross the frontier quickly.',
      available: true,
      selected: false,
    },
    {
      id: 'resource_tap',
      name: 'Resource Tap',
      copy: 'Extract resources.',
      available: false,
      selected: false,
    },
  ],
};
let panel: ReturnType<typeof mount> | undefined;

async function settle() {
  flushSync();
  await Promise.resolve();
  flushSync();
}
function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name
  );
  if (!found) {
    throw new Error(`Missing button ${name}`);
  }
  return found;
}
async function start(
  drawCanvases?: (
    hull: HTMLCanvasElement,
    tool: HTMLCanvasElement
  ) => ReturnType<typeof mountShipSchematicCanvases>
) {
  document.body.innerHTML = '';
  const view = writable(initialView);
  const state = fromStore(view);
  const onequip = vi.fn();
  const onutility = vi.fn();
  const onclose = vi.fn();
  const disposeDrawing = vi.fn();
  const refreshDrawing = vi.fn();
  const draw = vi.fn(
    drawCanvases ?? (() => ({ dispose: disposeDrawing, refresh: refreshDrawing }))
  );
  const onpage = vi.fn((page: number) =>
    view.set({ ...initialView, page, items: satellites.slice(page * 24, (page + 1) * 24) })
  );
  panel = mount(InventoryPanel, {
    target: document.body,
    props: {
      get view() {
        return state.current;
      },
      onequip,
      onutility,
      onclose,
      onpage,
      draw,
    },
  });
  await settle();
  return { view, onequip, onutility, onclose, onpage, draw, disposeDrawing, refreshDrawing };
}
afterEach(async () => {
  if (panel) {
    await unmount(panel);
  }
  panel = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('all sixty stored satellites are reachable in bounded pages and commands carry exact identifiers', async () => {
  const { onpage, onequip, onutility, onclose } = await start();
  const seen = new Set<string>();
  for (let page = 0; page < 3; page++) {
    const items = [...document.querySelectorAll<HTMLButtonElement>('[data-inventory-equip]')];
    expect(items).toHaveLength(page === 2 ? 12 : 24);
    for (const item of items) {
      const id = item.dataset['inventoryEquip'];
      if (id) {
        seen.add(id);
      }
    }
    if (page < 2) {
      button('Next').click();
      expect(onpage).toHaveBeenLastCalledWith(page + 1);
      await settle();
    }
  }
  expect(seen.size).toBe(60);
  expect(button('Next').disabled).toBe(true);
  button('Previous').click();
  expect(onpage).toHaveBeenLastCalledWith(1);
  await settle();
  button('Equip Survey satellite 25').click();
  expect(onequip).toHaveBeenCalledExactlyOnceWith('satellite-25');
  button('Boost Coupling').click();
  expect(onutility).toHaveBeenCalledExactlyOnceWith('boost_coupling');
  const locked = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Resource Tap')
  );
  if (!locked) {
    throw new Error('Missing locked tool');
  }
  expect(locked.disabled).toBe(true);
  expect(locked.textContent).toContain('Locked · Find in spider nests');
  locked.click();
  expect(onutility).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('Spider silk: 7');
  expect(document.body.textContent).toContain('8/10 HP · 90s lifetime');
  button('Return to flight').click();
  expect(onclose).toHaveBeenCalledTimes(1);
});

test('ordinary snapshots retain Equip focus while disabled or removed equipment returns focus to flight', async () => {
  const { view } = await start();
  const equip = button('Equip Survey satellite 0');
  equip.focus();
  view.set({
    ...initialView,
    silk: 8,
    items: initialView.items.map((item) => ({ ...item, health: 7 })),
  });
  await settle();
  expect(document.activeElement).toBe(equip);
  view.set({ ...initialView, canEquipSatellite: false });
  await settle();
  expect(document.activeElement).toBe(button('Return to flight'));
  expect(equip.disabled).toBe(true);
  view.set(initialView);
  await settle();
  equip.focus();
  view.set({ ...initialView, items: initialView.items.slice(1), total: 59 });
  await settle();
  expect(document.activeElement).toBe(button('Return to flight'));
});

test('the panel supplies two accessible canvases and disposes their drawing lifetime on unmount', async () => {
  const { draw, disposeDrawing, refreshDrawing, view } = await start();
  const canvases = [...document.querySelectorAll('canvas')];
  expect(canvases).toHaveLength(2);
  expect(canvases.map((canvas) => canvas.getAttribute('aria-label'))).toEqual([
    'Hauler hull schematic',
    'Selected ship tool schematic',
  ]);
  expect(draw).toHaveBeenCalledExactlyOnceWith(canvases[0], canvases[1]);
  expect(refreshDrawing).toHaveBeenCalledTimes(1);
  view.set({ ...initialView, silk: 9 });
  await settle();
  expect(refreshDrawing).toHaveBeenCalledTimes(1);
  view.set({ ...initialView, kitName: 'Scout' });
  await settle();
  expect(refreshDrawing).toHaveBeenCalledTimes(2);
  if (!panel) {
    throw new Error('Missing panel');
  }
  await unmount(panel);
  panel = undefined;
  expect(disposeDrawing).toHaveBeenCalledTimes(1);
});

test('reduced-motion schematic selection repaints immediately without scheduling animation frames', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const schedule = vi.spyOn(window, 'requestAnimationFrame');
  let utility: 'tow_cable' | 'boost_coupling' = 'tow_cable';
  const read = vi.fn(
    (): SchematicSelection => ({
      kitId: 'hauler',
      haulerUtility: utility,
      scoutUtility: 'mineral_scan',
    })
  );
  const { view } = await start((hull, tool) => mountShipSchematicCanvases(hull, tool, read));
  const initialPaints = read.mock.calls.length;
  expect(initialPaints).toBeGreaterThan(0);
  expect(schedule).not.toHaveBeenCalled();
  view.set({ ...initialView, items: initialView.items.map((item) => ({ ...item, health: 6 })) });
  await settle();
  expect(read).toHaveBeenCalledTimes(initialPaints);
  utility = 'boost_coupling';
  view.set({
    ...initialView,
    tools: initialView.tools.map((option) => ({
      ...option,
      selected: option.id === 'boost_coupling',
    })),
  });
  await settle();
  expect(read).toHaveBeenCalledTimes(initialPaints + 1);
  expect(read).toHaveLastReturnedWith({
    kitId: 'hauler',
    haulerUtility: 'boost_coupling',
    scoutUtility: 'mineral_scan',
  });
  expect(schedule).not.toHaveBeenCalled();
  if (!panel) {
    throw new Error('Missing panel');
  }
  await unmount(panel);
  panel = undefined;
  window.dispatchEvent(new Event('resize'));
  expect(read).toHaveBeenCalledTimes(initialPaints + 1);
});
