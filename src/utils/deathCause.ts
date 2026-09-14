/** Tokens that must never be printed on the HUD / game-over overlay. */
export function isGenericDeathCause(cause?: string): boolean {
  return !cause || cause === 'unknown' || cause === 'server-damage';
}

/**
 * First specific cause wins. Generic tokens (unknown / server-damage) lose
 * to a later wall / asteroid report so a lagged snapshot cannot lock GO.
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
export function describeDeathCause(cause: string | undefined): string {
  switch (cause) {
    case 'asteroid':
    case 'an asteroid':
      return 'an asteroid';
    case 'boundary':
    case 'the arena wall':
      return 'the arena wall';
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

/** Overlay string. Omit "killed by unknown" when the cause is missing. */
export function formatGameOverText(deathCause?: string): string {
  const killer = formatDeathCauseForOverlay(deathCause);
  if (!killer) {
    return 'Game Over';
  }
  return `Game Over: You were killed by ${killer}`;
}

/**
 * A fresh local player (3 lives, full health) can see a leftover 0-life
 * server snapshot for the previous session. That is not a real death.
 * Leftover deathCause on a full-health hull is still stale.
 */
export function isStaleGameOverSnapshot(params: {
  prevLives: number;
  nextLives: number;
  deathCause?: string;
  health?: number;
  exploding?: boolean;
}): boolean {
  const drop = params.prevLives - params.nextLives;
  if (drop <= 1 || params.nextLives > 0) {
    return false;
  }
  const looksDead = params.exploding || (params.health !== undefined && params.health <= 0);
  return !looksDead;
}
