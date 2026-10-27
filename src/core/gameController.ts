import { GAME } from '../../shared/constants/gameplay';
import { consumeTickAccumulator, GAME_TICK_MS } from '../../shared/gameClock';
import { boundedDiagnosticError } from '../../shared/stateDiagnostics';
import { spiderHitRadius } from '../../shared/terrainSpider';
import type {
  AsteroidData,
  AsteroidDestroyEvent,
  FurnaceDelivery,
  LootData,
  SatellitePickupCollected,
  ShipKitId,
} from '../../shared-types';
import { playDestructionSound } from '../audio/destructionSounds';
import { playFeedback } from '../audio/feedbackSounds';
import { playRespawn } from '../audio/interactionSounds';
import { updateRouteMusic } from '../audio/routeMusic';
import { bindGameAudio, resetGameAudio } from '../audio/spatialAudio';
import { mountSpiderScore } from '../audio/spiderScore';
import { clientPerformance } from '../diagnostics/performanceMetrics';
import { LootField } from '../entities/loot/LootField';
import type { Player } from '../entities/player/Player';
import { PlayerManager } from '../entities/player/PlayerManager';
import { advanceRemotePlayerShips } from '../entities/player/remoteLasers';
import { Roid, RoidBelt } from '../entities/roid/Roid';
import { clearAsteroidShatters, recordAsteroidShatter } from '../entities/roid/roidRenderer';
import { bindHarpoonFieldSource, publishHarpoonField } from '../entities/ship/harpoonField';
import { noteFurnacePipePulse, resetFurnacePipePulses } from '../fx/furnacePipePulse';
import { playLocalHaptic } from '../fx/haptics';
import { tickTouchControls } from '../input/touchControls';
import {
  applyAsteroidKinematics,
  bindAsteroidFieldApply,
  unbindAsteroidFieldApply,
} from '../network/services/asteroidFieldSync';
import { ConnectionManager } from '../network/services/ConnectionManager';
import { CollisionManager } from '../physics/CollisionManager';
import { getSpiderField } from '../physics/terrain/spiderSession';
import { stopTerrainPrefetch } from '../physics/terrain/terrainSession';
import { drawGame } from '../rendering/canvas';
import { canvasManager } from '../rendering/canvasSurface';
import { clearStaticFurnaceArtwork } from '../rendering/furnaceRenderer';
import { clearStaticCourtArtwork } from '../rendering/ricochetCourtRenderer';
import { getSelectedShipKitId } from '../runtime/shipSelection';
import { syncCargoFullHint } from '../ui/cargoFullHint';
import { mountFurnaceTravelPrompt, syncFurnaceTravelPrompt } from '../ui/furnaceTravelPrompt';
import { showSchematicEquipHint } from '../ui/schematicEquipHint';
import { playSpawnFlyIn } from '../ui/spawnFlyIn';
import { setPlayView } from '../ui/uiUtils';
import { bindUniverseMapField } from '../ui/universeMap';
import { logger } from '../utils/Logger';
import { GameStateManager } from './services/GameStateManager';
import { InputManager } from './services/InputManager';

export class GameController {
  private harpoonBodies() {
    return [
      ...this.currRoidBelt.getRoids(),
      ...getSpiderField().spiders.map((spider) => ({
        kind: 'spider' as const,
        id: spider.id,
        position: spider.position,
        velocity: { x: 0, y: 0 },
        health: spider.health,
        size: spiderHitRadius(spider.id),
      })),
    ];
  }

  private static instance: GameController;

  private gameStateManager: GameStateManager;
  private playerManager: PlayerManager;
  private inputManager: InputManager;
  private networkManager: ConnectionManager;
  private collisionManager: CollisionManager;

  private currRoidBelt: RoidBelt;
  private readonly localFirstPlayers: Player[] = [];
  private simulationAccumulatorMs = 0;
  /** True once this contact run's overlapping pose has actually been sent. */
  private boundaryContactReported = false;

  private constructor() {
    this.gameStateManager = GameStateManager.getInstance();
    this.networkManager = ConnectionManager.getInstance();
    this.playerManager = PlayerManager.getInstance({
      networkPort: this.networkManager,
      combatNetwork: this.networkManager.combatNetwork,
    });
    this.inputManager = InputManager.getInstance();
    this.collisionManager = CollisionManager.getInstance();
    // Initialize with empty asteroid belt - will be populated by server
    this.currRoidBelt = new RoidBelt();
  }

