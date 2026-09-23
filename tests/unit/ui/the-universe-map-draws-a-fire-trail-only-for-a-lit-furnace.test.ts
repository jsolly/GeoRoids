import { afterEach, expect, test, vi } from 'vitest';
import { ExplorationMap } from '../../../shared/exploration';
import { CIVIC_LOTS, civicLot, TOWN_HEARTH } from '../../../shared/furnaces';
import {
  bindPlayerNetworkPort,
  resetPlayerNetworkPort,
} from '../../../src/entities/player/playerNetworkPort';
import {
  setWorldExploration,
  setWorldMapAssets,
  worldFurnaces,
} from '../../../src/network/worldExploration';
import {
  closeUniverseMap,
  initializeUniverseMap,
  UNIVERSE_MAP_IDS,
} from '../../../src/ui/universeMap';

afterEach(() => {
  closeUniverseMap();
  worldFurnaces.replaceLit([]);
  setWorldMapAssets([]);
  setWorldExploration([]);
  resetPlayerNetworkPort();
  document.body.classList.remove('in-play');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountUniverseMap(): { toggle: HTMLButtonElement; ctx: CanvasRenderingContext2D } {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    },
  });
  document.body.classList.add('in-play');
  bindPlayerNetworkPort({
    getAllPlayers: () => [],
    setLocalPlayerName: () => undefined,
    updatePlayerState: () => undefined,
  });
  initializeUniverseMap();
  const toggle = document.querySelector(`#${UNIVERSE_MAP_IDS.toggle}`) as HTMLButtonElement;
  const canvas = document.querySelector(`#${UNIVERSE_MAP_IDS.canvas}`) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Expected a map canvas');
  }
  return { toggle, ctx };
}

test('the universe map draws a fire trail only for a lit furnace', () => {
  const furnace = civicLot('street-1-0');
  if (!furnace) {
    throw new Error('Missing furnace lot');
  }
  const { toggle, ctx } = mountUniverseMap();
  const fireTrail = () => {
    let count = 0;
    const spy = vi.spyOn(ctx, 'stroke').mockImplementation(function stroke(
      this: CanvasRenderingContext2D
    ) {
      if (String(this.strokeStyle).includes('244, 63, 94')) {
        count += 1;
      }
    });
    toggle.click();
    spy.mockRestore();
    closeUniverseMap();
    return count;
  };
  expect(fireTrail()).toBe(0);
  worldFurnaces.light(furnace.id, 'Ada');
  expect(fireTrail()).toBe(1);
});

test('the universe map marks furnace lots before that ground is explored', () => {
  const { toggle, ctx } = mountUniverseMap();
  const core = {
    id: 'loot:core',
    kind: 'laserCore' as const,
    name: 'Laser core',
    position: { x: 1_000, y: 1_000 },
  };
  setWorldMapAssets([
    {
      id: `furnace:${TOWN_HEARTH.id}`,
      kind: 'furnace',
      name: TOWN_HEARTH.name,
      position: { ...TOWN_HEARTH.position },
    },
    ...CIVIC_LOTS.map((lot) => ({
      id: `furnace:${lot.id}`,
      kind: 'foundation' as const,
      name: lot.name,
      position: { ...lot.position },
    })),
    core,
  ]);
  const locations = document.querySelector(`#${UNIVERSE_MAP_IDS.locations}`);
  const draw = (): { rings: number; text: string } => {
    let rings = 0;
    const arc = ctx.arc.bind(ctx);
    const spy = vi.spyOn(ctx, 'arc').mockImplementation(function ring(
      this: CanvasRenderingContext2D,
      ...args: Parameters<CanvasRenderingContext2D['arc']>
    ) {
      if (this.getLineDash().length > 0) {
        rings += 1;
      }
      arc(...args);
    });
    toggle.click();
    const text = locations?.textContent ?? '';
    spy.mockRestore();
    closeUniverseMap();
    return { rings, text };
  };
  const hidden = draw();
  expect(hidden.rings).toBe(CIVIC_LOTS.length);
  for (const lot of CIVIC_LOTS) {
    expect(hidden.text).toContain(lot.name);
  }
  expect(hidden.text).toContain(TOWN_HEARTH.name);
  expect(hidden.text).not.toContain(core.name);
  const explored = new ExplorationMap();
  explored.reveal(core.position, 400);
  setWorldExploration(explored.snapshot());
  const revealed = draw();
  expect(revealed.rings).toBe(CIVIC_LOTS.length);
  expect(revealed.text).toContain(core.name);
});
