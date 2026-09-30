/** Always attempt every restoration and retain the scenario's original failure. */
export async function withScenarioCleanup(
  scenario: () => void | Promise<void>,
  restorations: () => readonly (() => void | Promise<void>)[]
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await scenario();
  } catch (error) {
    failures.push(error);
  }
  for (const restore of restorations()) {
    try {
      await restore();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Scenario and restoration failures');
  }
}
