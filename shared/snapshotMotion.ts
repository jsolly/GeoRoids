/** Relative P4 values stay exact integers. Never zigzag by doubling a safe53 value. */
export type RelativeMotionTuple = readonly [number, number, ...number[]];
export type RelativeMotionPrediction = (
  ordinal: number,
  mask: number
) => readonly number[] | undefined;

// biome-ignore lint/security/noSecrets: This is the standard public RFC 4648 alphabet.
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
// A uint32 ordinal header takes at most six bytes; five safe53 values take forty.
const MAX_RECORD_BYTES = 48;

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  }
  // btoa/atob are native in supported browsers and Node 24, without a Buffer import.
  return btoa(chunks.join(''));
}

function base64Bytes(value: unknown, maximum: number): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4 * Math.ceil(maximum / 3) ||
    value.length % 4 !== 0
  ) {
    throw new Error('Invalid snapshot motion base64 length');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = value.length - padding;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) {
      throw new Error('Invalid snapshot motion base64 alphabet');
    }
  }
  if (padding && BASE64.indexOf(value.charAt(end - 1)) & (padding === 2 ? 15 : 3)) {
    throw new Error('Noncanonical snapshot motion base64 padding');
  }
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength > maximum) {
    throw new Error('Snapshot motion byte limit');
  }
  const decoded = atob(value);
  const bytes = new Uint8Array(decodedLength);
  for (let index = 0; index < decodedLength; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

/**
 * Each record is unsigned varint(gap * 32 + mask), then mask-implied signed values.
 * Mask bit 16 marks residuals against an eligible baseline prediction. All actual
 * deltas are still represented exactly, including impulses and wrapped rotations.
 * Signed values use sign bit 0 and six magnitude bits in their first byte, then seven
 * magnitude bits per byte. Bit 7 always means continuation. No full-number bit shifts.
 * Sort detached tuples because every ordinal addresses the immutable prior collection.
 */
export function encodeRelativeMotion(
  updates: readonly RelativeMotionTuple[],
  prediction?: RelativeMotionPrediction
): string {
  const sorted = [...updates].sort((left, right) => left[0] - right[0]);
  const bytes = new Uint8Array(sorted.length * MAX_RECORD_BYTES);
  let offset = 0;
  const unsigned = (value: number): void => {
    let remaining = value;
    do {
      const digit = remaining % 128;
      remaining = Math.floor(remaining / 128);
      bytes[offset++] = digit + (remaining ? 128 : 0);
    } while (remaining);
  };
  const signed = (value: number): void => {
    let magnitude = Math.abs(value);
    const digit = (magnitude % 64) * 2 + (value < 0 ? 1 : 0);
    magnitude = Math.floor(magnitude / 64);
    bytes[offset++] = digit + (magnitude ? 128 : 0);
    if (magnitude) {
      unsigned(magnitude);
    }
  };
  const unsignedLength = (value: number): number => {
    let remaining = value;
    let length = 1;
    while (remaining >= 128) {
      remaining = Math.floor(remaining / 128);
      length++;
    }
    return length;
  };
  const signedLength = (value: number): number =>
    1 + (Math.abs(value) < 64 ? 0 : unsignedLength(Math.floor(Math.abs(value) / 64)));
  let previous = -1;
  for (const tuple of sorted) {
    const [ordinal, mask] = tuple;
    const arity = (mask & 1 ? 2 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 2 : 0);
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal <= previous ||
      ordinal > 0xffff_ffff ||
      !Number.isSafeInteger(mask) ||
      mask < 9 ||
      mask > 15 ||
      tuple.length !== 2 + arity
    ) {
      throw new Error('Invalid snapshot relative motion input');
    }
    const values: number[] = [];
    for (let index = 2; index < tuple.length; index++) {
      const value = tuple[index];
      if (value === undefined || !Number.isSafeInteger(value)) {
        throw new Error('Invalid snapshot relative motion value');
      }
      values.push(value);
    }
    // Array ordinals are at most uint32, so multiplying this gap by 32 is exact.
    const gap = (ordinal - previous - 1) * 32;
    let header = gap + mask;
    let encoded = values;
    const predicted = prediction?.(ordinal, mask);
    if (predicted && predicted.length === arity && predicted.every(Number.isSafeInteger)) {
      const residuals = values.map((value, index) => value - (predicted[index] ?? Number.NaN));
      if (
        residuals.every(Number.isSafeInteger) &&
        unsignedLength(gap + (mask | 16)) +
          residuals.reduce((sum, value) => sum + signedLength(value), 0) <
          unsignedLength(header) + values.reduce((sum, value) => sum + signedLength(value), 0)
      ) {
        header = gap + (mask | 16);
        encoded = residuals;
      }
    }
    unsigned(header);
    for (const value of encoded) {
      signed(value);
    }
    previous = ordinal;
  }
  return base64(bytes.subarray(0, offset));
}

