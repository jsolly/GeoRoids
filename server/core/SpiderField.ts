import { clearHaulerLatch } from '../../shared/shipAbilities';
import { hullRadiusForKit } from '../../shared/shipKits';
import { isTowCableUtility, scoutUtilityOf } from '../../shared/shipUtilities';
import { SPIDER } from '../../shared/terrainSpider';
import { spatialQueryBounds } from '../world/spatialQueryBounds';
import { spiderResources } from './spiderResources';
import type { SpiderAttack } from './TerrainSpiderManager';
import type { SpiderFieldInputs } from './types';

/** Shared terrain and belt-spider frame, with bites retained until late combat. */
export class SpiderField {
  private pendingAttacks: SpiderAttack[] = [];

  public constructor(private readonly inputs: SpiderFieldInputs) {}

  public advance(frame: number): void {
    this.inputs.population.refresh();
    const spiderTows = this.inputs.actors
      .getAllEntities()
      .flatMap((entity) =>
        entity.harpoonTargetId &&
        isTowCableUtility(entity) &&
        !entity.exploding &&
        entity.health > 0
          ? [{ ownerId: entity.id, spiderId: entity.harpoonTargetId }]
          : []
      );
    const towedIds = new Set(spiderTows.map((tow) => tow.spiderId));
    const previousIds = new Set(this.inputs.terrain.getBodies().map((spider) => spider.id));
    const attacks = this.inputs.terrain.advance({
      towedIds,
      spiderTows,
      lightSources: this.inputs.glowtoys.lightSources(),
      releaseTow: (ownerId, spiderId) => {
        const owner = this.inputs.actors.getEntity(ownerId);
        if (owner?.harpoonTargetId === spiderId && isTowCableUtility(owner)) {
          clearHaulerLatch(owner);
        }
      },
      players: this.inputs.actors
        .getAllEntities()
        .filter((entity) => Boolean(entity.ws) || entity.botRole !== undefined)
        .map((entity) => ({
          id: entity.id,
          position: entity.position,
          health: entity.health,
          exploding: entity.exploding,
          ...(entity.respawnTimer !== undefined ? { respawnTimer: entity.respawnTimer } : {}),
          ...(entity.spawnProtectionTimer !== undefined
            ? { spawnProtectionTimer: entity.spawnProtectionTimer }
            : {}),
          radius: hullRadiusForKit(entity.kitId),
          cargo: entity.cargo,
          scanning:
            entity.kitId === 'scout' &&
            scoutUtilityOf(entity) === 'mineral_scan' &&
            entity.abilityActiveFrames > 0,
        })),
      nowFrame: frame,
      onNestCreated: (nest) => {
        this.inputs.loot.spawnNestCache(nest.position, frame);
        this.inputs.satellites.spawnNestPickup(nest.position);
      },
      resource: (id, home) => {
        // The former resource Map let later domains overwrite earlier matching IDs.
        const pickup = this.inputs.satellites.getPickup(id);
        if (pickup && !pickup.nestSalvage && pickup.state === 'loose' && pickup.health > 0) {
          return spiderResources([], [], [pickup])[0];
        }
        const drop = this.inputs.loot.getNestResource(id);
        if (drop) {
          return spiderResources([], [drop], [])[0];
        }
        const live = this.inputs.rocks.getAsteroid(id);
        const resource = live ? spiderResources([live], [], [])[0] : undefined;
        if (resource) {
          return resource;
        }
        const dormant = this.inputs.regional.dormantAsteroid(id, home);
        return dormant ? spiderResources([dormant], [], [])[0] : undefined;
      },
      resources: (players) => {
        const positions = players.map((player) => player.position);
        const rocks = this.inputs.rocks
          .spatialIndex()
          .queryMany(
            positions.map((position) => spatialQueryBounds(position, SPIDER.NEST_WAKE_DISTANCE))
          )
          .filter((rock) =>
            positions.some(
              (position) =>
                Math.hypot(position.x - rock.position.x, position.y - rock.position.y) <=
                SPIDER.NEST_WAKE_DISTANCE
            )
          );
        return spiderResources(
          rocks,
          this.inputs.loot.getNestResourcesNear(positions, SPIDER.NEST_WAKE_DISTANCE),
          this.inputs.satellites.getNestResources()
        );
      },
    });
    this.inputs.population.refresh();
    this.pendingAttacks.push(
      ...attacks,
      ...this.inputs.crawlers.advance({
        index: this.inputs.rocks.spatialIndex(),
        hosts: this.inputs.rocks.crawlerHostAsteroids(),
        players: this.inputs.actors
          .getAllEntities()
          .filter((entity) => Boolean(entity.ws) || entity.botRole !== undefined)
          .map((entity) => ({
            id: entity.id,
            position: entity.position,
            health: entity.health,
            exploding: entity.exploding,
            ...(entity.respawnTimer !== undefined ? { respawnTimer: entity.respawnTimer } : {}),
            radius: hullRadiusForKit(entity.kitId),
          })),
        nowFrame: frame,
      })
    );
    this.inputs.population.refresh();
    for (const entity of this.inputs.actors.getAllEntities()) {
      if (
        entity.harpoonTargetId != null &&
        entity.harpoonTargetId !== '' &&
        previousIds.has(entity.harpoonTargetId) &&
        !this.inputs.terrain.getBody(entity.harpoonTargetId)
      ) {
        clearHaulerLatch(entity);
      }
    }
  }

  public drainAttacks(): SpiderAttack[] {
    return this.pendingAttacks.splice(0);
  }

  public isAttackActive(attack: SpiderAttack): boolean {
    return (
      this.inputs.terrain.isAttackActive(attack) ||
      this.inputs.crawlers.isAttackActive(attack, this.inputs.rocks.spatialIndex())
    );
  }

  public clearPendingAttacks(): void {
    this.pendingAttacks = [];
  }
}
