import assert from 'node:assert/strict';

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function known(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== 'unknown';
}

/** Respawn clears the connection identity before its next join acknowledgment. */
export function inspectReleaseEvidence(rawIntervals: unknown, rawHealth: unknown) {
  assert(Array.isArray(rawIntervals) && rawIntervals.length > 0, 'Missing release intervals');
  const intervals = rawIntervals.map(record);
  const clients = new Set(intervals.map((interval) => interval['clientReleaseId']));
  assert(clients.size === 1 && [...clients].every(known), 'Missing or changed client release');
  const servers = new Set(intervals.map((interval) => interval['serverReleaseId']).filter(known));
  assert(servers.size === 1, 'Missing or changed server release');
  const clientRelease = [...clients][0];
  const serverRelease = [...servers][0];
  const transientUnknown: Array<{ index: number; durationMs: number }> = [];
  for (const [index, interval] of intervals.entries()) {
    if (interval['serverReleaseId'] === serverRelease) {
      continue;
    }
    assert(interval['serverReleaseId'] === 'unknown', 'Invalid server release');
    const phases = record(interval['phaseDurationsMs']);
    const respawn = phases['respawn'];
    assert(
      interval['phase'] === 'respawn' && typeof respawn === 'number' && respawn > 0,
      'Unknown server release outside respawn'
    );
    assert(
      intervals[index - 1]?.['serverReleaseId'] === serverRelease &&
        intervals[index + 1]?.['serverReleaseId'] === serverRelease,
      'Unknown release lacks matching adjacent joins'
    );
    const durationMs = interval['durationMs'];
    assert(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0);
    transientUnknown.push({ index, durationMs });
  }
  {
    assert(Array.isArray(rawHealth), 'Missing independent server identity witness');
    const health = rawHealth.map(record).filter((sample) => sample['measured'] === true);
    assert(health.length > 0, 'Missing measured server identity witness');
    for (const sample of health) {
      assert.equal(
        record(sample['data'])['releaseId'],
        serverRelease,
        'Server health identity changed or missing'
      );
    }
  }
  return { clientRelease, serverRelease, transientUnknown };
}
