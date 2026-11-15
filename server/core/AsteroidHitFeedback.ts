import type { AppliedAsteroidHit } from './types';

/** Owns synchronous asteroid-hit delivery and feedback waiting for its first listener. */
export class AsteroidHitFeedback {
  private onAsteroidHits?: (hits: AppliedAsteroidHit[]) => void;
  private pendingAsteroidHits: AppliedAsteroidHit[] = [];

  public setListener(listener: (hits: AppliedAsteroidHit[]) => void): void {
    this.onAsteroidHits = listener;
    if (this.pendingAsteroidHits.length > 0) {
      listener(this.pendingAsteroidHits.splice(0));
    }
  }

  public emit(hits: AppliedAsteroidHit[]): void {
    const applied = hits.filter((hit) => hit.applied);
    if (applied.length === 0) {
      return;
    }
    if (this.onAsteroidHits) {
      this.onAsteroidHits(applied);
      return;
    }
    this.pendingAsteroidHits.push(...applied);
  }

  public clearPending(): void {
    this.pendingAsteroidHits = [];
  }
}
