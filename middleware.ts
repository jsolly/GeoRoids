import { next } from '@vercel/functions';

/** Expose the deployed commit so /ship can prove which client reached production. */
export default function middleware() {
  const response = next();
  response.headers.set('x-release-id', process.env['VERCEL_GIT_COMMIT_SHA'] || 'dev');
  return response;
}
