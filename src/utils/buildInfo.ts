interface BuildInfo {
  commitHash: string;
  buildTime: string;
  version: string;
  environment: string;
}

// Get build information from build-time injected values
export function getBuildInfo(): BuildInfo {
  const commitHash = import.meta.env['VITE_COMMIT_HASH'] || 'dev';
  const buildTime = import.meta.env['VITE_BUILD_TIME'] || new Date().toISOString();
  const environment = import.meta.env.MODE || 'development';

  // Use commit hash as version, fallback to 'dev'
  const version = commitHash !== 'dev' ? commitHash : 'dev';

  return {
    commitHash,
    buildTime,
    version,
    environment,
  };
}

// Get a short build identifier for display
export function getBuildId(): string {
  const info = getBuildInfo();
  if (info.environment === 'development') {
    return 'dev';
  }
  return info.version.slice(0, 7);
}

// Get full build info as a string
export function getBuildInfoString(): string {
  const info = getBuildInfo();
  if (info.environment === 'development') {
    return 'dev';
  }
  return `${info.version} (${new Date(info.buildTime).toLocaleDateString()})`;
}
