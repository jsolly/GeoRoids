import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  document.body.classList.remove('in-play');
  vi.resetModules();
  vi.restoreAllMocks();
});

test('a flight that is already running stays unlabeled until an equippable pickup', async () => {
  document.body.classList.add('in-play');
  vi.resetModules();
  const { initializeSchematicEquipHint, schematicEquipHintAlpha, showSchematicEquipHint } =
    await import('../../../src/ui/schematicEquipHint');
  initializeSchematicEquipHint();
  expect(schematicEquipHintAlpha(1_000)).toBe(0);
  showSchematicEquipHint();
  expect(schematicEquipHintAlpha(1_000)).toBe(1);
});
