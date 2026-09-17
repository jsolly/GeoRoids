/**
 * Cached snapshots of the live player map.
 *
 * `handleGameState` mutates players in place ~30x/sec. The game loop and
 * canvas read the same map every frame via `getAllPlayers()` /
 * `getRemotePlayers()`, which used to allocate a new array (and a filter
 * array) on every call. Rebuild the lists only when the map gains or loses
 * an entry — in-place field updates stay visible because the cached arrays
 * hold the same Player references.
 */

export class PlayerListCache<T extends { type: string }> {
  private all: T[] | null = null;
  private remotes: T[] | null = null;

  invalidate(): void {
    this.all = null;
    this.remotes = null;
  }

  allPlayers(players: Map<string, T>): T[] {
    this.all ??= Array.from(players.values());
    return this.all;
  }

  remotePlayers(players: Map<string, T>): T[] {
    if (this.remotes === null) {
      const remotes: T[] = [];
      for (const player of players.values()) {
        if (player.type === 'remote') {
          remotes.push(player);
        }
      }
      this.remotes = remotes;
    }
    return this.remotes;
  }
}
