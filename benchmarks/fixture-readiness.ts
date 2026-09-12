interface PreparedFixtureRequirement {
  readonly sequence: number;
  readonly gameTime: number;
  readonly motionEpoch: number;
}

interface PreparedFixtureObservation {
  readonly lastKeyframeSequence: number | null;
  readonly lastSnapshotGameTime: number | null;
  readonly motionEpoch: number | null;
}

/** True only after an authoritative snapshot carries the prepared fixture generation. */
export function observesPreparedFixture(
  requirement: PreparedFixtureRequirement,
  observation: PreparedFixtureObservation
): boolean {
  return (
    observation.lastKeyframeSequence !== null &&
    Number.isSafeInteger(observation.lastKeyframeSequence) &&
    observation.lastKeyframeSequence >= requirement.sequence &&
    observation.lastSnapshotGameTime !== null &&
    Number.isFinite(observation.lastSnapshotGameTime) &&
    observation.lastSnapshotGameTime >= requirement.gameTime &&
    observation.motionEpoch !== null &&
    Number.isSafeInteger(observation.motionEpoch) &&
    observation.motionEpoch >= requirement.motionEpoch
  );
}
