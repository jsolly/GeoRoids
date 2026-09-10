import { assert, expect, test } from 'vitest';
import type { Position } from '../../../../shared-types';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

interface ObservedAsteroidMessage {
  type: string;
  data?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is Position {
  return isRecord(value) && typeof value['x'] === 'number' && typeof value['y'] === 'number';
}
const { browserManager } = createBrowserScenarioHooks();

// Medium ice is below the cooperative split class. Pre-existing medium rocks
// belong to the natural mixed-size belt and are not fragments of this shot.
test(
  'a medium ice roid breaks without producing fragments',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }
    const game = new GameInteractions(page);
    const received: ObservedAsteroidMessage[] = [];
    const parseErrors: unknown[] = [];
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        try {
          const message: unknown = JSON.parse(String(payload));
          if (!isRecord(message) || typeof message['type'] !== 'string') {
            throw new Error('Server message is missing its type');
          }
          const data = message['data'];
          if (data !== undefined && !isRecord(data)) {
            throw new Error(`Malformed ${message['type']} data`);
          }
          received.push({
            ...message,
            type: message['type'],
            ...(data === undefined ? {} : { data }),
          });
        } catch (error) {
          parseErrors.push(error);
        }
      })
    );
    await game.bootGame();
    const medium = (await game.getAsteroidPositions()).find(
      (asteroid) =>
        asteroid.radius >= 25 &&
        asteroid.radius < 40 &&
        !asteroid.isCollabTarget &&
        asteroid.material === 'ice'
    );
    expect(medium, 'expected a natural medium ice asteroid').toBeDefined();
    if (!medium) {
      throw new Error('Medium ice asteroid missing');
    }
    received.length = 0;
    await game.destroyAsteroidWithLaser(medium);
    await expect
      .poll(() =>
        received.find(
          (message) =>
            message.type === 'asteroidDestroy' && message.data?.['asteroidId'] === medium.id
        )
      )
      .toBeDefined();
    const index = received.findIndex(
      (message) => message.type === 'asteroidDestroy' && message.data?.['asteroidId'] === medium.id
    );
    // A later periodic state envelope on this ordered socket is a barrier: the
    // synchronous hit's fragment batch would precede it. Only ordering is used.
    await expect
      .poll(() =>
        received
          .slice(index + 1)
          .some((message) => message.type === 'gameState' || message.type === 'snapshot')
      )
      .toBe(true);
    expect(parseErrors).toEqual([]);
    expect(received[index]?.data?.['collabSplit']).toBe(false);
    const origin = received[index]?.data?.['origin'];
    assert.exists(origin, 'the destruction should identify the actual hit position');
    if (!isPosition(origin)) {
      throw new Error('Destruction origin is malformed');
    }
    const nearbyFragments = received
      .flatMap((message) => {
        if (message.type !== 'asteroidCreateBatch') {
          return [];
        }
        const asteroids: unknown = message.data?.['asteroids'];
        if (!Array.isArray(asteroids)) {
          throw new Error('Asteroid creation batch is missing its asteroid array');
        }
        return asteroids.map((asteroid: unknown) => {
          if (
            !isRecord(asteroid) ||
            typeof asteroid['material'] !== 'string' ||
            typeof asteroid['size'] !== 'number' ||
            !isPosition(asteroid['position'])
          ) {
            throw new Error('Asteroid creation batch contains a malformed asteroid');
          }
          return {
            material: asteroid['material'],
            size: asteroid['size'],
            position: asteroid['position'],
          };
        });
      })
      .filter(
        (asteroid) =>
          asteroid.material === 'ice' &&
          asteroid.size < medium.radius &&
          Math.hypot(asteroid.position.x - origin.x, asteroid.position.y - origin.y) <=
            medium.radius
      );
    expect(nearbyFragments, 'this ice break must not create smaller rocks at its impact').toEqual(
      []
    );
    expect((await game.getAsteroidPositions()).some((asteroid) => asteroid.id === medium.id)).toBe(
      false
    );
  },
  TestConfig.DEFAULT_TIMEOUT
);
