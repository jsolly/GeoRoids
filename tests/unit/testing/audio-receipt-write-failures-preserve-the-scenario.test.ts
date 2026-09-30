/* @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { writeScenarioReceipt } from '../../integration/utils/write-scenario-receipt';

test('an unavailable receipt directory preserves the scenario and capture failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-audio-receipt-'));
  try {
    const scenario = new Error('Replacement context stayed suspended');
    const capture = new Error('Native observation became unavailable');
    let failure: unknown;
    try {
      writeScenarioReceipt({
        path: join(directory, 'missing', 'receipt.json'),
        receipt: () => ({ stage: 'trusted-recovery' }),
        failures: [scenario, capture],
        message: 'Audio lifecycle failed',
      });
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected retained failures');
    }
    expect(failure.errors.slice(0, 2)).toEqual([scenario, capture]);
    expect(failure.errors).toHaveLength(3);
    expect(failure.errors[2]).toMatchObject({ code: 'ENOENT' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a circular receipt preserves the original failure and its serialization error', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-audio-receipt-'));
  try {
    const scenario = new Error('Old context did not close');
    const receipt: Record<string, unknown> = {};
    receipt['self'] = receipt;
    let failure: unknown;
    try {
      writeScenarioReceipt({
        path: join(directory, 'receipt.json'),
        receipt: () => receipt,
        failures: [scenario],
        message: 'Audio lifecycle failed',
      });
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected retained failures');
    }
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(scenario);
    expect(failure.errors[1]).toBeInstanceOf(TypeError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a retained receipt does not turn a failed scenario into a pass', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-audio-receipt-'));
  try {
    const path = join(directory, 'receipt.json');
    const scenario = new Error('Only-current-loop assertion failed');
    expect(() =>
      writeScenarioReceipt({
        path,
        receipt: () => ({ stage: 'replacement', failed: true }),
        failures: [scenario],
        message: 'Audio lifecycle failed',
      })
    ).toThrow(AggregateError);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ stage: 'replacement', failed: true });
    writeScenarioReceipt({
      path,
      receipt: () => ({ passed: true }),
      failures: [],
      message: 'Audio lifecycle failed',
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ passed: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
