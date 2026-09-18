/** A damped lateral kick in screen pixels; never changes asteroid physics. */
export function latchShudderOffset(elapsedMs: number): number {
  if (elapsedMs < 0 || elapsedMs >= 240) {
    return 0;
  }
  const decay = 1 - elapsedMs / 240;
  return Math.sin((elapsedMs * Math.PI) / 30) * 4 * decay * decay;
}
