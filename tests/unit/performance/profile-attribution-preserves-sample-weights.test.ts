import { expect, test } from 'vitest';
import { allocationAttribution, cpuAttribution } from '../../../benchmarks/profile-attribution';

const callFrame = (functionName: string) => ({ functionName, url: 'fixture.ts', lineNumber: 0 });

test('recursive profiler stacks count each location once and retain independent self weights', () => {
  const cpu = cpuAttribution({
    nodes: [
      { id: 1, callFrame: callFrame('root'), children: [2] },
      { id: 2, callFrame: callFrame('recur'), children: [3] },
      { id: 3, callFrame: callFrame('recur') },
    ],
    samples: [2, 3, 1],
    timeDeltas: [10, 20, 70],
  });
  expect(cpu.totalMicroseconds).toBe(100);
  expect(cpu.self.find((row) => row.location.startsWith('recur'))?.weight).toBe(30);
  expect(cpu.inclusive.find((row) => row.location.startsWith('recur'))?.weight).toBe(30);
  expect(cpu.inclusive.find((row) => row.location.startsWith('root'))?.weight).toBe(100);
  const allocation = allocationAttribution({
    head: {
      callFrame: callFrame('recur'),
      selfSize: 100,
      children: [{ callFrame: callFrame('recur'), selfSize: 200, children: [] }],
    },
  });
  expect(allocation.estimatedBytes).toBe(300);
  expect(allocation.self[0]?.weight).toBe(300);
  expect(allocation.inclusive[0]?.weight).toBe(300);
});

test('missing samples, missing referenced nodes and cyclic stacks cannot produce attribution', () => {
  const nodes = [{ id: 1, callFrame: callFrame('root') }];
  expect(() => cpuAttribution({ nodes, samples: [1], timeDeltas: [] })).toThrow('weights');
  expect(() => cpuAttribution({ nodes, samples: [2], timeDeltas: [10] })).toThrow('missing node');
  expect(() =>
    cpuAttribution({
      nodes: [{ id: 1, callFrame: callFrame('root'), children: [1] }],
      samples: [1],
      timeDeltas: [10],
    })
  ).toThrow('cycle');
  expect(() =>
    allocationAttribution({ head: { callFrame: callFrame('root'), selfSize: 0, children: [] } })
  ).toThrow('no sampled bytes');
});
