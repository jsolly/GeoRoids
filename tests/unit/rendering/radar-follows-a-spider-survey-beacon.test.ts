import { afterEach, expect, test, vi } from 'vitest';
import { ExplorationMap } from '../../../shared/exploration';
import { WORLD } from '../../../shared/world';
import type { TerrainSpider } from '../../../shared-types';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { resetWorldExploration, setWorldExploration } from '../../../src/network/worldExploration';
import { setSpiderField } from '../../../src/physics/terrain/spiderSession';
import { computeHudLayout } from '../../../src/rendering/hud/hudLayout';
import { drawMiniMap } from '../../../src/rendering/hud/minimap';

afterEach(() => {
  setSpiderField(undefined);
  resetWorldExploration();
  vi.restoreAllMocks();
});

test('radar follows a living spider beacon and hides destroyed or distant beacons', () => {
  vi.spyOn(Date, 'now').mockReturnValue(2500);
  const player = new Player({
    id: 'scout',
    name: 'Scout',
    type: 'local',
    input: new MockPlayerInput(),
  });
  player.ship.position = { x: 0, y: 0 };
  const spider: TerrainSpider = {
    id: 'spider',
    position: { x: 300, y: 0 },
    angle: 0,
    health: 3,
    maxHealth: 3,
    phase: 'scuttling',
    targetId: null,
    probe: {
      id: 'probe',
      ownerId: 'scout',
      health: 20,
      maxHealth: 40,
      attachedAt: 1000,
      expiresAt: 301000,
      angle: 0,
      radialOffset: 0,
    },
  };
  const map = new ExplorationMap();
  map.reveal({ x: 0, y: 0 }, 1000);
  setWorldExploration(map.snapshot());
  setSpiderField({ spiders: [spider], nests: [] });
  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Expected real canvas');
  }
  const layout = computeHudLayout(canvas, { touchControls: false });
  const arcs = vi.spyOn(ctx, 'arc');
  const render = () => {
    arcs.mockClear();
    drawMiniMap(ctx, layout, player.ship, [], [], [], []);
    return arcs.mock.calls.filter((call) => call[2] === 7);
  };
  const first = render();
  expect(first).toHaveLength(1);
  expect(first[0]?.[0]).toBeCloseTo(
    layout.miniMap.x +
      layout.miniMap.size / 2 +
      ((300 / WORLD.minimapRadius) * layout.miniMap.size) / 2
  );
  spider.position.x = -300;
  const moved = render();
  expect(moved).toHaveLength(1);
  expect(moved[0]?.[0]).toBeCloseTo(
    layout.miniMap.x +
      layout.miniMap.size / 2 -
      ((300 / WORLD.minimapRadius) * layout.miniMap.size) / 2
  );
  spider.position.x = WORLD.minimapRadius * 3;
  expect(render()).toHaveLength(0);
  spider.position.x = 0;
  if (!spider.probe) {
    throw new Error('Expected attached probe');
  }
  spider.probe.health = 0;
  expect(render()).toHaveLength(0);
});
