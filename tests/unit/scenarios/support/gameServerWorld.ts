import { afterEach, beforeEach, vi } from 'vitest';
import { WebSocketCore } from '../../../../server/communication/WebSocketCore';
import type { GameEntity } from '../../../../server/core/EntityManager';
import { GameEngine } from '../../../../server/core/GameEngine';
import { SNAPSHOT_VERSION, SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import type {
  AsteroidData,
  Position,
  ServerGameSnapshot,
  ShipKitId,
} from '../../../../shared-types';
import { SHIP } from '../../../../src/constants';
import { RecordingSocket } from '../../../support/recordingSocket';

function scenarioAsteroid(overrides: Partial<AsteroidData> = {}): AsteroidData {
  return {
    id: 'scenario-asteroid-0',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 10,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    ...overrides,
  };
}

/** Combat lifecycle timers count simulation frames. */
export const EXPLOSION_FRAMES = SHIP.EXPLODE_DURATION_FRAMES;
/** GameEngine schedules this at death; the explosion runs in parallel. */
export const RESPAWN_COUNTDOWN_FRAMES = SHIP.RESPAWN_DELAY_FRAMES;
export const SPAWN_PROTECTION_FRAMES = SHIP.INVINCIBILITY_DURATION_FRAMES;
/** Circular arena used by the server (`getGameBoundary()` / EntityManager). */
export const ARENA_RADIUS = 3100;

export interface Pilot {
  id: string;
  name: string;
  socket: RecordingSocket;
  resumeToken: string;
}

interface JoinOptions {
  kitId?: ShipKitId;
  resumeToken?: string;
}

interface JoinedAcknowledgment {
  id: string;
  name: string;
  resumeToken: string;
  snapshotVersion: typeof SNAPSHOT_VERSION;
  asteroidInteractions: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJoinedAcknowledgment(socket: RecordingSocket): JoinedAcknowledgment {
  const message = socket.lastReceived('joined');
  if (!message || !isRecord(message.data)) {
    throw new Error('Current join did not receive a joined acknowledgment');
  }
  const data = message.data;
  if (
    typeof data['id'] !== 'string' ||
    typeof data['name'] !== 'string' ||
    typeof data['resumeToken'] !== 'string' ||
    data['resumeToken'].length !== 64 ||
    data['snapshotVersion'] !== SNAPSHOT_VERSION ||
    data['asteroidInteractions'] !== 1
  ) {
    throw new Error('Joined acknowledgment did not advertise the current protocol');
  }
  return {
    id: data['id'],
    name: data['name'],
    resumeToken: data['resumeToken'],
    snapshotVersion: SNAPSHOT_VERSION,
    asteroidInteractions: 1,
  };
}

type SendCallback = (error?: Error) => void;
type SendData = Parameters<RecordingSocket['send']>[0];
type SendOptions = { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean };

/** Application state survives clearing the fixture's transport recording. */
class ScenarioSocket extends RecordingSocket {
  private readonly decoder = new SnapshotDecoder();
  private protocolReady = false;
  private ownerId: string | undefined;
  private appliedWorld: ServerGameSnapshot | undefined;
  private applicationFailure: Error | undefined;

  constructor(private readonly acknowledge: (sequence: number) => void) {
    super();
  }

  override send(data: SendData, callback?: SendCallback): void;
  override send(data: SendData, options: SendOptions, callback?: SendCallback): void;
  override send(
    data: SendData,
    optionsOrCallback?: SendOptions | SendCallback,
    callback?: SendCallback
  ): void {
    const previouslyRecorded = this.sent.length;
    if (typeof optionsOrCallback === 'object') {
      super.send(data, optionsOrCallback, callback);
    } else {
      super.send(data, optionsOrCallback ?? callback);
    }
    // Preserve RecordingSocket's transport callback/error behavior. Application
    // consumption happens only after a successful recorded transport send.
    if (this.sent.length > previouslyRecorded && typeof data === 'string') {
      this.applyMessage(data);
    }
  }

  private applyMessage(raw: string): void {
    try {
      const result = this.decoder.readMessage(raw, { acceptSnapshots: this.protocolReady });
      if (result.kind === 'snapshot-rejected') {
        throw result.error;
      }
      if (result.kind === 'message') {
        if (isRecord(result.message) && result.message['type'] === 'joined') {
          const joined = readJoinedAcknowledgment(this);
          this.ownerId = joined.id;
          this.protocolReady = true;
          this.decoder.reset();
        }
        return;
      }
      if (!result.state.entities.some((entity) => entity.id === this.ownerId)) {
        throw new Error('Fixture world omitted its current pilot');
      }
      this.appliedWorld = result.state;
      this.acknowledge(result.metadata.sequence);
    } catch (error) {
      // Consumer failure cannot turn a successful server write into a failed
      // transport callback. Surface it when observing or disposing the fixture.
      this.applicationFailure ??=
        error instanceof Error
          ? error
          : new Error('Fixture client failed to apply a world', { cause: error });
    }
  }

  checkApplication(): void {
    if (this.applicationFailure) {
      throw this.applicationFailure;
    }
  }

  snapshot(name: string): ServerGameSnapshot {
    this.checkApplication();
    if (!this.appliedWorld) {
      throw new Error(`${name} has not applied a current snapshot`);
    }
    return this.appliedWorld;
  }
}

/**
 * Real `GameEngine` + `WebSocketCore` with recording sockets and seeded world RNG.
 * The engine keeps its real server clock. Control it explicitly for gameplay deadlines.
 * `tick()` advances combat-frame counters; `startClock()` starts the real loop.
 */
export class GameServerWorld {
  readonly engine: GameEngine;
  readonly core: WebSocketCore;
  private joinCount = 0;
  private readonly clients = new Set<ScenarioSocket>();

  constructor(seed = 42) {
    this.engine = new GameEngine(seed);
    this.core = new WebSocketCore(this.engine);
    this.engine.setOnAsteroidHits((hits) => {
      this.core.getMessageHandler().broadcastAppliedAsteroidHits(hits);
    });
  }

  join(name: string, position: Position = { x: 0, y: 0 }, options: JoinOptions = {}): Pilot {
    this.joinCount += 1;
    const id = `${name.toLowerCase()}-${this.joinCount}`;
    const socket = this.createSocket();
    this.sendJoin(socket, id, name, position, options);
    const pilot = this.pilotFromJoin(socket, id, name);
    // The join protocol only keeps a town-ring arrival. Fixture poses are applied after that.
    if (
      !this.engine.playerMotion.placeActorForTesting(
        pilot.id,
        position,
        this.engine.getServerTime()
      )
    ) {
      throw new Error(`Join fixture could not place ${pilot.id}`);
    }
    return pilot;
  }

  joinWithId(
    id: string,
    name: string,
    position: Position = { x: 0, y: 0 },
    options: JoinOptions = {}
  ): Pilot {
    const socket = this.createSocket();
    this.sendJoin(socket, id, name, position, options);
    return this.pilotFromJoin(socket, id, name);
  }

  /** Send a current join without requiring the request to succeed. */
  attemptJoin(
    id: string,
    name: string,
    position: Position = { x: 0, y: 0 },
    options: JoinOptions = {}
  ): RecordingSocket {
    const socket = this.createSocket();
    this.sendJoin(socket, id, name, position, options);
    return socket;
  }

  /** Resume the current motion/session owner on a replacement gameplay socket. */
  resume(pilot: Pilot, position: Position = this.entity(pilot).position): Pilot {
    const socket = this.createSocket();
    this.sendJoin(socket, pilot.id, pilot.name, position, {
      resumeToken: pilot.resumeToken,
    });
    return this.pilotFromJoin(socket, pilot.id, pilot.name);
  }

  /** Model a transport close while retaining the private resume session. */
  dropTransport(pilot: Pilot): void {
    pilot.socket.close();
    this.engine.transportClosed(pilot.socket);
  }

  private sendJoin(
    socket: RecordingSocket,
    id: string,
    name: string,
    position: Position,
    options: JoinOptions
  ): void {
    this.core.handleClientMessage(
      {
        type: 'join',
        id,
        name,
        data: {
          name,
          position,
          kitId: options.kitId,
          snapshotVersion: SNAPSHOT_VERSION,
          asteroidInteractions: 1,
          ...(options.resumeToken ? { resumeToken: options.resumeToken } : {}),
        },
      },
      socket
    );
  }

  private createSocket(): ScenarioSocket {
    const socket: ScenarioSocket = new ScenarioSocket((sequence) => {
      this.core.handleClientMessage({ type: 'snapshotAck', data: { sequence } }, socket);
    });
    this.clients.add(socket);
    return socket;
  }

  private pilotFromJoin(socket: RecordingSocket, id: string, name: string): Pilot {
    const joined = readJoinedAcknowledgment(socket);
    if (joined.id !== id || joined.name !== name) {
      throw new Error(`Join returned ${joined.id}/${joined.name}, expected ${id}/${name}`);
    }
    return { id, name, socket, resumeToken: joined.resumeToken };
  }

  disconnect(pilot: Pilot): void {
    pilot.socket.close();
    this.core.removePlayer(pilot.id);
  }

  send(pilot: Pilot, message: Record<string, unknown>): void {
    this.core.handleClientMessage(message, pilot.socket);
  }

  hitBoundary(pilot: Pilot): void {
    this.send(pilot, {
      type: 'collisionDamage',
      data: {
        targetPlayerId: pilot.id,
        attackerId: 'boundary',
      },
    });
  }

  hitAsteroid(pilot: Pilot): void {
    const ship = this.entity(pilot);
    this.engine.addAsteroid(
      scenarioAsteroid({
        id: `scenario-roid-${pilot.id}`,
        position: { x: ship.position.x, y: ship.position.y },
      })
    );
    this.engine.resolveAuthoritativeCombat();
  }

  move(pilot: Pilot, position: Position): void {
    const entity = this.entity(pilot);
    const motion = entity.playerMotion;
    if (!motion) {
      throw new Error(`${pilot.name} has no current motion session`);
    }
    this.send(pilot, {
      type: 'update',
      id: pilot.id,
      data: {
        position,
        velocity: { x: 0, y: 0 },
        angle: entity.angle,
        thrusting: false,
        motionEpoch: motion.epoch,
        motionSequence: motion.ack + 1,
      },
    });
  }

  /**
   * Same combat pair the live loop runs each frame; server time is not advanced.
   * Does not move the asteroid belt — use `startClock()` / `advanceOneFrame` for that.
   */
  tick(frames = 1): void {
    for (let i = 0; i < frames; i++) {
      this.engine.advanceCombatFrame();
    }
  }

  wearOffJoinInvulnerability(): void {
    this.tick(SPAWN_PROTECTION_FRAMES);
  }

  tickThroughRespawn(): void {
    this.tick(RESPAWN_COUNTDOWN_FRAMES);
  }

  startClock(): void {
    this.engine.startGameLoop();
  }

  /** Remove the production-seeded belt when a scenario isolates ship combat. */
  clearAsteroids(): void {
    for (const asteroid of this.engine.getAllAsteroids()) {
      this.engine.removeAsteroid(asteroid.id);
    }
    this.engine.addAsteroid(
      scenarioAsteroid({
        id: 'scenario-combat-buffer',
        position: { x: 2000, y: 2000 },
        size: 10,
        health: 40,
        maxHealth: 40,
      })
    );
  }

  entity(pilot: Pilot): GameEntity {
    const entity = this.engine.getPlayer(pilot.id);
    if (!entity) {
      throw new Error(`${pilot.name} is not on the server`);
    }
    return entity;
  }

  ship(id: string): GameEntity {
    const entity = this.engine.entityManager.getEntity(id);
    if (!entity) {
      throw new Error(`No ship with id ${id}`);
    }
    return entity;
  }

  isOnServer(pilot: Pilot): boolean {
    return this.engine.getPlayer(pilot.id) !== undefined;
  }

  leaderboardNames(): string[] {
    return this.engine.getGameState().entities.map((entity) => entity.name);
  }

  gameTime(): number {
    return this.engine.getGameState().gameTime;
  }

  broadcastGameState(): void {
    this.core.getBroadcaster().broadcastGameState();
  }

  snapshot(pilot: Pilot): ServerGameSnapshot {
    if (!(pilot.socket instanceof ScenarioSocket)) {
      throw new Error(`${pilot.name} does not own a fixture client`);
    }
    return pilot.socket.snapshot(pilot.name);
  }

  dispose(): void {
    this.engine.stopGameLoop();
    this.core.stopPeriodicGameStateBroadcast();
    for (const client of this.clients) {
      client.checkApplication();
    }
  }
}

export function distanceFromCenter(position: Position): number {
  return Math.hypot(position.x, position.y);
}

export function useQuietServerConsole(): void {
  beforeEach(() => {
    for (const level of ['log', 'debug', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}
