import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { beltAsteroid } from '../../../shared/asteroidBelt';
import { nativeCrawlerSlot } from '../../../shared/beltCrawler';
import { TOWN_HEARTH } from '../../../shared/furnaces';
import type { AsteroidData } from '../../../shared-types';
import { instrumentBeltTraversals } from '../../support/beltTraversalInstrumentation';
import { resolveToolFlights } from '../../support/tool-flight';
import {
  GameServerWorld,
  type Pilot,
  useQuietServerConsole,
} from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

/**
 * One frame owes the belt a single motion pass, for physics. Every other
 * concern is rare enough to reach its own rocks directly, so a second walk
 * means something started scanning the belt again.
 */
const BELT_PASSES_PER_FRAME = 1;

/**
 * Sector activation runs once a second in `RegionalAsteroidField.update`, on
 * the cadence AGENTS.md sanctions for leaving the loop. It copies the belt to
 * find powered rocks, to find probes, and to partition rocks by sector. A
 * fourth copy there is new work on that cadence, so this pins it too.
 */
const SECTOR_PASS_BELT_COPIES = 3;

function cargo(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 20,
    jaggedness: 0.4,
    rotation: 0,
    angularVelocity: 0,
    health: 75,
    maxHealth: 75,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'metal',
    ore: 'metal',
  };
}

