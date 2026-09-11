import { areAllied } from '../../shared/factions';
import { consumeTickAccumulator } from '../../shared/gameClock';
import { boundedDiagnosticError } from '../../shared/stateDiagnostics';
import type {
  AsteroidData,
  LootData,
  Position,
  SatellitePickupCollected,
  ShipKitId,
} from '../../shared-types';
import {
  replaceThrustSources,
  resetThrustSources,
  thrustSourcesFromPlayers,
} from '../audio/gameSounds';
import { bindGameAudio } from '../audio/spatialAudio';
import { playSplitSound } from '../audio/splitSound';
import { GAME } from '../constants';
import { clientPerformance } from '../diagnostics/performanceMetrics';
import { entityFactory } from '../entities/EntityFactory';
import { LootField } from '../entities/loot/LootField';
import type { Player } from '../entities/player/Player';
import { PlayerManager } from '../entities/player/PlayerManager';
import { PlayerNetwork } from '../entities/player/playerNetwork';
import { advanceRemotePlayerShips } from '../entities/player/remoteLasers';
import type { RoidBelt } from '../entities/roid/Roid';
import { clearAsteroidShatters, recordAsteroidShatter } from '../entities/roid/roidRenderer';
import { SatelliteManager } from '../entities/satellite/SatelliteManager';
import { SatellitePickupManager } from '../entities/satellitePickup/SatellitePickupManager';
import {
  bindHarpoonFieldSource,
  collectPlayHarpoonField,
  harpoonBodiesFromRocks,
  harpoonBodyFromShip,
  publishHarpoonField,
} from '../entities/ship/harpoonField';
import type { Ship } from '../entities/ship/Ship';
import { diagnoseHarpoonLatch } from '../entities/ship/shipAbilities';
import { shockwaveManager } from '../fx/ShockwaveManager';
import { tickTouchControls } from '../input/touchControls';
import { NetworkManager } from '../network/networkManager';
import {
  applyAsteroidKinematics,
  applyAsteroidRowToBelt,
  bindAsteroidFieldApply,
  unbindAsteroidFieldApply,
} from '../network/services/asteroidFieldSync';
import { CollisionManager } from '../physics/collision/CollisionManager';
import { applyShockwaveToBody, type ShockwaveWaveSpec } from '../physics/shockwave';
import { contourSegmentCount } from '../physics/terrain/contours';
import { sampleGradient, sampleHeight } from '../physics/terrain/heightfield';
import {
  getTerrainContours,
  getTerrainField,
  getTerrainSeed,
} from '../physics/terrain/terrainSession';
import { canvasManager } from '../rendering/canvas';
import { LaserUpgradeReadout } from '../rendering/hud/LaserUpgradeReadout';
import { PLAYFIELD_CLOSE_SCALE } from '../rendering/playfieldCamera';
import { showNetworkBanner } from '../ui/networkStatus';
import { getSelectedShipKitId } from '../ui/shipKitSelect';
import { setPlayView } from '../ui/uiUtils';
import { formatGameOverText, preferDeathCause } from '../utils/deathCause';
import { logger } from '../utils/Logger';
import { GameStateManager } from './services/GameStateManager';
import { InputManager } from './services/InputManager';

export class GameController {
  private static instance: GameController;

  private gameStateManager: GameStateManager;
  private playerManager: PlayerManager;
  private inputManager: InputManager;
  private networkManager: NetworkManager;
  private collisionManager: CollisionManager;

  private currRoidBelt: RoidBelt;
  private recentShockwaveKeys = new Set<string>();
  private readonly otherShips: { ship: Ship; id: string }[] = [];
  private readonly localFirstPlayers: Player[] = [];
  private gameOverInProgress = false;
  private gameOverTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly GAME_OVER_MENU_DELAY_MS = 3500;
  private simulationAccumulatorMs = 0;
  private laserUpgradeReadout: LaserUpgradeReadout | undefined;

