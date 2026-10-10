import { expect, test } from 'vitest';
import {
  closeGameOverlay,
  getOpenGameOverlay,
  openGameOverlay,
  subscribeGameOverlay,
} from '../../../src/runtime/overlayState';

test('replacing Inventory with the map is one transition and a late Inventory close cannot dismiss it', () => {
  const transitions: string[] = [];
  const unsubscribe = subscribeGameOverlay((next, previous) => {
    expect(getOpenGameOverlay()).toBe(next);
    transitions.push(`${previous}->${next}`);
  });
  try {
    openGameOverlay('inventory');
    openGameOverlay('universe-map');
    closeGameOverlay('inventory');
    expect(getOpenGameOverlay()).toBe('universe-map');
    openGameOverlay('universe-map');
    expect(transitions).toEqual(['null->inventory', 'inventory->universe-map']);
    closeGameOverlay('universe-map');
    expect(getOpenGameOverlay()).toBeNull();
    unsubscribe();
    openGameOverlay('town-store');
    expect(transitions).toHaveLength(3);
  } finally {
    unsubscribe();
    const current = getOpenGameOverlay();
    if (current) {
      closeGameOverlay(current);
    }
  }
});
