import { isDeepStrictEqual } from 'node:util';

type Shape = { readonly [key: string]: Shape | ((value: unknown) => boolean) };
type SafeValue =
  | { state: 'absent' | 'null' | 'withheld' }
  | { state: 'value'; value: string | number | boolean };

const oneOf =
  (...values: readonly string[]) =>
  (value: unknown) =>
    typeof value === 'string' && values.includes(value);
const seconds = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 3600;
const boolean = (value: unknown) => typeof value === 'boolean';
const shapes: Record<'build' | 'deploy', Shape> = {
  build: {
    builder: oneOf('RAILPACK', 'NIXPACKS', 'DOCKERFILE'),
    buildEnvironment: oneOf('V2', 'V3'),
    railpackVersion: (value) =>
      typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(value),
  },
  deploy: {
    startCommand: oneOf('node --import tsx server.ts'),
    healthcheckPath: oneOf('/health'),
    healthcheckTimeout: seconds,
    drainingSeconds: seconds,
    overlapSeconds: seconds,
    runtime: oneOf('V2'),
    useLegacyStacker: boolean,
    ipv6EgressEnabled: boolean,
    multiRegionConfig: {
      iad: {
        numReplicas: (value) =>
          Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 20,
      },
    },
  },
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fixed paths and typed safe values only. This projection never grants plan admission. */
export function settingDetails(field: 'build' | 'deploy', before: unknown, after: unknown) {
  const changes: Array<{ path: string; before: SafeValue; after: SafeValue }> = [];
  let unknownFieldCount = 0;
  let incomplete = false;
  const safe = (
    record: Record<string, unknown>,
    key: string,
    validate: (value: unknown) => boolean
  ): SafeValue => {
    if (!Object.hasOwn(record, key)) {
      return { state: 'absent' };
    }
    const value = record[key];
    if (value === null) {
      return { state: 'null' };
    }
    if (
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') &&
      validate(value)
    ) {
      return { state: 'value', value };
    }
    incomplete = true;
    return { state: 'withheld' };
  };
  const visit = (shape: Shape, left: unknown, right: unknown, path: string) => {
    if (!object(left) || !object(right)) {
      incomplete = true;
      return;
    }
    unknownFieldCount += new Set(
      [...Object.keys(left), ...Object.keys(right)].filter((key) => !Object.hasOwn(shape, key))
    ).size;
    for (const [key, rule] of Object.entries(shape)) {
      const presentLeft = Object.hasOwn(left, key),
        presentRight = Object.hasOwn(right, key);
      const nextPath = `${path}.${key}`;
      if (typeof rule !== 'function') {
        if (!presentLeft && !presentRight) {
          continue;
        }
        const previousCount = changes.length;
        // A missing container can be expanded, but null/scalar containers are not equivalent to absence.
        visit(rule, presentLeft ? left[key] : {}, presentRight ? right[key] : {}, nextPath);
        if (presentLeft !== presentRight && changes.length === previousCount) {
          changes.push({
            path: nextPath,
            before: safe(left, key, () => false),
            after: safe(right, key, () => false),
          });
        }
      } else {
        if (presentLeft === presentRight && isDeepStrictEqual(left[key], right[key])) {
          continue;
        }
        changes.push({
          path: nextPath,
          before: safe(left, key, rule),
          after: safe(right, key, rule),
        });
      }
    }
  };
  visit(shapes[field], before, after, field);
  return {
    status: incomplete || unknownFieldCount ? 'incomplete' : 'complete',
    unknownFieldCount,
    changes,
  };
}
