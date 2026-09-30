import { expect, test } from 'vitest';
import { withScenarioCleanup } from '../../integration/utils/scenario-cleanup';

test('a failed shared-field body retains restoration errors and disposes both observers', async () => {
  const body = new Error('bitmap assertion failed');
  const restore = new Error('first page lost its controller');
  const dispose = new Error('second observer disposal failed');
  const completed: string[] = [];
  await expect(
    withScenarioCleanup(
      () => {
        throw body;
      },
      () => [
        () => {
          completed.push('first restore');
          throw restore;
        },
        () => {
          completed.push('second restore');
        },
        () => {
          completed.push('second observer');
          throw dispose;
        },
        () => {
          completed.push('first observer');
        },
      ]
    )
  ).rejects.toMatchObject({ errors: [body, restore, dispose] });
  expect(completed).toEqual([
    'first restore',
    'second restore',
    'second observer',
    'first observer',
  ]);
});

test('a body failure with successful restoration propagates the same error', async () => {
  const body = new Error('shared rock missing');
  await expect(
    withScenarioCleanup(
      () => {
        throw body;
      },
      () => []
    )
  ).rejects.toBe(body);
});

test('a successful body still fails when restoration fails', async () => {
  const restore = new Error('page closed during restoration');
  await expect(
    withScenarioCleanup(
      () => {},
      () => [
        () => {
          throw restore;
        },
      ]
    )
  ).rejects.toBe(restore);
});

test('failed pinball artifact capture retains the bounce failure and still restores and disposes handles', async () => {
  const bounce = new Error('authoritative shot did not bounce');
  const capture = new Error('artifact write failed');
  const steps: string[] = [];
  await expect(
    withScenarioCleanup(
      () => {
        throw bounce;
      },
      () => [
        async () => {
          await Promise.resolve();
          steps.push('capture');
          throw capture;
        },
        async () => {
          await Promise.resolve();
          steps.push('restore');
        },
        () => {
          steps.push('proof disposed');
        },
        () => {
          steps.push('field disposed');
        },
      ]
    )
  ).rejects.toMatchObject({ errors: [bounce, capture] });
  expect(steps).toEqual(['capture', 'restore', 'proof disposed', 'field disposed']);
});
