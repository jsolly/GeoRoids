import { classifyDevice, type DeviceHints, isMeasuredFireModel } from './deviceCategory';

type ScanDetail =
  | Readonly<{ mode: 'full'; reason: 'default-full' | 'forced-full' }>
  | Readonly<{
      mode: 'simple';
      reason: 'known-fire-model' | 'low-capacity-coarse-pointer' | 'forced-simple';
    }>;

/** Resolve once per session from supplied browser hints, outside the drawing loop. */
export function resolveScanDetail(search: string, hints: DeviceHints): ScanDetail {
  const params = new URLSearchParams(search);
  const diagnostic = ['1', 'collect'].includes(params.get('performance') ?? '');
  const requested = diagnostic ? params.get('scanDetail') : null;
  switch (requested) {
    case 'full':
      return { mode: 'full', reason: 'forced-full' };
    case 'simple':
      return { mode: 'simple', reason: 'forced-simple' };
    case null:
    case 'auto':
      break;
    default:
      throw new Error('scanDetail must be auto, full, or simple');
  }

  if (classifyDevice(hints) === 'low-end') {
    return {
      mode: 'simple',
      reason: isMeasuredFireModel(hints.userAgent)
        ? 'known-fire-model'
        : 'low-capacity-coarse-pointer',
    };
  }
  return { mode: 'full', reason: 'default-full' };
}
