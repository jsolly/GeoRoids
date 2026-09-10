/**
 * Remote-player presence helpers.
 *
 * The server removes a human on socket close and now also broadcasts
 * `playerLeft`. `handleSnapshotState` still updates entities in place (clearing
 * the map used to make bots flicker), so snapshot pruning remains the
 * fallback if a `playerLeft` is dropped.
 *
 * These helpers drop only `type === 'remote'` humans missing from the latest
 * authoritative snapshot. Local and bot entries stay — bots can be omitted
 * from a snapshot without having left the world.
 */

/** True when this snapshot row is the local pilot, including a new-id clone. */
export function isLocalGameEntity(
  entity: { id: string; name?: string; type?: string },
  local: { clientId: string; localPlayerId: string; localPlayerName: string }
): boolean {
  if (entity.id === local.clientId || entity.id === local.localPlayerId) {
    return true;
  }
  return Boolean(
    local.localPlayerName && entity.type === 'human' && entity.name === local.localPlayerName
  );
}

/** Drop remotes that are just another copy of our display name. */
export function duplicateOwnRemoteIds(
  players: Iterable<{ id: string; name: string; type: string }>,
  localPlayerName: string
): string[] {
  if (!localPlayerName) {
    return [];
  }
  const stale: string[] = [];
  for (const player of players) {
    if (player.type === 'remote' && player.name === localPlayerName) {
      stale.push(player.id);
    }
  }
  return stale;
}

export function staleRemotePlayerIds(
  players: Iterable<{ id: string; type: string }>,
  snapshotEntityIds: ReadonlySet<string>
): string[] {
  const stale: string[] = [];
  for (const player of players) {
    if (player.type === 'remote' && !snapshotEntityIds.has(player.id)) {
      stale.push(player.id);
    }
  }
  return stale;
}

/** Clear and refill `into` with this snapshot's entity ids — no new Set per tick. */
export function fillSnapshotEntityIds(
  entities: ReadonlyArray<{ id: string }>,
  into: Set<string>
): Set<string> {
  into.clear();
  for (const entity of entities) {
    into.add(entity.id);
  }
  return into;
}

/**
 * Drop remotes missing from the snapshot. Mutates `players` in place so
 * `handleSnapshotState` does not allocate an id array every broadcast.
 * Returns how many remotes were removed.
 */
export function pruneStaleRemotePlayers<T extends { type: string }>(
  players: Map<string, T>,
  snapshotEntityIds: ReadonlySet<string>
): number {
  let removed = 0;
  for (const [id, player] of players) {
    if (player.type === 'remote' && !snapshotEntityIds.has(id)) {
      players.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/** Drop remotes that are just another copy of our display name. */
export function pruneDuplicateOwnRemotes<T extends { name: string; type: string }>(
  players: Map<string, T>,
  localPlayerName: string
): number {
  if (!localPlayerName) {
    return 0;
  }
  let removed = 0;
  for (const [id, player] of players) {
    if (player.type === 'remote' && player.name === localPlayerName) {
      players.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/** Close the gameplay socket when the tab is hidden/unloaded (including bfcache). */
export function bindPageHideDisconnect(disconnect: () => void): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.addEventListener('pagehide', disconnect);
}
