import { DEV_RELEASE_ID, readReleaseId } from '../../shared/releaseId';

// Vite injects version metadata; archives without Git receive an opaque build token.
export function getBuildInfoString(): string {
  if (import.meta.env.MODE === 'development') {
    return 'dev';
  }
  const commitHash = import.meta.env['VITE_COMMIT_HASH'];
  const buildTime = import.meta.env['VITE_BUILD_TIME'];
  return `${commitHash} (${new Date(buildTime).toLocaleDateString()})`;
}

/** Host/Git identity or opaque build token, or `dev` when Vite did not inject one. */
export function getClientReleaseId(): string {
  return readReleaseId(import.meta.env['VITE_COMMIT_SHA']) ?? DEV_RELEASE_ID;
}
