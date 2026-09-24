/** Tokens that must never be printed on the death overlay. */
export function isGenericDeathCause(cause?: string): boolean {
  return !cause || cause === 'unknown' || cause === 'server-damage';
}

/**
 * First specific cause wins. Generic tokens (unknown / server-damage) lose
 * to a later wall / asteroid report so a lagged snapshot cannot obscure the cause.
 */
export function preferDeathCause(...causes: Array<string | undefined>): string | undefined {
  for (const cause of causes) {
    if (cause && !isGenericDeathCause(cause)) {
      return cause;
    }
  }
  return causes.find((cause) => Boolean(cause));
}

/** Human-readable environmental cause; never identify another crew pilot as a killer. */
export function describeDeathCause(
  cause: string | undefined
): 'an asteroid' | 'the arena wall' | 'a ricochet' | 'a terrain spider' | 'unknown' {
  switch (cause) {
    case 'spider':
    case 'a terrain spider':
      return 'a terrain spider';
    case 'asteroid':
    case 'an asteroid':
      return 'an asteroid';
    case 'boundary':
    case 'the arena wall':
      return 'the arena wall';
    case 'ricochet':
    case 'a ricochet':
      return 'a ricochet';
    default:
      return 'unknown';
  }
}

/** Overlay phrase. Undefined means omit "killed by …" (never print unknown). */
export function formatDeathCauseForOverlay(cause?: string): string | undefined {
  const described = describeDeathCause(cause);
  if (described === 'unknown') {
    return undefined;
  }
  return described;
}