  private runtimeListeners: AbortController | null = null;
  private joinGeneration = 0;
  private poseTimer: ReturnType<typeof setInterval> | null = null;

  private startPoseUpdates(): void {
    this.stopPoseUpdates();
    this.poseTimer = setInterval(() => this.playerManager.updateNetworkState(), GAME_TICK_MS);
  }

  private stopPoseUpdates(): void {
    if (this.poseTimer !== null) {
      clearInterval(this.poseTimer);
      this.poseTimer = null;
    }
  }

  /** Reattach the retained production graph for one mounted browser shell. */
  attachRuntime(): void {
    if (this.runtimeListeners) {
      return;
    }
    this.runtimeListeners = new AbortController();
    mountSpiderScore(this.runtimeListeners.signal);
    mountFurnaceTravelPrompt(this.runtimeListeners.signal);
    bindGameAudio({
      getListenerPosition: () => this.playerManager.getLocalShip()?.position,
      getViewport: () => {
        const canvas = canvasManager.getCanvas();
        if (!canvas) {
          return undefined;
        }
        const viewport = canvasManager.getViewportSize();
        return {
          width: viewport.width,
          height: viewport.height,
          rotation: 0,
        };
      },
    });

    bindHarpoonFieldSource(() => this.harpoonBodies());
    bindUniverseMapField(() => this.currRoidBelt.getRoids());
    this.networkManager.attachRuntime(this.runtimeListeners.signal);
    this.setupNetworkDisconnectionHandler(this.runtimeListeners.signal);
    window.gameController = this;
  }