  private constructor() {
    this.gameStateManager = GameStateManager.getInstance();
    this.playerManager = PlayerManager.getInstance();
    this.inputManager = InputManager.getInstance();
    this.networkManager = NetworkManager.getInstance();
    this.collisionManager = CollisionManager.getInstance();
    bindGameAudio({
      getListenerPosition: () => this.playerManager.getLocalShip()?.position,
      getViewport: () => {
        const canvas = canvasManager.getCanvas();
        if (!canvas) {
          return undefined;
        }
        const viewport = canvasManager.getViewportSize();
        return { width: viewport.width, height: viewport.height };
      },
    });

    shockwaveManager.setWaveFireHandler((origin, wave) => {
      this.applyLocalShockwaveKick(origin, wave);
    });

    // Initialize with empty asteroid belt - will be populated by server
    this.currRoidBelt = entityFactory.createEmptyRoidBelt();
    bindHarpoonFieldSource(() => this.snapshotHarpoonField());

    // Set up network disconnection handler
    this.setupNetworkDisconnectionHandler();

    // Set up game over handler
    this.setupGameOverHandler();
    this.setupShipExplodedHandler();

    // Expose game controller globally for testing
    if (typeof window !== 'undefined') {
      window.gameController = this;
    }
  }

  static getInstance(): GameController {
    if (!GameController.instance) {
      GameController.instance = new GameController();
    }
    return GameController.instance;
  }

  // Game lifecycle methods
  newGame(playerName?: string, kitId?: ShipKitId): void {
    clearAsteroidShatters();
    this.simulationAccumulatorMs = 0;
    // Create new player
    this.playerManager.createLocalPlayer(kitId ?? getSelectedShipKitId());
    this.laserUpgradeReadout?.update(undefined);

    // Set the player name if provided
    if (playerName) {
      this.playerManager.setPlayerName(playerName);
    }

    // Note: Asteroid belt creation is now handled in startGame() to support server-authoritative mode
  }

  async startGame(playerName?: string, kitId?: ShipKitId): Promise<void> {
    logger.debug('GAME_CONTROLLER', 'startGame called', { kitId });
    const joinStartedAt = performance.now();
    try {
      this.resetSessionForNewGame();
      clientPerformance.join(joinStartedAt);
      this.newGame(playerName, kitId ?? getSelectedShipKitId());
      setPlayView(true);
      this.laserUpgradeReadout ??= new LaserUpgradeReadout(
        document.getElementById('gameArea') ?? document.body
      );
      this.gameStateManager.setIsGameRunning(true);

      // Reset button text to default state
      this.inputManager.resetButtonText();

      // Connect before joining the server-owned world.
      await this.networkManager.connect();

      logger.debug('NETWORK', 'Connected to server, using server-authoritative game state');
      // Empty belt + listeners must be ready before join so the first
      // asteroidCreateBatch / snapshot cannot land on a static local set.
      this.currRoidBelt = entityFactory.createEmptyRoidBelt();
      shockwaveManager.clear();
      this.setupServerAsteroidListeners();
      this.networkManager.initializeAsteroidSync();

      if (!this.playerManager.getLocalPlayer()) {
        throw new Error('Cannot initialize input listeners without a local player');
      }
      logger.debug('GAME_CONTROLLER', 'Initializing input listeners');
      this.inputManager.initializeListeners();

      // Begin sending continuous local player updates to server
      PlayerNetwork.getInstance().startNetworkUpdates();

      window.dispatchEvent(new CustomEvent('gameStart'));
    } catch (error) {
      clientPerformance.joinFailed();
      this.gameStateManager.setIsGameRunning(false);
      this.networkManager.disconnect();
      resetThrustSources();
      setPlayView(false);
      const reportedError = boundedDiagnosticError(error, 'Unknown connection failure');
      const errorMessage = reportedError.message;
      const errorType = this.categorizeConnectionError(error);

      logger.error('NETWORK', 'Failed to connect to game server', reportedError, { errorType });

      // Show error message and stop the game - no local fallback
      this.showConnectionFailureMessage(errorType, 'Cannot connect');
      throw new Error(`Network connection failed: ${errorMessage}`);
    }
  }

