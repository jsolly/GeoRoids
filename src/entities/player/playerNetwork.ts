export class PlayerNetwork {
  private static instance: PlayerNetwork;
  private tick: (() => void) | null = null;
  private sending = false;

  private constructor() {}

  public static getInstance(): PlayerNetwork {
    if (!PlayerNetwork.instance) {
      PlayerNetwork.instance = new PlayerNetwork();
    }
    return PlayerNetwork.instance;
  }

  public bindTick(tick: () => void): void {
    this.tick = tick;
  }

  public startNetworkUpdates(): void {
    this.sending = true;
  }

  public stopNetworkUpdates(): void {
    this.sending = false;
  }

  /** Report one pose per simulation burst so HTML 16ms timers cannot drift from 60 Hz. */
  public notifySimulationFrames(frames: number): void {
    if (this.sending && frames > 0) {
      this.updatePlayerState();
    }
  }

  public updatePlayerState(): void {
    this.tick?.();
  }
}
