// @vitest-environment node
import { expect, test } from 'vitest';
import { clientSceneTraits, validateClientSceneFrames } from '../../../benchmarks/client-scenes';
import { parseArguments as parseBenchmarkArguments } from '../../../benchmarks/run';
import { parseSampleArguments, sampleOptions } from '../../../benchmarks/sample';

test('compiled client scenes keep their coupled frames and reject graphics scenarios on other runners', () => {
  expect(sampleOptions('client').scene).toBe('stationary');
  for (const scene of ['scan-transition', 'scan-wide', 'spider-field'] as const) {
    expect(sampleOptions('client', '42', 'tablet', 'canvas', '3', false, scene).scene).toBe(scene);
    const traits = clientSceneTraits(scene);
    expect(() =>
      validateClientSceneFrames(scene, traits.warmupFrames, traits.measuredFrames)
    ).not.toThrow();
    expect(() =>
      validateClientSceneFrames(scene, traits.warmupFrames, traits.measuredFrames + 1)
    ).toThrow('declared');
    expect(traits.warmupFrames + traits.measuredFrames).toBeLessThanOrEqual(3600);
  }
  expect(() =>
    sampleOptions('client', '42', 'desktop', 'canvas', '1', false, 'constructor')
  ).toThrow('Unknown client scene');
  expect(() =>
    sampleOptions('server', '42', 'desktop', 'canvas', '1', false, 'stationary')
  ).toThrow('Only client');
  expect(() => clientSceneTraits('anything')).toThrow('Unknown client scene');
  expect(
    parseBenchmarkArguments(['measure', 'client', '--revision', 'HEAD', '--scene', 'scan-wide'])
      .scene
  ).toBe('scan-wide');
  expect(
    parseSampleArguments([
      '--kind',
      'client',
      '--scene',
      'spider-field',
      '--output',
      '/tmp/scene-report.json',
    ]).scene
  ).toBe('spider-field');
  expect(() =>
    parseBenchmarkArguments(['measure', 'server', '--revision', 'HEAD', '--scene', 'stationary'])
  ).toThrow('Only client');
  expect(() =>
    parseSampleArguments([
      '--kind',
      'client',
      '--scene',
      'untracked',
      '--output',
      '/tmp/scene-report.json',
    ])
  ).toThrow('Unknown client scene');
  // Stationary callers retain the original bounded configurable frame window.
  expect(() => validateClientSceneFrames('stationary', 30, 120)).not.toThrow();
  expect(() => validateClientSceneFrames('stationary', 15, 45)).not.toThrow();
});