  detachRuntime(): void {
    clearStaticFurnaceArtwork();
    clearStaticCourtArtwork();
    this.joinGeneration++;
    this.gameStateManager.setIsGameRunning(false);
    this.runtimeListeners?.abort();
    this.runtimeListeners = null;
    this.cleanupServerAsteroidListeners();
    this.inputManager.detachRuntime();
    this.stopPoseUpdates();
    this.networkManager.disconnect();
    resetGameAudio();
    stopTerrainPrefetch();
    bindHarpoonFieldSource(null);
    bindUniverseMapField(() => []);
    if (window.gameController === this) {
      delete window.gameController;
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
    clearStaticFurnaceArtwork();
    clearStaticCourtArtwork();
    clearAsteroidShatters();
    resetFurnacePipePulses();
    this.simulationAccumulatorMs = 0;
    this.boundaryContactReported = false;
    // Create new player
    this.playerManager.createLocalPlayer(kitId ?? getSelectedShipKitId());

    // Set the player name if provided
    if (playerName != null && playerName !== '') {
      this.playerManager.setPlayerName(playerName);
    }

    // startGame waits for the authoritative asteroid field.
  }

  async startGame(playerName?: string, kitId?: ShipKitId): Promise<void> {
    logger.debug('GAME_CONTROLLER', 'startGame called', { kitId });
    this.attachRuntime();
    const generation = ++this.joinGeneration;
    const joinStartedAt = performance.now();
    try {
      this.resetSessionForNewGame();
      clientPerformance.join(joinStartedAt);
      this.newGame(playerName, kitId ?? getSelectedShipKitId());

      // Connect before joining the server-owned world.
      await this.networkManager.connect();
      if (generation !== this.joinGeneration) {
        return;
      }

      logger.debug('NETWORK', 'Connected to server, using server-authoritative game state');
      // Empty belt + listeners must be ready before join so the first
      // asteroidCreateBatch / snapshot cannot land on a static local set.
      this.currRoidBelt = new RoidBelt();
      this.setupServerAsteroidListeners();
      const joined = await this.networkManager.joinAndWaitForWorld();
      if (generation !== this.joinGeneration) {
        return;
      }
      if (!joined) {
        this.gameStateManager.setIsGameRunning(false);
        setPlayView(false);
        return;
      }
      setPlayView(true);
      this.gameStateManager.setIsGameRunning(true);

      if (!this.playerManager.getLocalPlayer()) {
        throw new Error('Cannot initialize input listeners without a local player');
      }
      logger.debug('GAME_CONTROLLER', 'Initializing input listeners');
      this.inputManager.initializeListeners(canvasManager.requireCanvas());

      // Begin sending continuous local player updates to server
      this.startPoseUpdates();

      playRespawn();
      playSpawnFlyIn();
      window.dispatchEvent(new CustomEvent('gameStart'));
    } catch (error) {
      if (generation !== this.joinGeneration) {
        return;
      }
      clientPerformance.joinFailed();
      this.gameStateManager.setIsGameRunning(false);
      this.networkManager.disconnect();
      setPlayView(false);
      const reportedError = boundedDiagnosticError(error, 'Unknown connection failure');
      const errorMessage = reportedError.message;

      logger.error('NETWORK', 'Failed to connect to game server', reportedError);

      throw new Error(`Network connection failed: ${errorMessage}`, { cause: error });
    }
  }

  // Event handler methods for server asteroid synchronization
  private applyServerAsteroidCreated = (asteroid: AsteroidData): void => {
    this.currRoidBelt.add(new Roid(asteroid));
  };

  private applyServerAsteroidUpdated = (asteroidId: string, updates: AsteroidData): void => {
    const roid = this.currRoidBelt.getById(asteroidId);
    if (roid) {
      applyAsteroidKinematics(roid, updates);
    }
  };

  private removeServerAsteroid = (
    event: AsteroidDestroyEvent,
    showDestructionVfx: boolean
  ): void => {
    const { asteroidId } = event;

    const roid = this.currRoidBelt.getById(asteroidId);
    if (!roid) {
      return;
    }
    if (showDestructionVfx) {
      playDestructionSound('asteroid', roid.position);
      recordAsteroidShatter(
        roid,
        performance.now(),
        event.consumedBy === 'furnace' ? 'furnace' : 'break'
      );
    }
    this.currRoidBelt.remove(roid);
  };

  private applyServerAsteroidDestroyed = (event: AsteroidDestroyEvent): void => {
    this.removeServerAsteroid(event, true);
  };

  private applyServerAsteroidReconciled = (asteroidId: string): void => {
    this.removeServerAsteroid({ asteroidId }, false);
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
    this.gameStateManager.setPickupMessage(detail.pickupName);
    showSchematicEquipHint();
  };

  private handleFurnaceDelivery = (event: Event): void => {
    const delivery = (event as CustomEvent<FurnaceDelivery>).detail;
    noteFurnacePipePulse(delivery.furnaceId);
    const reward = delivery.rewards.find(
      (item) => item.playerId === this.networkManager.getLocalPlayerId()
    );
    if (!reward) {
      return;
    }
    this.gameStateManager.setDeliveryMessage(reward.points, delivery.rewards.length);
    playFeedback('delivery');
    playLocalHaptic(true, 'pickup');
  };

  private setupServerAsteroidListeners(): void {
    this.cleanupServerAsteroidListeners();
    bindAsteroidFieldApply({
      readBelt: () => this.currRoidBelt.getRoids(),
      onCreated: this.applyServerAsteroidCreated,
      onUpdated: this.applyServerAsteroidUpdated,
      onDestroyed: this.applyServerAsteroidDestroyed,
      onReconciled: this.applyServerAsteroidReconciled,
    });
    window.addEventListener('satellitePickupCollected', this.handleSatellitePickupCollected);
    window.addEventListener('furnaceDelivery', this.handleFurnaceDelivery);
  }

  private cleanupServerAsteroidListeners(): void {
    unbindAsteroidFieldApply();
    window.removeEventListener('satellitePickupCollected', this.handleSatellitePickupCollected);
    window.removeEventListener('furnaceDelivery', this.handleFurnaceDelivery);
  }

  private resetSessionForNewGame(): void {
    this.gameStateManager.clearPickupMessage();
    canvasManager.clearPlayfield();
    this.stopPoseUpdates();
    this.networkManager.disconnect({ newSession: true });
  }

  getCurrPlayer() {
    return this.playerManager.getLocalPlayer();
  }

  getCurrRoidBelt(): RoidBelt {
    return this.currRoidBelt;
  }

  getCurrRoidCount(): number {
    return this.currRoidBelt.size();
  }

  getLoot(): LootData[] {
    return LootField.getInstance().getAll();
  }

  getIsGameRunning(): boolean {
    return this.gameStateManager.getIsGameRunning();
  }

  /** Stop a broken frame from repeating while the visible restart notice is shown. */
  stopAfterFrameFailure(): void {
    this.gameStateManager.setIsGameRunning(false);
    this.stopPoseUpdates();
    this.inputManager.releaseHeldInput();
    this.networkManager.disconnect();
    setPlayView(false);
  }

  getNetworkManager(): ConnectionManager {
    return this.networkManager;
  }

  getGameStateManager(): GameStateManager {
    return this.gameStateManager;
  }

  private setupNetworkDisconnectionHandler(signal: AbortSignal): void {
    // Listen for successful reconnection
    window.addEventListener(
      'networkReconnected',
      () => {
        logger.info('NETWORK', 'Successfully reconnected to server - re-joining the live field');
        this.networkManager.initializeAsteroidSync();
      },
      { signal }
    );

    // Terminal join, protocol or reconnect failure leaves play.
    window.addEventListener(
      'networkPermanentlyDisconnected',
      () => {
        // Only stop the game when reconnection has permanently failed
        this.gameStateManager.setIsGameRunning(false);
        this.stopPoseUpdates();
        setPlayView(false);
      },
      { signal }
    );
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
    InputManager.getInstance().updateMovementLock();
    syncFurnaceTravelPrompt();
    syncCargoFullHint();
    tickTouchControls(currPlayer);
    currPlayer.ship.update();

    // Remote pose remains server-driven; their projectiles and lifecycle
    // advance on the same simulation clock as the local ship.
    const allPlayers = this.networkManager.getAllPlayers();
    advanceRemotePlayerShips(allPlayers);

    // Update asteroids
    this.currRoidBelt.moveRoids();
    this.publishLiveHarpoonField();

    // Flash local wall contact, and report it before the frame ends
    this.reportBoundaryContact();

    // Update game state manager
    this.gameStateManager.updatePickupMessageTimer();
  }

  private publishLiveHarpoonField(): void {
    publishHarpoonField(this.harpoonBodies());
  }

  private playersWithLocal(local: Player, allPlayers: Player[]): Player[] {
    this.localFirstPlayers.length = 0;
    this.localFirstPlayers.push(local);
    for (const player of allPlayers) {
      this.localFirstPlayers.push(player);
    }
    return this.localFirstPlayers;
  }

  /**
   * Flash the local hull on wall contact and make sure the server sees it.
   * The latch means one report per contact run, and it is set from the send's
   * own result so a refused pose is retried on the next overlapping frame.
   */
  private reportBoundaryContact(): void {
    const currPlayer = this.playerManager.getLocalPlayer();
    if (!currPlayer) {
      return;
    }

    // Only check the locally-controlled ship. The network player list holds
    // server-synced copies (which lag at 30 FPS) rather than the predicted
    // local ship, and the server kills each pilot from its own reading of
    // their reported pose, so nothing here needs the hold size.
    if (!this.collisionManager.checkBoundaryCollisions([currPlayer.ship])) {
      this.boundaryContactReported = false;
      return;
    }
    if (this.boundaryContactReported) {
      return;
    }
    // Report this frame's overlapping position from inside the simulation
    // frame. `updateGame` drains the tick accumulator in a synchronous loop, so
    // the 60 Hz pose timer can only ever sample the burst's final frame: on a
    // client advancing two frames per repaint, a contact lasting a single frame
    // would never reach the server and the wall would not be lethal there.
    // At most one *delivered* report per contact run. A refused attempt puts
    // nothing on the wire — `sendPlayerState` refuses before building a packet,
    // and a send that throws retires the socket — so retrying on later
    // overlapping frames costs no inbound budget:
    // `server/communication/messageBudget.ts` allows 120/s against roughly 90/s
    // of poses and snapshot acknowledgments, and exceeding it terminates the
    // socket rather than throttling it. `InputManager.updateMovementLock`
    // reports out of band the same way.
    this.boundaryContactReported = this.playerManager.updateNetworkState();
  }

  // Simple render method - no game logic, just rendering
  renderGame(): void {
    const currPlayer = this.playerManager.getLocalPlayer();
    if (!currPlayer) {
      return;
    }

    // Use ConnectionManager's player list which has the correct names from server
    const allPlayers = this.networkManager.getAllPlayers();
    const playersToRender = allPlayers.includes(currPlayer)
      ? allPlayers
      : this.playersWithLocal(currPlayer, allPlayers);

    updateRouteMusic(currPlayer.ship);
    // Render the current game state
    drawGame(currPlayer, this.currRoidBelt, playersToRender);
  }
}