  // Event handler methods for server asteroid synchronization
  private applyServerAsteroidCreated = (asteroid: AsteroidData): void => {
    logger.debug('GAME', 'Adding server asteroid to local belt', { asteroidId: asteroid.id });

    // Clear local asteroids only once when receiving the first server asteroid (server-authoritative)
    if (
      this.currRoidBelt &&
      this.currRoidBelt.roids.length > 0 &&
      !this.currRoidBelt.roids.some((r) => r.id.startsWith('server-asteroid-'))
    ) {
      logger.debug('GAME', 'Clearing local asteroids, server is authoritative', {
        localAsteroidCount: this.currRoidBelt.roids.length,
      });
      this.currRoidBelt.roids.length = 0;
    }

    // Duplicate create (late join / rejoined snapshot) must still take the
    // live pose — skipping here left a private static copy on prod.
    if (this.currRoidBelt) {
      const existingRoid = this.currRoidBelt.roids.find((r) => r.id === asteroid.id);
      if (existingRoid) {
        applyAsteroidKinematics(existingRoid, asteroid, { snapPosition: true });
        return;
      }
    }

    // Create a proper Roid object from server data with server ID
    const roid = entityFactory.createRoid({
      position: asteroid.position,
      size: asteroid.size,
      id: asteroid.id,
    });

    applyAsteroidKinematics(roid, asteroid, { snapPosition: true });

    // Override shape properties to match server exactly. Keep the factory
    // silhouette when the snapshot omits offsets / vertices — wiping those
    // made the playfield skip every rock while the minimap still dotted.
    if (asteroid.jaggedness !== undefined) {
      roid.jaggedness = asteroid.jaggedness;
    }
    if (asteroid.vertices !== undefined) {
      roid.vertices = asteroid.vertices;
    }
    if (asteroid.offsets && asteroid.offsets.length > 0) {
      roid.offsets.length = 0;
      roid.offsets.push(...asteroid.offsets);
    }

    // Add to current asteroid belt if it exists
    if (this.currRoidBelt) {
      this.currRoidBelt.roids.push(roid);
      logger.debug(
        'GAME',
        `Added asteroid ${asteroid.id} to belt. Total asteroids: ${this.currRoidBelt.roids.length}`
      );
    } else {
      logger.error('GAME', 'No asteroid belt available for adding asteroid');
    }
  };

  private applyServerAsteroidUpdated = (
    asteroidId: string,
    updates: Partial<AsteroidData>,
    complete = false
  ): void => {
    logger.debug('GAME', 'Updating server asteroid in local belt', { asteroidId });

    if (!this.currRoidBelt || !updates) {
      return;
    }
    applyAsteroidRowToBelt(
      (id) => this.currRoidBelt.roids.find((roid) => roid.id === id),
      asteroidId,
      updates,
      this.applyServerAsteroidCreated,
      complete
    );
  };

  private removeServerAsteroid = (
    event: {
      asteroidId: string;
      collabSplit?: boolean;
      origin?: Position;
    },
    showDestructionVfx: boolean
  ): void => {
    const { asteroidId, collabSplit, origin } = event;
    logger.debug('GAME', 'Removing server asteroid from local belt', {
      asteroidId,
      collabSplit,
      showDestructionVfx,
    });

    if (!this.currRoidBelt) {
      return;
    }
    const index = this.currRoidBelt.roids.findIndex((r) => r.id === asteroidId);
    if (index === -1) {
      return;
    }
    const roid = this.currRoidBelt.roids[index];
    if (!roid) {
      return;
    }
    if (showDestructionVfx) {
      if (collabSplit) {
        this.spawnCollabShockwave(origin ?? roid.position, asteroidId);
      }
      recordAsteroidShatter(roid);
    }
    delete roid.taggedUntil;
    this.currRoidBelt.roids.splice(index, 1);
  };

  private applyServerAsteroidDestroyed = (event: {
    asteroidId: string;
    collabSplit?: boolean;
    origin?: Position;
  }): void => {
    this.removeServerAsteroid(event, true);
  };

  private applyServerAsteroidReconciled = (asteroidId: string): void => {
    this.removeServerAsteroid({ asteroidId }, false);
  };

