/**
 * Counts upgrades the edge could not attribute, and reports them in batches.
 *
 * This is small enough to look like it belongs inline in `createServer`, and it
 * was inline until review found the defect it now exists to prevent. Reporting
 * on the next upgrade after an interval elapsed meant an incident that ended
 * inside the interval reported exactly `1` and dropped the rest: a fleet-wide
 * outage worth thousands of upgrades logged one line claiming one, which is
 * worse than the uncounted line it replaced, because it states a volume that is
 * wrong. Separating the tally from the socket path is what lets a test drive
 * that case without standing up a server.
 */
interface LostAttributionTally {
  /** One upgrade the edge could not attribute. */
  note(): void;
  /**
   * Everything counted since the last flush, or null when there is nothing to
   * report. Callers log it; this returns rather than logs so a test can read it.
   */
  flush(): number | null;
}

export function createLostAttributionTally(): LostAttributionTally {
  let counted = 0;
  return {
    note(): void {
      counted += 1;
    },
    flush(): number | null {
      if (counted === 0) {
        return null;
      }
      const reported = counted;
      counted = 0;
      return reported;
    },
  };
}
