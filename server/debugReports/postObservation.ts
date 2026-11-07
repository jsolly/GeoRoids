const WINDOW_MS = 60_000;
const ADDRESS_CAPACITY = 2048;

function burstBand(count: number) {
  if (count <= 1) {
    return 'one';
  }
  if (count <= 5) {
    return 'twoToFive';
  }
  if (count <= 10) {
    return 'sixToTen';
  }
  if (count <= 30) {
    return 'elevenToThirty';
  }
  if (count <= 60) {
    return 'thirtyOneToSixty';
  }
  return 'overSixty';
}

/** Process-local aggregate evidence only. No address or request data leaves this observer. */
export function createReportPostObservation(now: () => number = Date.now) {
  const startedAt = now();
  let minute = Math.floor(startedAt / WINDOW_MS);
  const addresses = new Map<string, number>();
  const bursts = {
    one: 0,
    twoToFive: 0,
    sixToTen: 0,
    elevenToThirty: 0,
    thirtyOneToSixty: 0,
    overSixty: 0,
  };
  const outcomes = {
    accepted: 0,
    rateLimited: 0,
    clientRejected: 0,
    unavailable: 0,
    other: 0,
    aborted: 0,
  };
  let requests = 0;
  let unattributedRequests = 0;
  let capacityExcludedRequests = 0;
  let peakRequestsPerIpMinute = 0;
  let requestsAboveSixtyPerIpMinute = 0;

  return {
    start(address: string | undefined) {
      requests++;
      const currentMinute = Math.floor(now() / WINDOW_MS);
      if (currentMinute !== minute) {
        addresses.clear();
        minute = currentMinute;
      }
      if (address === undefined) {
        unattributedRequests++;
      } else {
        const previous = addresses.get(address);
        if (previous === undefined && addresses.size >= ADDRESS_CAPACITY) {
          capacityExcludedRequests++;
        } else {
          const count = (previous ?? 0) + 1;
          addresses.set(address, count);
          if (previous !== undefined) {
            bursts[burstBand(previous)]--;
          }
          bursts[burstBand(count)]++;
          peakRequestsPerIpMinute = Math.max(peakRequestsPerIpMinute, count);
          if (count > 60) {
            requestsAboveSixtyPerIpMinute++;
          }
        }
      }
      let completed = false;
      return (status: number | null) => {
        if (completed) {
          return;
        }
        completed = true;
        if (status === null) {
          outcomes.aborted++;
        } else if (status === 202) {
          outcomes.accepted++;
        } else if (status === 429) {
          outcomes.rateLimited++;
        } else if (status >= 500) {
          outcomes.unavailable++;
        } else if (status >= 400) {
          outcomes.clientRejected++;
        } else {
          outcomes.other++;
        }
      };
    },
    read() {
      return {
        mode: 'observe-only',
        startedAt,
        windowSeconds: WINDOW_MS / 1000,
        addressCapacityPerMinute: ADDRESS_CAPACITY,
        requests,
        outcomes: { ...outcomes },
        unattributedRequests,
        capacityExcludedRequests,
        peakRequestsPerIpMinute,
        requestsAboveSixtyPerIpMinute,
        ipMinuteBursts: { ...bursts },
      };
    },
  };
}
