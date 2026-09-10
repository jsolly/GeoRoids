// Vite injects release metadata and rejects builds without a valid commit.
export function getBuildInfoString(): string {
  if (import.meta.env.MODE === 'development') {
    return 'dev';
  }
  const commitHash = import.meta.env['VITE_COMMIT_HASH'];
  const buildTime = import.meta.env['VITE_BUILD_TIME'];
  return `${commitHash} (${new Date(buildTime).toLocaleDateString()})`;
}
