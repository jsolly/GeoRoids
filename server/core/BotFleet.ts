import { randomUUID } from 'node:crypto';
import { AI_SHIPS, inBotSanctuary } from '../../shared/aiShips';
import { isCombatantImmune } from '../../shared/combat';
import { GAME, LASER, SHIP } from '../../shared/constants/gameplay';
import { ECONOMY } from '../../shared/economy';
import type { FurnaceField } from '../../shared/furnaceField';
import { hullRadiusForKit } from '../../shared/shipKits';
import { terrainCruiseVelocity } from '../../shared/terrainTravel';
import { WORLD } from '../../shared/world';
import type { BotRole, Position, SavedPointLoot, Velocity } from '../../shared-types';
import { spatialQueryBounds } from '../world/spatialQueryBounds';
import type { AsteroidManager } from './AsteroidManager';
import type { EntityManager, GameEntity } from './EntityManager';
import type { LootManager } from './LootManager';

interface FleetInputs {
  readonly actors: Pick<EntityManager, 'getAllEntities' | 'addBot' | 'removeEntity'>;
  readonly loot: Pick<LootManager, 'queryCircle'>;
  readonly rocks: Pick<AsteroidManager, 'spatialIndex'>;
  readonly furnaces: Pick<FurnaceField, 'nearest'>;
  readonly removePlayer: (id: string) => void;
  readonly spawnPlayerLaser: (ownerId: string, start: Position, velocity: Velocity) => void;
}

interface Bot {
  actor: GameEntity;
  awaitingRespawn: boolean;
  nextShotFrame: number;
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nearest<T extends { position: Position }>(
  origin: Position,
  rows: readonly T[]
): T | undefined {
  let result: T | undefined;
  let best = Infinity;
  for (const row of rows) {
    const candidate = distance(origin, row.position);
    if (candidate < best) {
      result = row;
      best = candidate;
    }
  }
  return result;
}

function botSpawn(anchor: Position, role: BotRole): Position {
  const position = { x: anchor.x + (role === 'raider' ? 850 : 350), y: anchor.y - 180 };
  const radius = Math.hypot(position.x, position.y);
  const limit = WORLD.radius - 200;
  if (radius > limit) {
    position.x *= limit / radius;
    position.y *= limit / radius;
  }
  if (inBotSanctuary(position)) {
    position.x = AI_SHIPS.sanctuaryRadius + 250;
    position.y = role === 'raider' ? 200 : -200;
  }
  return position;
}

function workerLoiterPosition(actor: GameEntity, human: GameEntity): Position {
  const humanDistance = distance(actor.position, human.position);
  const angle =
    humanDistance > 0
      ? Math.atan2(actor.position.y - human.position.y, actor.position.x - human.position.x)
      : -actor.angle;
  const position = {
    x: human.position.x + Math.cos(angle) * AI_SHIPS.workerLoiterRadius,
    y: human.position.y + Math.sin(angle) * AI_SHIPS.workerLoiterRadius,
  };
  // Leave room for the hull and for stopping anywhere within the loiter tolerance.
  const limit = WORLD.radius - hullRadiusForKit(actor.kitId) - AI_SHIPS.workerLoiterTolerance;
  const radius = Math.hypot(position.x, position.y);
  if (radius > limit) {
    position.x *= limit / radius;
    position.y *= limit / radius;
  }
  return position;
}

/** Server-owned decisions; existing engine owners apply physical and economic effects. */
export class BotFleet {
  private readonly bots = new Map<BotRole, Bot>();
  private inhabitedFrames = 0;

  constructor(private readonly inputs: FleetInputs) {}

  /** Normal departures return cargo and report removals before the final checkpoint. */
  clear(): void {
    this.clearWith((id) => this.inputs.removePlayer(id));
  }

  /** World resets discard transient actors without creating cargo or departure events. */
  reset(): void {
    this.clearWith((id) => this.inputs.actors.removeEntity(id));
  }

  private clearWith(remove: (id: string) => void): void {
    const ids = [...this.bots.values()].map((bot) => bot.actor.id);
    this.bots.clear();
    this.inhabitedFrames = 0;
    for (const id of ids) {
      remove(id);
    }
  }

  forget(id: string): void {
    for (const [role, bot] of this.bots) {
      if (bot.actor.id === id) {
        this.bots.delete(role);
      }
    }
  }

  /** A crash recovers transient holds as ordinary loose points, in the same economy batch. */
  savedCargo(now: number): SavedPointLoot[] {
    return [...this.bots.values()]
      .filter(({ actor }) => actor.cargo > 0)
      .map(({ actor }) => ({
        id: `bot-cargo-${actor.id}`,
        position: { ...actor.position },
        points: actor.cargo,
        expiresAt: now + ECONOMY.pointLootMs,
      }));
  }

