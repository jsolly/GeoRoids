import { afterEach, beforeEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AsteroidData, Position, ShipKitId, SoftFactionId } from '../../../../shared-types';
import { WebSocketCore } from '../../../../server/communication/WebSocketCore';
import type { GameEntity } from '../../../../server/core/EntityManager';
import { GameEngine } from '../../../../server/core/GameEngine';
import { DAMAGE, GAME, SHIP } from '../../../../src/constants';

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
export const FRAMES_PER_SECOND = GAME.FPS;
export const EXPLOSION_FRAMES = SHIP.EXPLODE_DURATION_FRAMES;
/** GameEngine schedules this at death; the explosion runs in parallel. */
export const RESPAWN_COUNTDOWN_FRAMES = SHIP.RESPAWN_DELAY_FRAMES;
export const SPAWN_PROTECTION_FRAMES = SHIP.INVINCIBILITY_DURATION_FRAMES;
/** Circular arena used by the server (`getGameBoundary()` / EntityManager). */
export const ARENA_RADIUS = 3100;

export interface ServerMessage {
  type: string;
  data?: Record<string, unknown> & { id?: string };
  timestamp?: number;
}

/**
 * In-process stand-in for a browser WebSocket.
 * `GameStateBroadcaster` only needs `readyState` and `send`.
 */
export class FakeSocket {
  readyState: number = WebSocket.OPEN;
  readonly inbox: ServerMessage[] = [];

  send(raw: string): void {
    this.inbox.push(JSON.parse(raw) as ServerMessage);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  received(type: string): ServerMessage[] {
    return this.inbox.filter((message) => message.type === type);
  }

  lastReceived(type: string): ServerMessage | undefined {
    return this.received(type).at(-1);
  }

  clear(): void {
    this.inbox.length = 0;
  }
}

export interface Pilot {
  id: string;
  name: string;
  socket: FakeSocket;
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
  }

  join(
    name: string,
    position: Position = { x: 0, y: 0 },
    options: { kitId?: ShipKitId; factionId?: SoftFactionId } = {}
  ): Pilot {
    this.joinCount += 1;
    const id = `${name.toLowerCase()}-${this.joinCount}`;
    const socket = new FakeSocket();
    this.send(
      { id, name, socket },
      {
        type: 'join',
        id,
        name,
        data: { name, position, kitId: options.kitId, factionId: options.factionId },
      }
    );
    return { id, name, socket };
  }

  disconnect(pilot: Pilot): void {
    pilot.socket.close();
    this.core.removePlayer(pilot.id);
  }

  send(pilot: Pilot, message: Record<string, unknown>): void {
    this.core.handleClientMessage(message, pilot.socket as unknown as WebSocket);
  }

  shoot(attacker: Pilot, target: Pilot, damage: number = DAMAGE.LASER_HIT): void {
    this.send(attacker, {
      type: 'laserDamage',
      data: { targetPlayerId: target.id, attackerId: attacker.id, damage },
    });
  }

  shootSatellite(attacker: Pilot, satelliteId: string, damage: number = DAMAGE.LASER_HIT): void {
    const satellite = this.engine.getSatellite(satelliteId);
    if (!satellite) {
      return;
    }

    // The server accepts a satelliteDamage report only when it can consume a
    // matching server-owned human laser. Keep this test helper on that same
    // wire path instead of bypassing the authoritative shot check.
    const hitCount = Math.max(1, Math.ceil(damage / DAMAGE.LASER_HIT));
    for (let i = 0; i < hitCount; i++) {
      const laserPosition = { ...satellite.position };
      this.engine.spawnLaser(attacker.id, laserPosition, { x: 0, y: 0 });
      this.send(attacker, {
        type: 'satelliteDamage',
        data: {
          satelliteId,
          attackerId: attacker.id,
          damage: DAMAGE.LASER_HIT,
          laserPosition,
        },
      });
    }
  }

  shootBot(attacker: Pilot, botId: string, damage: number = DAMAGE.LASER_HIT): void {
    this.send(attacker, {
      type: 'botDamage',
      data: { botId, attackerId: attacker.id, damage },
    });
  }

  hitBoundary(pilot: Pilot): void {
    this.send(pilot, {
      type: 'collisionDamage',
      data: {
        targetPlayerId: pilot.id,
        attackerId: 'boundary',
        damage: DAMAGE.BOUNDARY_COLLISION,
      },
    });
  }

  hitAsteroid(pilot: Pilot, damage: number = DAMAGE.LASER_HIT): void {
    const ship = this.entity(pilot);
    this.engine.addAsteroid(
      scenarioAsteroid({
        id: `scenario-roid-${pilot.id}`,
        position: { x: ship.position.x, y: ship.position.y },
      })
    );
    const before = ship.health;
    this.engine.resolveAuthoritativeCombat(Date.now());
    const applied = Math.max(0, before - this.entity(pilot).health);
    const remaining = damage - applied;
    if (remaining > 0 && this.entity(pilot).health > 0) {
      this.engine.handleShipDamage(pilot.id, 'asteroid', remaining, 'collision');
    }
  }

  move(pilot: Pilot, position: Position): void {
    this.send(pilot, { type: 'update', id: pilot.id, position });
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

  /** Park bots far from the origin so kit-ability tests can isolate one target. */
  parkBots(position: Position = { x: 2500, y: 2500 }): void {
    for (const bot of this.engine.entityManager.getBots()) {
      bot.position = { ...position };
      bot.velocity = { x: 0, y: 0 };
    }
  }

  /** Remove the production-seeded belt when a scenario isolates ship combat. */
  clearAsteroids(): void {
    for (const asteroid of this.engine.getAllAsteroids()) {
      this.engine.removeAsteroid(asteroid.id);
    }
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
