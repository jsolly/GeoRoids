import { afterEach, expect, test, vi } from 'vitest';
import { AsteroidGestures } from '../../../src/asteroidTools/AsteroidGestures';
import { AsteroidToolsController } from '../../../src/asteroidTools/AsteroidToolsController';

let gestures: AsteroidGestures | undefined;
afterEach(() => {
  gestures?.dispose();
  document.body.replaceChildren();
});

function setup() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const capture = new Set<number>();
  canvas.setPointerCapture = (id) => {
    capture.add(id);
  };
  canvas.hasPointerCapture = (id) => capture.has(id);
  canvas.releasePointerCapture = (id) => {
    capture.delete(id);
  };
  const tool = vi.fn(() => true);
  const motion = vi.fn(() => true);
  const controller = new AsteroidToolsController({
    dispatchTool: tool,
    dispatchMotionAction: motion,
  });
  controller.update({
    pilot: { alive: true, kitId: 'hauler', position: { x: 0, y: 0 } },
    targets: [{ id: 'rock', position: { x: 100, y: 100 }, size: 30 }],
  });
  let playing = true;
  gestures = new AsteroidGestures(canvas, controller, {
    isPlaying: () => playing,
    project: (point) => ({ ...point, scale: 1 }),
  });
  const pointer = (
    type: string,
    x = 100,
    y = 100,
    pointerType = 'touch',
    button = 0,
    pointerId = 1
  ) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button, cancelable: true });
    Object.defineProperties(event, {
      pointerType: { value: pointerType },
      pointerId: { value: pointerId },
    });
    canvas.dispatchEvent(event);
  };
  return {
    canvas,
    tool,
    motion,
    controller,
    pointer,
    stop: () => {
      playing = false;
    },
  };
}

test('tapping a rock latches once and a second rock becomes the payload while latched', () => {
  const { pointer, controller, tool, motion } = setup();
  pointer('pointerdown');
  pointer('pointerup');
  expect(tool).toHaveBeenCalledExactlyOnceWith({ action: 'latch', targetId: 'rock', sequence: 1 });
  controller.setPilot({
    alive: true,
    kitId: 'hauler',
    asteroidMotion: { epoch: 1, mode: 'latched', ack: 0, asteroidId: 'primary' },
  });
  pointer('pointerdown');
  pointer('pointerup');
  expect(motion).toHaveBeenCalledExactlyOnceWith('anchor', 'rock');
});

test.each([
  [-65, 0, 'brake'],
  [65, 0, 'spin'],
  [0, 65, 'release'],
  [0, -65, 'anchor'],
] as const)('a flick of %s,%s sends %s without also latching', (dx, dy, action) => {
  const { pointer, controller, tool, motion } = setup();
  controller.setPilot({
    alive: true,
    kitId: 'hauler',
    asteroidMotion: { epoch: 1, mode: 'latched', ack: 0, asteroidId: 'primary' },
  });
  pointer('pointerdown');
  pointer('pointerup', 100 + dx, 100 + dy);
  expect(motion).toHaveBeenCalledWith(
    action,
    action === 'anchor' || action === 'brake' ? 'rock' : undefined
  );
  expect(tool).not.toHaveBeenCalled();
});

test.each([
  'pointercancel',
  'lostpointercapture',
  'blur',
  'stop',
  'death',
])('%s between press and release discards the pending action', (reason) => {
  const { pointer, tool, motion, stop, controller } = setup();
  pointer('pointerdown');
  if (reason === 'blur') {
    window.dispatchEvent(new Event('blur'));
  } else if (reason === 'stop') {
    stop();
  } else if (reason === 'death') {
    controller.setPilot({ alive: false, kitId: 'hauler' });
  } else {
    pointer(reason);
  }
  pointer('pointerup');
  expect(tool).not.toHaveBeenCalled();
  expect(motion).not.toHaveBeenCalled();
});

test('left and right mouse clicks keep their gameplay roles; middle click performs the tool action', () => {
  const { pointer, tool } = setup();
  for (const button of [0, 2]) {
    pointer('pointerdown', 100, 100, 'mouse', button);
    pointer('pointerup', 100, 100, 'mouse', button);
  }
  expect(tool).not.toHaveBeenCalled();
  pointer('pointerdown', 100, 100, 'mouse', 1);
  pointer('pointerup', 100, 100, 'mouse', 1);
  expect(tool).toHaveBeenCalledOnce();
});

test('another finger cannot finish or replace a pending gesture', () => {
  const { pointer, tool } = setup();
  pointer('pointerdown');
  pointer('pointerdown', 400, 400, 'touch', 0, 2);
  pointer('pointerup', 400, 400, 'touch', 0, 2);
  expect(tool).not.toHaveBeenCalled();
  pointer('pointerup');
  expect(tool).toHaveBeenCalledOnce();
});
