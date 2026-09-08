import { expect, test } from 'vitest';

import { canvasManager } from '../../../src/rendering/canvas';
import { projectWorldToScreenInto } from '../../../src/rendering/playfieldCamera';

test('worldToScreenInto writes into the provided object and returns it', () => {
  const out = { x: 1, y: 2 };
  const result = canvasManager.worldToScreenInto(out, { x: 10, y: 20 }, { x: 3, y: 4 });
  expect(result).toBe(out);
  expect(out).toEqual({ x: 7, y: 16 });
});

test('projectWorldToScreenInto writes into the provided object and returns it', () => {
  const out = { x: 0, y: 0 };
  const result = projectWorldToScreenInto(
    out,
    { x: 20, y: 10 },
    { x: 4, y: 2 },
    {
      width: 200,
      height: 100,
    }
  );
  expect(result).toBe(out);
  expect(out).toEqual({ x: 116, y: 58 });
});
