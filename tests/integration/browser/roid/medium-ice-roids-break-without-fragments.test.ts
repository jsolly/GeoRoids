import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

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
    const received: any[] = [];
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const message = JSON.parse(String(payload));
        received.push(message);
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
          (message) => message.type === 'asteroidDestroy' && message.data?.asteroidId === medium.id
        )
      )
      .toBeDefined();
    const index = received.findIndex(
      (message) => message.type === 'asteroidDestroy' && message.data?.asteroidId === medium.id
    );
    // A later complete state on this ordered socket is a barrier: any fragment
    // batch from the hit has arrived before we make a negative assertion.
    await expect
      .poll(() =>
        received
          .slice(index + 1)
          .some((message) => message.type === 'gameState' || message.type === 'snapshot')
      )
      .toBe(true);
    expect(received[index].data.collabSplit).toBe(false);
    const origin = received[index].data.origin;
    expect(origin, 'the destruction should identify the actual hit position').toBeDefined();
    const nearbyFragments = received
      .flatMap((message) => (message.type === 'asteroidCreateBatch' ? message.data.asteroids : []))
      .filter(
        (asteroid: any) =>
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
