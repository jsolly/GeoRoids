export class PlayerNetwork {
  private static instance: PlayerNetwork;
  private tick: (() => void) | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private readonly UPDATE_FREQUENCY = 60; // 60 FPS

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
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    this.updateInterval = setInterval(() => {
      this.updatePlayerState();
    }, 1000 / this.UPDATE_FREQUENCY);
  }

  public stopNetworkUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  public updatePlayerState(): void {
    this.tick?.();
  }
}
