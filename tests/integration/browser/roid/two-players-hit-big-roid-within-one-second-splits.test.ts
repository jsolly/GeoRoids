import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { isAsteroidMaterial } from '../../../../shared/asteroidMaterials';
import type { AsteroidData, AsteroidDestroyEvent } from '../../../../shared-types';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

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
  | { type: 'snapshot' }
  | { type: 'error'; data: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Validate only the event fields this scenario observes; snapshots are decoded by the clients.
function readSplitEvidence(value: unknown): SplitEvidence | undefined {
  assert.ok(isRecord(value), 'Expected a WebSocket message envelope');
  const type = value['type'];
  if (type === 'snapshot') {
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
    await game2.bootGame({ waitForCombatReady: false });
    const playerIds = await Promise.all([game1.getLocalPlayerId(), game2.getLocalPlayerId()]);
    await arrangeCrewField(playerIds, 'cooperative');
    await Promise.all([game1.placeShipAt(-35, -340), game2.placeShipAt(35, -340)]);
    await Promise.all([game1.waitForCombatReady(), game2.waitForCombatReady()]);
    await expect
      .poll(async () => (await game1.getAsteroidPositions()).map((rock) => rock.id))
      .toEqual(['crew-fixture-ore']);
    const [collaborative] = await game1.getAsteroidPositions();
    if (!collaborative) {
      throw new Error('Controlled cooperative asteroid missing');
    }
    expect(collaborative).toMatchObject({ material: 'ice', radius: 50, isCollabTarget: false });

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
      const nextState = subsequent.findIndex((message) => message.type === 'snapshot');
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
