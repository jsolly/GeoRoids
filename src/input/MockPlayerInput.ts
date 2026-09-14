import type { PlayerInput } from './PlayerInput';

/**
 * Mock input implementation for testing
 */
export class MockPlayerInput implements PlayerInput {
  private thrusting: boolean = false;
  private angularVelocity: number = 0;
  private shooting: boolean = false;

  constructor(overrides?: {
    thrusting?: boolean;
    angularVelocity?: number;
    shooting?: boolean;
  }) {
    if (overrides) {
      this.thrusting = overrides.thrusting ?? this.thrusting;
      this.angularVelocity = overrides.angularVelocity ?? this.angularVelocity;
      this.shooting = overrides.shooting ?? this.shooting;
    }
  }

  getThrusting(): boolean {
    return this.thrusting;
  }

  getAngularVelocity(): number {
    return this.angularVelocity;
  }

  getShooting(): boolean {
    return this.shooting;
  }
}
