import { next, rewrite } from '@vercel/functions';

/** Serve the field manual from its canonical static entry. */
export default function middleware(request: Request) {
  const url = new URL(request.url);
  const isWikiEntry = url.pathname === '/wiki' || url.pathname === '/wiki/';
  if (isWikiEntry) {
    url.pathname = '/wiki/index.html';
  }
  const response = isWikiEntry ? rewrite(url) : next();
  return response;
}
