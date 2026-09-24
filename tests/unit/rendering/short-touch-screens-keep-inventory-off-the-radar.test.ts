import { describe, expect, test } from 'vitest';
import { playfieldToggleOffsets } from '../../../src/rendering/canvasSurface';

const radar = { y: 96, size: 64 };

describe('playfield toggle stack', () => {
  test('a tall screen keeps Inventory above Map and clear of the radar', () => {
    const offsets = playfieldToggleOffsets(radar, false, 900);
    expect(offsets.schematicY).toBeLessThan(offsets.mapY);
    expect(offsets.storeY).toBeLessThan(offsets.schematicY);
    expect(offsets.mapY).toBeLessThan(radar.y);
  });

  test('a short touch screen puts Inventory under the radar and still above Map', () => {
    const offsets = playfieldToggleOffsets(radar, true, 400);
    expect(offsets.schematicY).toBe(radar.y + radar.size + 8);
    expect(offsets.mapY).toBe(offsets.schematicY + 52);
    expect(offsets.storeY).toBe(offsets.mapY + 52);
    expect(offsets.schematicY).toBeGreaterThanOrEqual(radar.y + radar.size);
  });
});