  private handleServerShockwave = (event: Event): void => {
    const customEvent = event as CustomEvent<{ origin: Position; asteroidId?: string }>;
    const { origin, asteroidId } = customEvent.detail;
    if (!origin) {
      return;
    }
    this.spawnCollabShockwave(origin, asteroidId);
  };

  private spawnCollabShockwave(origin: Position, asteroidId?: string): void {
    const key = asteroidId ?? `${Math.round(origin.x)}:${Math.round(origin.y)}`;
    if (this.recentShockwaveKeys.has(key)) {
      return;
    }
    this.recentShockwaveKeys.add(key);
    window.setTimeout(() => this.recentShockwaveKeys.delete(key), 1000);
    playSplitSound(origin);
    shockwaveManager.spawn(origin);
  }

  private applyLocalShockwaveKick(origin: Position, wave: ShockwaveWaveSpec): void {
    const ship = this.playerManager.getLocalShip();
    if (ship && !ship.exploding) {
      const next = applyShockwaveToBody(
        { position: ship.position, velocity: ship.velocity, size: ship.r },
        origin,
        wave
      );
      if (next) {
        ship.velocity = next;
      }
    }

    if (!this.currRoidBelt) {
      return;
    }
    for (const roid of this.currRoidBelt.roids) {
      const next = applyShockwaveToBody(
        { position: roid.position, velocity: roid.velocity, size: roid.r },
        origin,
        wave
      );
      if (next) {
        roid.velocity = next;
      }
    }
  }

  private applyServerAsteroidTagged = (event: { asteroidId: string; expiresAt: number }): void => {
    const { asteroidId, expiresAt } = event;
    const roid = this.currRoidBelt?.roids.find((r) => r.id === asteroidId);
    if (!roid) {
      return;
    }
    roid.taggedUntil = expiresAt;
    logger.debug('GAME', 'Server tagged asteroid for collab window', { asteroidId, expiresAt });
  };

  private handleSatellitePickupCollected = (event: Event): void => {
    const detail = (event as CustomEvent<SatellitePickupCollected>).detail;
    if (
      detail?.playerId !== this.networkManager.getLocalPlayerId() ||
      !detail.pickupName ||
      !Number.isFinite(detail.scoreBonus)
    ) {
      return;
    }
    this.gameStateManager.setPickupMessage(detail.pickupName, detail.scoreBonus);
  };

  private setupServerAsteroidListeners(): void {
    this.cleanupServerAsteroidListeners();
    bindAsteroidFieldApply({
      onCreated: this.applyServerAsteroidCreated,
      onUpdated: this.applyServerAsteroidUpdated,
      onDestroyed: this.applyServerAsteroidDestroyed,
      onReconciled: this.applyServerAsteroidReconciled,
      onTagged: this.applyServerAsteroidTagged,
    });
    window.addEventListener('serverShockwave', this.handleServerShockwave);
    window.addEventListener('satellitePickupCollected', this.handleSatellitePickupCollected);
  }

  private cleanupServerAsteroidListeners(): void {
    unbindAsteroidFieldApply();
    window.removeEventListener('serverShockwave', this.handleServerShockwave);
    window.removeEventListener('satellitePickupCollected', this.handleSatellitePickupCollected);
  }

  /** Drop a pending return-to-menu so Start (or a test) can open a new session. */
  cancelPendingGameOver(): void {
    if (this.gameOverTimer !== null) {
      clearTimeout(this.gameOverTimer);
      this.gameOverTimer = null;
    }
    this.gameOverInProgress = false;
  }

  private resetSessionForNewGame(): void {
    this.cancelPendingGameOver();
    this.laserUpgradeReadout?.update(undefined);
    this.gameStateManager.clearOverlay();
    canvasManager.clearPlayfield();
    resetThrustSources();
    PlayerNetwork.getInstance().stopNetworkUpdates();
    this.networkManager.disconnect({ newSession: true });
  }

