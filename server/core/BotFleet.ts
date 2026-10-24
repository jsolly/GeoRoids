import { randomUUID } from 'node:crypto';
import { AI_SHIPS, inBotSanctuary } from '../../shared/aiShips';
import { isCombatantImmune } from '../../shared/combat';
import { GAME, SHIP } from '../../shared/constants/gameplay';
import { ECONOMY } from '../../shared/economy';
import { hullRadiusForKit } from '../../shared/shipKits';
import { terrainCruiseVelocity } from '../../shared/terrainTravel';
import { WORLD } from '../../shared/world';
import type { AsteroidData, BotRole, LootData, Position, SavedPointLoot } from '../../shared-types';
import type { GameEntity } from './EntityManager';

interface FleetHost {
  humans: readonly GameEntity[];
  frame: number;
  spawn: (id: string, role: BotRole, position: Position) => GameEntity;
  remove: (id: string) => void;
  lootNear: (position: Position) => LootData[];
  rocksNear: (position: Position) => readonly AsteroidData[];
  furnaceNear: (position: Position) => { position: Position };
  fire: (actor: GameEntity) => void;
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

/** Server-owned decisions; existing engine owners apply physical and economic effects. */
export class BotFleet {
  private readonly bots = new Map<BotRole, Bot>();
  private inhabitedFrames = 0;

  clear(remove: (id: string) => void): void {
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

  advance(host: FleetHost): void {
    if (!host.humans.length) {
      this.clear(host.remove);
      return;
    }
    this.inhabitedFrames++;
    if (this.inhabitedFrames < AI_SHIPS.spawnDelayFrames) {
      return;
    }
    const anchor = host.humans[0];
    if (!anchor) {
      return;
    }
    for (const role of ['worker', 'raider'] as const) {
      let bot = this.bots.get(role);
      if (!bot) {
        bot = {
          actor: host.spawn(`ai-${randomUUID()}`, role, botSpawn(anchor.position, role)),
          awaitingRespawn: false,
          nextShotFrame: host.frame + AI_SHIPS.shotIntervalFrames,
        };
        this.bots.set(role, bot);
      }
      const actor = bot.actor;
      const human = nearest(actor.position, host.humans);
      if (!human) {
        continue;
      }
      // Distant bots disappear, spilling their cargo through the owning engine.
      // A fresh bounded replacement arrives on the next inhabited frame.
      if (distance(actor.position, human.position) > AI_SHIPS.tetherRadius) {
        this.bots.delete(role);
        host.remove(actor.id);
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
        bot.nextShotFrame = host.frame + AI_SHIPS.shotIntervalFrames;
      }
      const target =
        role === 'worker'
          ? this.workerTarget(actor, human, host)
          : nearest(
              actor.position,
              [...host.humans, ...[...this.bots.values()].map((entry) => entry.actor)].filter(
                (candidate) =>
                  candidate.botRole !== 'raider' &&
                  !isCombatantImmune(candidate) &&
                  !candidate.furnaceTransit &&
                  !inBotSanctuary(candidate.position) &&
                  distance(actor.position, candidate.position) <= AI_SHIPS.engagementRadius
              )
            );
      const humanDistance = distance(actor.position, human.position);
      const loiterAngle =
        humanDistance > 0
          ? Math.atan2(actor.position.y - human.position.y, actor.position.x - human.position.x)
          : -actor.angle;
      const destination =
        target?.position ??
        (role === 'worker'
          ? {
              x: human.position.x + Math.cos(loiterAngle) * AI_SHIPS.workerLoiterRadius,
              y: human.position.y + Math.sin(loiterAngle) * AI_SHIPS.workerLoiterRadius,
            }
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
      const obstacle = host.rocksNear(actor.position).find((rock) => {
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
        host.frame >= bot.nextShotFrame
      ) {
        host.fire(actor);
        bot.nextShotFrame = host.frame + AI_SHIPS.shotIntervalFrames;
      }
    }
  }

  private workerTarget(
    actor: GameEntity,
    human: GameEntity,
    host: FleetHost
  ): { position: Position } | undefined {
    if (actor.cargo > 0) {
      const furnace = host.furnaceNear(actor.position);
      return distance(furnace.position, human.position) < AI_SHIPS.tetherRadius
        ? furnace
        : undefined;
    }
    return nearest(
      actor.position,
      host.lootNear(actor.position).filter((loot) => loot.kind === 'points')
    );
  }
}
