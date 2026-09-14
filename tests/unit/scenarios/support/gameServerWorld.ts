import { afterEach, beforeEach, vi } from 'vitest';
import { WebSocketCore } from '../../../../server/communication/WebSocketCore';
import type { GameEntity } from '../../../../server/core/EntityManager';
import { GameEngine } from '../../../../server/core/GameEngine';
import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import type {
  AsteroidData,
  Position,
  ServerGameSnapshot,
  ShipKitId,
} from '../../../../shared-types';
import { DAMAGE, GAME, LASER, SHIP } from '../../../../src/constants';
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

/** One server tick is one frame at GAME.FPS. */
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
  snapshotVersion: 1;
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
    data['snapshotVersion'] !== 1 ||
    data['asteroidInteractions'] !== 1
  ) {
    throw new Error('Joined acknowledgment did not advertise the current protocol');
  }
  return {
    id: data['id'],
    name: data['name'],
    resumeToken: data['resumeToken'],
    snapshotVersion: 1,
    asteroidInteractions: 1,
  };
}

/**
 * Real `GameEngine` + `WebSocketCore` with no TCP and no wall-clock timers.
 * Scenario tests drive the world with `tick()` / `startClock()`.
 */
export class GameServerWorld {
  readonly engine: GameEngine;
  readonly core: WebSocketCore;
  private joinCount = 0;

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
    const socket = new RecordingSocket();
    this.sendJoin(socket, id, name, position, options);
    return this.pilotFromJoin(socket, id, name);
  }

  joinWithId(
    id: string,
    name: string,
    position: Position = { x: 0, y: 0 },
    options: JoinOptions = {}
  ): Pilot {
    const socket = new RecordingSocket();
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
    const socket = new RecordingSocket();
    this.sendJoin(socket, id, name, position, options);
    return socket;
  }

  /** Resume the current motion/session owner on a replacement gameplay socket. */
  resume(pilot: Pilot, position: Position = this.entity(pilot).position): Pilot {
    const socket = new RecordingSocket();
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
          snapshotVersion: 1,
          asteroidInteractions: 1,
          ...(options.resumeToken ? { resumeToken: options.resumeToken } : {}),
        },
      },
      socket
    );
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

  shootAsteroid(attacker: Pilot, asteroidId: string, damage: number = DAMAGE.LASER_HIT): void {
    const asteroid = this.engine.getAsteroid(asteroidId);
    if (!asteroid) {
      throw new Error(`No asteroid with id ${asteroidId}`);
    }
    const shooter = this.entity(attacker);
    for (const candidate of this.engine.getAllAsteroids()) {
      if (candidate.id !== asteroidId) {
        this.engine.removeAsteroid(candidate.id);
      }
    }
    const hitCount = Math.max(1, Math.ceil(damage / DAMAGE.LASER_HIT));
    for (let i = 0; i < hitCount && asteroid.health > 0; i++) {
      const healthBefore = asteroid.health;
      asteroid.position = { x: shooter.position.x + 40, y: shooter.position.y };
      asteroid.velocity = { x: 0, y: 0 };
      this.fireAt(attacker, asteroid.position, () => asteroid.health < healthBefore);
    }
  }

  private fireAt(attacker: Pilot, target: Position, settled: () => boolean): void {
    const shooter = this.entity(attacker);
    const delta = { x: target.x - shooter.position.x, y: target.y - shooter.position.y };
    const distance = Math.hypot(delta.x, delta.y);
    const direction =
      distance > 0 ? { x: delta.x / distance, y: delta.y / distance } : { x: 1, y: 0 };
    const laserStart = {
      x: shooter.position.x,
      y: shooter.position.y,
    };
    this.send(attacker, {
      type: 'shoot',
      id: attacker.id,
      data: {
        laserStart,
        laserDirection: {
          x: direction.x * (LASER.SPEED / GAME.FPS),
          y: direction.y * (LASER.SPEED / GAME.FPS),
        },
      },
    });

    const frames = Math.max(4, Math.ceil(Math.max(1, distance) / (LASER.SPEED / GAME.FPS)) + 4);
    for (let frame = 0; frame < frames && !settled(); frame++) {
      this.engine.advanceOneFrame();
    }
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
   * Same combat pair the live loop runs each frame, plus the monotonic clock.
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
    const decoder = new SnapshotDecoder();
    let state: ServerGameSnapshot | undefined;
    for (const raw of pilot.socket.sent) {
      const result = decoder.readMessage(raw, { acceptSnapshots: true });
      if (result.kind === 'snapshot-rejected') {
        throw result.error;
      }
      if (result.kind === 'snapshot') {
        state = result.state;
      } else if (
        result.message &&
        typeof result.message === 'object' &&
        'type' in result.message &&
        result.message.type === 'joined'
      ) {
        decoder.reset();
      }
    }
    if (!state) {
      throw new Error(`${pilot.name} has not received a current snapshot`);
    }
    return state;
  }

  dispose(): void {
    this.engine.stopGameLoop();
    this.core.stopPeriodicGameStateBroadcast();
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
