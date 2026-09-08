// Mulberry32 seeded PRNG for deterministic asteroid/bot generation
export class RNGService {
  private rngState: number;
  private initialSeed: number;

  constructor(serverSeed?: number) {
    // Store the initial seed for reset functionality
    this.initialSeed = RNGService.toUint32(serverSeed ?? 0x9e3779b9); // Default seed, normalized to unsigned 32-bit
    this.rngState = this.initialSeed;
  }

  // Private static method to validate and convert to uint32
  private static toUint32(n: number): number {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new TypeError('Seed must be a finite number');
    }
    return n >>> 0;
  }

  // Seeded random number generator (mulberry32)
  public random(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Reset RNG to initial state for reproducible generation
  public reset(): void {
    this.rngState = this.initialSeed;
  }

  // Get random position within bounds (supports both rectangular and circular)
  public randomPosition(bounds: { width?: number; height?: number; radius?: number }): {
    x: number;
    y: number;
  } {
    if (bounds.radius) {
      // Circular boundary
      const angle = this.random() * Math.PI * 2;
      const radius = this.random() * bounds.radius * 0.8; // Stay within 80% of boundary
      return {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
    } else {
      // Rectangular boundary (legacy support)
      return {
        x: this.random() * bounds.width! - bounds.width! / 2,
        y: this.random() * bounds.height! - bounds.height! / 2,
      };
    }
  }

  // Get random velocity
  public randomVelocity(maxSpeed: number): { x: number; y: number } {
    return {
      x: (this.random() - 0.5) * maxSpeed,
      y: (this.random() - 0.5) * maxSpeed,
    };
  }

  // Get current RNG state
  public getState(): number {
    return this.rngState;
  }

  // Set RNG state
  public setState(state: number): void {
    this.rngState = RNGService.toUint32(state); // Ensure unsigned 32-bit with validation
  }

  // Set a new seed and reset the generator
  public setSeed(seed: number): void {
    const normalizedSeed = RNGService.toUint32(seed);
    if (normalizedSeed === 0) {
      throw new Error('Seed cannot be 0');
    }
    this.initialSeed = normalizedSeed;
    this.rngState = this.initialSeed;
  }

  // Create a new RNGService instance with the provided seed or derived from current state
  public fork(seed?: number): RNGService {
    const newSeed = seed !== undefined ? seed : this.random() * 0xffffffff;
    return new RNGService(RNGService.toUint32(newSeed));
  }
}
