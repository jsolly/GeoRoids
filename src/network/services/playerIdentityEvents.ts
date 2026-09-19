export type PlayerIdentityChangedDetail = {
  playerId: string;
};

/** Tell opt-in Debug chrome the correlator written on STATE logs after join. */
export function publishPlayerIdentity(playerId: string): void {
  if (typeof window === 'undefined' || !playerId) {
    return;
  }
  window.dispatchEvent(new CustomEvent('playerIdentityChanged', { detail: { playerId } }));
}
