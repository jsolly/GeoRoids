import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { MAX_DEBUG_REPORT_BYTES } from '../../shared/debugReports';
import type { DebugJsonValue } from '../../shared-types';
import { DebugReportError, type DebugReportWorker } from './client';

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu;
const REPORT_ID = /^[0-9a-f-]{36}$/iu;
const RECEIPT_AUTHORIZATION = /^Bearer [0-9a-f]{64}$/u;

interface ReportHttpOptions {
  allowedOrigins: readonly string[];
  sameOriginClient: boolean;
  railwayIngress: boolean;
  health: () => DebugJsonValue;
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/** Only a server serving its own client accepts a canonical Origin matching the request Host. */
function isClientOrigin(origin: string, host: string | undefined): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === origin &&
      url.host === host
    );
  } catch {
    return false;
  }
}

/** Only Railway public HTTP ingress supplies this header; local proxies cannot select it. */
function clientAddress(req: IncomingMessage, railwayIngress: boolean): string {
  if (railwayIngress) {
    const value = req.headers['x-real-ip'];
    if (typeof value !== 'string' || !isIP(value)) {
      throw new DebugReportError(503, 'Reporting ingress address is unavailable');
    }
    return value;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Routing happens before general HTTP logs, so receipt Authorization never reaches logs. */
export function createDebugReportHttp(
  worker: DebugReportWorker | undefined,
  options: ReportHttpOptions
): (req: IncomingMessage, res: ServerResponse) => boolean {
  let uploads = 0;
  const statusRequests = new Map<string, { count: number; until: number }>();
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      respond(res, 400, { error: 'Invalid request target' });
      return true;
    }
    if (pathname !== '/debug-reports' && !pathname.startsWith('/debug-reports/')) {
      return false;
    }
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (
      origin &&
      !options.allowedOrigins.includes(origin) &&
      !(options.sameOriginClient && isClientOrigin(origin, req.headers.host))
    ) {
      respond(res, 403, { error: 'Reporting origin is not allowed' });
      return true;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (!worker) {
      respond(res, 503, { error: 'Reporting is not configured; keep or download this report' });
      return true;
    }
    const activeWorker = worker;
    void (async () => {
      let ownsUpload = false;
      const deadline = setTimeout(() => {
        respond(res, 408, { error: 'Report request timed out; retry the same report' });
        req.destroy();
      }, 10_000);
      try {
        const address = clientAddress(req, options.railwayIngress);
        if (pathname === '/debug-reports' && req.method === 'POST') {
          if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) {
            respond(res, 415, { error: 'Reports require application/json' });
            return;
          }
          if (uploads >= 2) {
            respond(res, 503, { error: 'Reporting is busy; retry the same report' });
            return;
          }
          if (Number(req.headers['content-length'] ?? 0) > MAX_DEBUG_REPORT_BYTES) {
            respond(res, 413, { error: 'Report exceeds 2 MiB; download diagnostics instead' });
            return;
          }
          uploads++;
          ownsUpload = true;
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_DEBUG_REPORT_BYTES) {
              respond(res, 413, { error: 'Report exceeds 2 MiB; download diagnostics instead' });
              return;
            }
            chunks.push(buffer);
          }
          const body = Buffer.concat(chunks, bytes).toString('utf8');
          // Body parsing, hashing, validation, redaction and SQLite all belong to the worker.
          const receipt = await activeWorker.enqueue(body, address, options.health());
          respond(res, 202, receipt);
          return;
        }
        const id = pathname.slice('/debug-reports/'.length);
        if (req.method === 'GET' && REPORT_ID.test(id)) {
          const bearer = req.headers.authorization;
          if (!bearer || !RECEIPT_AUTHORIZATION.test(bearer)) {
            respond(res, 404, { error: 'Report receipt not found' });
            return;
          }
          const now = Date.now();
          for (const [key, budget] of statusRequests) {
            if (budget.until <= now) {
              statusRequests.delete(key);
            }
          }
          const budget = statusRequests.get(address) ?? { count: 0, until: now + 60_000 };
          if (budget.count >= 60 || (!statusRequests.has(address) && statusRequests.size >= 1024)) {
            respond(res, 429, { error: 'Too many report status requests' });
            return;
          }
          budget.count++;
          statusRequests.set(address, budget);
          const receipt = await activeWorker.status(id, bearer.slice('Bearer '.length));
          respond(res, receipt ? 200 : 404, receipt ?? { error: 'Report receipt not found' });
          return;
        }
        respond(res, 405, { error: 'Unsupported report method or path' });
      } catch (error) {
        respond(res, error instanceof DebugReportError ? error.status : 503, {
          error:
            error instanceof DebugReportError
              ? error.message
              : 'Report could not be saved; retry the same report',
        });
      } finally {
        clearTimeout(deadline);
        if (ownsUpload) {
          uploads--;
        }
      }
    })();
    return true;
  };
}