  gameOver(deathCause?: string): void {
    if (this.gameOverInProgress) {
      return;
    }
    this.gameOverInProgress = true;
    this.laserUpgradeReadout?.update(undefined);

    const localPlayer = this.playerManager.getLocalPlayer();
    const raw = preferDeathCause(
      deathCause,
      localPlayer?.deathCause,
      localPlayer?.ship.lastExplodeCause
    );
    const resolveName = (id: string): string | undefined => this.networkManager.getPlayer(id)?.name;
    this.gameStateManager.updateTextProperties(formatGameOverText(raw, resolveName), 1.0);

    this.cleanupServerAsteroidListeners();
    PlayerNetwork.getInstance().stopNetworkUpdates();
    this.networkManager.disconnect({ newSession: true });

    this.gameOverTimer = setTimeout(() => {
      this.gameOverTimer = null;
      this.gameStateManager.setIsGameRunning(false);
      resetThrustSources();
      setPlayView(false);
    }, GameController.GAME_OVER_MENU_DELAY_MS);
  }

  private setupShipExplodedHandler(): void {
    window.addEventListener('shipExploded', (event) => {
      const customEvent = event as CustomEvent<{
        shipId: string;
        cause?: string;
        killerName?: string;
      }>;
      const cause = customEvent.detail.cause;
      if (!cause) {
        return;
      }

      const localPlayer = this.playerManager.getLocalPlayer();
      if (localPlayer?.ship.id === customEvent.detail.shipId) {
        localPlayer.onShipExploded({ cause });
        return;
      }

      for (const player of this.networkManager.getAllPlayers()) {
        if (player.ship.id === customEvent.detail.shipId) {
          player.onShipExploded({ cause });
          return;
        }
      }
    });
  }

  private setupGameOverHandler(): void {
    // Listen for player death events (both life loss and game over)
    window.addEventListener('playerDied', (event) => {
      const customEvent = event as CustomEvent<{
        playerId: string;
        deathCause: string;
        isGameOver: boolean;
      }>;

      // Only handle events for local player
      const localPlayer = this.playerManager.getLocalPlayer();
      if (customEvent.detail.playerId === localPlayer?.id) {
        const { deathCause, isGameOver } = customEvent.detail;

        if (isGameOver) {
          // Final death - show game over message
          logger.info('GAME', 'Game over', {
            playerId: customEvent.detail.playerId,
          });
          this.gameOver(deathCause);
        } else {
          // Life loss - death message is handled by GameLoopManager during respawn
          logger.info('GAME', 'Life lost', {
            playerId: customEvent.detail.playerId,
          });
        }
      } else {
        // Handle other player deaths - check if local player killed them
        const { deathCause } = customEvent.detail;
        if (deathCause.includes('laser') && deathCause.includes(localPlayer?.name || '')) {
          // Extract the killed player's name from the death cause
          // The death cause format is typically "PlayerName's laser" or similar
          const deathCauseText = deathCause.toLowerCase();
          const localPlayerName = localPlayer?.name.toLowerCase() || '';

          // Check if this death was caused by the local player's laser
          if (deathCauseText.includes(localPlayerName) && deathCauseText.includes('laser')) {
            // Get the killed player's name from the event
            const killedPlayerId = customEvent.detail.playerId;

            // Try to find the player in the network manager (remote players only)
            const networkManager = this.networkManager;
            const remotePlayers = networkManager.getRemotePlayers();

            // Check remote players
            const killedPlayer = remotePlayers.find((p) => p.id === killedPlayerId);

            if (killedPlayer) {
              this.setKillMessage(killedPlayer.name);
            }
          }
        }
      }
    });

    // Listen for remote player deaths
    window.addEventListener('remotePlayerDied', (event) => {
      const customEvent = event as CustomEvent<{
        playerId: string;
        playerName: string;
        deathCause: string;
      }>;

      // Set kill message for remote player death
      this.setKillMessage(customEvent.detail.playerName);

      logger.debug('GAME', 'Remote player killed', {
        playerId: customEvent.detail.playerId,
        playerName: customEvent.detail.playerName,
        deathCause: customEvent.detail.deathCause,
      });
    });
  }

  getCurrPlayer() {
    return this.playerManager.getLocalPlayer();
  }

  getCurrRoidBelt(): RoidBelt {
    return this.currRoidBelt;
  }

  getCurrRoidCount(): number {
    return this.currRoidBelt.roids.length;
  }

