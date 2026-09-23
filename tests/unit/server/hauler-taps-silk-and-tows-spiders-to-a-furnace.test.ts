import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { civicLot, TOWN_HEARTH } from '../../../shared/furnaces';
import { SPIDER } from '../../../shared/terrainSpider';
import type { HaulerUtilityId } from '../../../shared-types';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import {
  GameServerWorld,
  type Pilot,
  useQuietServerConsole,
} from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

describe('Hauler tools interact with living spiders', () => {
  let world: GameServerWorld;
  let pilot: Pilot;
  beforeEach(() => {
    world = new GameServerWorld();
    world.clearAsteroids();
    world.engine.clearSpiderField();
    pilot = world.join('Silk collector', { x: 4400, y: 0 }, { kitId: 'hauler' });
    world.clearAsteroids();
  });
  afterEach(() => world.dispose());

  function equip(utilityId: HaulerUtilityId) {
    if (utilityId !== 'tow_cable') {
      world.entity(pilot).equipment = [utilityId];
    }
    world.send(pilot, { type: 'setHaulerUtility', id: pilot.id, data: { utilityId } });
    world.entity(pilot).abilityCooldownFrames = 0;
  }
  function activate() {
    world.send(pilot, {
      type: 'useAbility',
      id: pilot.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });
  }

  test('tap provokes a spider, extracts finite silk without ore, and preserves collected silk on reconnect', () => {
    const spider = world.engine.spawnTerrainSpider({ x: 4500, y: 0 });
    if (!spider) {
      throw new Error('Spider arrangement failed');
    }
    equip('resource_tap');
    activate();
    expect(world.entity(pilot).harpoonTargetId).toBe(spider.id);
    expect(world.engine.getSpiderField().spiders[0]).toMatchObject({
      phase: 'hunting',
      targetId: pilot.id,
      shudderFrames: SPIDER.SHUDDER_FRAMES,
    });
    for (let frame = 0; frame < SHIP_ABILITY.TAP_EXTRACT_FRAMES; frame++) {
      world.engine.tickAbilities();
    }
    const drops = world.engine.getLoot();
    expect(drops).toHaveLength(SPIDER.SILK_BURSTS);
    expect(drops.every((drop) => drop.kind === 'silk' && drop.mass === 0)).toBe(true);
    expect(world.engine.getSpiderField().spiders[0]?.health).toBe(spider.health);
    expect(world.entity(pilot).harpoonTargetId).toBeNull();
    equip('resource_tap');
    activate();
    expect(world.entity(pilot).harpoonTargetId).toBe(spider.id);
    for (let frame = 0; frame < SHIP_ABILITY.TAP_EXTRACT_FRAMES; frame++) {
      world.engine.tickAbilities();
    }
    expect(world.engine.getLoot()).toHaveLength(SPIDER.SILK_BURSTS);
    const before = { mass: world.entity(pilot).mass, score: world.entity(pilot).score };
    // Let the ejected bundles settle, then fly over one collectible.
    world.engine.clearSpiderField();
    world.engine.updatePlayer(pilot.id, { position: { x: 5200, y: 0 } });
    for (let frame = 0; frame < 30; frame++) {
      world.engine.advanceOneFrame();
    }
    const silk = world.engine.getLoot().find((drop) => drop.id === drops[0]?.id);
    if (!silk) {
      throw new Error('Silk disappeared before pickup');
    }
    world.engine.updatePlayer(pilot.id, { position: { ...silk.position } });
    expect(world.engine.collectLoot().some((event) => event.lootId === silk.id)).toBe(true);
    const count = world.entity(pilot).silk;
    expect(count).toBeGreaterThan(0);
    expect(world.entity(pilot).mass).toBe(before.mass);
    expect(world.entity(pilot).score).toBe(before.score);
    world.dropTransport(pilot);
    pilot = world.resume(pilot);
    expect(world.entity(pilot).silk).toBe(count);
  });

  test.each(['landmark', 'built'])(
    'tow pulls a spider into a %s furnace, consumes it once, and releases its cable',
    (kind) => {
      const street = civicLot('street-1-0');
      if (!street) {
        throw new Error('Missing street lot');
      }
      if (kind === 'built') {
        const scout = world.join('Builder', street.position, { kitId: 'scout' });
        world.entity(scout).position = { ...street.position };
        world.entity(scout).score = street.cost;
        world.entity(scout).abilityCooldownFrames = 0;
        expect(world.engine.useAbility(scout.id)).toBe(true);
      }
      const furnace = kind === 'built' ? street : TOWN_HEARTH;
      world.engine.updatePlayer(pilot.id, {
        position: { x: furnace.position.x + 400, y: furnace.position.y },
      });
      world.clearAsteroids();
      const spider = world.engine.spawnTerrainSpider({
        x: furnace.position.x + 500,
        y: furnace.position.y,
      });
      if (!spider) {
        throw new Error('Spider arrangement failed');
      }
      equip('tow_cable');
      activate();
      expect(world.entity(pilot).harpoonTargetId).toBe(spider.id);
      let crossedProtection = false;
      for (let frame = 0; frame < 400; frame++) {
        world.engine.updatePlayer(pilot.id, {
          position: { x: furnace.position.x + 400 - frame * 2, y: furnace.position.y },
          velocity: { x: -2, y: 0 },
        });
        world.engine.advanceOneFrame();
        const live = world.engine.getSpiderField().spiders.find((body) => body.id === spider.id);
        if (!live) {
          break;
        }
        if (live.position.x < furnace.position.x + SPIDER.FURNACE_SAFE_RADIUS) {
          crossedProtection = true;
        }
      }
      expect(crossedProtection).toBe(true);
      expect(world.engine.getSpiderField().spiders.some((body) => body.id === spider.id)).toBe(
        false
      );
      expect(world.engine.getSpiderField().consumed).toEqual([
        expect.objectContaining({ id: spider.id, furnaceId: furnace.id }),
      ]);
      expect(world.entity(pilot).harpoonTargetId).toBeNull();
      for (let frame = 0; frame < 10; frame++) {
        world.engine.advanceOneFrame();
      }
      expect(world.engine.getSpiderField().consumed).toHaveLength(1);
    }
  );

  test('Boost Coupling ignores spiders, and switching tools releases a spider tow', () => {
    const spider = world.engine.spawnTerrainSpider({ x: 4500, y: 0 });
    if (!spider) {
      throw new Error('Spider arrangement failed');
    }
    equip('boost_coupling');
    activate();
    expect(world.entity(pilot).harpoonTargetId).toBeNull();
    equip('tow_cable');
    activate();
    expect(world.entity(pilot).harpoonTargetId).toBe(spider.id);
    equip('boost_coupling');
    expect(world.entity(pilot).harpoonTargetId).toBeNull();
  });
});
