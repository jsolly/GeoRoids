import { next, rewrite } from '@vercel/functions';

/** Expose the deployed commit so /ship can prove which client reached production. */
export default function middleware(request: Request) {
  const url = new URL(request.url);
  const isWikiEntry = url.pathname === '/wiki' || url.pathname === '/wiki/';
  if (isWikiEntry) {
    url.pathname = '/wiki/index.html';
  }
  const response = isWikiEntry ? rewrite(url) : next();
  response.headers.set('x-release-id', process.env['VERCEL_GIT_COMMIT_SHA'] || 'dev');
  return response;
}
