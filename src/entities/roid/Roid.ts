import { tickAsteroidBoost } from '../../../shared/asteroidBoost';
import { stepAsteroidMotionInto } from '../../../shared/asteroidMotion';
import { stepContourAsteroid } from '../../../shared/contourAsteroid';

import type {
  AsteroidBoost,
  AsteroidData,
  AsteroidMaterial,
  AsteroidPhenomenon,
  AsteroidProbe,
  Position,
  Velocity,
} from '../../../shared-types';
import { worldFurnaces } from '../../network/worldExploration';

class Roid {
  position: Position;
  r: number;
  id: string;
  angle: number;
  angularVelocity: number;
  offsets: number[] = [];
  vertices: number;
  velocity: Velocity;
  health: number;
  maxHealth: number;
  material?: AsteroidMaterial;
  ore?: AsteroidMaterial | null;
  supply?: AsteroidData['supply'];
  surveyedBy?: string[];
  miningContributors?: string[];
  /** Optional server-owned reflection metadata. */
  phenomenon?: AsteroidPhenomenon;
  glowtoy?: AsteroidData['glowtoy'];
  contourRider?: AsteroidData['contourRider'];
  boost?: AsteroidBoost | null;
  probe?: AsteroidProbe | null;
  /** Shared multi-pilot HP rock. Lasers chip; do not pending-lock. */
  jaggedness: number;

  constructor(row: AsteroidData) {
    this.id = row.id;
    this.position = { ...row.position };
    this.velocity = { ...row.velocity };
    this.r = row.size;
    this.angle = row.rotation;
    this.angularVelocity = row.angularVelocity;
    this.health = row.health;
    this.maxHealth = row.maxHealth;
    this.vertices = row.vertices;
    this.offsets = [...row.offsets];
    this.jaggedness = row.jaggedness;
    this.applySnapshotMetadata(row);
  }

  /** Copy complete server metadata and clear fields absent from the latest snapshot. */
  applySnapshotMetadata(row: AsteroidData): void {
    this.probe = row.probe ? { ...row.probe } : null;
    this.boost = row.boost ? { ...row.boost } : null;
    if (row.material !== undefined) {
      this.material = row.material;
    } else {
      delete this.material;
    }
    if (row.ore !== undefined) {
      this.ore = row.ore;
    } else {
      delete this.ore;
    }
    if (row.supply) {
      this.supply = { ...row.supply };
    } else {
      delete this.supply;
    }
    this.contourRider = row.contourRider ? { ...row.contourRider } : row.contourRider;
    this.glowtoy = row.glowtoy ? { ...row.glowtoy } : row.glowtoy;
    if (row.surveyedBy) {
      this.surveyedBy = [...row.surveyedBy];
    } else {
      delete this.surveyedBy;
    }
    if (row.miningContributors) {
      this.miningContributors = [...row.miningContributors];
    } else {
      delete this.miningContributors;
    }
    if (row.phenomenon) {
      this.phenomenon = { ...row.phenomenon };
    } else {
      delete this.phenomenon;
    }
  }
}

class RoidBelt {
  private rocks: Roid[] = [];
  private readonly byId = new Map<string, Roid>();

  /**
   * The live belt, for readers. `readonly` on purpose: an id index derived from
   * an array other code may splice cannot be kept honest by watching the array,
   * so the belt owns every membership change instead (see `getById`).
   */
  getRoids(): readonly Roid[] {
    return this.rocks;
  }

  size(): number {
    return this.rocks.length;
  }

  /** Take a rock into the belt and into the index together. */
  add(roid: Roid): void {
    this.rocks.push(roid);
    this.byId.set(roid.id, roid);
  }

  /** Drop a rock from the belt and the index together. False if it was not here. */
  remove(roid: Roid): boolean {
    const index = this.rocks.indexOf(roid);
    if (index === -1) {
      return false;
    }
    this.rocks.splice(index, 1);
    this.byId.delete(roid.id);
    return true;
  }

  /** Swap the whole belt, for a join or a reset. */
  replaceAll(roids: Roid[]): void {
    this.rocks = roids;
    this.byId.clear();
    for (const roid of roids) {
      this.byId.set(roid.id, roid);
    }
  }

  /**
   * The rock with this id, without scanning the belt.
   *
   * Every snapshot reports one row per nearby asteroid, so a linear scan per row
   * costs the square of the field size on the apply path. The index is maintained
   * by `add`, `remove` and `replaceAll` rather than rebuilt when the belt looks
   * different, because looking different is not a reliable signal: a splice and a
   * push between two lookups leave the array's identity and length unchanged, and
   * a rebuild keyed on those would keep the removed rock and miss the added one.
   * Snapshots fan created before removed, so that pairing is ordinary traffic.
   */
  getById(id: string): Roid | undefined {
    return this.byId.get(id);
  }

  moveRoids(): void {
    for (const roid of this.rocks) {
      tickAsteroidBoost(roid, roid.r, worldFurnaces);
      if (!stepContourAsteroid(roid)) {
        stepAsteroidMotionInto(roid.position, roid.velocity, 1, roid.position, roid.velocity);
      }
    }
  }
}

export { Roid, RoidBelt };
