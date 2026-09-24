import { afterEach, expect, test } from 'vitest';
import { ExplorationMap } from '../../../shared/exploration';
import { WORLD } from '../../../shared/world';
import { PALETTE } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { resetWorldExploration, setWorldExploration } from '../../../src/network/worldExploration';
import { computeHudLayout } from '../../../src/rendering/hud/hudLayout';
import { drawMiniMap } from '../../../src/rendering/hud/minimap';

afterEach(resetWorldExploration);

test.each([1280, 390])(
  'radar at width %i reveals ground as crew exploration arrives and resets to fog',
  (width) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = 900;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Expected real canvas');
    }
    const player = new Player({
      id: 'scout',
      name: 'Scout',
      type: 'local',
      input: new MockPlayerInput(),
    });
    player.ship.position = { x: 10000, y: 10000 };
    const layout = computeHudLayout(canvas, { touchControls: width < 500 });
    const sample = { x: 10437.5, y: 10437.5 };
    const pixelX = Math.floor(
      layout.miniMap.x +
        layout.miniMap.size / 2 +
        ((sample.x - player.ship.position.x) * layout.miniMap.size) / (2 * WORLD.minimapRadius)
    );
    const pixelY = Math.floor(
      layout.miniMap.y +
        layout.miniMap.size / 2 +
        ((sample.y - player.ship.position.y) * layout.miniMap.size) / (2 * WORLD.minimapRadius)
    );
    const render = (background: string) => {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawMiniMap(ctx, layout, player.ship, [], [], [], []);
      return Array.from(ctx.getImageData(pixelX, pixelY, 1, 1).data);
    };
    const fog = render(PALETTE.BG);
    // Fog must hide even a bright playfield underneath the HUD.
    expect(render('#ffffff')).toEqual(fog);
    const exploration = new ExplorationMap();
    exploration.reveal(sample, 200);
    setWorldExploration(exploration.snapshot());
    const revealed = render(PALETTE.BG);
    expect((revealed[1] ?? 0) - (fog[1] ?? 0)).toBeGreaterThan(25);
    const revealedOverBrightPlayfield = render('#ffffff');
    expect((revealedOverBrightPlayfield[1] ?? 0) - (fog[1] ?? 0)).toBeGreaterThan(25);
    resetWorldExploration();
    expect(render(PALETTE.BG)).toEqual(fog);
  }
);
