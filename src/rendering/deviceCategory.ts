export type DeviceHints = Readonly<{
  userAgent: string;
  coarsePointer: boolean;
  deviceMemory: number | null;
  hardwareConcurrency: number | null;
}>;

export type DeviceCategory = 'low-end' | 'commodity' | 'high-end' | 'unknown';

const measuredFireModel = /\bKFTUWI\b/iu;

/** The Fire HD 10 whose physical recordings set the low-end flight and Scan policies. */
export function isMeasuredFireModel(userAgent: string): boolean {
  return measuredFireModel.test(userAgent);
}

/**
 * Resolve once per session from supplied browser hints, outside the drawing loop.
 * Flight glow and Mineral Scan detail both apply this one rule to the same hints.
 */
export function classifyDevice(hints: DeviceHints): DeviceCategory {
  if (isMeasuredFireModel(hints.userAgent)) {
    return 'low-end';
  }
  const { deviceMemory, hardwareConcurrency } = hints;
  if (
    deviceMemory === null ||
    !Number.isFinite(deviceMemory) ||
    deviceMemory <= 0 ||
    hardwareConcurrency === null ||
    !Number.isInteger(hardwareConcurrency) ||
    hardwareConcurrency <= 0
  ) {
    return 'unknown';
  }
  if (hints.coarsePointer && deviceMemory <= 4 && hardwareConcurrency <= 4) {
    return 'low-end';
  }
  if (deviceMemory >= 8 && hardwareConcurrency >= 8) {
    return 'high-end';
  }
  return 'commodity';
}
