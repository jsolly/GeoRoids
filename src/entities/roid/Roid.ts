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
  roids: Roid[] = [];

  getRoids(): Roid[] {
    return this.roids;
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
