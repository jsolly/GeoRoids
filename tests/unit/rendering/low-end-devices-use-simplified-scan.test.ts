import { expect, test } from 'vitest';
import { classifyDevice } from '../../../src/rendering/deviceCategory';
import { resolveScanDetail } from '../../../src/rendering/scanDetailPolicy';

const desktop = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36',
  coarsePointer: false,
  deviceMemory: 16,
  hardwareConcurrency: 12,
};
const lowCapacityTouch = {
  userAgent: 'Mozilla/5.0 (Linux; Android 12; Tablet) Chrome/141.0.0.0 Safari/537.36',
  coarsePointer: true,
  deviceMemory: 4,
  hardwareConcurrency: 4,
};

test('the measured Fire model selects simple detail even when capacity hints are unavailable', () => {
  const fire = {
    userAgent:
      'Mozilla/5.0 (Linux; Android 9; KFTUWI Build/PS7326.3321N) AppleWebKit/537.36 (KHTML, like Gecko) Silk/132.5.6 like Chrome/132.0.6834.210 Safari/537.36',
    coarsePointer: true,
    deviceMemory: null,
    hardwareConcurrency: null,
  };
  expect(classifyDevice(fire)).toBe('low-end');
  expect(resolveScanDetail('', fire)).toEqual({ mode: 'simple', reason: 'known-fire-model' });
  expect(
    resolveScanDetail('', { ...desktop, userAgent: 'Android 9; kftuwi Build/PS7326' })
  ).toEqual({
    mode: 'simple',
    reason: 'known-fire-model',
  });
});

test.each(['NotKFTUWI', 'KFTUWIX', 'KFTUWI2', 'unknown_KFTUWI', 'KFTUWI_unknown'])(
  'a model substring in %s does not classify an unrelated device as the measured Fire',
  (userAgent) => {
    expect(classifyDevice({ ...desktop, userAgent })).toBe('high-end');
    expect(resolveScanDetail('', { ...desktop, userAgent })).toEqual({
      mode: 'full',
      reason: 'default-full',
    });
  }
);

test('simple automatic detail needs coarse input and both low-capacity hints', () => {
  expect(classifyDevice(lowCapacityTouch)).toBe('low-end');
  expect(resolveScanDetail('', lowCapacityTouch)).toEqual({
    mode: 'simple',
    reason: 'low-capacity-coarse-pointer',
  });
  expect(
    resolveScanDetail('', { ...lowCapacityTouch, deviceMemory: 0.5, hardwareConcurrency: 1 })
  ).toEqual({ mode: 'simple', reason: 'low-capacity-coarse-pointer' });
  expect(resolveScanDetail('', { ...lowCapacityTouch, coarsePointer: false })).toEqual({
    mode: 'full',
    reason: 'default-full',
  });
});

test('capable touch devices, iPhones without memory hints and desktops keep full detail', () => {
  for (const hints of [
    desktop,
    { ...lowCapacityTouch, deviceMemory: 8 },
    { ...lowCapacityTouch, hardwareConcurrency: 8 },
    { ...lowCapacityTouch, deviceMemory: 4.1 },
    { ...lowCapacityTouch, hardwareConcurrency: 5 },
    {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
      coarsePointer: true,
      deviceMemory: null,
      hardwareConcurrency: 4,
    },
    { ...lowCapacityTouch, deviceMemory: null, hardwareConcurrency: null },
  ]) {
    expect(resolveScanDetail('', hints)).toEqual({ mode: 'full', reason: 'default-full' });
  }
});

test.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  'missing or invalid memory hint %s preserves full detail',
  (deviceMemory) => {
    expect(classifyDevice({ ...lowCapacityTouch, deviceMemory })).toBe('unknown');
    expect(resolveScanDetail('', { ...lowCapacityTouch, deviceMemory })).toEqual({
      mode: 'full',
      reason: 'default-full',
    });
  }
);

test.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  'missing or invalid core hint %s preserves full detail',
  (hardwareConcurrency) => {
    expect(classifyDevice({ ...lowCapacityTouch, hardwareConcurrency })).toBe('unknown');
    expect(resolveScanDetail('', { ...lowCapacityTouch, hardwareConcurrency })).toEqual({
      mode: 'full',
      reason: 'default-full',
    });
  }
);

test('high-end requires both capacity hints and all other valid combinations are commodity', () => {
  expect(classifyDevice(desktop)).toBe('high-end');
  expect(classifyDevice({ ...lowCapacityTouch, deviceMemory: 8, hardwareConcurrency: 8 })).toBe(
    'high-end'
  );
  for (const hints of [
    { ...lowCapacityTouch, deviceMemory: 8 },
    { ...lowCapacityTouch, hardwareConcurrency: 8 },
    { ...lowCapacityTouch, deviceMemory: 7.5, hardwareConcurrency: 8 },
    { ...lowCapacityTouch, deviceMemory: 8, hardwareConcurrency: 7 },
    { ...lowCapacityTouch, coarsePointer: false },
  ]) {
    expect(classifyDevice(hints)).toBe('commodity');
  }
});

test.each(['', '?performance=0', '?performance=true', '?performance=Collect'])(
  'scan overrides have no effect outside diagnostics at %s',
  (search) => {
    const prefix = search ? `${search}&` : '?';
    expect(resolveScanDetail(`${prefix}scanDetail=simple`, desktop)).toEqual({
      mode: 'full',
      reason: 'default-full',
    });
    expect(resolveScanDetail(`${prefix}scanDetail=full`, lowCapacityTouch)).toEqual({
      mode: 'simple',
      reason: 'low-capacity-coarse-pointer',
    });
    expect(resolveScanDetail(`${prefix}scanDetail=invalid`, desktop)).toEqual({
      mode: 'full',
      reason: 'default-full',
    });
  }
);

test.each(['1', 'collect'])(
  'performance=%s allows forced detail on capable devices and explicit automatic selection',
  (performance) => {
    const prefix = `?performance=${performance}`;
    expect(resolveScanDetail(`${prefix}&scanDetail=simple`, desktop)).toEqual({
      mode: 'simple',
      reason: 'forced-simple',
    });
    expect(classifyDevice(desktop)).toBe('high-end');
    expect(resolveScanDetail(`${prefix}&scanDetail=full`, desktop)).toEqual({
      mode: 'full',
      reason: 'forced-full',
    });
    expect(resolveScanDetail(`${prefix}&scanDetail=full`, lowCapacityTouch)).toEqual({
      mode: 'full',
      reason: 'forced-full',
    });
    expect(classifyDevice(lowCapacityTouch)).toBe('low-end');
    expect(resolveScanDetail(`${prefix}&scanDetail=auto`, lowCapacityTouch)).toEqual({
      mode: 'simple',
      reason: 'low-capacity-coarse-pointer',
    });
    expect(resolveScanDetail(prefix, desktop)).toEqual({ mode: 'full', reason: 'default-full' });
  }
);

test.each(['', 'invalid', 'FULL', 'Simple'])(
  'diagnostics reject invalid scan detail %s with its accepted values',
  (value) => {
    expect(() => resolveScanDetail(`?performance=collect&scanDetail=${value}`, desktop)).toThrow(
      'scanDetail must be auto, full, or simple'
    );
  }
);
