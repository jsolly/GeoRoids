/* @vitest-environment node */

import { expect, test } from 'vitest';
import { createLostAttributionTally } from '../../../server/communication/lostAttribution';

test('an incident that ends between upgrades still reports every one of them', () => {
  const tally = createLostAttributionTally();

  // The defect this guards, which shipped once: reporting on the next upgrade
  // after an interval elapsed meant an incident ending inside the interval was
  // reported as exactly 1 and the rest were dropped with no record. A
  // fleet-wide outage worth thousands of upgrades logged one line claiming one.
  for (let upgrade = 0; upgrade < 5_000; upgrade += 1) {
    tally.note();
  }
  expect(tally.flush()).toBe(5_000);

  // Flushing is what resets it, so nothing is counted twice.
  expect(tally.flush()).toBeNull();
});

test('one caller withholding the header reads differently from a fleet losing it', () => {
  const tally = createLostAttributionTally();

  // Volume is the only thing that separates the two, which is why the record
  // carries it at all.
  tally.note();
  expect(tally.flush()).toBe(1);

  for (let upgrade = 0; upgrade < 100; upgrade += 1) {
    tally.note();
  }
  expect(tally.flush()).toBe(100);
});

test('a quiet interval reports nothing rather than a zero', () => {
  const tally = createLostAttributionTally();

  // The caller logs whatever this returns, so returning 0 would write a warning
  // every cleanup tick on a healthy server.
  expect(tally.flush()).toBeNull();
  tally.note();
  expect(tally.flush()).toBe(1);
  expect(tally.flush()).toBeNull();
});
