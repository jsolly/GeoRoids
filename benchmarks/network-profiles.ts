export const networkProfiles = {
  clean: { latencyMs: 0, jitterMs: 0, downBytesPerSecond: 625000, upBytesPerSecond: 125000 },
  normal: { latencyMs: 40, jitterMs: 20, downBytesPerSecond: 625000, upBytesPerSecond: 125000 },
  degraded: { latencyMs: 90, jitterMs: 60, downBytesPerSecond: 125000, upBytesPerSecond: 32000 },
};

/** Keep at least 10 authoritative updates/s; reserve 20% bandwidth for control/events. */
export function deliveryBudget(
  profile: keyof typeof networkProfiles,
  averageSnapshotBytes: number
) {
  const network = networkProfiles[profile];
  const capacityHz = profile === 'clean' ? 30 : network.downBytesPerSecond / averageSnapshotBytes;
  return {
    minimumStateHz:
      profile === 'clean' ? 27 : Math.max(10, Math.min(27, Math.floor(capacityHz * 0.8))),
    maximumStateGapMs:
      profile === 'clean'
        ? 250
        : Math.max(
            250,
            2 * (network.latencyMs + network.jitterMs) +
              (65536 / network.downBytesPerSecond) * 1000 +
              100
          ),
    maximumRejoinMs: 10_000,
    averageSnapshotBytes,
    capacityHz,
    rationale:
      '80% serialized snapshot bandwidth; >=10Hz useful updates; gap allows round-trip propagation plus one bounded64KiB receive chunk and100ms scheduling.',
  };
}