/** EOF terminates the stream. Shortest varints and canonical base64 have one spelling. */
export function readRelativeMotion(
  value: unknown,
  baselineLength: number,
  allowVelocity: boolean,
  apply: (ordinal: number, mask: number, values: number[]) => void,
  prediction?: RelativeMotionPrediction
): void {
  const bytes = base64Bytes(value, baselineLength * MAX_RECORD_BYTES);
  let offset = 0;
  const integer = (signed: boolean): number => {
    const first = bytes[offset++];
    if (first === undefined) {
      throw new Error('Truncated snapshot motion integer');
    }
    let magnitude = signed ? Math.floor((first % 128) / 2) : first % 128;
    let multiplier = signed ? 64 : 128;
    let digit = first;
    let count = 1;
    while (digit >= 128) {
      digit = bytes[offset++] ?? -1;
      if (digit < 0 || ++count > 8) {
        throw new Error('Truncated or oversized snapshot motion integer');
      }
      const payload = digit % 128;
      if (payload > Math.floor((MAX_INTEGER - magnitude) / multiplier)) {
        throw new Error('Unsafe snapshot motion integer');
      }
      magnitude += payload * multiplier;
      if (digit < 128 && payload === 0) {
        throw new Error('Noncanonical snapshot motion integer');
      }
      multiplier *= 128;
    }
    if (signed && first % 2) {
      if (magnitude === 0) {
        throw new Error('Noncanonical snapshot motion negative zero');
      }
      return -magnitude;
    }
    return magnitude;
  };
  let previous = -1;
  while (offset < bytes.length) {
    const header = integer(false);
    const wireMask = header % 32;
    const mask = wireMask % 16;
    const gap = Math.floor(header / 32);
    if (mask < 9 || (!allowVelocity && mask > 11)) {
      throw new Error('Invalid snapshot packed motion mask');
    }
    if (gap >= baselineLength - previous - 1) {
      throw new Error('Invalid snapshot packed motion ordinal');
    }
    const ordinal = previous + 1 + gap;
    const arity = (mask & 1 ? 2 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 2 : 0);
    const values: number[] = [];
    for (let index = 0; index < arity; index++) {
      values.push(integer(true));
    }
    if (wireMask & 16) {
      const predicted = prediction?.(ordinal, mask);
      if (!predicted || predicted.length !== arity) {
        throw new Error('Invalid snapshot motion prediction baseline');
      }
      for (let index = 0; index < values.length; index++) {
        const residual = values[index];
        const expected = predicted[index];
        if (
          residual === undefined ||
          expected === undefined ||
          !Number.isSafeInteger(expected) ||
          !Number.isSafeInteger(residual + expected)
        ) {
          throw new Error('Unsafe snapshot motion prediction sum');
        }
        values[index] = residual + expected;
      }
    }
    apply(ordinal, mask, values);
    previous = ordinal;
  }
}
