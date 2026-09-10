import { afterEach, describe, expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { RNGService } from '../../../server/core/RNGService';
import { DEBUG } from '../../../src/constants';

const defaultPlacement = DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER;
const playerPositions = [
  { x: 100, y: 200 },
  { x: 150, y: 250 },
];
const botPositions = [
  { x: 300, y: 400 },
  { x: 500, y: 600 },
];

function field() {
  return new AsteroidManager(new RNGService(731));
}

afterEach(() => {
  Object.assign(DEBUG.ROIDS, { PLACE_ON_LOCAL_PLAYER: defaultPlacement });
});

describe('asteroid collision-fixture placement', () => {
  test('opt-in placement puts each rock exactly on a named player position', () => {
    Object.assign(DEBUG.ROIDS, { PLACE_ON_LOCAL_PLAYER: true });
    const asteroids = field().createAsteroids(5, { radius: 3100 }, botPositions, playerPositions);

    expect(asteroids.map((asteroid) => asteroid.position)).toEqual([
      { x: 100, y: 200 },
      { x: 150, y: 250 },
      { x: 100, y: 200 },
      { x: 150, y: 250 },
      { x: 100, y: 200 },
    ]);
  });

  test('normal placement is off by default and player or bot hints do not pin the field', () => {
    expect(DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER).toBe(false);
    expect(DEBUG.ROIDS.PLACE_ON_BOT).toBe(false);
    const baseline = field().createAsteroids(4, { radius: 3100 }, [], []);
    const withParticipants = field().createAsteroids(
      4,
      { radius: 3100 },
      botPositions,
      playerPositions
    );

    expect(withParticipants).toHaveLength(4);
    expect(withParticipants.map((asteroid) => asteroid.position)).toEqual(
      baseline.map((asteroid) => asteroid.position)
    );
    for (const asteroid of withParticipants) {
      expect([...playerPositions, ...botPositions]).not.toContainEqual(asteroid.position);
    }
  });
});
