import { writeFileSync } from 'node:fs';

/** Keep observation/serialization/write failures alongside the original scenario failure. */
export function writeScenarioReceipt({
  path,
  receipt,
  failures,
  message,
}: {
  path: string;
  receipt: () => unknown;
  failures: readonly unknown[];
  message: string;
}): void {
  const retainedFailures = [...failures];
  try {
    writeFileSync(path, JSON.stringify(receipt(), null, 2));
  } catch (error) {
    retainedFailures.push(error);
  }
  if (retainedFailures.length > 0) {
    throw new AggregateError(retainedFailures, message);
  }
}
