import type { Position, Velocity } from '../shared-types';

const STATE_SNAPSHOT_SAMPLE_INTERVAL = 450;
const MAX_ERROR_TEXT = 2048;

interface DiagnosticActorState {
  position: Position;
  velocity: Velocity;
  angle: number;
  health: number;
  maxHealth: number;
  lives: number;
  score: number;
  exploding: boolean;
  respawnTimer?: number;
  spawnProtectionTimer?: number;
}

type ActorStateSource = DiagnosticActorState;

/** A small immutable view for logs; never pass mutable actor/snapshot rows to the logger. */
export function captureDiagnosticActorState(source: ActorStateSource): DiagnosticActorState {
  return {
    position: { x: source.position.x, y: source.position.y },
    velocity: { x: source.velocity.x, y: source.velocity.y },
    angle: source.angle,
    health: source.health,
    maxHealth: source.maxHealth,
    lives: source.lives,
    score: source.score,
    exploding: source.exploding,
    ...(source.respawnTimer !== undefined ? { respawnTimer: source.respawnTimer } : {}),
    ...(source.spawnProtectionTimer !== undefined
      ? { spawnProtectionTimer: source.spawnProtectionTimer }
      : {}),
  };
}

export function shouldSampleSnapshot(sequence: number): boolean {
  return sequence === 1 || sequence % STATE_SNAPSHOT_SAMPLE_INTERVAL === 0;
}

function boundedText(value: string, max = MAX_ERROR_TEXT): string {
  return Array.from(value.replace(/(https?:\/\/[^\s?#)]+)[?#][^\s)]*/g, '$1'), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  })
    .join('')
    .slice(0, max);
}

/** Preserve a useful error cause without serializing arbitrary rejected objects or URL secrets. */
export function boundedDiagnosticError(value: unknown, fallback: string): Error {
  if (!(value instanceof Error)) {
    return new Error(typeof value === 'string' ? boundedText(value) : boundedText(fallback));
  }
  const error = new Error(boundedText(value.message || fallback));
  error.name = boundedText(value.name || 'Error', 128);
  if (value.stack) {
    error.stack = boundedText(value.stack);
  }
  return error;
}
