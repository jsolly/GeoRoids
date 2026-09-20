import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  document.body.classList.remove('in-play');
  vi.resetModules();
  vi.doUnmock('../../../src/ui/viewportChrome');
  vi.restoreAllMocks();
});

test('a touch join that is already in play still shows the hold-to-equip reminder', async () => {
  document.body.classList.add('in-play');
  vi.resetModules();
  vi.doMock('../../../src/ui/viewportChrome', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/ui/viewportChrome')>();
    return {
      ...actual,
      shouldUseTouchControls: () => true,
    };
  });
  const { initializeSchematicJoinHint, schematicJoinHintAlpha } = await import(
    '../../../src/ui/schematicJoinHint'
  );
  initializeSchematicJoinHint();
  expect(schematicJoinHintAlpha(1_000)).toBe(1);
});