  /** QA probe: kit, field, nearest gap, latch, WS. Used by the headed smoke. */
  diagnoseHarpoon():
    | (ReturnType<typeof diagnoseHarpoonLatch> & {
        connected: boolean;
        harpoonTimer: number;
        abilityActiveFrames: number;
        latchPos?: { x: number; y: number };
        liveTargetId?: string;
      })
    | null {
    const local = this.playerManager.getLocalPlayer();
    if (!local) {
      return null;
    }
    this.publishLiveHarpoonField(local);
    const probe = diagnoseHarpoonLatch(local.ship);
    return {
      ...probe,
      connected: this.networkManager.isConnected,
      harpoonTimer: local.ship.harpoonTimer,
      abilityActiveFrames: local.ship.abilityActiveFrames,
      ...(local.ship.harpoonLatchPos !== undefined ? { latchPos: local.ship.harpoonLatchPos } : {}),
      ...(local.ship.harpoonTargetId !== undefined
        ? { liveTargetId: local.ship.harpoonTargetId }
        : {}),
    };
  }

  getLoot(): LootData[] {
    return LootField.getInstance().getAll();
  }

  getSatellites() {
    return SatelliteManager.getInstance().getAll();
  }

  getSatellitePickups() {
    return SatellitePickupManager.getInstance().getAll();
  }

  // Score management — the server is authoritative; the local player's entity
  // score is synced from the server's authoritative snapshot.
  getCurrScore(): number {
    return this.playerManager.getLocalPlayer()?.score ?? 0;
  }

  getText(): string {
    return this.gameStateManager.getText();
  }

  // Kill message methods
  setKillMessage(playerName: string): void {
    this.gameStateManager.setKillMessage(playerName);
  }

  getIsGameRunning(): boolean {
    return this.gameStateManager.getIsGameRunning();
  }

  /** Stop a broken frame from repeating while the visible restart notice is shown. */
  stopAfterFrameFailure(): void {
    this.gameStateManager.setIsGameRunning(false);
    PlayerNetwork.getInstance().stopNetworkUpdates();
  }

  updateNetworkPlayerState(): void {
    this.playerManager.updateNetworkState();
  }

  getNetworkManager(): NetworkManager {
    return this.networkManager;
  }

  getGameStateManager(): GameStateManager {
    return this.gameStateManager;
  }

  getPlayerManager(): PlayerManager {
    return this.playerManager;
  }

  /** Probe the shared heightfield — used by tests to read elevation / slope. */
  getTerrainProbe(position?: { x: number; y: number }): {
    seed: number;
    height: number;
    gradient: { x: number; y: number };
    contourCount: number;
  } {
    const field = getTerrainField();
    const at = position ?? this.playerManager.getLocalShip()?.position ?? { x: 0, y: 0 };
    return {
      seed: getTerrainSeed(),
      height: sampleHeight(field, at.x, at.y),
      gradient: sampleGradient(field, at.x, at.y),
      contourCount: contourSegmentCount(getTerrainContours()),
    };
  }

  // Connection error handling methods
  private categorizeConnectionError(
    error: unknown
  ): 'network' | 'timeout' | 'auth' | 'server' | 'unknown' {
    if (!(error instanceof Error)) {
      return 'unknown';
    }

    const message = error.message.toLowerCase();
    const code = (error as { code?: string }).code;

    // Network unreachable errors
    if (
      code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      message.includes('network') ||
      message.includes('unreachable')
    ) {
      return 'network';
    }

    // Timeout errors
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || message.includes('timeout')) {
      return 'timeout';
    }

    // Authentication/permission errors
    if (
      code === 'EAUTH' ||
      code === 'EPERM' ||
      message.includes('auth') ||
      message.includes('permission') ||
      message.includes('unauthorized')
    ) {
      return 'auth';
    }

    // Server errors (5xx responses, internal server errors)
    if (code === 'ESERVER' || message.includes('server') || message.includes('internal')) {
      return 'server';
    }

