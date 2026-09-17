/** Railway injects the deployed Git revision; local runs have no release identity. */
import process from 'node:process';
export const SERVER_RELEASE_ID = process.env['RAILWAY_GIT_COMMIT_SHA'] || 'dev';