describe('A frame walks the asteroid belt once, for physics', () => {
  let world: GameServerWorld;
  let hauler: Pilot;
  let probe: ReturnType<typeof instrumentBeltTraversals>;

  /** Distant sleepers: they only ever cost the frame its mandatory passes. */
  function fillBelt(count: number, from = 0): void {
    for (let i = from; i < from + count; i++) {
      world.engine.addAsteroid(cargo(`sleeper-${i}`, { x: 30_000 + i * 400, y: 30_000 }));
    }
  }

  /** Only the coupling matters here, and it is the one utility worn as kit. */
  function equipBoostCoupling(pilot: Pilot): void {
    world.entity(pilot).equipment = ['boost_coupling'];
    world.send(pilot, {
      type: 'setHaulerUtility',
      id: pilot.id,
      data: { utilityId: 'boost_coupling' },
    });
  }

  function activate(pilot: Pilot): void {
    world.send(pilot, { type: 'useAbility', id: pilot.id, data: {} });
    resolveToolFlights(world.engine);
  }

  /**
   * The frame's belt bill. Rows walked are bounded by the belt the frame
   * started with, times its mandatory passes: a third pass breaks the bound
   * however the belt changed mid-frame.
   */
  function frameCost(): { beltPasses: number; rowsVisited: number; beltCopies: number } {
    const started = probe.snapshot().beltRows;
    probe.reset();
    world.engine.advanceOneFrame();
    const { beltPasses, rowsVisited, beltCopies } = probe.snapshot();
    expect(beltPasses).toBe(BELT_PASSES_PER_FRAME);
    expect(beltCopies).toBe(0);
    expect(rowsVisited).toBeLessThanOrEqual(started * BELT_PASSES_PER_FRAME);
    return { beltPasses, rowsVisited, beltCopies };
  }

  beforeEach(() => {
    world = new GameServerWorld();
    hauler = world.join('Hauler', { x: 150, y: 0 }, { kitId: 'hauler' });
    world.clearAsteroids();
    probe = instrumentBeltTraversals(world.engine);
  });

  afterEach(() => {
    probe.dispose();
    world.dispose();
  });

  test('a burning rock is smelted while the frame walks the belt only for physics', () => {
    fillBelt(200);
    const rock = cargo('burning-cargo', { ...TOWN_HEARTH.position });
    rock.boost = { phase: 'burning', ownerId: hauler.id, angle: 0 };
    world.engine.addAsteroid(rock);

    const cost = frameCost();

    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
    expect(world.engine.getGameState().settlement.resources.metal).toBeGreaterThan(0);
    expect(cost.beltPasses).toBe(BELT_PASSES_PER_FRAME);
    expect(cost.beltCopies).toBe(0);
  });

  test('a rock admitted mid-burn is smelted by a delivery pass that runs on its own', () => {
    // Scenario tests drive intake without moving the belt, so a rock that
    // arrives already burning must be reachable before any motion pass.
    fillBelt(200);
    const rock = cargo('loaded-cargo', { ...TOWN_HEARTH.position });
    rock.boost = { phase: 'burning', ownerId: hauler.id, angle: 0 };
    world.engine.addAsteroid(rock);

    probe.reset();
    world.engine.processFurnaceDeliveries();

    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
    expect(probe.snapshot()).toMatchObject({ beltPasses: 0, rowsVisited: 0, beltCopies: 0 });
  });

  test('a rock armed through the ability message is pruned when its owner dies, belt untouched', () => {
    fillBelt(200);
    const rock = cargo('armed-cargo', { x: 150, y: 0 });
    world.engine.addAsteroid(rock);
    world.entity(hauler).angle = 0;
    equipBoostCoupling(hauler);
    activate(hauler);
    expect(rock.boost?.phase).toBe('armed');

    // The owner is the only coupling, so losing it disarms the rock.
    world.entity(hauler).health = 0;
    const cost = frameCost();

    expect(rock.boost).toBeNull();
    expect(cost.beltPasses).toBe(BELT_PASSES_PER_FRAME);
    expect(cost.beltCopies).toBe(0);
  });

  test('a boost written straight onto a tracked row still delivers, one frame later', () => {
    // The backstop for an unannounced write: the motion pass already reads
    // every boost, so a row armed behind the manager's back is picked up on
    // the next frame instead of being missed for good.
    fillBelt(200);
    const rock = cargo('smuggled-cargo', { ...TOWN_HEARTH.position });
    world.engine.addAsteroid(rock);
    rock.boost = { phase: 'burning', ownerId: hauler.id, angle: 0 };

    frameCost();

    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
    expect(world.engine.getGameState().settlement.resources.metal).toBeGreaterThan(0);
  });

  test('a belt crawler advances on its native slot without a belt walk', () => {
    fillBelt(200);
    // Slot 0 is a native crawler slot, so this rock is born carrying one.
    const occupied = beltAsteroid(7, 0, 1);
    expect(nativeCrawlerSlot(occupied.id)).toBe(true);
    world.engine.addAsteroid(occupied);
    world.move(hauler, { ...occupied.position });

    frameCost();

    const crawlers = world.engine
      .getSpiderField()
      .spiders.filter((spider) => spider.crawler?.hostId === occupied.id);
    expect(crawlers).toHaveLength(1);
    expect(occupied.beltCrawlerIds).toEqual([`belt-crawler:${occupied.id}:0`]);
  });

  test('only the once-a-second sector pass costs more than a motion pass', () => {
    fillBelt(60);
    const busy: { frame: number; beltPasses: number; beltCopies: number }[] = [];
    for (let frame = 0; frame < 60; frame++) {
      probe.reset();
      world.engine.advanceOneFrame();
      const { beltPasses, beltCopies } = probe.snapshot();
      if (beltPasses > BELT_PASSES_PER_FRAME || beltCopies > 0) {
        busy.push({ frame: world.gameTime(), beltPasses, beltCopies });
      }
    }

    expect(busy).toHaveLength(1);
    expect(busy[0]?.frame).toBe(60);
    expect(busy[0]?.beltCopies).toBeLessThanOrEqual(SECTOR_PASS_BELT_COPIES);
    expect(busy[0]?.beltPasses).toBeLessThanOrEqual(
      BELT_PASSES_PER_FRAME + SECTOR_PASS_BELT_COPIES
    );
  });

  test('a belt four times larger costs the frame no extra pass', () => {
    fillBelt(100);
    const armed = cargo('armed-cargo', { x: 150, y: 0 });
    world.engine.addAsteroid(armed);
    world.entity(hauler).angle = 0;
    equipBoostCoupling(hauler);
    activate(hauler);
    expect(armed.boost?.phase).toBe('armed');

    const small = frameCost();
    fillBelt(300, 100);
    const large = frameCost();

    // Four times the rows cost four times the mandatory walking, no more: the
    // armed rock is still reached directly, and the pass count never moves.
    expect(small.beltPasses).toBe(large.beltPasses);
    expect(large.rowsVisited).toBeGreaterThan(small.rowsVisited * 3);
    expect(armed.boost?.phase).toBe('armed');
  });
});
