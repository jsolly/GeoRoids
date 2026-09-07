import { logger } from '../../utils/Logger';

export class GameStateManager {
  private static instance: GameStateManager;
  private textAlpha = 1;
  private text = '';
  private isGameRunning = false;

  // Kill message system
  private killMessage = '';
  private killMessageTimer = 0;
  private readonly KILL_MESSAGE_DURATION_FRAMES = 120; // 2 seconds at 60 FPS

  private pickupMessage = '';
  private pickupMessageTimer = 0;
  private readonly PICKUP_MESSAGE_DURATION_FRAMES = 120;

  private constructor() {}

  static getInstance(): GameStateManager {
    if (!GameStateManager.instance) {
      GameStateManager.instance = new GameStateManager();
    }
    return GameStateManager.instance;
  }

  getTextAlpha(): number {
    return this.textAlpha;
  }

  getText(): string {
    return this.text;
  }

  getIsGameRunning(): boolean {
    return this.isGameRunning;
  }

  updateTextProperties(text: string, alpha: number): void {
    this.text = text;
    this.textAlpha = alpha;
  }

  clearOverlay(): void {
    this.text = '';
    this.textAlpha = 0;
    this.clearKillMessage();
    this.clearPickupMessage();
  }

  toggleIsGameRunning(): void {
    this.isGameRunning = !this.isGameRunning;
    logger.debug('GAME_STATE', 'Game state toggled', { isGameRunning: this.isGameRunning });
  }

  setIsGameRunning(running: boolean): void {
    this.isGameRunning = running;
    logger.debug('GAME_STATE', 'Game running state set', { isGameRunning: running });
  }

  updateTextAlpha(alpha: number): void {
    this.textAlpha = alpha;
  }

  // Kill message methods
  setKillMessage(playerName: string): void {
    this.killMessage = `You killed ${playerName}`;
    this.killMessageTimer = this.KILL_MESSAGE_DURATION_FRAMES;
  }

  clearKillMessage(): void {
    this.killMessage = '';
    this.killMessageTimer = 0;
  }

  getKillMessage(): string {
    return this.killMessage;
  }

  hasKillMessage(): boolean {
    return this.killMessageTimer > 0;
  }

  updateKillMessageTimer(): void {
    if (this.killMessageTimer > 0) {
      this.killMessageTimer--;
      if (this.killMessageTimer <= 0) {
        this.killMessage = '';
      }
    }
  }

  setPickupMessage(pickupName: string, scoreBonus: number): void {
    this.pickupMessage = `${pickupName} acquired +${scoreBonus}`;
    this.pickupMessageTimer = this.PICKUP_MESSAGE_DURATION_FRAMES;
  }

  clearPickupMessage(): void {
    this.pickupMessage = '';
    this.pickupMessageTimer = 0;
  }

  getPickupMessage(): string {
    return this.pickupMessage;
  }

  hasPickupMessage(): boolean {
    return this.pickupMessageTimer > 0;
  }

  updatePickupMessageTimer(): void {
    if (this.pickupMessageTimer > 0) {
      this.pickupMessageTimer--;
      if (this.pickupMessageTimer <= 0) {
        this.pickupMessage = '';
      }
    }
  }
}
