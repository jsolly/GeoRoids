import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import destination from '../../config/server/debug-reports.json' with { type: 'json' };

export interface DebugReportConfiguration {
  path: string;
  token: string;
  projectId: string;
  sectionId: string;
  /** Test-only dependency: accepted only for loopback HTTP origins. Never populated from env. */
  testApiOrigin?: string;
  limits?: {
    databaseBytes?: number;
    pendingBytes?: number;
    pendingCount?: number;
    minimumFreeBytes?: number;
  };
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let exists = true;
  try {
    lstatSync(absolute);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
    exists = false;
  }
  if (exists) {
    return realpathSync(absolute);
  }
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
}

export function readDebugReportConfiguration(
  env: NodeJS.ProcessEnv,
  nodeEnv: string | undefined
): DebugReportConfiguration | undefined {
  if (env['GEOROIDS_DEBUG_REPORTS_ENABLED'] === '0') {
    return undefined;
  }
  const configured = env['GEOROIDS_DEBUG_REPORTS_PATH'];
  if (nodeEnv === 'test' || env['NODE_ENV'] === 'test' || env['VITEST'] === 'true') {
    return undefined;
  }
  const worldPath = env['GEOROIDS_WORLD_PATH'];
  const path =
    configured ||
    (nodeEnv === 'production'
      ? env['RAILWAY_ENVIRONMENT_ID'] && worldPath
        ? join(dirname(worldPath), 'debug-reports.sqlite')
        : undefined
      : resolve('.data/debug-reports.sqlite'));
  if (!path) {
    return undefined;
  }
  let canonicalReport: string;
  try {
    canonicalReport = canonicalPath(path);
    if (worldPath && canonicalReport === canonicalPath(worldPath)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (nodeEnv === 'production') {
    const mount = env['RAILWAY_VOLUME_MOUNT_PATH'];
    if (!env['RAILWAY_ENVIRONMENT_ID'] || !mount || !isAbsolute(path) || !isAbsolute(mount)) {
      return undefined;
    }
    let canonicalMount: string;
    try {
      canonicalMount = canonicalPath(mount);
    } catch {
      return undefined;
    }
    const withinVolume = relative(canonicalMount, canonicalReport);
    if (!withinVolume || withinVolume.startsWith('..') || isAbsolute(withinVolume)) {
      return undefined;
    }
  }
  const token = env['TODOIST_API_TOKEN'];
  if (!token) {
    // Nothing can be delivered without it, so booting "configured" would accept
    // reports into a queue that cannot drain. Refusing makes `/debug-reports`
    // answer 503 and the client keep its report.
    return undefined;
  }
  return {
    path,
    token,
    projectId: destination.projectId,
    sectionId: env['GEOROIDS_DEBUG_REPORTS_SECTION_ID'] ?? destination.sectionId,
  };
}
