import { next, rewrite } from '@vercel/functions';

/** Serve the manual and diagnostic game entry while preserving query parameters. */
export default function middleware(request: Request) {
  const url = new URL(request.url);
  const isWikiEntry = url.pathname === '/wiki' || url.pathname === '/wiki/';
  if (isWikiEntry) {
    url.pathname = '/wiki/index.html';
  }
  const isDebugEntry = url.pathname === '/debug' || url.pathname === '/debug/';
  if (isDebugEntry) {
    url.pathname = '/index.html';
  }
  const response = isWikiEntry || isDebugEntry ? rewrite(url) : next();
  return response;
}
