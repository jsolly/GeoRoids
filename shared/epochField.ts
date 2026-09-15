/** Finite non-negative epoch milliseconds, matching persisted `lastSeenAt`. */
export function readEpoch(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function epochField<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const epoch = readEpoch(value);
  return epoch === undefined ? {} : ({ [key]: epoch } as { [P in K]: number });
}
