import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { beltAsteroid } from '../../../shared/asteroidBelt';
import { BELT_CRAWLER, isNativeCrawlerSlot } from '../../../shared/beltCrawler';
import { GAME } from '../../../shared/constants/gameplay';
import { TOWN_HEARTH } from '../../../shared/furnaces';
import type { AsteroidData } from '../../../shared-types';
import { instrumentBeltTraversals } from '../../support/beltTraversalInstrumentation';
import { RecordingSocket } from '../../support/recordingSocket';
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
 * The once-a-second frame, on the cadence AGENTS.md sanctions for work leaving
 * the loop. Two blocks land on it together: `ensureAsteroidField` copies the
 * belt three times in `RegionalAsteroidField.update`, and `checkpointWorld`
 * copies it four more in `RegionalAsteroidField.checkpoint` — but only when a
 * `WorldPersistence` exists, which production always has. Both counts are
 * pinned, each against the world shape that reaches it.
 */
const SECTOR_PASS_BELT_COPIES = 3;
const PERSISTED_SECTOR_BELT_COPIES = 7;

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
  function frameCost(): {
    beltPasses: number;
    rowsVisited: number;
    beltCopies: number;
    trackedRows: number;
  } {
    const started = probe.snapshot().beltRows;
    probe.reset();
    world.engine.advanceOneFrame();
    const { beltPasses, rowsVisited, beltCopies, trackedRows } = probe.snapshot();
    expect(beltPasses).toBe(BELT_PASSES_PER_FRAME);
    expect(beltCopies).toBe(0);
    expect(rowsVisited).toBeLessThanOrEqual(started * BELT_PASSES_PER_FRAME);
    return { beltPasses, rowsVisited, beltCopies, trackedRows };
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
    expect(isNativeCrawlerSlot(occupied.id)).toBe(true);
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

    const [costly] = busy;
    if (!costly) {
      throw new Error('Expected one frame to cost more than a motion pass');
    }
    expect(busy).toHaveLength(1);
    expect(costly.frame).toBe(60);
    // A ceiling, not a pin: reducing this cost is the recorded next move, and
    // the exact pass count beside it is what catches a walk that moved route.
    expect(costly.beltCopies).toBeLessThanOrEqual(SECTOR_PASS_BELT_COPIES);
    expect(costly.beltPasses).toBe(BELT_PASSES_PER_FRAME + costly.beltCopies);
  });

  test('a persisting world pays for its checkpoint on that same one frame', () => {
    // The world shape production runs: `checkpointWorld` returns early without
    // a `WorldPersistence`, so a fixture without one never reaches these.
    const store = new WorldStore(':memory:');
    let elapsed = 0;
    const clock = new ServerClock({ wallNow: () => 10_000, monotonicNow: () => elapsed });
    const engine = new GameEngine(82, clock, new InlineWorldPersistence(store));
    const socket = new RecordingSocket();
    const miner = engine.addPlayer('miner', 'Miner', socket, { x: 0, y: 0 }, 'hauler');
    expect(engine.registerPilot(miner, socket).ok).toBe(true);
    for (const existing of engine.getAllAsteroids()) {
      engine.removeAsteroid(existing.id);
    }
    for (let i = 0; i < 40; i++) {
      engine.addAsteroid(cargo(`persisted-${i}`, { x: 300 + i * 120, y: 0 }));
    }
    const persisted = instrumentBeltTraversals(engine);
    const busy: { frame: number; beltPasses: number; beltCopies: number }[] = [];
    try {
      for (let frame = 0; frame < 60; frame++) {
        persisted.reset();
        elapsed += 1000 / GAME.FPS;
        engine.advanceOneFrame(clock.now());
        const { beltPasses, beltCopies } = persisted.snapshot();
        if (beltPasses > BELT_PASSES_PER_FRAME || beltCopies > 0) {
          busy.push({ frame: engine.getDiagnostics().gameTime, beltPasses, beltCopies });
        }
      }
    } finally {
      persisted.dispose();
      engine.stopGameLoop();
      store.close();
    }

    const [costly] = busy;
    if (!costly) {
      throw new Error('Expected one frame to pay for the checkpoint');
    }
    expect(busy).toHaveLength(1);
    expect(costly.frame).toBe(60);
    expect(costly.beltCopies).toBeLessThanOrEqual(PERSISTED_SECTOR_BELT_COPIES);
    expect(costly.beltPasses).toBe(BELT_PASSES_PER_FRAME + costly.beltCopies);
  });

  test('a boost set through the manager is delivered', () => {
    // `updateAsteroid` takes an arbitrary row patch, so it must keep its own
    // derived sets whatever today's callers happen to pass.
    fillBelt(60);
    const rock = cargo('patched-cargo', { ...TOWN_HEARTH.position });
    world.engine.addAsteroid(rock);
    world.engine.updateAsteroid(rock.id, {
      boost: { phase: 'burning', ownerId: hauler.id, angle: 0 },
    });

    world.engine.processFurnaceDeliveries();

    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
  });

  test('crawler rows set through the manager put their rock back on the frame', () => {
    fillBelt(60);
    const rock = cargo('patched-host', { x: 600, y: 0 });
    world.engine.addAsteroid(rock);
    expect(isNativeCrawlerSlot(rock.id)).toBe(false);
    world.engine.updateAsteroid(rock.id, {
      beltCrawlerIds: ['belt-crawler:patched-host:0'],
      beltCrawlerHealth: [BELT_CRAWLER.MAX_HEALTH],
    });

    frameCost();

    expect(
      world.engine.getSpiderField().spiders.some((body) => body.crawler?.hostId === rock.id)
    ).toBe(true);
  });

  test('crawler rows written straight onto a tracked row rejoin the frame', () => {
    // What `BeltCrawlerManager.transfer` does to a transfer destination: it
    // writes the rows onto a rock nothing announced. The motion pass is the
    // only thing that tracks it, and without that the rock is never named
    // again once a population dip drops its body.
    fillBelt(60);
    const rock = cargo('smuggled-host', { x: 900, y: 0 });
    world.engine.addAsteroid(rock);
    expect(isNativeCrawlerSlot(rock.id)).toBe(false);
    rock.beltCrawlerIds = ['belt-crawler:smuggled-host:0'];
    rock.beltCrawlerHealth = [BELT_CRAWLER.MAX_HEALTH];

    frameCost();

    expect(
      world.engine.getSpiderField().spiders.some((body) => body.crawler?.hostId === rock.id)
    ).toBe(true);
  });

  test('a combat frame reaches a crawler host without the motion pass', () => {
    // `advanceCombatFrame` drives death and respawn without moving the belt,
    // so it runs the crawler frame with no motion pass behind it. That makes
    // it the observable for a host the manager was told about directly.
    fillBelt(60);
    const rock = cargo('combat-host', { x: 1_200, y: 0 });
    world.engine.addAsteroid(rock);
    expect(isNativeCrawlerSlot(rock.id)).toBe(false);
    world.engine.updateAsteroid(rock.id, {
      beltCrawlerIds: ['belt-crawler:combat-host:0'],
      beltCrawlerHealth: [BELT_CRAWLER.MAX_HEALTH],
    });

    world.tick();

    expect(
      world.engine.getSpiderField().spiders.some((body) => body.crawler?.hostId === rock.id)
    ).toBe(true);
  });

  test('a delivered rock stops costing the frame anything', () => {
    // The sets are only cheaper than the belt while they shrink. Removal and
    // the read-time prune mask each other, so this pins the pair: drop both
    // and a delivered rock's id is reconsidered on every later frame.
    fillBelt(60);
    const rock = cargo('spent-cargo', { ...TOWN_HEARTH.position });
    rock.boost = { phase: 'burning', ownerId: hauler.id, angle: 0 };
    world.engine.addAsteroid(rock);

    frameCost();
    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
    const settled = frameCost();

    expect(settled.trackedRows).toBe(0);
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
    // The tracked sets hold the rare case, not the belt, so what the frame
    // reaches through them does not grow with the belt behind it.
    expect(large.trackedRows).toBe(small.trackedRows);
  });
});
