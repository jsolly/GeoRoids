import { existsSync, realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, STATUS_CODES } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { logger } from '../setup/serverLogger';

// Preview environments serve the Astro build from the game server's origin so the
// client's same-origin /ws fallback reaches the matching server. Production keeps
// Vercel as the client host and never passes a client root.

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

// Mirrors vercel.ts: open clients poll these manifests to detect a new build.
const UNCACHED_PATHS = new Set(['/release.json', '/client-assets.json']);

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

function reject(res: ServerResponse, status: 400 | 404 | 405): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(STATUS_CODES[status]);
}

type CacheControl =
  | 'no-store'
  | 'public, max-age=31536000, immutable'
  | 'public, max-age=0, must-revalidate';

function cacheControl(pathname: string): CacheControl {
  if (UNCACHED_PATHS.has(pathname)) {
    return 'no-store';
  }
  return pathname.startsWith('/_astro/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=0, must-revalidate';
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function missing(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function resolveFile(root: string, pathname: string): Promise<string | undefined> {
  const requested = resolve(root, `.${pathname}`);
  if (!inside(root, requested)) {
    return undefined;
  }
  try {
    const entry = await stat(requested);
    // Astro emits directory routes; /debug and /debug/ both serve debug/index.html.
    const file = entry.isDirectory() ? join(requested, 'index.html') : requested;
    const real = await realpath(file);
    if (!inside(root, real) || !(await stat(real)).isFile()) {
      return undefined;
    }
    return real;
  } catch (error) {
    // Only an absent path is a 404; anything else is a broken build and reaches the 500 log.
    if (missing(error)) {
      return undefined;
    }
    throw error;
  }
}

async function serve(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    reject(res, 405);
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    reject(res, 400);
    return;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    reject(res, 400);
    return;
  }
  const file = await resolveFile(root, pathname);
  if (file == null || file === '') {
    reject(res, 404);
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.byteLength,
    'Cache-Control': cacheControl(pathname),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Serves a built client directory; refuses a root without the built game page. */
export function createStaticClient(clientRoot: string): RequestHandler {
  if (!existsSync(join(clientRoot, 'index.html'))) {
    throw new Error(`Preview client requires a built client at ${join(clientRoot, 'index.html')}`);
  }
  const root = realpathSync(clientRoot);
  return (req, res) => {
    void serve(root, req, res).catch((error) => {
      logger.error('Failed to serve preview client file', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end();
    });
  };
}
