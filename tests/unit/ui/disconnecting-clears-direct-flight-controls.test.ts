import { expect, test, vi } from 'vitest';
import { GameController } from '../../../src/core/gameController';

test.each([undefined, []])(
  'a disabled capability snapshot clears a live pilot even when targets are %s',
  (asteroids) => {
    const controls = GameController.getInstance().getAsteroidToolsController();
    controls.update({
      pilot: {
        alive: true,
        kitId: 'hauler',
        position: { x: 0, y: 0 },
        laserUpgrade: { charges: 6, expiresAt: Date.now() + 60000 },
      },
      targets: [{ id: 'rock', size: 30, position: { x: 100, y: 0 } }],
    });
    controls.selectTarget('rock');
    window.dispatchEvent(
      new CustomEvent('asteroidToolsSnapshot', { detail: { enabled: false, asteroids } })
    );
    const state = controls.getState();
    expect(state.pilot).toBeUndefined();
    expect(state.selectedTargetId).toBeUndefined();
    expect(state.reflectionPreview).toBeUndefined();
    expect(state.targets).toEqual([]);
    expect(controls.handleKeyDown({ code: 'KeyQ', repeat: false, preventDefault: vi.fn() })).toBe(
      false
    );
  }
);
