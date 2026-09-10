import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { isAsteroidMaterial } from '../../../../shared/asteroidMaterials';
import { segmentCircleContact } from '../../../../shared/asteroidPhenomena';
import type { AsteroidData, AsteroidDestroyEvent } from '../../../../shared-types';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

declare global {
  interface Window {
    __collabFieldSamples?: string[][];
  }
}

type SplitEvidence =
  | { type: 'asteroidDestroy'; data: AsteroidDestroyEvent }
  | {
      type: 'asteroidCreateBatch';
      data: { asteroids: Pick<AsteroidData, 'id' | 'material' | 'size' | 'position'>[] };
    }
  | { type: 'gameState' | 'snapshot' }
  | { type: 'error'; data: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Validate only the event fields this scenario observes; snapshots are decoded by the clients.
function readSplitEvidence(value: unknown): SplitEvidence | undefined {
  assert.ok(isRecord(value), 'Expected a WebSocket message envelope');
  const type = value['type'];
  if (type === 'gameState' || type === 'snapshot') {
    return { type };
  }
  if (type === 'error') {
    return { type, data: value['data'] };
  }
  if (type !== 'asteroidDestroy' && type !== 'asteroidCreateBatch') {
    return undefined;
  }
  const data = value['data'];
  assert.ok(isRecord(data), 'Asteroid event payload missing');
  if (type === 'asteroidDestroy') {
    const asteroidId = data['asteroidId'];
    const origin = data['origin'];
    const collabSplit = data['collabSplit'];
    assert.ok(typeof asteroidId === 'string');
    assert.ok(collabSplit === undefined || typeof collabSplit === 'boolean');
    if (origin === undefined) {
      return { type, data: { asteroidId, ...(collabSplit === undefined ? {} : { collabSplit }) } };
    }
    assert.ok(
      isRecord(origin) && typeof origin['x'] === 'number' && typeof origin['y'] === 'number'
    );
    return {
      type,
      data: {
        asteroidId,
        origin: { x: origin['x'], y: origin['y'] },
        ...(collabSplit === undefined ? {} : { collabSplit }),
      },
    };
  }
  const asteroids: unknown = data['asteroids'];
  assert.ok(Array.isArray(asteroids), 'Asteroid batch missing');
  return {
    type,
    data: {
      asteroids: asteroids.map((asteroid: unknown) => {
        assert.ok(isRecord(asteroid), 'Asteroid row missing');
        const id = asteroid['id'];
        const size = asteroid['size'];
        const material = asteroid['material'];
        const position = asteroid['position'];
        assert.ok(typeof id === 'string' && typeof size === 'number');
        assert.ok(isAsteroidMaterial(material));
        assert.ok(
          isRecord(position) &&
            typeof position['x'] === 'number' &&
            typeof position['y'] === 'number'
        );
        return { id, size, material, position: { x: position['x'], y: position['y'] } };
      }),
    },
  };
}

// Scenario: two players shoot an ordinary large ice asteroid within
// 1s → the server removes it and broadcasts the same fragments to both pilots.
test(
  'two players hit a large ice roid within 1s and both see its split',
  async () => {
    const page1 = browserManager.getCurrentPage();
    if (!page1) {
      throw new Error('First page unavailable');
    }
    const page2 = await browserManager.createAdditionalPage();
    const game1 = new GameInteractions(page1);
    const game2 = new GameInteractions(page2);
    const received1: SplitEvidence[] = [];
    const received2: SplitEvidence[] = [];
    const sent: unknown[] = [];
    for (const [page, messages] of [
      [page1, received1],
      [page2, received2],
    ] as const) {
      page.on('websocket', (socket) => {
        socket.on('framereceived', ({ payload }) => {
          const evidence = readSplitEvidence(JSON.parse(String(payload)));
          if (evidence) {
            messages.push(evidence);
          }
        });
        socket.on('framesent', ({ payload }) => {
          const message: unknown = JSON.parse(String(payload));
          if (
            isRecord(message) &&
            ['shoot', 'asteroidDestroyed', 'lootExplode'].includes(String(message['type']))
          ) {
            sent.push(message);
          }
        });
      });
    }
    await game1.bootGame({ waitForCombatReady: false });
    await game1.placeShipAt(-1700, 0);
    await game2.bootGame({ waitForCombatReady: false });
    await game2.placeShipAt(1700, 0);
    await Promise.all([game1.waitForCombatReady(), game2.waitForCombatReady()]);

    await game1.waitForAsteroids(1, 30000);
    const initialFields = await Promise.all([
      game1.getAsteroidPositions(),
      game2.getAsteroidPositions(),
    ]);
    const loot = await game1.getLoot();
    // An arbitrary first rock may overlap another rock or a loot drop, which
    // legitimately intercepts one pilot's shot. Use the most isolated live
    // target so both pilots exercise the intended cooperative collision.
    const obstacles = [...initialFields[0], ...loot];
    const clearance = (target: (typeof initialFields)[0][number]) =>
      Math.min(
        ...obstacles
          .filter((other) => other.id !== target.id)
          .map(
            (other) =>
              Math.hypot(other.x - target.x, other.y - target.y) - other.radius - target.radius
          )
      );
    const collaborative = initialFields[0]
      .filter(
        (asteroid) =>
          !asteroid.isCollabTarget && asteroid.material === 'ice' && asteroid.radius >= 40
      )
      .sort((left, right) => clearance(right) - clearance(left))[0];
    expect(
      collaborative,
      'expected an ordinary large ice asteroid; the marked kits target uses shared HP instead'
    ).toBeDefined();
    if (!collaborative) {
      throw new Error('Large ice asteroid missing');
    }

    const [shipRadius1, shipRadius2] = await Promise.all([
      game1.getShipRadius(),
      game2.getShipRadius(),
    ]);
    const [liveField, liveLoot] = await Promise.all([
      game1.getAsteroidPositions(),
      game1.getLoot(),
    ]);
    const liveTarget = liveField.find((asteroid) => asteroid.id === collaborative.id);
    expect(
      liveTarget,
      'the selected target should remain alive while preparing both pilots'
    ).toBeDefined();
    if (!liveTarget) {
      throw new Error('Target disappeared while preparing both pilots');
    }
    const liveObstacles = [...liveField, ...liveLoot];
    // Opposing firing lanes make a missed projectile continue directly into
    // the other pilot. Put both hulls on the same side in close, separate
    // lanes so each real shot reaches the moving rock within a few frames and
    // neither pilot can intercept the other's projectile.
    const radialGap = liveTarget.radius + Math.max(shipRadius1, shipRadius2) + 20;
    const tangentOffset = (shipRadius1 + shipRadius2 + 20) / 2;
    const firingFixture = Array.from({ length: 16 }, (_, index) => (index * Math.PI) / 8)
      .map((angle) => {
        const normal = { x: Math.cos(angle), y: Math.sin(angle) };
        const tangent = { x: -normal.y, y: normal.x };
        return {
          positions: [
            {
              x: liveTarget.x - normal.x * radialGap + tangent.x * tangentOffset,
              y: liveTarget.y - normal.y * radialGap + tangent.y * tangentOffset,
              radius: shipRadius1,
            },
            {
              x: liveTarget.x - normal.x * radialGap - tangent.x * tangentOffset,
              y: liveTarget.y - normal.y * radialGap - tangent.y * tangentOffset,
              radius: shipRadius2,
            },
          ],
        };
      })
      .find(({ positions }) =>
        positions.every(({ x, y, radius }) => {
          return liveObstacles.every((other) => {
            if (other.id === collaborative.id) {
              return true;
            }
            if (Math.hypot(other.x - x, other.y - y) <= other.radius + radius + 12) {
              return false;
            }
            return (
              segmentCircleContact(
                { x, y },
                { x: liveTarget.x, y: liveTarget.y },
                { x: other.x, y: other.y },
                other.radius + 8
              ) === undefined
            );
          });
        })
      );
    expect(
      firingFixture,
      'both hulls and laser paths need clear same-side firing lanes'
    ).toBeDefined();
    if (!firingFixture) {
      throw new Error('No clear same-side firing lanes');
    }
    const [position1, position2] = firingFixture.positions;
    if (!position1 || !position2) {
      throw new Error('Same-side firing fixture did not contain both pilots');
    }

    // Park both hulls outside the target and acknowledge each pose before the
    // concurrent shots.
    await Promise.all([
      game1.placeShipAt(position1.x, position1.y),
      game2.placeShipAt(position2.x, position2.y),
    ]);

    const [current1, current2] = await Promise.all([
      game1
        .getAsteroidPositions()
        .then((field) => field.find((asteroid) => asteroid.id === collaborative.id)),
      game2
        .getAsteroidPositions()
        .then((field) => field.find((asteroid) => asteroid.id === collaborative.id)),
    ]);
    expect(
      current1,
      'pilot one should retain the collaborative target before firing'
    ).toBeDefined();
    expect(
      current2,
      'pilot two should retain the collaborative target before firing'
    ).toBeDefined();
    if (!current1 || !current2) {
      throw new Error('Target disappeared before both shots');
    }

    // Observe the decoded field every rendered frame before firing. Fragments
    // remain normal combat objects and can legitimately disappear again before
    // a later test-process poll reaches either pilot.
    await Promise.all(
      [page1, page2].map((page) =>
        page.evaluate(() => {
          const samples: string[][] = [];
          window.__collabFieldSamples = samples;
          const gc = window.gameController;
          if (!gc) {
            throw new Error('Field observer requires the game controller');
          }
          const observe = () => {
            samples.push(
              gc
                .getCurrRoidBelt()
                .getRoids()
                .map((roid) => roid.id)
            );
            if (samples.length > 600) {
              samples.shift();
            }
            requestAnimationFrame(observe);
          };
          requestAnimationFrame(observe);
        })
      )
    );

    await Promise.all([
      game1.fireLaserToward(current1.x, current1.y),
      game2.fireLaserToward(current2.x, current2.y),
    ]);

    const splitFor = (messages: SplitEvidence[]) =>
      messages.find(
        (message) =>
          message.type === 'asteroidDestroy' &&
          message.data?.asteroidId === collaborative.id &&
          message.data.collabSplit === true
      );
    try {
      await expect
        .poll(() => Boolean(splitFor(received1) && splitFor(received2)), {
          timeout: 5000,
          message: 'both pilots should receive the cooperative split event for this rock',
        })
        .toBe(true);
    } catch (error) {
      console.error('Cooperative split evidence', {
        target: collaborative,
        sent,
        received: received1.filter(
          (message) =>
            message.type === 'error' ||
            (message.type === 'asteroidDestroy' && message.data.asteroidId === collaborative.id)
        ),
      });
      throw error;
    }

    const fragmentIds = (messages: SplitEvidence[]): string[] => {
      const destroyIndex = messages.findIndex(
        (message) =>
          message.type === 'asteroidDestroy' && message.data?.asteroidId === collaborative.id
      );
      if (destroyIndex < 0) {
        return [];
      }
      const destruction = messages[destroyIndex];
      if (destruction?.type !== 'asteroidDestroy' || !destruction.data.origin) {
        throw new Error('Cooperative split must identify its origin');
      }
      const origin = destruction.data.origin;
      const subsequent = messages.slice(destroyIndex + 1);
      const nextState = subsequent.findIndex(
        (message) => message.type === 'gameState' || message.type === 'snapshot'
      );
      if (nextState < 0) {
        return [];
      }
      return subsequent
        .slice(0, nextState)
        .flatMap((message) =>
          message.type === 'asteroidCreateBatch' ? message.data.asteroids : []
        )
        .filter(
          (asteroid) =>
            asteroid.material === 'ice' &&
            asteroid.size < collaborative.radius &&
            Math.hypot(asteroid.position.x - origin.x, asteroid.position.y - origin.y) <=
              collaborative.radius
        )
        .map((asteroid) => asteroid.id)
        .sort();
    };

    await expect
      .poll(
        () => {
          const ids1 = fragmentIds(received1);
          const ids2 = fragmentIds(received2);
          return ids1.length === 2 && ids1.join('|') === ids2.join('|');
        },
        {
          timeout: 5000,
          message: "both pilots should receive this impact's identical two-fragment batch",
        }
      )
      .toBe(true);
    const expectedFragments = fragmentIds(received1);

    await expect
      .poll(
        async () => {
          const seen = await Promise.all(
            [page1, page2].map((page) =>
              page.evaluate(
                ({ original, fragments }) => {
                  const samples = window.__collabFieldSamples;
                  if (!samples) {
                    throw new Error('Rendered field observer unavailable');
                  }
                  return samples.some(
                    (field) =>
                      !field.includes(original) && fragments.every((id) => field.includes(id))
                  );
                },
                { original: collaborative.id, fragments: expectedFragments }
              )
            )
          );
          return seen.every(Boolean);
        },
        {
          timeout: 5000,
          message:
            'both rendered fields should show the original replaced by its exact fragment IDs',
        }
      )
      .toBe(true);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
