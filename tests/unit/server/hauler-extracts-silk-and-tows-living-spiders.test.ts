import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { HaulerUtilityId } from '../../../shared-types';
import { resolveToolFlights } from '../../support/tool-flight';
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
    resolveToolFlights(world.engine);
  }

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
