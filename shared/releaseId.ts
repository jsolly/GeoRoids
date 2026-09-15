/** Git SHA of a deployed build, or `dev` for local/test processes without Railway. */
export const DEV_RELEASE_ID = 'dev';

const GIT_SHA = /^[a-f0-9]{40}$/i;

export function isReleaseId(value: unknown): value is string {
  return value === DEV_RELEASE_ID || (typeof value === 'string' && GIT_SHA.test(value));
}

export function readReleaseId(value: unknown): string | undefined {
  if (value === DEV_RELEASE_ID) {
    return DEV_RELEASE_ID;
  }
  if (typeof value === 'string' && GIT_SHA.test(value)) {
    return value.toLowerCase();
  }
  return undefined;
}

export function releaseField<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  const releaseId = readReleaseId(value);
  return releaseId === undefined ? {} : ({ [key]: releaseId } as { [P in K]: string });
}
