/* @vitest-environment node */
import { expect, test } from 'vitest';
import type { WebSocket } from 'ws';
import {
  GAMEPLAY_MESSAGE_BUDGET,
  GameplayMessageBudget,
} from '../../../server/communication/messageBudget';

/** The budget keys off socket identity only; a bare object stands in for a real socket. */
function socket(): WebSocket {
  return {} as WebSocket;
}

const POSE_BYTES = 220;

test('an honest 60 Hz client with occasional shots never trips the budget over a full minute', () => {
  let now = 0;
  const budget = new GameplayMessageBudget({ now: () => now });
  const ws = socket();
  let rejected = 0;
  // 60 poses/s for 60 s, plus a shot every 5th frame — well above ordinary play.
  for (let frame = 0; frame < 60 * 60; frame++) {
    now += 1000 / 60;
    if (budget.admit(ws, POSE_BYTES) === 'rate-limited') {
      rejected++;
    }
    if (frame % 5 === 0 && budget.admit(ws, 90) === 'rate-limited') {
      rejected++;
    }
  }
  expect(rejected).toBe(0);
  expect(budget.diagnostics()).toEqual({ rejected: 0, disconnected: 0 });
});

test('a message flood is refused once the burst drains, and counts as one disconnect', () => {
  let now = 0;
  const budget = new GameplayMessageBudget({ now: () => now });
  const ws = socket();
  const outcomes: string[] = [];
  // A burst with no time passing: the bucket starts full and then empties.
  for (let i = 0; i < GAMEPLAY_MESSAGE_BUDGET.messageBurst + 50; i++) {
    outcomes.push(budget.admit(ws, POSE_BYTES));
  }
  const accepted = outcomes.filter((outcome) => outcome === 'ok').length;
  expect(accepted).toBe(GAMEPLAY_MESSAGE_BUDGET.messageBurst);
  expect(outcomes.at(-1)).toBe('rate-limited');
  // Every message after the burst is refused, but the socket is one disconnect.
  expect(budget.diagnostics()).toEqual({ rejected: 50, disconnected: 1 });

  // The bucket refills over time: one second later the client can send again.
  now += 1000;
  expect(budget.admit(ws, POSE_BYTES)).toBe('ok');
});

test('a large-but-legal message rate is bounded by the byte budget, not just the count', () => {
  const now = 0;
  const budget = new GameplayMessageBudget({ now: () => now });
  const ws = socket();
  // Each message is just under the 64 KiB wire cap; far fewer than the message
  // burst exhausts the byte burst.
  const big = 60 * 1024;
  let accepted = 0;
  for (let i = 0; i < GAMEPLAY_MESSAGE_BUDGET.messageBurst; i++) {
    if (budget.admit(ws, big) === 'ok') {
      accepted++;
    }
  }
  expect(accepted).toBeLessThan(GAMEPLAY_MESSAGE_BUDGET.messageBurst);
  expect(accepted).toBe(Math.floor(GAMEPLAY_MESSAGE_BUDGET.byteBurst / big));
  expect(budget.diagnostics().disconnected).toBe(1);
});

test('each connection has its own budget', () => {
  const now = 0;
  const budget = new GameplayMessageBudget({ now: () => now });
  const flooder = socket();
  const honest = socket();
  for (let i = 0; i < GAMEPLAY_MESSAGE_BUDGET.messageBurst + 10; i++) {
    budget.admit(flooder, POSE_BYTES);
  }
  expect(budget.admit(flooder, POSE_BYTES)).toBe('rate-limited');
  // The second connection is untouched by the first's flood.
  expect(budget.admit(honest, POSE_BYTES)).toBe('ok');
  expect(budget.diagnostics().disconnected).toBe(1);
});
