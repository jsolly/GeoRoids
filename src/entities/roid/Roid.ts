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
import { playHitSound as playHitSoundAt } from '../../audio/gameSounds';
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

  playHitSound(): void {
    playHitSoundAt(this.position);
  }

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
  roids: Roid[] = [];
  private byId = new Map<string, Roid>();
  private indexedRoids: Roid[] | null = null;
  private indexedLength = -1;

  getRoids(): Roid[] {
    return this.roids;
  }

  /**
   * The rock with this id, without scanning the belt.
   *
   * Every snapshot reports one row per nearby asteroid, so a linear scan per row
   * costs the square of the field size on the apply path. `roids` stays a plain
   * public array that callers may push, splice or replace, so the index rebuilds
   * whenever that array's identity or length no longer matches what was indexed.
   */
  getById(id: string): Roid | undefined {
    if (this.indexedRoids !== this.roids || this.indexedLength !== this.roids.length) {
      this.byId.clear();
      for (const roid of this.roids) {
        this.byId.set(roid.id, roid);
      }
      this.indexedRoids = this.roids;
      this.indexedLength = this.roids.length;
    }
    return this.byId.get(id);
  }

  moveRoids(): void {
    for (const roid of this.roids) {
      tickAsteroidBoost(roid, roid.r, worldFurnaces);
      if (!stepContourAsteroid(roid)) {
        stepAsteroidMotionInto(roid.position, roid.velocity, 1, roid.position, roid.velocity);
      }
    }
  }
}

export { Roid, RoidBelt };
