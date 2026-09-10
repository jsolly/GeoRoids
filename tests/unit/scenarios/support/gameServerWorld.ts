import { afterEach, beforeEach, vi } from 'vitest';
import { WebSocketCore } from '../../../../server/communication/WebSocketCore';
import type { GameEntity } from '../../../../server/core/EntityManager';
import { GameEngine } from '../../../../server/core/GameEngine';
import type { AsteroidData, Position, ShipKitId, SoftFactionId } from '../../../../shared-types';
import { DAMAGE, SHIP } from '../../../../src/constants';
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
    const socket = new RecordingSocket();
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
    this.core.handleClientMessage(message, pilot.socket);
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
      throw new Error(`No satellite with id ${satelliteId}`);
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
    const bot = this.engine.getBot(botId);
    if (!bot) {
      throw new Error(`No bot with id ${botId}`);
    }

    // The wire message predates positional hit evidence. Seed the server's
    // tracked human-shot list at the authoritative bot position so this
    // helper exercises the same one-use evidence gate as a live client.
    this.engine.spawnLaser(attacker.id, { ...bot.position }, { x: 0, y: 0 });
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

  hitAsteroid(pilot: Pilot): void {
    const ship = this.entity(pilot);
    this.engine.addAsteroid(
      scenarioAsteroid({
        id: `scenario-roid-${pilot.id}`,
        position: { x: ship.position.x, y: ship.position.y },
      })
    );
    this.engine.resolveAuthoritativeCombat(Date.now());
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
