import { DEV_RELEASE_ID, readReleaseId } from '../../shared/releaseId';

// Vite injects release metadata and rejects builds without a valid commit.
export function getBuildInfoString(): string {
  if (import.meta.env.MODE === 'development') {
    return 'dev';
  }
  const commitHash = import.meta.env['VITE_COMMIT_HASH'];
  const buildTime = import.meta.env['VITE_BUILD_TIME'];
  return `${commitHash} (${new Date(buildTime).toLocaleDateString()})`;
}

/** Full Git SHA of this client bundle, or `dev` when Vite did not inject one. */
export function getClientReleaseId(): string {
  return readReleaseId(import.meta.env['VITE_COMMIT_SHA']) ?? DEV_RELEASE_ID;
}
