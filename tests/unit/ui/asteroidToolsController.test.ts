import { beforeEach, expect, test, vi } from 'vitest';
import type { AsteroidToolAction } from '../../../shared-types';
import {
  AsteroidToolsController,
  type AsteroidToolsTarget,
} from '../../../src/asteroidTools/AsteroidToolsController';

const target: AsteroidToolsTarget = {
  id: 'roid-7',
  position: { x: 4, y: -2 },
  size: 26,
  material: 'metal',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

test('Q toggles the compact asteroid tools panel without sending a gameplay action', () => {
  const dispatchTool = vi.fn(() => true);
  const controller = new AsteroidToolsController({ dispatchTool });
  controller.setPilot({ id: 'pilot', alive: true, kitId: 'dart' });

  const preventDefault = vi.fn();
  expect(controller.handleKeyDown({ code: 'KeyQ', repeat: false, preventDefault })).toBe(true);
  expect(controller.getState().active).toBe(true);
  expect(controller.handleKeyDown({ code: 'KeyQ', repeat: true, preventDefault })).toBe(false);
  expect(dispatchTool).not.toHaveBeenCalled();
  expect(preventDefault).toHaveBeenCalledOnce();

  expect(controller.handleKeyDown({ code: 'Escape', repeat: false, preventDefault })).toBe(true);
  expect(controller.getState().active).toBe(false);
});

test('Hauler motion controls use the negotiated motion sink and reject non-Haulers', () => {
  const motion = vi.fn(() => true);
  const controller = new AsteroidToolsController({ dispatchMotionAction: motion });
  controller.setPilot({
    alive: true,
    kitId: 'hauler',
    asteroidMotion: { epoch: 8, mode: 'latched', ack: 3 },
  });
  controller.setTargets([target]);
  controller.selectTarget(target.id);

  expect(controller.requestMotion('release')).toBe(true);
  expect(motion).toHaveBeenCalledWith('release', undefined);

  controller.setPilot({ alive: true, kitId: 'dart' });
  expect(controller.requestMotion('release')).toBe(false);
});

test('Hauler anchor carries the selected second rock and brake reuses it before payload attach', () => {
  let now = 10_000;
  const payload: AsteroidToolsTarget = {
    id: 'roid-8',
    position: { x: 20, y: -2 },
    size: 22,
    material: 'ice',
  };
  const motion = vi.fn(() => true);
  const controller = new AsteroidToolsController({ now: () => now, dispatchMotionAction: motion });
  controller.setPilot({
    alive: true,
    kitId: 'hauler',
    asteroidMotion: { epoch: 8, mode: 'latched', ack: 3 },
  });
  controller.setTargets([target, payload]);
  controller.selectTarget(payload.id);

  expect(controller.requestMotion('anchor')).toBe(true);
  expect(motion).toHaveBeenLastCalledWith('anchor', payload.id);

  now += 251;
  expect(controller.requestMotion('brake')).toBe(true);
  expect(motion).toHaveBeenLastCalledWith('brake', payload.id);

  now += 251;
  motion.mockReturnValue(false);
  expect(controller.requestMotion('release')).toBe(false);
  expect(controller.getState().status).toBe('Brake requested');
});

test('Hauler latch sends only the selected target through the authoritative tool command', () => {
  const actions: AsteroidToolAction[] = [];
  const controller = new AsteroidToolsController({
    dispatchTool: (action) => {
      actions.push(action);
      return true;
    },
    dispatchMotionAction: vi.fn(() => true),
  });
  controller.setPilot({ alive: true, kitId: 'hauler' });
  controller.setTargets([target]);
  controller.selectTarget(target.id);

  expect(controller.requestMotion('latch')).toBe(true);
  expect(actions).toEqual([{ action: 'latch', targetId: target.id, sequence: 1 }]);
});

test('a quick latch-to-anchor transition is accepted while duplicate taps are collapsed', () => {
  const tool = vi.fn(() => true);
  const motion = vi.fn(() => true);
  const controller = new AsteroidToolsController({
    now: () => 100,
    dispatchTool: tool,
    dispatchMotionAction: motion,
  });
  controller.setPilot({ alive: true, kitId: 'hauler' });
  controller.setTargets([target, { ...target, id: 'payload' }]);
  controller.selectTarget(target.id);
  expect(controller.requestMotion('latch')).toBe(true);
  expect(controller.requestMotion('latch')).toBe(false);
  controller.setPilot({
    alive: true,
    kitId: 'hauler',
    asteroidMotion: { epoch: 1, mode: 'latched', ack: 0, asteroidId: target.id },
  });
  controller.selectTarget('payload');
  expect(controller.requestMotion('anchor')).toBe(true);
  expect(controller.requestMotion('anchor')).toBe(false);
  expect(motion).toHaveBeenCalledExactlyOnceWith('anchor', 'payload');
  expect(controller.requestMotion('release')).toBe(true);
});

test('death closes the tools panel and prevents actions until a living pilot returns', () => {
  const dispatchTool = vi.fn(() => true);
  const controller = new AsteroidToolsController({ dispatchTool });
  controller.setPilot({ alive: true, kitId: 'hauler' });
  controller.setActive(true);
  controller.setPilot({ alive: false, kitId: 'hauler' });

  expect(controller.getState().active).toBe(false);
  expect(controller.getState().selectedTargetId).toBeUndefined();
  expect(controller.requestMotion('latch')).toBe(false);
  expect(dispatchTool).not.toHaveBeenCalled();
});

test('snapshot update batches pilot, targets, and preview state for one UI render', () => {
  const onChange = vi.fn();
  const controller = new AsteroidToolsController({ onChange });
  controller.update({
    active: true,
    pilot: { alive: true, kitId: 'dart' },
    targets: [target],
    reflectionPreview: {
      segments: [],
      impacts: [],
      finalDirection: { x: 1, y: 0 },
      traveledDistance: 0,
      termination: 'stationary',
    },
  });

  expect(onChange).toHaveBeenCalledOnce();
  expect(controller.getState()).toMatchObject({
    active: true,
    targets: [target],
    pilot: { kitId: 'dart' },
  });
});

test('omitted tool updates preserve state while explicit clears remove the optional fields', () => {
  const controller = new AsteroidToolsController();
  controller.update({ pilot: { alive: true, kitId: 'hauler' }, targets: [target] });
  controller.selectTarget(target.id);
  controller.setActive(true);
  controller.update({ targets: [target] });
  expect(controller.getState().pilot?.kitId).toBe('hauler');
  expect(controller.getState().selectedTargetId).toBe(target.id);
  controller.update({ pilot: undefined, reflectionPreview: undefined });
  const cleared = controller.getState();
  expect(cleared.active).toBe(false);
  expect(cleared).not.toHaveProperty('pilot');
  expect(cleared).not.toHaveProperty('selectedTargetId');
  expect(cleared).not.toHaveProperty('selectedTarget');
  expect(cleared).not.toHaveProperty('reflectionPreview');
});

test('failed latch sends leave the status and debounce available for a real retry', () => {
  const dispatchTool = vi.fn(() => false);
  const controller = new AsteroidToolsController({ dispatchTool, now: () => 100 });
  controller.setPilot({ alive: true, kitId: 'hauler' });
  controller.setTargets([target]);
  controller.selectTarget(target.id);
  const before = controller.getState().status;
  expect(controller.requestMotion('latch')).toBe(false);
  expect(controller.getState().status).toBe(before);
  dispatchTool.mockReturnValue(true);
  expect(controller.requestMotion('latch')).toBe(true);
  expect(controller.getState().status).toBe('Latch requested');
});