    return 'unknown';
  }

  private showConnectionFailureMessage(errorType: string, reason: string): void {
    let message = '';

    switch (errorType) {
      case 'network':
        message = `Network connection failed. ${reason}.`;
        break;
      case 'timeout':
        message = `Connection timed out. ${reason}.`;
        break;
      case 'auth':
        message = `Authentication failed. Please check your credentials.`;
        break;
      case 'server':
        message = `Server error occurred. ${reason}.`;
        break;
      default:
        message = `Connection failed: ${reason}.`;
    }

    showNetworkBanner(`${message} Select Enter Game to try again.`);
  }

  private setupNetworkDisconnectionHandler(): void {
    // Listen for network disconnection events
    window.addEventListener('networkDisconnected', (event) => {
      const customEvent = event as CustomEvent<{ reason: string }>;
      logger.warn(
        'NETWORK',
        `Network disconnected: ${customEvent.detail.reason} - attempting reconnection`
      );

      // Don't stop the game immediately - let the NetworkManager handle reconnection
      // The game continues running while reconnection attempts are made
    });

    // Listen for successful reconnection
    window.addEventListener('networkReconnected', () => {
      logger.info('NETWORK', 'Successfully reconnected to server - re-joining the live field');
      this.networkManager.initializeAsteroidSync();
    });

    // Listen for permanent disconnection (after all reconnection attempts fail)
    window.addEventListener('networkPermanentlyDisconnected', (event) => {
      const customEvent = event as CustomEvent<{ reason: string }>;
      logger.error(
        'NETWORK',
        `Permanently disconnected: ${customEvent.detail.reason} - stopping game`
      );

      // Only stop the game when reconnection has permanently failed
      this.gameStateManager.setIsGameRunning(false);
      resetThrustSources();
      setPlayView(false);

      // Show permanent disconnection message
      this.showConnectionFailureMessage('network', 'Connection permanently lost');
    });
  }

  /** Resume from current authoritative state instead of replaying hidden presentation time. */
  resetPresentationClock(): void {
    this.simulationAccumulatorMs = 0;
  }

  // Update game state (movement, physics, etc.)
  updateGame(dtMs: number = 1000 / GAME.FPS): void {
    const currPlayer = this.playerManager.getLocalPlayer();
    if (!currPlayer) {
      return;
    }

    const elapsed = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 1000 / GAME.FPS;
    this.simulationAccumulatorMs += elapsed;
    const { frames, remainingMs } = consumeTickAccumulator(this.simulationAccumulatorMs);
    this.simulationAccumulatorMs = remainingMs;

    for (let frame = 0; frame < frames; frame++) {
      this.advanceSimulationFrame(currPlayer);
    }
  }

  /** Movement, timers, and swept collisions share one 60 Hz step. */
  private advanceSimulationFrame(currPlayer: Player): void {
    tickTouchControls(currPlayer);
    currPlayer.ship.update();
    shockwaveManager.update();

    // Remote pose remains server-driven; their projectiles and lifecycle
    // advance on the same simulation clock as the local ship.
    const allPlayers = this.networkManager.getAllPlayers();
    for (const player of allPlayers) {
      if (player.type === 'bot' && player.ship) {
        player.ship.update();
      }
    }
    advanceRemotePlayerShips(allPlayers);

    // One thrust loop for local + bot + remote ships; volume is the loudest in-range source.
    replaceThrustSources(
      thrustSourcesFromPlayers(
        allPlayers.includes(currPlayer) ? allPlayers : this.playersWithLocal(currPlayer, allPlayers)
      )
    );

    // Update asteroids
    if (this.currRoidBelt) {
      this.currRoidBelt.moveRoids();
      this.publishLiveHarpoonField(currPlayer);
    }

    SatelliteManager.getInstance().update();

    this.checkSatelliteLaserCollisions();

    // Ship↔asteroid damage is server-owned. Keep local ship-ship overlap
    // for offline DOT / visual contact only. Factions still skip allies.
    this.checkShipShipCollisions(allPlayers);

    // Check boundary collisions for ships
    this.checkBoundaryCollisions();

    // Update game state manager
    this.gameStateManager.updateKillMessageTimer();
    this.gameStateManager.updatePickupMessageTimer();
  }

  private snapshotHarpoonField(localPlayer?: Player | null) {
    const local = localPlayer ?? this.playerManager.getLocalPlayer();
    const allPlayers = this.networkManager.getAllPlayers();
    const ships = allPlayers
      .filter((player) => player.id && player.id !== local?.id && player.ship)
      .map((player) =>
        harpoonBodyFromShip(player.id, player.ship, player.factionId ?? player.ship.factionId)
      );
    const rocks = harpoonBodiesFromRocks(this.currRoidBelt?.roids ?? []);
    const canvas = canvasManager.getCanvas();
    const viewport = canvasManager.getViewportSize();
    // KeyE runs outside the render loop. Keep latch range at the same fixed
    // close/play scale as the renderer, even before the first frame publishes.
    const playfieldScale = PLAYFIELD_CLOSE_SCALE;
    return {
      bodies: collectPlayHarpoonField(rocks, ships),
      playfieldScale,
      ...(canvas ? { canvas: { width: viewport.width, height: viewport.height } } : {}),
    };
  }

  private publishLiveHarpoonField(localPlayer?: Player | null): void {
    const snapshot = this.snapshotHarpoonField(localPlayer);
    publishHarpoonField(snapshot.bodies, snapshot.playfieldScale, snapshot.canvas);
  }

  private playersWithLocal(local: Player, allPlayers: Player[]): Player[] {
    this.localFirstPlayers.length = 0;
    this.localFirstPlayers.push(local);
    for (const player of allPlayers) {
      this.localFirstPlayers.push(player);
    }
    return this.localFirstPlayers;
  }

  private checkSatelliteLaserCollisions(): void {
    const currPlayer = this.playerManager.getLocalPlayer();
    if (!currPlayer) {
      return;
    }
    const localPlayerId = this.networkManager.getLocalPlayerId() || currPlayer.id;
    this.collisionManager.checkSatelliteLaserCollisions(
      SatelliteManager.getInstance().getAll(),
      currPlayer.ship,
      localPlayerId
    );
  }

  // Check boundary collisions for ships
  private checkBoundaryCollisions(): void {
    const currPlayer = this.playerManager.getLocalPlayer();
    if (!currPlayer) {
      return;
    }

    // Only check the locally-controlled ship. The network player list holds
    // server-synced copies (which lag at 30 FPS) rather than the predicted
    // local ship, and boundary damage is always attributed to the local
    // player. Bots are kept in-bounds server-side; remote players self-report.
    this.collisionManager.checkBoundaryCollisions([currPlayer.ship], currPlayer.id);
  }

  // Check ship collisions with other ships
  private checkShipShipCollisions(allPlayers: Player[]): void {
    const currPlayer = this.playerManager.getLocalPlayer();
    if (!currPlayer) {
      return;
    }

    let count = 0;
    for (const player of allPlayers) {
      if (player.id === currPlayer.id || areAllied(currPlayer.factionId, player.factionId)) {
        continue;
      }
      const existing = this.otherShips[count];
      if (existing) {
        existing.ship = player.ship;
        existing.id = player.id;
      } else {
        this.otherShips[count] = { ship: player.ship, id: player.id };
      }
      count += 1;
    }
    this.otherShips.length = count;

    this.collisionManager.checkShipShipCollisions(currPlayer.ship, this.otherShips, currPlayer.id);
  }

  // Simple render method - no game logic, just rendering
  renderGame(): void {
    const currPlayer = this.playerManager.getLocalPlayer();
    if (!currPlayer) {
      return;
    }

    // Use NetworkManager's player list which has the correct names from server
    const allPlayers = this.networkManager.getAllPlayers();
    const playersToRender = allPlayers.includes(currPlayer)
      ? allPlayers
      : this.playersWithLocal(currPlayer, allPlayers);
    const currScore = currPlayer.score;
    const textAlpha = this.gameStateManager.getTextAlpha();
    const text = this.gameStateManager.getText();

    // Render the current game state
    canvasManager.drawGame(
      currPlayer,
      this.currRoidBelt,
      currScore,
      textAlpha,
      text,
      currPlayer.lives,
      playersToRender
    );
    this.laserUpgradeReadout?.update(
      currPlayer.ship.exploding ? undefined : currPlayer.ship.laserUpgrade
    );
  }
}
