import { seedAsteroidPhenomena } from '../../shared/asteroidPhenomena';
import type { AsteroidData } from '../../shared-types';
import type { AsteroidManager } from './AsteroidManager';
import type { AsteroidFieldInputs } from './types';

/** Owns regional admission and fixture decoration at their separate frame slots. */
export class AsteroidField {
  private fieldMode: 'regional' | 'fixture' = 'regional';
  private decoratedFieldId: string | undefined;

  constructor(private readonly inputs: AsteroidFieldInputs) {}

  get mode() {
    return this.fieldMode;
  }

  createFixtures(
    count: number,
    bounds: Parameters<AsteroidManager['createAsteroids']>[1]
  ): AsteroidData[] {
    this.fieldMode = 'fixture';
    return this.inputs.rocks.createAsteroids(count, bounds);
  }

  seedFixtures(): void {
    if (this.fieldMode === 'regional') {
      return;
    }
    const rocks = this.inputs.rocks.getAllAsteroids();
    const firstRock = rocks[0];
    if (!firstRock) {
      return;
    }
    if (this.decoratedFieldId == null || this.decoratedFieldId === '') {
      seedAsteroidPhenomena(rocks);
      // Phenomena reshape and move live rows in place.
      this.inputs.rocks.refile(rocks);
      this.decoratedFieldId = firstRock.id;
    }
  }

  ensure(): AsteroidData[] {
    if (this.inputs.isPaused() || this.inputs.actors.getHumanPlayers().length === 0) {
      return [];
    }
    if (this.fieldMode === 'fixture') {
      this.seedFixtures();
      return [];
    }
    return this.inputs.regional.update(
      this.inputs.rocks,
      [
        ...this.inputs.actors.getHumanPlayers().map((entity) => entity.position),
        ...this.inputs.probes.observerPositions(),
      ],
      this.inputs.now()
    );
  }

  advanceFixtureSeeding(frame: number): void {
    if (frame % 60 === 0) {
      this.seedFixtures();
    }
  }

  advanceRegions(frame: number): void {
    if (frame % 60 === 0) {
      this.ensure();
    }
  }

  forgetFixtureDecoration(): void {
    this.decoratedFieldId = undefined;
  }

  restoreRegionalMode(): void {
    this.fieldMode = 'regional';
  }
}