  advance(frame: number): void {
    const humans = this.inputs.actors
      .getAllEntities()
      .filter(
        (actor) =>
          actor.botRole === undefined && actor.ws !== undefined && actor.playerMotion !== undefined
      );
    if (!humans.length) {
      this.clear();
      return;
    }
    this.inhabitedFrames++;
    if (this.inhabitedFrames < AI_SHIPS.spawnDelayFrames) {
      return;
    }
    const anchor = humans[0];
    if (!anchor) {
      return;
    }
    for (const role of ['worker', 'raider'] as const) {
      let bot = this.bots.get(role);
      if (!bot) {
        bot = {
          actor: this.inputs.actors.addBot(
            `ai-${randomUUID()}`,
            role,
            botSpawn(anchor.position, role)
          ),
          awaitingRespawn: false,
          nextShotFrame: frame + AI_SHIPS.shotIntervalFrames,
        };
        this.bots.set(role, bot);
      }
      const actor = bot.actor;
      const human = nearest(actor.position, humans);
      if (!human) {
        continue;
      }
      // Distant bots disappear, spilling their cargo through the owning engine.
      // A fresh bounded replacement arrives on the next inhabited frame.
      if (distance(actor.position, human.position) > AI_SHIPS.tetherRadius) {
        this.bots.delete(role);
        this.inputs.removePlayer(actor.id);
        continue;
      }
      if (actor.health <= 0 || actor.exploding || actor.respawnTimer !== undefined) {
        bot.awaitingRespawn = true;
        continue;
      }
      if (bot.awaitingRespawn) {
        actor.position = botSpawn(human.position, role);
        actor.velocity = { x: 0, y: 0 };
        bot.awaitingRespawn = false;
        bot.nextShotFrame = frame + AI_SHIPS.shotIntervalFrames;
      }
      const target =
        role === 'worker'
          ? this.workerTarget(actor, human)
          : nearest(
              actor.position,
              [...humans, ...[...this.bots.values()].map((entry) => entry.actor)].filter(
                (candidate) =>
                  candidate.botRole !== 'raider' &&
                  !isCombatantImmune(candidate) &&
                  !candidate.furnaceTransit &&
                  !inBotSanctuary(candidate.position) &&
                  distance(actor.position, candidate.position) <= AI_SHIPS.engagementRadius
              )
            );
      const destination =
        target?.position ??
        (role === 'worker'
          ? workerLoiterPosition(actor, human)
          : inBotSanctuary(human.position)
            ? botSpawn(human.position, role)
            : human.position);
      const remaining = distance(actor.position, destination);
      const wanted = Math.atan2(
        -(destination.y - actor.position.y),
        destination.x - actor.position.x
      );
      let turn = Math.atan2(Math.sin(wanted - actor.angle), Math.cos(wanted - actor.angle));
      // Avoid local rocks, never enumerate the saved asteroid world.
      const obstacle = this.inputs.rocks
        .spatialIndex()
        .query(spatialQueryBounds(actor.position, AI_SHIPS.avoidRadius))
        .find((rock) => {
          const dx = rock.position.x - actor.position.x;
          const dy = rock.position.y - actor.position.y;
          const ahead = dx * Math.cos(actor.angle) - dy * Math.sin(actor.angle);
          return (
            ahead > 0 &&
            ahead < rock.size + AI_SHIPS.avoidRadius / 2 &&
            Math.abs(dx * Math.sin(actor.angle) + dy * Math.cos(actor.angle)) <
              rock.size + hullRadiusForKit(actor.kitId)
          );
        });
      if (obstacle) {
        turn = Math.PI / 2;
      }
      const maxTurn = (SHIP.TURN_SPEED * Math.PI) / 180 / GAME.FPS;
      actor.angle += Math.max(-maxTurn, Math.min(maxTurn, turn));
      const stoppingDistance =
        role === 'worker' && !target
          ? AI_SHIPS.workerLoiterTolerance
          : role === 'raider' && target
            ? 260
            : 20;
      actor.thrusting = remaining > stoppingDistance;
      if (actor.thrusting) {
        const targetVelocity = terrainCruiseVelocity(
          actor.position,
          actor.angle,
          SHIP.MAX_VELOCITY
        );
        const speed = Math.hypot(targetVelocity.x, targetVelocity.y);
        const acceleration = SHIP.THRUST / GAME.FPS;
        const propelled = Math.min(
          speed,
          Math.hypot(actor.velocity.x, actor.velocity.y) + acceleration
        );
        actor.velocity = {
          x: (targetVelocity.x * propelled) / speed,
          y: (targetVelocity.y * propelled) / speed,
        };
        actor.position.x += actor.velocity.x;
        actor.position.y += actor.velocity.y;
      } else {
        actor.velocity = { x: 0, y: 0 };
      }
      if (
        role === 'raider' &&
        target &&
        !obstacle &&
        !inBotSanctuary(actor.position) &&
        !isCombatantImmune(actor) &&
        Math.abs(turn) < 0.12 &&
        frame >= bot.nextShotFrame
      ) {
        this.fire(actor);
        bot.nextShotFrame = frame + AI_SHIPS.shotIntervalFrames;
      }
    }
  }

  private fire(actor: GameEntity): void {
    const dx = Math.cos(actor.angle);
    const dy = -Math.sin(actor.angle);
    const reach = (4 / 3) * hullRadiusForKit(actor.kitId);
    this.inputs.spawnPlayerLaser(
      actor.id,
      { x: actor.position.x + dx * reach, y: actor.position.y + dy * reach },
      {
        x: actor.velocity.x + (dx * LASER.SPEED) / GAME.FPS,
        y: actor.velocity.y + (dy * LASER.SPEED) / GAME.FPS,
      }
    );
  }

  private workerTarget(actor: GameEntity, human: GameEntity): { position: Position } | undefined {
    if (actor.cargo > 0) {
      const furnace = this.inputs.furnaces.nearest(actor.position);
      return distance(furnace.position, human.position) < AI_SHIPS.tetherRadius
        ? furnace
        : undefined;
    }
    return nearest(
      actor.position,
      this.inputs.loot
        .queryCircle(actor.position, AI_SHIPS.workRadius)
        .filter((loot) => loot.kind === 'points')
    );
  }
}
