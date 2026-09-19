export type PlayerIdentityStatus = 'provisional' | 'confirmed';

export type PlayerIdentityChangedDetail = {
  playerId: string;
  status: PlayerIdentityStatus;
};

/** Tell opt-in Debug chrome when the correlator used in STATE logs changes. */
export function publishPlayerIdentity(playerId: string, status: PlayerIdentityStatus): void {
  if (typeof window === 'undefined' || !playerId) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent('playerIdentityChanged', {
      detail: { playerId, status },
    })
  );
}
