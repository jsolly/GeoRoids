import { expect, test } from 'vitest';
import { TowLifecycle, type TowSample } from '../../../support/towLifecycle';

const selection = { pilotId: 'hauler', targetId: 'captive', epoch: 3 };

function sample(overrides: Partial<TowSample> = {}): TowSample {
  return {
    pilotId: selection.pilotId,
    epoch: selection.epoch,
    targetId: selection.targetId,
    health: 140,
    exploding: false,
    inTransit: false,
    at: 10,
    ...overrides,
  };
}

test('a delayed reader retains the rendered attachment and subsequent release by value', () => {
  const observer = new TowLifecycle(selection);
  const attachment = sample();
  observer.observe(attachment, true);
  attachment.targetId = null;
  observer.observe(sample({ targetId: null, at: 20 }));
  const retained = observer.snapshot();
  expect(retained.attached).toEqual(sample());
  expect(retained.released).toEqual(sample({ targetId: null, at: 20 }));
  expect(retained.failure).toBeNull();
  expect(observer.finish()).toEqual(retained);
  if (!retained.attached) {
    throw new Error('Missing retained attachment');
  }
  retained.attached.health = 0;
  expect(observer.snapshot().attached?.health).toBe(140);
});

test('model attachment without a cable draw and release without attachment cannot prove rescue', () => {
  const observer = new TowLifecycle(selection);
  observer.observe(sample());
  observer.observe(sample({ targetId: null, at: 20 }), true);
  expect(observer.snapshot()).toEqual({ attached: null, released: null, failure: null });
  expect(() => observer.finish()).toThrow(/not both observed/u);
});

test.each([
  { pilotId: 'other-pilot' },
  { epoch: 4 },
  { epoch: undefined },
  { health: 0 },
  { exploding: true },
  { inTransit: true },
  { targetId: 'different-spider' },
])('a changed participant or fixture cannot be erased by a later good frame: %j', (invalid) => {
  const observer = new TowLifecycle(selection);
  observer.observe(sample(invalid), true);
  observer.observe(sample(), true);
  observer.observe(sample({ targetId: null, at: 20 }));
  expect(observer.snapshot().failure).not.toBeNull();
  expect(observer.snapshot().attached).toBeNull();
  expect(observer.snapshot().released).toBeNull();
  expect(() => observer.finish()).toThrow();
});

test('death and respawn after release still invalidate the original live pilot', () => {
  const observer = new TowLifecycle(selection);
  observer.observe(sample(), true);
  observer.observe(sample({ targetId: null, at: 20 }));
  observer.observe(sample({ targetId: null, health: 0, at: 30 }));
  observer.observe(sample({ targetId: null, epoch: 4, at: 40 }));
  expect(observer.snapshot().failure).not.toBeNull();
  expect(() => observer.finish()).toThrow(/fixture epoch changed/u);
});

test('a release preceding its attachment and an unexpected relatch cannot prove one rescue', () => {
  const early = new TowLifecycle(selection);
  early.observe(sample(), true);
  early.observe(sample({ targetId: null, at: 9 }));
  expect(early.snapshot().failure).not.toBeNull();
  expect(() => early.finish()).toThrow(/did not follow/u);
  const relatch = new TowLifecycle(selection);
  relatch.observe(sample(), true);
  relatch.observe(sample({ targetId: null, at: 20 }));
  relatch.observe(sample({ at: 30 }), true);
  expect(relatch.snapshot().failure).not.toBeNull();
  expect(() => relatch.finish()).toThrow(/reattached/u);
});
