// @vitest-environment node
import assert from 'node:assert/strict';
import { ChildProcess, execFile } from 'node:child_process';
import process from 'node:process';
import { afterEach, expect, test, vi } from 'vitest';
import {
  ownedGroupAbsentInInventory,
  ownedProcessGroupAbsent,
} from '../../support/owned-process-group';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

test('native browser cleanup retains a surviving child after its group leader exits', () => {
  expect(ownedGroupAbsentInInventory('  1 1\n  65300 63527\n  65301 65301\n', 63527)).toBe(false);
  expect(ownedGroupAbsentInInventory('  1 1\n  65301 65301\n', 63527)).toBe(true);
});

test.each(['', 'PID PGID\n1 1\n', '1 1\n2 ?\n', '1 1\n1 2\n'])(
  'native browser cleanup retains its profile when the process inventory cannot prove group absence',
  (inventory) => expect(() => ownedGroupAbsentInInventory(inventory, 63527)).toThrow()
);

test('native browser cleanup propagates an unexpected signal failure unchanged', async () => {
  const failure = Object.assign(new Error('Unexpected signal failure'), { code: 'EIO' });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw failure;
  });
  await expect(ownedProcessGroupAbsent(63527)).rejects.toBe(failure);
});

test('native browser cleanup retains both the denied signal and failed inventory', async () => {
  const signalFailure = Object.assign(new Error('Signal denied'), { code: 'EPERM' });
  const inventoryFailure = new Error('Process inventory unavailable');
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw signalFailure;
  });
  vi.mocked(execFile).mockImplementation(() => {
    throw inventoryFailure;
  });
  const result = ownedProcessGroupAbsent(63527);
  await expect(result).rejects.toBeInstanceOf(AggregateError);
  await expect(result).rejects.toHaveProperty('errors', [signalFailure, inventoryFailure]);
});

test.each([
  ['a surviving descendant retains the owned group', '1 1\n65300 63527\n65301 65301\n', false],
  ['a complete inventory proves the owned group absent', '1 1\n65301 65301\n', true],
])(
  'native browser cleanup after a denied group probe: %s',
  async (_scenario, inventory, absent) => {
    const signalFailure = Object.assign(new Error('Signal denied'), { code: 'EPERM' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw signalFailure;
    });
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      assert(callback, 'Process inventory requires a completion callback');
      callback(null, inventory, '');
      return new ChildProcess();
    });
    await expect(ownedProcessGroupAbsent(63527)).resolves.toBe(absent);
  }
);
