import { expect, test } from 'vitest';
import { boundedDiagnosticError } from '../../../shared/stateDiagnostics';

test('a diagnostic error keeps its cause chain, code and aggregate members', () => {
  const disk = Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' });
  const wrapped = new Error('Persistent world checkpoint failed', {
    cause: new Error('World store worker failed', { cause: disk }),
  });
  const bounded = boundedDiagnosticError(wrapped, 'fallback');
  expect(bounded.message).toBe('Persistent world checkpoint failed');
  const middle = bounded.cause as Error;
  expect(middle.message).toBe('World store worker failed');
  const root = middle.cause as Error & { code?: string };
  expect(root.message).toBe('database or disk is full');
  expect(root.code).toBe('ERR_SQLITE_ERROR');

  const aggregate = boundedDiagnosticError(
    new AggregateError(
      [wrapped, 'a plain string', { code: 42 }],
      'Server shutdown did not complete cleanly'
    ),
    'fallback'
  );
  expect(aggregate).toBeInstanceOf(AggregateError);
  expect((aggregate as AggregateError).errors.map((member: Error) => member.message)).toEqual([
    'Persistent world checkpoint failed',
    'a plain string',
    'Unknown error',
  ]);
});

test('a cyclic or endlessly nested error still produces a bounded diagnostic', () => {
  // These run inside the fatal-error handlers; throwing there would skip the shutdown.
  const selfCause = new Error('self');
  selfCause.cause = selfCause;
  const selfAggregate = new AggregateError([], 'self-aggregate');
  selfAggregate.errors.push(selfAggregate);
  selfAggregate.cause = selfCause;

  const bounded = boundedDiagnosticError(selfAggregate, 'fallback') as AggregateError;
  let depth = 0;
  for (let error: unknown = bounded; error instanceof Error; error = error.cause) {
    depth++;
  }
  expect(depth).toBeLessThanOrEqual(5);
  let nested = 0;
  for (
    let error: unknown = bounded;
    error instanceof AggregateError && error.errors.length > 0;
    error = error.errors[0]
  ) {
    nested++;
  }
  expect(nested).toBeLessThanOrEqual(4);
});
